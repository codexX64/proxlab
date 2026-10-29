// L'écran fluide, côté navigateur : une WebSocket par session. Le navigateur
// dit la taille et la cadence voulues, ProxLab ouvre la session Sunshine et lui
// passe chaque image complète ; dans l'autre sens, des messages d'entrée
// courts, vérifiés un à un, deviennent des paquets GameStream.
//
// Vers le navigateur : texte JSON ({pret}, {fin}, {b}) ; binaire
//   [0x01][drapeaux : bit 0 = image clé][numéro u32 BE][H.264 Annex B].
// Depuis le navigateur : texte {debut:{largeur,hauteur,ips,debit}} une fois ;
// binaire, un message par geste :
//   0x10 touche [bas][vk u16 LE][modificateurs]   0x11 position [x u16][y u16]
//   0x12 bouton [bas][n]   0x13 molette [dy i16][dx i16]   0x14 image clé
import { SessionFlux, ENTREE } from './session.js';

const RETARD_MAX = 4 * 1024 * 1024;       // octets en attente vers le navigateur
const ENTREES_PAR_SECONDE = 2000;
const BATTEMENT_MS = 25000;
export const LIMITES = { largeurMin: 320, largeurMax: 3840, hauteurMin: 200, hauteurMax: 2160, ips: [30, 60, 120], debitMin: 1000, debitMax: 150000 };

export function lireDebut(texte) {
  let m;
  try { m = JSON.parse(texte); } catch { return null; }
  const d = m && typeof m === 'object' ? m.debut : null;
  if (!d || typeof d !== 'object') return null;
  const entier = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
  const largeur = entier(d.largeur, LIMITES.largeurMin, LIMITES.largeurMax), hauteur = entier(d.hauteur, LIMITES.hauteurMin, LIMITES.hauteurMax);
  const ips = LIMITES.ips.includes(d.ips) ? d.ips : null, debit = entier(d.debit, LIMITES.debitMin, LIMITES.debitMax);
  if (!largeur || !hauteur || !ips || !debit) return null;
  // ajuster : l'écran de la VM prend la taille du flux (sans bandes noires).
  return { largeur: largeur & ~1, hauteur: hauteur & ~1, ips, debit, ...(d.ajuster === true ? { ajuster: true } : {}) };
}

// Un message d'entrée du navigateur → paquet GameStream (ou null si invalide).
export function lireEntree(m, { largeur, hauteur }) {
  if (!m.length) return null;
  switch (m[0]) {
    case 0x10: {
      if (m.length !== 5 || m[1] > 1) return null;
      const vk = m.readUInt16LE(2);
      if (vk < 1 || vk > 0xfe || m[4] > 0x1f) return null;
      return { clavier: ENTREE.touche(vk, m[1] === 1, m[4]) };
    }
    case 0x11: {
      if (m.length !== 5) return null;
      const x = m.readUInt16BE(1), y = m.readUInt16BE(3);
      if (x >= largeur || y >= hauteur) return null;
      return { souris: ENTREE.position(x, y, largeur, hauteur) };
    }
    case 0x12:
      if (m.length !== 3 || m[1] > 1 || m[2] < 1 || m[2] > 5) return null;
      return { souris: ENTREE.bouton(m[2], m[1] === 1) };
    case 0x13: {
      if (m.length !== 5) return null;
      const dy = Math.max(-1200, Math.min(1200, m.readInt16BE(1))), dx = Math.max(-1200, Math.min(1200, m.readInt16BE(3)));
      const p = [];
      if (dy) p.push(ENTREE.molette(dy));
      if (dx) p.push(ENTREE.moletteH(dx));
      return p.length ? { souris: p } : null;
    }
    case 0x14:
      return m.length === 1 ? { imageCle: true } : null;
    default:
      return null;
  }
}

export function relayerFlux(navigateur, { ouvrirHote, appId, preparer = null, surFin = () => {}, vivante = () => true, journal = () => {} }) {
  let session = null, fini = false, debut = null, attenteCle = false;
  let fenetre = Date.now(), entrees = 0;
  const finir = message => {
    if (fini) return;
    fini = true;
    clearInterval(battement); clearInterval(garde);
    if (message) { try { navigateur.envoyerTexte(JSON.stringify({ fin: message })); } catch { /* fermé */ } }
    try { navigateur.close(); } catch { /* fermé */ }
    const s = session; session = null;
    if (s) s.arreter().catch(() => {});
    surFin(s?.stats?.() || null, message);
  };
  const battement = setInterval(() => { try { navigateur.envoyerTexte('{"b":1}'); navigateur.ping(); } catch { /* fermé */ } }, BATTEMENT_MS);
  const garde = setInterval(() => { if (!vivante()) finir('session fermée'); }, 60e3);
  battement.unref?.(); garde.unref?.();
  navigateur.on('fermeture', () => finir(null));
  navigateur.on('message', (m, texte) => {
    if (fini) return;
    if (texte) {
      if (debut) return;
      debut = lireDebut(m.toString('utf8'));
      if (!debut) return finir('demande d\'écran invalide');
      lancer();
      return;
    }
    if (!session) return;
    const t = Date.now();
    if (t - fenetre >= 1000) { fenetre = t; entrees = 0; }
    if (++entrees > ENTREES_PAR_SECONDE) return;               // rafale : l'excédent est perdu
    const e = lireEntree(m, debut);
    if (!e) return finir('message refusé');
    if (e.clavier) session.entreeClavier(e.clavier);
    else if (e.souris) for (const p of [].concat(e.souris)) session.entreeSouris(p);
    else if (e.imageCle) session.demanderImageComplete();
  });

  async function lancer() {
    try {
      // L'écran de la VM à la taille du flux, avant que Sunshine ne le capture.
      // Sans effet ou refusé, le flux s'ouvre quand même (bandes noires).
      let ecranVm = null;
      if (debut.ajuster && preparer) {
        try { ecranVm = await preparer(debut); } catch (e) { ecranVm = { erreur: String(e?.message || e).slice(0, 120) }; }
        if (fini) return;
      }
      const hote = await ouvrirHote();
      if (fini) return;
      const id = await appId(hote);
      session = new SessionFlux({ hote, appId: id, largeur: debut.largeur, hauteur: debut.hauteur, ips: debut.ips, debitKbps: debut.debit });
      session.on('fin', r => finir(r || 'session terminée'));
      session.on('image', i => {
        // Navigateur en retard : l'image est sautée, et les suivantes jusqu'à
        // une image clé, demandée aussitôt (sinon le décodeur partirait d'un trou).
        if (navigateur.socket.writableLength > RETARD_MAX) { attenteCle = true; session.demanderImageComplete(); return; }
        if (attenteCle && !i.cle) return;
        attenteCle = false;
        const tete = Buffer.alloc(6);
        tete[0] = 0x01; tete[1] = i.cle ? 1 : 0; tete.writeUInt32BE(i.numero >>> 0, 2);
        navigateur.envoyerBinaire(Buffer.concat([tete, i.donnees]));
      });
      const pret = await session.demarrer();
      if (fini) { session?.arreter().catch(() => {}); return; }
      if (ecranVm) pret.ecranVm = ecranVm;
      journal(pret);
      navigateur.envoyerTexte(JSON.stringify({ pret }));
    } catch (e) {
      finir(`écran fluide indisponible : ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  return { finir };
}
