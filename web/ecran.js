// Écran d'une machine virtuelle : un client RFB (VNC) minimal, dessiné dans un
// <canvas>. ProxLab a déjà fait la poignée avec Proxmox ; ce client reprend à
// ClientInit. Pixels en 32 bits (rouge, vert, bleu, rien), encodages Raw et
// CopyRect, changement de taille, et la touche étendue de QEMU : le code
// physique de chaque touche part avec elle, si bien que la disposition du
// clavier est celle de la machine invitée (AZERTY reste AZERTY).
//
// Presse-papiers dans les deux sens : le protocole étendu de VNC (celui de
// QEMU avec « clipboard=vnc », relayé dans l'invité par spice-vdagent), en
// UTF-8 et compressé en zlib ; sans agent, « taper » le texte touche par
// touche selon la disposition du clavier de l'invité.

// event.code → code XT (préfixe E0 noté 0xE0xx).
const XT = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17,
  KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21,
  KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42,
  F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b,
  Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  IntlBackslash: 0x56, F11: 0x57, F12: 0x58, NumpadEnter: 0xe01c, ControlRight: 0xe01d, NumpadDivide: 0xe035, PrintScreen: 0xe037,
  AltRight: 0xe038, Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050,
  PageDown: 0xe051, Insert: 0xe052, Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c, ContextMenu: 0xe05d,
};
// Les touches sans caractère : leur keysym X11.
const KEYSYMS = {
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff, Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52,
  ArrowRight: 0xff53, ArrowDown: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63, ContextMenu: 0xff67, NumLock: 0xff7f,
  CapsLock: 0xffe5, ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3, ControlRight: 0xffe4, MetaLeft: 0xffeb, MetaRight: 0xffec,
  AltLeft: 0xffe9, AltRight: 0xfe03, PrintScreen: 0xff61, ScrollLock: 0xff14,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0xffbe + i])),
};
export function keysym(e) {
  if (KEYSYMS[e.code] && (e.key.length !== 1 || /^(Shift|Control|Alt|Meta)/.test(e.code))) return KEYSYMS[e.code];
  if (KEYSYMS[e.key]) return KEYSYMS[e.key];
  const cps = [...e.key];
  if (cps.length === 1) { const cp = cps[0].codePointAt(0); return cp < 0x100 ? cp : 0x01000000 | cp; }
  return 0;
}
// Code envoyé à QEMU : un code étendu E0xx devient xx | 0x80.
export const codeQemu = xt => ((xt >> 8) === 0xe0 && (xt & 0xff) < 0x7f ? (xt & 0xff) | 0x80 : xt);

const PRESSE_EXT = 0xC0A1E5CE | 0;       // pseudo-encodage du presse-papiers étendu
// CopyRect, Raw, DesktopSize, ExtendedDesktopSize, touche étendue QEMU, presse-papiers
const ENCODAGES = [1, 0, -223, -308, -258, PRESSE_EXT];
const PP = { TEXTE: 1, CAPS: 1 << 24, REQUEST: 1 << 25, PEEK: 1 << 26, NOTIFY: 1 << 27, PROVIDE: 1 << 28 };
const PRESSE_MAX = 64 * 1024 - 64;      // ProxLab refuse au-delà de 64 Kio
export const FRAPPE_MAX = 4000;

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

// Caractère → touches physiques, par disposition. [code, maj, altgr] ; une
// suite pour les touches mortes (^ puis e → ê).
const T = (code, maj = false, altgr = false) => [code, maj, altgr];
function carteUs() {
  const c = {};
  for (let i = 0; i < 26; i++) { const l = String.fromCharCode(97 + i), code = `Key${l.toUpperCase()}`; c[l] = [T(code)]; c[l.toUpperCase()] = [T(code, true)]; }
  '0123456789'.split('').forEach(d => { c[d] = [T(`Digit${d}`)]; });
  ')!@#$%^&*('.split('').forEach((x, i) => { c[x] = [T(`Digit${i}`, true)]; });
  for (const [code, bas, haut] of [['Minus', '-', '_'], ['Equal', '=', '+'], ['BracketLeft', '[', '{'], ['BracketRight', ']', '}'], ['Backslash', '\\', '|'], ['Semicolon', ';', ':'], ['Quote', "'", '"'], ['Comma', ',', '<'], ['Period', '.', '>'], ['Slash', '/', '?'], ['Backquote', '`', '~']]) { c[bas] = [T(code)]; c[haut] = [T(code, true)]; }
  return c;
}
function carteFr() {
  const c = {};
  const lettres = { a: 'KeyQ', z: 'KeyW', q: 'KeyA', w: 'KeyZ', m: 'Semicolon' };
  for (let i = 0; i < 26; i++) { const l = String.fromCharCode(97 + i), code = lettres[l] || `Key${l.toUpperCase()}`; c[l] = [T(code)]; c[l.toUpperCase()] = [T(code, true)]; }
  const rang = ['&', 'é', '"', "'", '(', '-', 'è', '_', 'ç', 'à'];
  rang.forEach((x, i) => { const code = `Digit${(i + 1) % 10}`; c[x] = [T(code)]; c[String((i + 1) % 10)] = [T(code, true)]; });
  for (const [code, bas, haut] of [['Minus', ')', '°'], ['Equal', '=', '+'], ['BracketRight', '$', '£'], ['Quote', 'ù', '%'], ['Backslash', '*', 'µ'], ['KeyM', ',', '?'], ['Comma', ';', '.'], ['Period', ':', '/'], ['Slash', '!', '§'], ['IntlBackslash', '<', '>']]) { c[bas] = [T(code)]; c[haut] = [T(code, true)]; }
  c['²'] = [T('Backquote')];
  for (const [code, x] of [['Digit2', '~'], ['Digit3', '#'], ['Digit4', '{'], ['Digit5', '['], ['Digit6', '|'], ['Digit7', '`'], ['Digit8', '\\'], ['Digit9', '^'], ['Digit0', '@'], ['Minus', ']'], ['Equal', '}'], ['KeyE', '€']]) c[x] = [T(code, false, true)];
  for (const [b, v] of [['a', 'â'], ['e', 'ê'], ['i', 'î'], ['o', 'ô'], ['u', 'û']]) c[v] = [T('BracketLeft'), ...c[b]];
  for (const [b, v] of [['a', 'ä'], ['e', 'ë'], ['i', 'ï'], ['o', 'ö'], ['u', 'ü'], ['y', 'ÿ']]) c[v] = [T('BracketLeft', true), ...c[b]];
  return c;
}
const COMMUNES = { ' ': [T('Space')], '\n': [T('Enter')], '\t': [T('Tab')] };
export const DISPOSITIONS = { fr: { nom: 'AZERTY (français)', carte: { ...carteFr(), ...COMMUNES } }, us: { nom: 'QWERTY (US)', carte: { ...carteUs(), ...COMMUNES } } };
// Les caractères qu'une disposition ne sait pas taper.
export const intapables = (texte, d) => [...new Set([...texte.replace(/\r\n?/g, '\n')].filter(ch => !DISPOSITIONS[d]?.carte[ch]))];
export const estMac = () => /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '');

export class Ecran {
  constructor(hote, ws, { surEtat = () => {}, surPresse = () => {}, surColler = null } = {}) {
    this.ws = ws; this.surEtat = surEtat; this.surPresse = surPresse; this.surColler = surColler;
    this.actif = false; this.capsPresse = 0; this.aFournir = null; this.dernierPresse = ''; this.copie = null;
    this.mac = estMac(); this.metaSeul = null;
    this.morceaux = []; this.dispo = 0;
    this.etat = 'init'; this.rects = 0; this.rect = null;
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
    this.ctx = this.toile.getContext('2d', { alpha: false });
    // ⌘V / Ctrl+V : le collage du navigateur est dirigé dans ce champ caché,
    // le temps d'une touche : le texte arrive sans demande d'autorisation.
    this.piege = document.createElement('textarea');
    this.piege.className = 'ecran-piege';
    this.piege.tabIndex = -1;
    this.piege.setAttribute('aria-hidden', 'true');
    hote.replaceChildren(this.toile, this.piege);
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
    try { while (this.pas()); } catch (e) { this.surEtat(`erreur : ${e.message}`); this.ws.close(); }
  }
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
      const enc = new DataView(new ArrayBuffer(4 + 4 * ENCODAGES.length));
      enc.setUint8(0, 2); enc.setUint16(2, ENCODAGES.length);
      ENCODAGES.forEach((e, i) => enc.setInt32(4 + 4 * i, e));
      this.envoyer(enc.buffer);
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
        if (r.l && r.h) this.ctx.drawImage(this.toile, v.getUint16(0), v.getUint16(2), r.l, r.h, r.x, r.y, r.l, r.h);
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
        if (premier) this.surEtat('ajustable');
      }
      else if (r.enc === -258) this.qemu = true;
      else throw new Error(`encodage ${r.enc} non demandé`);
      this.rect = null;
      if (--this.rects <= 0) this.finImage();
      return true;
    }
    return false;
  }
  finImage() { this.etat = 'message'; this.demander(true); }
  taille(l, h) {
    if (l < 1 || h < 1 || l > 8192 || h > 8192) throw new Error('taille d\'écran invalide');
    this.toile.width = l; this.toile.height = h;
    this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, l, h);
    this.surEtat('taille', `${l} × ${h}`);
  }

  // Demande à la VM un écran de l x h (SetDesktopSize). Faux si QEMU ne l'a
  // pas annoncé ; la VM répond par un changement de taille, ou le refuse
  // (affichage sans redimensionnement : il faut VirtIO-GPU).
  ajuster(l, h) {
    if (!this.actif || !this.etendu) return false;
    l = Math.max(320, Math.min(8192, Math.floor(l / 2) * 2)); h = Math.max(200, Math.min(8192, Math.floor(h / 2) * 2));
    if ((l === this.toile.width && h === this.toile.height) || (this.demandee && this.demandee[0] === l && this.demandee[1] === h)) return true;
    this.demandee = [l, h];
    const b = new DataView(new ArrayBuffer(24));
    b.setUint8(0, 251); b.setUint16(2, l); b.setUint16(4, h); b.setUint8(6, 1);
    b.setUint32(8, this.ecranId); b.setUint16(16, l); b.setUint16(18, h);
    this.envoyer(b.buffer);
    return true;
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
  // Taper le texte, touche par touche, selon la disposition de l'invité.
  async taper(texte, disposition = 'fr', { surAvance = () => {} } = {}) {
    const carte = DISPOSITIONS[disposition]?.carte || DISPOSITIONS.fr.carte;
    const caracteres = [...String(texte).replace(/\r\n?/g, '\n')].slice(0, FRAPPE_MAX);
    let sautes = 0;
    for (let i = 0; i < caracteres.length; i++) {
      if (!this.actif || this.ws.readyState !== 1) break;
      const suite = carte[caracteres[i]];
      if (!suite) { sautes++; continue; }
      for (const [j, [code, maj, altgr]] of suite.entries()) {
        if (maj) this.touche({ code: 'ShiftLeft', key: 'Shift' }, true);
        if (altgr) this.touche({ code: 'AltRight', key: 'AltGraph' }, true);
        // La casse du keysym doit suivre Maj : QEMU (lock_key_sync) prend une
        // lettre minuscule avec Maj enfoncée pour un Verr. Maj à corriger, et
        // ajoute un appui sur Verr. Maj — le texte sortait en minuscules.
        const ch = caracteres[i];
        const key = j === suite.length - 1 && [...ch].length === 1 && ch > ' ' ? ch
          : code.startsWith('Key') ? (maj ? code.slice(3) : code.slice(3).toLowerCase()) : code.startsWith('Digit') ? code.slice(5) : code === 'Space' ? ' ' : code;
        this.touche({ code, key }, true); this.touche({ code, key }, false);
        if (altgr) this.touche({ code: 'AltRight', key: 'AltGraph' }, false);
        if (maj) this.touche({ code: 'ShiftLeft', key: 'Shift' }, false);
      }
      if (i % 8 === 7) { surAvance(i + 1, caracteres.length); await new Promise(r => setTimeout(r, 25)); }
    }
    surAvance(caracteres.length, caracteres.length);
    return { tapes: caracteres.length - sautes, sautes };
  }
  pieger(maj) {
    this.piege.value = '';
    // Sans collage natif (navigateur qui ne le fait pas) : la lecture du presse-papiers, par l'appelant.
    this.collage = { maj, minuterie: setTimeout(() => { if (!this.collage) return; this.collage = null; this.toile.focus({ preventScroll: true }); this.surColler({ maj, texte: null }); }, 500) };
    this.piege.focus({ preventScroll: true });
  }
  // Une combinaison Ctrl(+Maj)+lettre envoyée à l'invité.
  combinaison(lettre, maj = false, code = `Key${lettre.toUpperCase()}`) {
    this.touche({ code: 'ControlLeft', key: 'Control' }, true);
    if (maj) this.touche({ code: 'ShiftLeft', key: 'Shift' }, true);
    const k = maj ? lettre.toUpperCase() : lettre;
    this.touche({ code, key: k }, true); this.touche({ code, key: k }, false);
    if (maj) this.touche({ code: 'ShiftLeft', key: 'Shift' }, false);
    this.touche({ code: 'ControlLeft', key: 'Control' }, false);
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
  position(e) {
    const r = this.toile.getBoundingClientRect(), l = this.toile.width, h = this.toile.height;
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
    const code = DISPOSITIONS[disposition]?.carte[lettre]?.[0]?.[0] || `Key${lettre.toUpperCase()}`;
    this.combinaison(lettre, maj, code);
  }
  // Ctrl+Alt+Suppr : la combinaison que le navigateur garde pour lui.
  ctrlAltSuppr() {
    const seq = [['ControlLeft', 'Control'], ['AltLeft', 'Alt'], ['Delete', 'Delete']];
    for (const [code, key] of seq) this.touche({ code, key }, true);
    for (const [code, key] of seq.reverse()) this.touche({ code, key }, false);
  }
  relacher() { for (const [code, key] of this.enfoncees) this.touche({ code, key }, false); this.enfoncees.clear(); this.metaSeul = null; }

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
      if (this.mac && /^Meta/.test(e.code)) { this.metaSeul = e.code; return; }
      if (mod(e) && /^[cxazy]$/.test(lettre) && /^Key/.test(e.code)) {
        if (e.repeat) return;
        if (this.mac) this.metaSeul = null;
        if (lettre === 'c' || lettre === 'x') this.armerCopie();
        if (this.mac) this.combinaison(lettre, e.shiftKey, e.code);
        else { this.enfoncees.set(e.code, e.key); this.touche(e, true); }
        return;
      }
      if (this.metaSeul) { this.enfoncees.set(this.metaSeul, 'Meta'); this.touche({ code: this.metaSeul, key: 'Meta' }, true); this.metaSeul = null; }
      if (e.repeat && !this.enfoncees.has(e.code)) return;
      this.enfoncees.set(e.code, e.key);
      this.touche(e, true);
    });
    t.addEventListener('keyup', e => {
      e.preventDefault();
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
    t.addEventListener('pointerdown', e => { t.focus(); t.setPointerCapture?.(e.pointerId); this.boutons = masque(e); this.pointeur(...this.position(e), this.boutons); e.preventDefault(); });
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
