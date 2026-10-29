// Écran d'une machine virtuelle : le VNC de QEMU, par vncproxy et
// vncwebsocket de Proxmox, relayé au navigateur.
//
// La poignée RFB (version, sécurité, réponse au défi avec le ticket de
// vncproxy) est faite ici : le ticket ne quitte jamais ProxLab. Le navigateur
// reprend le protocole à ClientInit. Dans son sens, seuls les messages d'un
// client RFB ordinaire passent, entiers et bornés — format des pixels,
// encodages, demandes d'image, touches, souris, presse-papiers, taille d'écran
// demandée, touche QEMU étendue ; tout autre octet ferme l'écran.
import { chemin } from './pve.js';
import { connecter } from './websocket.js';
import { reponseVnc } from './des.js';

const PRESSE_PAPIERS_MAX = 64 * 1024;
const ENCODAGES_MAX = 64;

// Lecture d'un flux d'octets découpé en messages WebSocket.
class Lecteur {
  constructor(conn) {
    this.morceaux = []; this.taille = 0; this.attente = null; this.fini = false;
    conn.on('message', d => { this.morceaux.push(Buffer.from(d)); this.taille += d.length; this.reveiller(); });
    conn.on('fermeture', () => { this.fini = true; this.reveiller(); });
  }
  reveiller() { const a = this.attente; if (a && (this.taille >= a.n || this.fini)) { this.attente = null; a.r(); } }
  async lire(n) {
    while (this.taille < n) {
      if (this.fini) throw new Error('Proxmox a fermé l\'écran pendant la poignée');
      await new Promise(r => { this.attente = { n, r }; });
    }
    const tout = Buffer.concat(this.morceaux);
    this.morceaux = tout.length > n ? [tout.subarray(n)] : [];
    this.taille = tout.length - n;
    return tout.subarray(0, n);
  }
  reste() { const r = Buffer.concat(this.morceaux); this.morceaux = []; this.taille = 0; return r; }
}

// Poignée RFB 3.8 côté client, authentification VNC par le ticket.
export async function poigneeRfb(conn, motDePasse, { delai = 15000 } = {}) {
  const lecteur = new Lecteur(conn);
  const minuterie = new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('poignée VNC trop longue')), delai); t.unref?.(); });
  const derouler = async () => {
    const version = (await lecteur.lire(12)).toString('latin1');
    if (!/^RFB 003\.00[378]\n$/.test(version)) throw new Error('serveur VNC inattendu');
    conn.envoyerBinaire(Buffer.from('RFB 003.008\n', 'latin1'));
    const n = (await lecteur.lire(1))[0];
    if (n === 0) {
      const l = (await lecteur.lire(4)).readUInt32BE(0);
      throw new Error(`VNC refuse : ${(await lecteur.lire(Math.min(l, 512))).toString('utf8')}`);
    }
    const types = [...await lecteur.lire(n)];
    if (types.includes(2)) {
      conn.envoyerBinaire(Buffer.from([2]));
      conn.envoyerBinaire(reponseVnc(motDePasse, await lecteur.lire(16)));
    } else if (types.includes(1)) {
      conn.envoyerBinaire(Buffer.from([1]));
    } else throw new Error(`aucune sécurité VNC prise en charge (${types.join(', ')})`);
    if ((await lecteur.lire(4)).readUInt32BE(0) !== 0) {
      let raison = '';
      try { const l = (await lecteur.lire(4)).readUInt32BE(0); raison = (await lecteur.lire(Math.min(l, 512))).toString('utf8'); } catch { /* sans raison */ }
      throw new Error(`authentification VNC refusée${raison ? ' : ' + raison : ''}`);
    }
    return lecteur.reste();
  };
  return Promise.race([derouler(), minuterie]);
}

export async function ouvrirVnc(proxmox, { noeud, vmid }) {
  const base = chemin('nodes', noeud, 'qemu', vmid);
  const vp = await proxmox.postSession(base + '/vncproxy', { websocket: 1 });
  const ticket = await proxmox.obtenirTicket();
  const l = proxmox.liaison();
  const amont = await connecter(l, `/api2/json${base}/vncwebsocket?port=${encodeURIComponent(vp.port)}&vncticket=${encodeURIComponent(vp.ticket)}`, {
    entetes: { Cookie: `PVEAuthCookie=${encodeURIComponent(ticket.ticket)}`, 'Sec-WebSocket-Protocol': 'binary', Origin: `https://${l.hote}:${l.port}` },
  });
  try {
    const deja = await poigneeRfb(amont, vp.ticket);
    return { amont, deja };
  } catch (e) { try { amont.close(); } catch { /* fermé */ } throw e; }
}

// La taille de l'écran d'une VM, demandée par VNC comme le fait l'onglet
// Écran (SetDesktopSize) : l'écran fluide la règle sur la taille du flux, pour
// que l'image remplisse l'écran sans bandes noires. QEMU transmet la demande à
// l'invité (VirtIO-GPU) et annonce la nouvelle taille quand l'invité l'a prise
// (ExtendedDesktopSize) ; un affichage qui ne sait pas changer de taille
// répond « disposition invalide ». Connexion partagée : un écran ouvert reste
// ouvert. Rend { avant, apres, fait } ou { avant, refus } ; jamais d'erreur
// pour un délai dépassé, la taille d'avant est alors rendue.
const ENC_TAILLE_ETENDUE = -308, ENC_TAILLE = -223;
export async function tailleEcranVm(ouvrir, l, h, { delai = 6000 } = {}) {
  if (!Number.isInteger(l) || !Number.isInteger(h) || l < 1 || h < 1 || l > 8192 || h > 8192) throw new Error('taille d\'écran invalide');
  const { amont, deja } = await ouvrir();
  const lecteur = new Lecteur(amont);
  if (deja?.length) { lecteur.morceaux.unshift(Buffer.from(deja)); lecteur.taille += deja.length; }
  let vue = null, minuteur = null;
  const lire = n => lecteur.lire(n);
  const derouler = async () => {
    amont.envoyerBinaire(Buffer.from([1]));
    const init = await lire(24);
    vue = [init.readUInt16BE(0), init.readUInt16BE(2)];
    const octetsPixel = Math.max(1, init[4] >> 3);
    await lire(Math.min(init.readUInt32BE(20), 1024));
    const avant = vue;
    if (avant[0] === l && avant[1] === h) return { avant, apres: avant, fait: true };
    const enc = Buffer.alloc(12); enc[0] = 2; enc.writeUInt16BE(2, 2); enc.writeInt32BE(ENC_TAILLE_ETENDUE, 4); enc.writeInt32BE(ENC_TAILLE, 8);
    const demande = Buffer.alloc(24); demande[0] = 251; demande.writeUInt16BE(l, 2); demande.writeUInt16BE(h, 4); demande[6] = 1;
    demande.writeUInt16BE(l, 16); demande.writeUInt16BE(h, 18);
    amont.envoyerBinaire(enc); amont.envoyerBinaire(demande);
    for (;;) {
      const type = (await lire(1))[0];
      if (type === 0) {
        const n = (await lire(3)).readUInt16BE(1);
        for (let i = 0; i < n; i++) {
          const r = await lire(12), x = r.readUInt16BE(0), y = r.readUInt16BE(2), rl = r.readUInt16BE(4), rh = r.readUInt16BE(6), e = r.readInt32BE(8);
          if (e === ENC_TAILLE_ETENDUE) {
            const ecrans = (await lire(4))[0];
            await lire(16 * ecrans);
            vue = [rl, rh];
            // x : raison (1 = réponse à notre demande), y : statut (1 à 3 = refus).
            if (x === 1 && y >= 1 && y <= 3) return { avant, refus: y === 3 ? 'affichage sans changement de taille (VirtIO-GPU requis)' : 'changement de taille refusé par QEMU' };
          } else if (e === ENC_TAILLE) vue = [rl, rh];
          else if (e === 0) await lire(rl * rh * octetsPixel);
          else throw new Error(`réponse VNC inattendue (encodage ${e})`);
          if (vue[0] === l && vue[1] === h) return { avant, apres: vue, fait: true };
        }
      } else if (type === 1) { const t = await lire(5); await lire(6 * t.readUInt16BE(3)); }
      else if (type === 2) { /* sonnerie */ }
      else if (type === 3) { const t = await lire(7); await lire(Math.min(Math.abs(t.readInt32BE(3)), PRESSE_PAPIERS_MAX * 2)); }
      else throw new Error(`message VNC inattendu (${type})`);
    }
  };
  const attente = new Promise(ok => { minuteur = setTimeout(() => ok(null), delai); minuteur.unref?.(); });
  try {
    const r = await Promise.race([derouler(), attente]);
    return r || { avant: vue, apres: vue, fait: false };
  } finally { clearTimeout(minuteur); try { amont.close(); } catch { /* fermé */ } }
}

// Filtre du sens navigateur → Proxmox : rend la longueur du premier message
// complet du tampon, 0 s'il en manque encore, -1 s'il n'est pas admis.
export function longueurMessageClient(b, debut) {
  if (debut) return b.length >= 1 ? 1 : 0;            // ClientInit : un octet (partage)
  if (!b.length) return 0;
  switch (b[0]) {
    case 0: return b.length >= 20 ? 20 : 0;             // SetPixelFormat
    case 2: {                                           // SetEncodings
      if (b.length < 4) return 0;
      const n = b.readUInt16BE(2);
      if (n > ENCODAGES_MAX) return -1;
      return b.length >= 4 + 4 * n ? 4 + 4 * n : 0;
    }
    case 3: return b.length >= 10 ? 10 : 0;             // FramebufferUpdateRequest
    case 4: return b.length >= 8 ? 8 : 0;               // KeyEvent
    case 5: return b.length >= 6 ? 6 : 0;               // PointerEvent
    case 6: {                                           // ClientCutText (étendu si longueur négative)
      if (b.length < 8) return 0;
      const n = Math.abs(b.readInt32BE(4));
      if (n > PRESSE_PAPIERS_MAX || (b.readInt32BE(4) < 0 && n < 4)) return -1;
      return b.length >= 8 + n ? 8 + n : 0;
    }
    case 251: {                                         // SetDesktopSize : taille de l'écran demandée à la VM
      if (b.length < 8) return 0;
      const n = b[6], l = b.readUInt16BE(2), h = b.readUInt16BE(4);
      if (n < 1 || n > 16 || l < 1 || h < 1 || l > 8192 || h > 8192) return -1;
      return b.length >= 8 + 16 * n ? 8 + 16 * n : 0;
    }
    case 255:                                           // QEMU : touche étendue seulement
      if (b.length < 2) return 0;
      if (b[1] !== 0) return -1;
      return b.length >= 12 ? 12 : 0;
    default: return -1;
  }
}

// Un écran qui ne change pas ne fait passer aucun octet : un tunnel ou un
// mandataire coupe alors la connexion au bout d'une minute ou deux, et l'image
// fige. Un battement toutes les 25 s la garde ouverte de bout en bout, et dit
// au navigateur que ProxLab est toujours là.
export const BATTEMENT_MS = 25e3;

export function relayerEcran(navigateur, ouvrir, { vivante = () => true, surFin = () => {}, battementMs = BATTEMENT_MS } = {}) {
  let amont = null, fini = false, tampon = Buffer.alloc(0), debut = true;
  const finir = message => {
    if (fini) return;
    fini = true;
    clearInterval(garde); clearInterval(battement);
    if (message) { try { navigateur.envoyerTexte(JSON.stringify({ fin: message })); } catch { /* fermé */ } }
    try { navigateur.close(); } catch { /* fermé */ }
    try { amont?.close(); } catch { /* fermé */ }
    surFin();
  };
  const garde = setInterval(() => { if (!vivante()) finir('session fermée'); }, 60e3);
  const battement = setInterval(() => {
    try { navigateur.envoyerTexte('{"b":1}'); navigateur.ping(); amont?.ping(); } catch { /* fermé : la fermeture le dira */ }
  }, battementMs);
  garde.unref?.(); battement.unref?.();
  const transmettre = () => {
    for (;;) {
      // Une touche ou un mouvement de souris envoyé avant ClientInit (un ancien
      // client, une souris qui bouge pendant l'ouverture) : lu entier et laissé
      // de côté, au lieu de passer pour ClientInit et de décaler tout le reste.
      if (debut && tampon.length && tampon[0] > 1) {
        const n = longueurMessageClient(tampon, false);
        if (n < 0) return finir('message refusé');
        if (n === 0) return;
        tampon = tampon.subarray(n);
        continue;
      }
      const n = longueurMessageClient(tampon, debut);
      if (n < 0) return finir('message refusé');
      if (n === 0) return;
      amont.envoyerBinaire(tampon.subarray(0, n));
      tampon = tampon.subarray(n);
      debut = false;
    }
  };
  const enAttente = [];
  navigateur.on('message', (donnees, texte) => {
    if (texte || fini) return;
    if (tampon.length + donnees.length > PRESSE_PAPIERS_MAX + 4096) return finir('message refusé');
    tampon = Buffer.concat([tampon, donnees]);
    if (amont) transmettre(); else enAttente.push(1);
  });
  navigateur.on('fermeture', () => finir(null));
  // Proxmox ferme parfois la toute première connexion pendant la poignée
  // (vncproxy encore en train de naître) : une seconde tentative, pas plus.
  const essayer = reste => ouvrir().catch(async e => {
    if (fini || reste <= 0 || !/pendant la poignée|trop longue|ECONNRESET|socket hang up|EPIPE/.test(String(e?.message || e))) throw e;
    await new Promise(r => setTimeout(r, 400));
    return essayer(reste - 1);
  });
  essayer(1).then(({ amont: conn, deja }) => {
    if (fini) { conn.close(); return; }
    amont = conn;
    conn.on('message', d => { try { navigateur.envoyerBinaire(d); } catch { finir(null); } });
    conn.on('fermeture', () => finir('écran fermé par Proxmox'));
    navigateur.envoyerTexte(JSON.stringify({ pret: true }));
    if (deja.length) navigateur.envoyerBinaire(deja);
    if (enAttente.length) transmettre();
  }, e => finir(`écran indisponible : ${String(e.message || e).slice(0, 160)}`));
}
