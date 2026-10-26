// Écran d'une machine virtuelle : un client RFB (VNC) minimal, dessiné dans un
// <canvas>. ProxLab a déjà fait la poignée avec Proxmox ; ce client reprend à
// ClientInit. Pixels en 32 bits (rouge, vert, bleu, rien), encodages Raw et
// CopyRect, changement de taille, et la touche étendue de QEMU.
//
// Clavier : le caractère tapé ici arrive tel quel dans l'invité, quelle que
// soit la disposition de chacun — un « a » d'un Mac AZERTY reste un « a » dans
// une VM QWERTY : il part sur la touche qui le donne dans la disposition de la
// VM (/socle/clavier.js). Les touches sans caractère (flèches, Entrée,
// fonctions) et les raccourcis partent par leur touche physique ; Maj, Ctrl et
// Alt ne partent qu'avec une telle touche, ou une lettre de raccourci.
// Sans disposition connue, chaque touche part par son code physique.
//
// Presse-papiers dans les deux sens : le protocole étendu de VNC (celui de
// QEMU avec « clipboard=vnc », relayé dans l'invité par spice-vdagent), en
// UTF-8 et compressé en zlib ; sans agent, le texte collé est tapé par
// ProxLab lui-même (POST /api/machines/…/frappe).
import { XT, KEYSYMS, codeQemu, DISPOSITIONS, intapables, appuis, evenementsCaractere } from './socle/clavier.js';

export { DISPOSITIONS, intapables, codeQemu };

export function keysym(e) {
  if (KEYSYMS[e.code] && (e.key.length !== 1 || /^(Shift|Control|Alt|Meta)/.test(e.code))) return KEYSYMS[e.code];
  if (KEYSYMS[e.key]) return KEYSYMS[e.key];
  const cps = [...e.key];
  if (cps.length === 1) { const cp = cps[0].codePointAt(0); return cp < 0x100 ? cp : 0x01000000 | cp; }
  return 0;
}

const PRESSE_EXT = 0xC0A1E5CE | 0;       // pseudo-encodage du presse-papiers étendu
// Tight d'abord : l'image arrive compressée (zlib, et JPEG pour les zones
// photographiques), dix à cent fois moins lourde que Raw — c'est ce qui
// rendait l'écran lent, peint par morceaux. Puis CopyRect, Raw, DesktopSize,
// ExtendedDesktopSize, touche étendue QEMU, voyants du clavier (Verr. Maj),
// presse-papiers, qualité JPEG 6 (-32 + 6) et compression 2 (-256 + 2).
const ENCODAGES = [7, 1, 0, -223, -308, -258, -261, PRESSE_EXT, -254];
// Qualité JPEG demandée à QEMU (niveaux -32 à -23) : sans elle, Tight reste sans
// perte. Sans perte (nette) : ce que demande ProxLab — le texte posé sur une
// image (fond d'écran, navigateur) reste net ; sinon le niveau 8.
export const encodages = nette => (nette ? ENCODAGES : [...ENCODAGES, -24]);

// Un flux zlib de Tight, décompressé ici même (RFC 1950/1951), sans dépendre
// du DecompressionStream du navigateur, dont la sortie en flux continu n'est
// pas la même partout (Safari pouvait la retenir : l'écran restait figé). Le
// serveur garde le flux d'un rectangle à l'autre et le vide à chaque
// rectangle (Z_SYNC_FLUSH) : chaque morceau finit sur une frontière de bloc ;
// les 32 derniers Kio sortis restent pour les renvois du morceau suivant.
const LONG_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LONG_SUP = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_SUP = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDRE_LONGUEURS = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function huffman(longueurs) {
  const nb = new Uint16Array(16), debut = new Uint16Array(16), sym = new Uint16Array(longueurs.length);
  for (const l of longueurs) nb[l]++;
  nb[0] = 0;
  for (let i = 1, o = 0; i < 16; i++) { debut[i] = o; o += nb[i]; }
  for (let s = 0; s < longueurs.length; s++) if (longueurs[s]) sym[debut[longueurs[s]]++] = s;
  return { nb, sym };
}
const FIXE_LIT = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXE_DIST = huffman(new Array(30).fill(5));
const HIST = 32768;

export class Inflate {
  constructor() { this.entete = false; this.fini = false; this.hist = new Uint8Array(0); }
  bit() {
    if (!this.nbits) { if (this.p >= this.e.length) throw new Error('zlib : données tronquées'); this.octet = this.e[this.p++]; this.nbits = 8; }
    const b = this.octet & 1; this.octet >>= 1; this.nbits--; return b;
  }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v |= this.bit() << i; return v; }
  symbole(h) {
    let code = 0, premier = 0, index = 0;
    for (let l = 1; l < 16; l++) {
      code |= this.bit();
      const n = h.nb[l];
      if (code - n < premier) return h.sym[index + (code - premier)];
      index += n; premier = (premier + n) << 1; code <<= 1;
    }
    throw new Error('zlib : code invalide');
  }
  // Décompresse un morceau : exactement n octets attendus, ni plus ni moins.
  lire(entree, n) {
    if (this.fini) throw new Error('zlib : flux déjà terminé');
    this.e = entree; this.p = 0; this.nbits = 0;
    if (!this.entete) {
      if (entree.length < 2 || (entree[0] & 15) !== 8 || ((entree[0] << 8) | entree[1]) % 31 || entree[1] & 32) throw new Error('zlib : en-tête invalide');
      this.p = 2; this.entete = true;
    }
    const h = this.hist, fin = h.length + n, out = new Uint8Array(fin);
    out.set(h);
    let o = h.length;
    const mettre = v => { if (o >= fin) throw new Error('zlib : plus de données qu’annoncé'); out[o++] = v; };
    while (this.p < this.e.length && !this.fini) {
      this.fini = !!this.bit();
      const genre = this.bits(2);
      if (genre === 0) {
        this.nbits = 0;
        if (this.p + 4 > this.e.length) throw new Error('zlib : données tronquées');
        const lg = this.e[this.p] | (this.e[this.p + 1] << 8), inv = this.e[this.p + 2] | (this.e[this.p + 3] << 8);
        if ((lg ^ 0xffff) !== inv) throw new Error('zlib : bloc brut invalide');
        this.p += 4;
        if (this.p + lg > this.e.length) throw new Error('zlib : données tronquées');
        if (o + lg > fin) throw new Error('zlib : plus de données qu’annoncé');
        out.set(this.e.subarray(this.p, this.p + lg), o); o += lg; this.p += lg;
        continue;
      }
      if (genre === 3) throw new Error('zlib : bloc invalide');
      let lit = FIXE_LIT, dist = FIXE_DIST;
      if (genre === 2) {
        const nlit = this.bits(5) + 257, ndist = this.bits(5) + 1, ncode = this.bits(4) + 4;
        if (nlit > 286 || ndist > 30) throw new Error('zlib : bloc invalide');
        const lc = new Array(19).fill(0);
        for (let i = 0; i < ncode; i++) lc[ORDRE_LONGUEURS[i]] = this.bits(3);
        const hc = huffman(lc), ls = [];
        while (ls.length < nlit + ndist) {
          const s = this.symbole(hc);
          if (s < 16) ls.push(s);
          else if (s === 16) { if (!ls.length) throw new Error('zlib : répétition sans valeur'); const v = ls[ls.length - 1]; for (let k = 3 + this.bits(2); k--;) ls.push(v); }
          else for (let k = s === 17 ? 3 + this.bits(3) : 11 + this.bits(7); k--;) ls.push(0);
        }
        if (ls.length > nlit + ndist) throw new Error('zlib : longueurs en trop');
        lit = huffman(ls.slice(0, nlit)); dist = huffman(ls.slice(nlit));
      }
      for (;;) {
        const s = this.symbole(lit);
        if (s < 256) { mettre(s); continue; }
        if (s === 256) break;
        if (s > 285) throw new Error('zlib : longueur invalide');
        const lg = LONG_BASE[s - 257] + this.bits(LONG_SUP[s - 257]);
        const ds = this.symbole(dist);
        if (ds > 29) throw new Error('zlib : distance invalide');
        const d = DIST_BASE[ds] + this.bits(DIST_SUP[ds]);
        if (d > o) throw new Error('zlib : distance hors de l’historique');
        if (o + lg > fin) throw new Error('zlib : plus de données qu’annoncé');
        for (let k = 0; k < lg; k++, o++) out[o] = out[o - d];
      }
    }
    if (o !== fin) throw new Error('zlib : moins de données qu’annoncé');
    this.hist = out.slice(Math.max(0, o - HIST), o);
    return out.subarray(h.length, o);
  }
}
const PP = { TEXTE: 1, CAPS: 1 << 24, REQUEST: 1 << 25, PEEK: 1 << 26, NOTIFY: 1 << 27, PROVIDE: 1 << 28 };
const PRESSE_MAX = 64 * 1024 - 64;      // ProxLab refuse au-delà de 64 Kio
export const PLAFOND = Object.freeze({ l: 3840, h: 2400, pixels: 3840 * 2160 });

async function deflate(octets) {
  const flux = new Blob([octets]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(flux).arrayBuffer());
}
// Le texte vient de la VM : décompressé morceau par morceau, et abandonné au-delà
// de max octets (une bombe de décompression ne remplit pas la mémoire de l'onglet).
async function inflate(octets, max) {
  const lecteur = new Blob([octets]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const morceaux = []; let total = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    total += value.length;
    if (total > max) { lecteur.cancel().catch(() => {}); throw new Error('presse-papiers démesuré'); }
    morceaux.push(value);
  }
  const sortie = new Uint8Array(total); let k = 0;
  for (const m of morceaux) { sortie.set(m, k); k += m.length; }
  return sortie;
}

export const estMac = () => /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '');

export class Ecran {
  // disposition() : la disposition du clavier de l'invité (« fr », « us »), ou
  // null pour tout envoyer par touche physique. surIntapable(ch) : un caractère
  // tapé ici que cette disposition ne sait pas donner.
  constructor(hote, ws, { surEtat = () => {}, surPresse = () => {}, surColler = null, remplir = false, garderImage = false, nette = false, disposition = () => null, surIntapable = () => {} } = {}) {
    this.nette = !!nette;
    this.disposition = disposition; this.surIntapable = surIntapable;
    // Maj, Ctrl, Alt tenus ici et pas encore envoyés (mode caractère), et ceux envoyés.
    this.modsTenus = new Map(); this.modsEnvoyes = new Set(); this.modUtilise = false;
    this.ws = ws; this.surEtat = surEtat; this.surPresse = surPresse; this.surColler = surColler; this.remplir = remplir;
    this.actif = false; this.capsPresse = 0; this.aFournir = null; this.dernierPresse = ''; this.copie = null;
    this.mac = estMac(); this.metaSeul = null;
    this.morceaux = []; this.dispo = 0;
    this.etat = 'init'; this.rects = 0; this.rect = null; this.flux = [null, null, null, null]; this.occupe = false;
    this.derniereImage = Date.now();   // la fin de la dernière mise à jour reçue
    this.qemu = false; this.enfoncees = new Map(); this.boutons = 0;
    // Taille de l'écran demandée à la VM (ExtendedDesktopSize) : connue quand
    // QEMU l'annonce ; this.ecranId est l'écran qu'il décrit.
    this.etendu = false; this.ecranId = 0; this.demandee = null;
    this.toile = document.createElement('canvas');
    this.toile.className = 'ecran';
    this.toile.tabIndex = 0;
    this.toile.width = 640; this.toile.height = 400;
    this.toile.setAttribute('role', 'img');
    this.toile.setAttribute('aria-label', 'Écran de la machine : cliquer pour lui donner le clavier');
    // Chaque mise à jour est dessinée hors écran, puis montrée d'un coup : on
    // ne voit plus une image à moitié reçue ni des bandes d'âges différents.
    this.vue = this.toile.getContext('2d', { alpha: false });
    this.hors = document.createElement('canvas');
    this.hors.width = 640; this.hors.height = 400;
    this.ctx = this.hors.getContext('2d', { alpha: false });
    this.zone = null;
    // ⌘V / Ctrl+V : le collage du navigateur est dirigé dans ce champ caché,
    // le temps d'une touche : le texte arrive sans demande d'autorisation.
    this.piege = document.createElement('textarea');
    this.piege.className = 'ecran-piege';
    this.piege.tabIndex = -1;
    this.piege.setAttribute('aria-hidden', 'true');
    // garderImage : l'image d'avant reste affichée jusqu'à la première de
    // cette connexion (une reconnexion ne passe pas par un écran noir).
    if (garderImage) {
      for (const x of hote.querySelectorAll('[data-attente]')) x.remove();   // essais d'avant restés sans image
      this.toile.hidden = true; this.toile.dataset.attente = '1'; this.piege.dataset.attente = '1';
      this.attente = hote;
      hote.append(this.toile, this.piege);
    } else hote.replaceChildren(this.toile, this.piege);
    this.brancher();
  }

  envoyer(octets) { if (this.ws.readyState === 1) this.ws.send(octets); }
  demarrer() { this.envoyer(new Uint8Array([1])); }      // ClientInit : partagé
  demander(incremental = true) {
    const b = new DataView(new ArrayBuffer(10));
    b.setUint8(0, 3); b.setUint8(1, incremental ? 1 : 0); b.setUint16(6, this.toile.width); b.setUint16(8, this.toile.height);
    this.envoyer(b.buffer);
  }

  recevoir(donnees) {
    const u = new Uint8Array(donnees);
    if (!u.length) return;
    this.morceaux.push(u); this.dispo += u.length;
    this.pomper();
  }
  // Un pas peut attendre (zlib, JPEG) : les suivants attendent avec lui, l'ordre reste.
  pomper() {
    if (this.occupe) return;
    try {
      for (;;) {
        const r = this.pas();
        if (!r) return;
        if (typeof r.then === 'function') {
          this.occupe = true;
          r.then(() => { this.occupe = false; this.pomper(); }, e => { this.occupe = false; this.echec(e); });
          return;
        }
      }
    } catch (e) { this.echec(e); }
  }
  echec(e) { this.surEtat(`erreur : ${e.message}`); this.ws.close(); }
  // n octets, consommés ; null s'il en manque.
  prendre(n) {
    if (this.dispo < n) return null;
    const sortie = new Uint8Array(n);
    let k = 0;
    while (k < n) {
      const m = this.morceaux[0], t = Math.min(m.length, n - k);
      sortie.set(m.subarray(0, t), k); k += t;
      if (t === m.length) this.morceaux.shift(); else this.morceaux[0] = m.subarray(t);
    }
    this.dispo -= n;
    return sortie;
  }
  regarder(n) { if (this.dispo < n) return null; const s = this.prendre(n); this.morceaux.unshift(s); this.dispo += n; return s; }

  pas() {
    if (this.etat === 'init') {
      const t = this.regarder(24); if (!t) return false;
      const lg = new DataView(t.buffer).getUint32(20);
      if (lg > 4096) throw new Error('nom démesuré');
      const tout = this.prendre(24 + lg); if (!tout) return false;
      const v = new DataView(tout.buffer);
      this.taille(v.getUint16(0), v.getUint16(2));
      this.nom = new TextDecoder().decode(tout.subarray(24));
      // Format : 32 bits, profondeur 24, petit-boutiste, couleurs vraies, R<<0, G<<8, B<<16.
      const pf = new Uint8Array(20);
      pf.set([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16]);
      this.envoyer(pf);
      this.envoyerEncodages();
      this.demander(false);
      this.etat = 'message';
      this.actif = true;     // clavier et souris seulement maintenant : avant, ils casseraient la poignée
      this.surEtat('pret');
      return true;
    }
    if (this.etat === 'message') {
      const t = this.regarder(1); if (!t) return false;
      if (t[0] === 0) { const h = this.prendre(4); if (!h) return false; this.rects = new DataView(h.buffer).getUint16(2); this.etat = 'rect'; if (!this.rects) this.finImage(); return true; }
      if (t[0] === 1) { const h = this.regarder(6); if (!h) return false; const n = new DataView(h.buffer).getUint16(4); return !!this.prendre(6 + 6 * n); }
      if (t[0] === 2) { this.prendre(1); return true; }
      if (t[0] === 3) {
        const h = this.regarder(8); if (!h) return false;
        const lg = new DataView(h.buffer).getInt32(4), n = Math.abs(lg);
        if (n > 1 << 20) throw new Error('presse-papiers démesuré');
        const m = this.prendre(8 + n); if (!m) return false;
        if (lg >= 0) this.presseRecu(new TextDecoder('latin1').decode(m.subarray(8)));
        else if (n >= 4) this.presseEtendu(m.subarray(8));
        return true;
      }
      throw new Error(`message VNC inconnu (${t[0]})`);
    }
    if (this.etat === 'rect') {
      if (!this.rect) {
        const h = this.prendre(12); if (!h) return false;
        const v = new DataView(h.buffer);
        this.rect = { x: v.getUint16(0), y: v.getUint16(2), l: v.getUint16(4), h: v.getUint16(6), enc: v.getInt32(8) };
        if ([0, 1, 7].includes(this.rect.enc)) this.marquer(this.rect);
      }
      const r = this.rect;
      if (r.enc === 0) {
        const px = this.prendre(r.l * r.h * 4); if (!px) return false;
        if (r.l && r.h) {
          for (let i = 3; i < px.length; i += 4) px[i] = 255;
          this.ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), r.l, r.h), r.x, r.y);
        }
      } else if (r.enc === 1) {
        const s = this.prendre(4); if (!s) return false;
        const v = new DataView(s.buffer);
        if (r.l && r.h) this.ctx.drawImage(this.hors, v.getUint16(0), v.getUint16(2), r.l, r.h, r.x, r.y, r.l, r.h);
      } else if (r.enc === 7) {
        const fait = this.tight(r);
        if (fait === false) return false;
        if (fait !== true) return fait.then(() => this.finRect());
      } else if (r.enc === -223) this.taille(r.l, r.h);
      else if (r.enc === -308) {
        // x : la raison (0 la VM, 1 notre demande, 2 un autre client) ; y : le
        // statut de notre demande (0 accepté, 4 transmis à la VM par QEMU).
        const e = this.regarder(4); if (!e) return false;
        if (e[0] > 16) throw new Error('écrans démesurés');
        const tout = this.prendre(4 + 16 * e[0]); if (!tout) return false;
        const premier = !this.etendu;
        this.etendu = true;
        if (e[0]) this.ecranId = new DataView(tout.buffer).getUint32(4);
        if (r.x === 1 && r.y !== 0 && r.y !== 4) { this.surEtat('ajustement-refuse', r.y); this.demandee = null; }
        else this.taille(r.l, r.h);
        // La VM a répondu (ou changé de taille) : la demande suivante peut partir.
        if (r.x !== 2 && this.enAttente) setTimeout(() => this.liberer(), 0);
        if (premier) this.surEtat('ajustable');
      }
      else if (r.enc === -258) this.qemu = true;
      else if (r.enc === -261) {
        // Voyants de l'invité : bit 0 Arrêt défil., bit 1 Verr. num., bit 2 Verr. Maj.
        const s = this.prendre(1); if (!s) return false;
        this.verrous = { caps: !!(s[0] & 4) };
        this.surEtat('verrous', { ...this.verrous });
      }
      else throw new Error(`encodage ${r.enc} non demandé`);
      return this.finRect();
    }
    return false;
  }
  finRect() { this.rect = null; if (--this.rects <= 0) this.finImage(); return true; }

  // ── Tight ── Un octet de contrôle : ses 4 bits bas remettent à zéro les flux
  // zlib nommés ; le haut dit le genre — remplissage (8), JPEG (9), ou base
  // (flux 0 à 3, filtre copie, palette ou gradient). Les octets d'un rectangle
  // sont tous là avant d'en consommer un seul. Rend true, false (il en manque)
  // ou une promesse (décodage JPEG).
  tight(r) {
    const vu = n => (this.dispo >= n ? this.regarder(n) : null);
    let t = vu(1); if (!t) return false;
    const ctl = t[0], genre = ctl >> 4;
    const longueur = (b, i) => {           // longueur compacte : 1 à 3 octets
      if (b.length <= i) return null;
      let n = b[i] & 0x7f; if (!(b[i] & 0x80)) return [n, 1];
      if (b.length <= i + 1) return null;
      n |= (b[i + 1] & 0x7f) << 7; if (!(b[i + 1] & 0x80)) return [n, 2];
      if (b.length <= i + 2) return null;
      return [n | (b[i + 2] << 14), 3];
    };
    const remettre = () => { for (let i = 0; i < 4; i++) if (ctl & (1 << i)) this.flux[i] = null; };
    if (genre === 8) {
      const b = this.prendre(4); if (!b) return false;
      remettre();
      this.ctx.fillStyle = `rgb(${b[1]},${b[2]},${b[3]})`; this.ctx.fillRect(r.x, r.y, r.l, r.h);
      return true;
    }
    if (genre === 9) {
      t = vu(Math.min(4, this.dispo)); const lg = longueur(t, 1); if (!lg) return false;
      const total = 1 + lg[1] + lg[0];
      if (this.dispo < total) return false;
      const b = this.prendre(total); remettre();
      // Un décodage qui ne rend jamais la main figerait l'écran : au bout de dix
      // secondes, c'est une erreur, la connexion se ferme et se rouvre.
      let chien;
      const delai = new Promise((_, ko) => { chien = setTimeout(() => ko(new Error('image JPEG non décodée')), 10000); });
      return Promise.race([createImageBitmap(new Blob([b.subarray(1 + lg[1])], { type: 'image/jpeg' })), delai])
        .then(img => { clearTimeout(chien); this.ctx.drawImage(img, r.x, r.y); img.close?.(); }, e => { clearTimeout(chien); throw e; });
    }
    if (genre > 9) throw new Error(`Tight : genre ${genre} inconnu`);
    let i = 1, filtre = 0, couleurs = 0;
    if (ctl & 0x40) { t = vu(2); if (!t) return false; filtre = t[1]; i = 2; }
    if (filtre === 1) { t = vu(3); if (!t) return false; couleurs = t[2] + 1; i = 3 + 3 * couleurs; }
    else if (filtre > 2) throw new Error(`Tight : filtre ${filtre} inconnu`);
    const brut = filtre === 1 ? (couleurs === 2 ? ((r.l + 7) >> 3) * r.h : r.l * r.h) : r.l * r.h * 3;
    let total = i + brut, lg = null;
    if (brut >= 12) {
      t = vu(Math.min(i + 3, this.dispo)); if (!t || t.length < i + 1) return false;
      lg = longueur(t, i); if (!lg) return false;
      total = i + lg[1] + lg[0];
    }
    if (this.dispo < total) return false;
    const b = this.prendre(total); remettre();
    const palette = filtre === 1 ? b.subarray(3, 3 + 3 * couleurs) : null;
    const peindre = d => this.peindreTight(r, d, filtre, palette, couleurs);
    if (!lg) { peindre(b.subarray(i)); return true; }
    const n = (ctl >> 4) & 3;
    this.flux[n] ||= new Inflate();
    peindre(this.flux[n].lire(b.subarray(i + lg[1]), brut));
    return true;
  }
  peindreTight(r, d, filtre, palette, couleurs) {
    if (!r.l || !r.h) return;
    const img = new ImageData(r.l, r.h), px = img.data;
    if (filtre === 1) {
      const ligne = (r.l + 7) >> 3;
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.l; x++) {
        const c = couleurs === 2 ? (d[y * ligne + (x >> 3)] >> (7 - (x & 7))) & 1 : d[y * r.l + x];
        const o = (y * r.l + x) * 4;
        px[o] = palette[c * 3]; px[o + 1] = palette[c * 3 + 1]; px[o + 2] = palette[c * 3 + 2]; px[o + 3] = 255;
      }
    } else if (filtre === 2) {
      // Gradient : chaque composante prédite par gauche + haut - haut-gauche.
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.l; x++) for (let c = 0; c < 3; c++) {
        const o = (y * r.l + x) * 4 + c;
        const g = x ? px[o - 4] : 0, h = y ? px[o - r.l * 4] : 0, gh = x && y ? px[o - r.l * 4 - 4] : 0;
        px[o] = (Math.max(0, Math.min(255, g + h - gh)) + d[(y * r.l + x) * 3 + c]) & 255;
        if (c === 2) px[o + 1] = 255;
      }
    } else {
      for (let k = 0, o = 0; k < r.l * r.h * 3; k += 3, o += 4) { px[o] = d[k]; px[o + 1] = d[k + 1]; px[o + 2] = d[k + 2]; px[o + 3] = 255; }
    }
    this.ctx.putImageData(img, r.x, r.y);
  }
  finImage() {
    const z = this.zone;
    if (z) { const l = z[2] - z[0], h = z[3] - z[1]; if (l > 0 && h > 0) this.vue.drawImage(this.hors, z[0], z[1], l, h, z[0], z[1], l, h); this.zone = null; }
    this.derniereImage = Date.now(); this.vu = true;
    if (this.attente) {
      const h = this.attente, avait = h.contains(document.activeElement);
      this.attente = null;
      for (const x of [...h.querySelectorAll('canvas.ecran, .ecran-piege, p.vide')]) if (x !== this.toile && x !== this.piege) x.remove();
      this.toile.hidden = false; delete this.toile.dataset.attente; delete this.piege.dataset.attente;
      if (avait) this.toile.focus({ preventScroll: true });
    }
    this.etat = 'message'; this.demander(true);
  }
  // L'image gardée hors écran, remise d'un coup sur la toile : Safari peut vider
  // une toile restée cachée (autre bureau, onglet en arrière-plan) — au retour,
  // elle revient aussitôt, sans attendre le réseau.
  repeindre() { if (this.vu) this.vue.drawImage(this.hors, 0, 0); }
  // La part de l'image qu'une mise à jour a touchée, à montrer à sa fin.
  marquer(r) {
    const x1 = Math.min(r.x + r.l, this.hors.width), y1 = Math.min(r.y + r.h, this.hors.height);
    this.zone = this.zone ? [Math.min(this.zone[0], r.x), Math.min(this.zone[1], r.y), Math.max(this.zone[2], x1), Math.max(this.zone[3], y1)] : [r.x, r.y, x1, y1];
  }
  envoyerEncodages() {
    const liste = encodages(this.nette);
    const enc = new DataView(new ArrayBuffer(4 + 4 * liste.length));
    enc.setUint8(0, 2); enc.setUint16(2, liste.length);
    liste.forEach((e, i) => enc.setInt32(4 + 4 * i, e));
    this.envoyer(enc.buffer);
  }
  // Nouvelle taille : l'image d'avant, mise à l'échelle, reste affichée
  // jusqu'à la nouvelle — un changement de taille ne passe plus par du noir.
  taille(l, h) {
    if (l < 1 || h < 1 || l > 8192 || h > 8192) throw new Error('taille d\'écran invalide');
    let ancienne = null;
    if (this.vu && this.hors.width > 1) {
      ancienne = document.createElement('canvas'); ancienne.width = this.hors.width; ancienne.height = this.hors.height;
      ancienne.getContext('2d').drawImage(this.hors, 0, 0);
    }
    this.toile.width = l; this.toile.height = h; this.hors.width = l; this.hors.height = h;
    this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, l, h);
    this.vue.fillStyle = '#000'; this.vue.fillRect(0, 0, l, h);
    if (ancienne) { this.ctx.drawImage(ancienne, 0, 0, l, h); this.vue.drawImage(ancienne, 0, 0, l, h); }
    this.zone = null;
    this.surEtat('taille', `${l} × ${h}`);
  }

  // Demande à la VM un écran de l x h (SetDesktopSize). Faux si QEMU ne l'a
  // pas annoncé ; la VM répond par un changement de taille, ou le refuse
  // (affichage sans redimensionnement : il faut VirtIO-GPU).
  // Plafonnée à la 4K (proportions gardées) : au-delà, un invité peut refuser
  // le mode et éteindre sa sortie (« Display output is not active »). Une seule
  // demande à la fois : la suivante attend la réponse de la VM (trois secondes
  // au plus), pour ne pas lui en envoyer une rafale pendant un redimensionnement.
  ajuster(l, h, { libre = false } = {}) {
    if (!this.actif || !this.etendu) return false;
    if (!libre) {
      const k = Math.min(1, PLAFOND.l / l, PLAFOND.h / h, Math.sqrt(PLAFOND.pixels / (l * h)));
      l *= k; h *= k;
    }
    l = Math.max(320, Math.min(8192, Math.floor(l / 2) * 2)); h = Math.max(200, Math.min(8192, Math.floor(h / 2) * 2));
    if ((l === this.toile.width && h === this.toile.height) || (this.demandee && this.demandee[0] === l && this.demandee[1] === h)) return true;
    if (this.enAttente && Date.now() - this.enAttente < 3000) {
      this.prochaine = [l, h];
      clearTimeout(this.relance);
      this.relance = setTimeout(() => this.liberer(), 3000 - (Date.now() - this.enAttente));
      return true;
    }
    this.enAttente = Date.now(); this.prochaine = null;
    this.demandee = [l, h];
    const b = new DataView(new ArrayBuffer(24));
    b.setUint8(0, 251); b.setUint16(2, l); b.setUint16(4, h); b.setUint8(6, 1);
    b.setUint32(8, this.ecranId); b.setUint16(16, l); b.setUint16(18, h);
    this.envoyer(b.buffer);
    return true;
  }

  // Réponse de la VM, ou trois secondes sans elle : la demande en file part.
  liberer() {
    clearTimeout(this.relance);
    this.enAttente = 0;
    if (!this.prochaine) return;
    const [l, h] = this.prochaine; this.prochaine = null;
    this.ajuster(l, h, { libre: true });
  }

  // Un écran éteint par l'invité (veille) : un mouvement de souris et Maj.
  reveiller() {
    if (!this.actif) return;
    this.pointeur(Math.min(10, this.toile.width - 1), Math.min(10, this.toile.height - 1), 0);
    this.touche({ code: 'ShiftLeft', key: 'Shift' }, true);
    this.touche({ code: 'ShiftLeft', key: 'Shift' }, false);
    this.demander(false);
  }

  // ── Presse-papiers ──
  coupe(flags, donnees = new Uint8Array(0)) {
    const b = new Uint8Array(12 + donnees.length), v = new DataView(b.buffer);
    v.setUint8(0, 6); v.setInt32(4, -(4 + donnees.length)); v.setUint32(8, flags >>> 0); b.set(donnees, 12);
    this.envoyer(b);
  }
  presseEtendu(p) {
    const flags = new DataView(p.buffer, p.byteOffset).getUint32(0);
    if (flags & PP.CAPS) {
      this.capsPresse = flags;
      const max = new Uint8Array(4); new DataView(max.buffer).setUint32(0, PRESSE_MAX);
      this.coupe(PP.CAPS | PP.REQUEST | PP.NOTIFY | PP.PROVIDE | PP.TEXTE, max);
      return;
    }
    if (flags & PP.REQUEST && flags & PP.TEXTE) { this.fournir(); return; }
    if (flags & PP.PEEK) { this.coupe(PP.NOTIFY | (this.aFournir !== null ? PP.TEXTE : 0)); return; }
    if (flags & PP.NOTIFY) { if (flags & PP.TEXTE) this.coupe(PP.REQUEST | PP.TEXTE); return; }
    if (flags & PP.PROVIDE && flags & PP.TEXTE) {
      inflate(p.subarray(4), PRESSE_MAX + 8).then(z => {
        const n = new DataView(z.buffer).getUint32(0);
        this.presseRecu(new TextDecoder().decode(z.subarray(4, 4 + Math.min(n, z.length - 4))).replace(/\0+$/, '').replace(/\r\n/g, '\n'));
      }).catch(() => this.surEtat('presse-papiers de la VM ignoré : illisible ou plus de 64 Kio'));
    }
  }
  presseRecu(texte) {
    this.dernierPresse = texte;
    if (this.copie) { this.copie.resoudre(texte); this.copie = null; }
    this.surPresse(texte);
  }
  async fournir() {
    if (this.aFournir === null) return;
    const t = new TextEncoder().encode(this.aFournir.replace(/\r?\n/g, '\r\n') + '\0');
    const brut = new Uint8Array(4 + t.length); new DataView(brut.buffer).setUint32(0, t.length); brut.set(t, 4);
    this.coupe(PP.PROVIDE | PP.TEXTE, await deflate(brut));
  }
  // Le texte devient le presse-papiers de l'invité (il le colle avec Ctrl+V).
  envoyerPresse(texte) {
    texte = String(texte).slice(0, 60000);
    if (!this.actif) return false;
    if (this.capsPresse) { this.aFournir = texte; this.coupe(PP.NOTIFY | PP.TEXTE); return true; }
    const octets = Uint8Array.from([...texte].map(ch => { const c = ch.codePointAt(0); return c < 256 ? c : 63; }));
    const b = new Uint8Array(8 + octets.length); b[0] = 6; new DataView(b.buffer).setUint32(4, octets.length); b.set(octets, 8);
    this.envoyer(b);
    return true;
  }
  // Ce que l'invité copiera dans les deux secondes ira dans le presse-papiers
  // d'ici : l'écriture est demandée pendant le geste (Safari l'exige) et
  // tenue par une promesse que le texte de l'invité résout.
  armerCopie() {
    if (!navigator.clipboard) return;
    let resoudre, rejeter;
    const promesse = new Promise((ok, ko) => { resoudre = ok; rejeter = ko; });
    const minuterie = setTimeout(() => { if (this.copie?.promesse === promesse) this.copie = null; rejeter(new Error('rien copié')); }, 2500);
    this.copie = { promesse, resoudre: t => { clearTimeout(minuterie); resoudre(t); } };
    if (window.ClipboardItem && navigator.clipboard.write) {
      navigator.clipboard.write([new ClipboardItem({ 'text/plain': promesse.then(t => new Blob([t], { type: 'text/plain' })) })]).catch(() => {});
    } else promesse.then(t => navigator.clipboard.writeText(t)).catch(() => {});
  }
  pieger(maj) {
    this.piege.value = '';
    // Sans collage natif (navigateur qui ne le fait pas) : la lecture du presse-papiers, par l'appelant.
    this.collage = { maj, minuterie: setTimeout(() => { if (!this.collage) return; this.collage = null; this.toile.focus({ preventScroll: true }); this.surColler({ maj, texte: null }); }, 500) };
    this.piege.focus({ preventScroll: true });
  }
  // Une combinaison Ctrl(+Maj)+lettre envoyée à l'invité.
  // Ctrl et Maj déjà tenus (doigt sur la touche) ne sont ni renvoyés ni lâchés :
  // l'invité les garde enfoncés pour la touche suivante.
  combinaison(lettre, maj = false, code = `Key${lettre.toUpperCase()}`) {
    const tenue = (...c) => c.some(x => this.enfoncees.has(x));
    const ctrl = !tenue('ControlLeft', 'ControlRight'), shift = maj && !tenue('ShiftLeft', 'ShiftRight');
    if (ctrl) this.touche({ code: 'ControlLeft', key: 'Control' }, true);
    if (shift) this.touche({ code: 'ShiftLeft', key: 'Shift' }, true);
    const k = [...lettre].length === 1 ? (maj ? lettre.toUpperCase() : lettre) : lettre;
    this.touche({ code, key: k }, true); this.touche({ code, key: k }, false);
    if (shift) this.touche({ code: 'ShiftLeft', key: 'Shift' }, false);
    if (ctrl) this.touche({ code: 'ControlLeft', key: 'Control' }, false);
  }

  // Un événement tout fait (/socle/clavier.js) : code QEMU et keysym.
  evenement({ xt, keysym: ks, bas }) {
    if (!this.actif || (!xt && !ks)) return;
    if (this.qemu && xt) {
      const b = new DataView(new ArrayBuffer(12));
      b.setUint8(0, 255); b.setUint8(1, 0); b.setUint16(2, bas ? 1 : 0); b.setUint32(4, ks); b.setUint32(8, xt);
      this.envoyer(b.buffer);
    } else if (ks) {
      const b = new DataView(new ArrayBuffer(8));
      b.setUint8(0, 4); b.setUint8(1, bas ? 1 : 0); b.setUint32(4, ks);
      this.envoyer(b.buffer);
    }
  }
  // Un caractère tapé ici, sur les touches qui le donnent dans la disposition
  // de l'invité. Ce que l'invité tient de Maj/Alt/Ctrl est relâché d'abord :
  // le caractère porte déjà sa casse et son Alt Gr.
  caractere(ch, d) {
    const ev = evenementsCaractere(ch, d, { mode: this.qemu ? 'qemu' : 'us' });
    if (!ev) { this.surIntapable(ch); return; }
    this.relacherMods();
    // Verr. Maj de l'invité éteint : le caractère est déjà dans sa casse.
    if (this.verrous?.caps) this.basculerCaps();
    for (const x of ev) this.evenement(x);
    this.modUtilise = true;
  }
  // Mode caractère : Maj, Ctrl et Alt tenus ici partent avant une touche sans caractère.
  envoyerMods() {
    for (const [code, key] of this.modsTenus) if (!this.modsEnvoyes.has(code)) { this.modsEnvoyes.add(code); this.touche({ code, key }, true); }
    this.modUtilise = true;
  }
  relacherMods() {
    for (const code of this.modsEnvoyes) this.touche({ code, key: this.modsTenus.get(code) || code }, false);
    this.modsEnvoyes.clear();
  }

  touche(e, bas) {
    if (!this.actif) return;
    const xt = XT[e.code] || 0, ks = keysym(e);
    if (!xt && !ks) return;
    if (this.qemu && xt) {
      const b = new DataView(new ArrayBuffer(12));
      b.setUint8(0, 255); b.setUint8(1, 0); b.setUint16(2, bas ? 1 : 0); b.setUint32(4, ks); b.setUint32(8, codeQemu(xt));
      this.envoyer(b.buffer);
    } else if (ks) {
      const b = new DataView(new ArrayBuffer(8));
      b.setUint8(0, 4); b.setUint8(1, bas ? 1 : 0); b.setUint32(4, ks);
      this.envoyer(b.buffer);
    }
  }
  pointeur(x, y, masque) {
    if (!this.actif) return;
    const b = new DataView(new ArrayBuffer(6));
    b.setUint8(0, 5); b.setUint8(1, masque);
    b.setUint16(2, Math.max(0, Math.min(this.toile.width - 1, Math.round(x))));
    b.setUint16(4, Math.max(0, Math.min(this.toile.height - 1, Math.round(y))));
    this.envoyer(b.buffer);
  }
  // L'image est contenue dans la toile sans être déformée (object-fit:
  // contain) : en plein écran, des bandes l'entourent, hors de l'image.
  // Image étirée pour remplir l'écran (remplir) : une échelle par axe, sans bande.
  position(e) {
    const r = this.toile.getBoundingClientRect(), l = this.toile.width, h = this.toile.height;
    if (this.remplir) return [(e.clientX - r.left) / ((r.width / l) || 1), (e.clientY - r.top) / ((r.height / h) || 1)];
    const k = Math.min(r.width / l, r.height / h) || 1;
    return [(e.clientX - r.left - (r.width - l * k) / 2) / k, (e.clientY - r.top - (r.height - h * k) / 2) / k];
  }
  // Une combinaison quelconque : les touches enfoncées dans l'ordre, relâchées à rebours.
  combo(...codes) {
    const nom = c => ({ ControlLeft: 'Control', AltLeft: 'Alt', ShiftLeft: 'Shift', MetaLeft: 'Meta', AltRight: 'AltGraph' })[c] || (c.startsWith('Key') ? c.slice(3).toLowerCase() : c);
    for (const c of codes) this.touche({ code: c, key: nom(c) }, true);
    for (const c of [...codes].reverse()) this.touche({ code: c, key: nom(c) }, false);
  }
  // Ctrl(+Maj)+lettre sur la touche qui porte cette lettre dans la disposition de l'invité.
  raccourci(lettre, { maj = false, disposition = 'fr' } = {}) {
    const code = appuis(lettre, disposition)?.[0]?.[0] || `Key${lettre.toUpperCase()}`;
    this.combinaison(lettre, maj, code);
  }
  // Ctrl+Alt+Suppr : la combinaison que le navigateur garde pour lui.
  ctrlAltSuppr() {
    const seq = [['ControlLeft', 'Control'], ['AltLeft', 'Alt'], ['Delete', 'Delete']];
    for (const [code, key] of seq) this.touche({ code, key }, true);
    for (const [code, key] of seq.reverse()) this.touche({ code, key }, false);
  }
  // Verr. Maj : celui de l'invité suit celui d'ici. macOS ne donne qu'un
  // keydown à l'allumage et qu'un keyup à l'extinction : l'invité ne
  // basculait qu'une fois sur deux et restait en majuscules. Chaque touche
  // compare donc l'état d'ici aux voyants que QEMU annonce, et rattrape un
  // écart d'un appui sur Verr. Maj.
  basculerCaps() {
    this.touche({ code: 'CapsLock', key: 'CapsLock' }, true); this.touche({ code: 'CapsLock', key: 'CapsLock' }, false);
    if (this.verrous) { this.verrous.caps = !this.verrous.caps; this.surEtat('verrous', { ...this.verrous }); }   // la VM le confirmera
  }
  synchroniserCaps(e) {
    if (!this.verrous || e.code === 'CapsLock' || typeof e.getModifierState !== 'function') return;
    if (e.getModifierState('CapsLock') !== this.verrous.caps) this.basculerCaps();
  }
  relacher() { for (const [code, key] of this.enfoncees) this.touche({ code, key }, false); this.enfoncees.clear(); this.relacherMods(); this.modsTenus.clear(); this.metaSeul = null; }

  brancher() {
    const t = this.toile;
    // Raccourcis : ⌘ sur Mac, Ctrl ailleurs. Coller prend le presse-papiers
    // d'ici ; copier et couper rapportent ici ce que l'invité a copié. Sur Mac,
    // ⌘+lettre devient Ctrl+lettre dans l'invité ; ⌘ seul reste la touche Super.
    const mod = e => (this.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;
    t.addEventListener('keydown', e => {
      // La lettre selon la disposition d'ici (⌘A en AZERTY est la touche KeyQ) ;
      // rejouée dans l'invité sur la même touche physique.
      const lettre = e.key.length === 1 ? e.key.toLowerCase() : '';
      if (mod(e) && lettre === 'v' && this.surColler) {
        // Pas de preventDefault : le collage natif doit avoir lieu, dans le piège.
        if (e.repeat) return;
        if (this.mac) this.metaSeul = null;
        this.relacher();
        this.pieger(e.shiftKey);
        return;
      }
      e.preventDefault();
      if (e.code === 'CapsLock') {
        // Voyants connus : rien n'est envoyé, l'invité est aligné à la touche
        // suivante. Sans eux : sur Mac chaque événement est un appui complet,
        // ailleurs la touche part telle quelle.
        if (this.verrous) return;
        if (this.mac) { this.basculerCaps(); return; }
      }
      const d = this.disposition();
      // Mode caractère (disposition de l'invité connue) : Verr. Maj ne part pas
      // (le caractère porte sa casse), Maj, Ctrl et Alt attendent de servir.
      if (d) {
        if (e.code === 'CapsLock') return;
        if (/^(Shift|Control|Alt)/.test(e.code)) { if (!this.modsTenus.has(e.code)) { this.modsTenus.set(e.code, e.key); this.modUtilise = false; } return; }
        if (e.key === 'Dead') return;    // touche morte d'ici : le caractère composé arrive à la touche suivante
        const altgr = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
        const ch = [...e.key].length === 1 && !e.metaKey && (!e.ctrlKey || altgr) && (!e.altKey || altgr || this.mac) ? e.key : null;
        if (ch !== null) { this.metaSeul = null; this.caractere(ch, d); return; }
      } else this.synchroniserCaps(e);
      if (this.mac && /^Meta/.test(e.code)) { this.metaSeul = e.code; return; }
      // Sur Mac, ⌘ + une touche devient Ctrl + la même touche dans l'invité
      // (⌘S, ⌘F, ⌘T, ⌘←…), comme ⌘C et ⌘V ; ⌘Espace ouvre la recherche de
      // l'invité (Super), ⌘Tab y change de fenêtre (Alt+Tab). macOS ne donne
      // pas le relâché d'une touche lâchée sous ⌘ : elle était restée enfoncée
      // dans l'invité, qui la répétait. L'appui part donc complet, tout de suite.
      if (this.mac && e.metaKey && !/^(Shift|Control|Alt)/.test(e.code)) {
        this.metaSeul = null;
        if (e.code === 'Space') { if (!e.repeat) this.combo('MetaLeft'); return; }
        if (e.code === 'Tab') { if (!e.repeat) this.combo('AltLeft', 'Tab'); return; }
        if (lettre === 'c' || lettre === 'x') { if (e.repeat) return; this.armerCopie(); }
        // La lettre du raccourci, sur sa touche dans la disposition de l'invité (⌘A → Ctrl+A partout).
        this.combinaison(lettre || e.key, e.shiftKey, (d && lettre && appuis(lettre, d)?.[0]?.[0]) || e.code);
        return;
      }
      if (!this.mac && mod(e) && (lettre === 'c' || lettre === 'x') && !e.repeat) this.armerCopie();
      if (d && e.ctrlKey && !e.altKey && lettre && appuis(lettre, d)) {
        // Ctrl + lettre : la lettre sur sa touche dans l'invité (Ctrl est tenu ici, pas encore là-bas).
        this.modUtilise = true;
        this.combinaison(lettre, e.shiftKey, appuis(lettre, d)[0][0]);
        return;
      }
      if (d) this.envoyerMods();
      if (e.repeat && !this.enfoncees.has(e.code)) return;
      this.enfoncees.set(e.code, e.key);
      this.touche(e, true);
    });
    t.addEventListener('keyup', e => {
      e.preventDefault();
      if (this.modsTenus.has(e.code)) {
        const envoye = this.modsEnvoyes.delete(e.code);
        if (envoye) this.touche({ code: e.code, key: this.modsTenus.get(e.code) }, false);
        // Alt seul, appuyé puis lâché (menus de Windows) : l'appui part entier.
        else if (/^Alt/.test(e.code) && !this.modUtilise && !this.mac) this.combo(e.code);
        this.modsTenus.delete(e.code);
        return;
      }
      if (e.code === 'CapsLock' && this.mac && !this.verrous) { this.basculerCaps(); return; }
      if (this.mac && /^Meta/.test(e.code) && this.metaSeul === e.code) { this.metaSeul = null; this.touche({ code: e.code, key: 'Meta' }, true); this.touche({ code: e.code, key: 'Meta' }, false); return; }
      if (!this.enfoncees.has(e.code)) return;
      const key = this.enfoncees.get(e.code) ?? e.key;
      this.enfoncees.delete(e.code);
      this.touche({ code: e.code, key }, false);
    });
    t.addEventListener('blur', () => this.relacher());
    this.piege.addEventListener('paste', e => {
      e.preventDefault();
      const c = this.collage; this.collage = null;
      if (!c) return;
      clearTimeout(c.minuterie);
      this.toile.focus({ preventScroll: true });
      this.surColler({ maj: c.maj, texte: e.clipboardData?.getData('text/plain') ?? '' });
    });
    this.piege.addEventListener('keydown', e => { if (!/^(Meta|Control|Shift)/.test(e.key) && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); this.toile.focus({ preventScroll: true }); } });
    const masque = e => (e.buttons & 1 ? 1 : 0) | (e.buttons & 4 ? 2 : 0) | (e.buttons & 2 ? 4 : 0);
    t.addEventListener('pointerdown', e => { if (this.modsTenus.size) this.envoyerMods(); t.focus(); t.setPointerCapture?.(e.pointerId); this.boutons = masque(e); this.pointeur(...this.position(e), this.boutons); e.preventDefault(); });
    t.addEventListener('pointerup', e => { this.boutons = masque(e); this.pointeur(...this.position(e), this.boutons); });
    t.addEventListener('pointermove', e => { this.boutons = masque(e); this.pointeur(...this.position(e), this.boutons); });
    t.addEventListener('wheel', e => {
      e.preventDefault();
      const [x, y] = this.position(e), b = e.deltaY < 0 ? 8 : 16;
      this.pointeur(x, y, this.boutons | b); this.pointeur(x, y, this.boutons);
    }, { passive: false });
    t.addEventListener('contextmenu', e => e.preventDefault());
  }
}
