// Écran fluide : la vidéo que Sunshine encode dans la VM (H.264), relayée par
// ProxLab sur la WebSocket et décodée ici par le navigateur lui-même
// (WebCodecs, matériel quand il y en a). Images clés : SPS et PPS en tirent la
// description « avcC » ; chaque image part ensuite en unités NAL préfixées par
// leur longueur, la forme que tous les navigateurs décodent.
//
// Clavier : comme l'écran VNC, le caractère tapé ici arrive tel quel — il
// part sur la touche qui le donne dans la disposition de la VM, en codes de
// touche Windows (VK) que Sunshine rejoue. Souris en position absolue.
import { appuis } from './socle/clavier.js';

// Codes de touche Windows (disposition US) par touche physique.
const VK = { Backspace: 0x08, Tab: 0x09, Enter: 0x0d, NumpadEnter: 0x0d, ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5,
  Pause: 0x13, CapsLock: 0x14, Escape: 0x1b, Space: 0x20, PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  PrintScreen: 0x2c, Insert: 0x2d, Delete: 0x2e, MetaLeft: 0x5b, MetaRight: 0x5c, OSLeft: 0x5b, OSRight: 0x5c, ContextMenu: 0x5d,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f, NumLock: 0x90, ScrollLock: 0x91,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde, IntlBackslash: 0xe2, IntlRo: 0xc1 };
for (let i = 0; i < 26; i++) VK[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i;
for (let i = 0; i < 10; i++) { VK[`Digit${i}`] = 0x30 + i; VK[`Numpad${i}`] = 0x60 + i; }
for (let i = 1; i <= 24; i++) VK[`F${i}`] = 0x6f + i;
export { VK };
const ETENDUES = new Set(['NumpadEnter', 'ControlRight', 'AltRight', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'NumpadDivide', 'MetaLeft', 'MetaRight']);
const MOD = { ShiftLeft: 1, ShiftRight: 1, ControlLeft: 2, ControlRight: 2, AltLeft: 4, AltRight: 4, MetaLeft: 8, MetaRight: 8 };
const ETENDU = 0x10;

export const fluideDisponible = () => typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window;

// Unités NAL d'un flux Annex B (codes de début 00 00 01 ou 00 00 00 01).
export function unitesNal(b) {
  const sortie = [];
  let i = 0, debut = -1;
  const n = b.length;
  while (i + 2 < n) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (debut >= 0) sortie.push(b.subarray(debut, finSansZeros(b, debut, i)));
      i += 3; debut = i;
    } else i++;
  }
  if (debut >= 0 && debut < n) sortie.push(b.subarray(debut, finSansZeros(b, debut, n)));
  return sortie.filter(u => u.length);
}
function finSansZeros(b, debut, fin) { while (fin > debut && b[fin - 1] === 0) fin--; return fin; }

// avcC (ISO 14496-15) à partir d'un SPS et d'un PPS.
export function avcC(sps, pps) {
  const d = new Uint8Array(11 + sps.length + pps.length);
  d.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff], 0);
  d.set(sps, 8);
  d.set([1, pps.length >> 8, pps.length & 0xff], 8 + sps.length);
  d.set(pps, 11 + sps.length);
  return d;
}
const hex2 = v => v.toString(16).padStart(2, '0');
export const codecAvc = sps => `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`;

// Une image Annex B → { donnees (longueurs sur 4 octets), sps, pps }.
export function versAvcc(annexB) {
  let sps = null, pps = null;
  const garder = [];
  for (const u of unitesNal(annexB)) {
    const type = u[0] & 0x1f;
    if (type === 7) sps = u; else if (type === 8) pps = u;
    else if (type !== 9) garder.push(u);           // le délimiteur d'unité d'accès ne sert pas
  }
  const total = garder.reduce((s, u) => s + 4 + u.length, 0);
  const donnees = new Uint8Array(total);
  let o = 0;
  for (const u of garder) { new DataView(donnees.buffer).setUint32(o, u.length); donnees.set(u, o + 4); o += 4 + u.length; }
  return { donnees, sps, pps };
}

export class EcranFluide {
  constructor(hote, ws, { disposition = () => null, surEtat = () => {}, surIntapable = () => {}, surColler = null, surTouche = () => false, mac = /mac|iphone|ipad/i.test(navigator.platform || '') } = {}) {
    // surTouche : une touche que la page garde pour elle (Suppr pendant une frappe) ; ni elle ni son relâché ne partent.
    this.surTouche = surTouche; this.avalees = new Set();
    this.hote = hote; this.ws = ws; this.disposition = disposition; this.surEtat = surEtat; this.surIntapable = surIntapable; this.surColler = surColler; this.mac = mac;
    this.toile = document.createElement('canvas');
    this.toile.className = 'ecran fluide';
    this.toile.tabIndex = 0;
    this.toile.width = 1280; this.toile.height = 720;
    this.ctx = this.toile.getContext('2d', { alpha: false, desynchronized: true });
    this.largeur = 1280; this.hauteur = 720;
    this.actif = false; this.cleConfig = ''; this.attenteCle = true;
    this.enfoncees = new Map();       // code → vk, touches enfoncées dans l'invité
    this.modsTenus = new Set(); this.modsEnvoyes = new Set();
    this.stats = { images: 0, sautees: 0, decodees: 0, debut: performance.now() };
    // ⌘V / Ctrl+V : le collage du navigateur est dirigé dans ce champ caché, le
    // temps d'une touche ; le texte va ensuite à la frappe par ProxLab.
    this.piege = document.createElement('textarea');
    this.piege.className = 'ecran-piege';
    this.piege.tabIndex = -1;
    this.piege.setAttribute('aria-hidden', 'true');
    hote.replaceChildren(this.toile, this.piege);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', ev => { if (typeof ev.data !== 'string') this.recevoir(new Uint8Array(ev.data)); });
    this.brancher();
  }

  // La demande d'écran : taille (paire), cadence et débit.
  commencer({ largeur, hauteur, ips, debit, ajuster = false }) {
    this.ws.send(JSON.stringify({ debut: { largeur: largeur & ~1, hauteur: hauteur & ~1, ips, debit, ...(ajuster ? { ajuster: true } : {}) } }));
  }

  pret({ largeur, hauteur }) {
    this.largeur = largeur; this.hauteur = hauteur;
    this.toile.width = largeur; this.toile.height = hauteur;
    this.actif = true;
    this.creerDecodeur();
  }

  creerDecodeur() {
    try { this.decodeur?.close(); } catch { /* déjà fermé */ }
    this.cleConfig = ''; this.attenteCle = true;
    this.decodeur = new VideoDecoder({
      output: f => {
        this.stats.decodees++;
        try { this.ctx.drawImage(f, 0, 0, this.toile.width, this.toile.height); } finally { f.close(); }
      },
      error: e => { this.surEtat('erreur', String(e?.message || e)); this.creerDecodeur(); this.demanderCle(); },
    });
  }

  demanderCle() { this.envoyer(Uint8Array.of(0x14)); }

  recevoir(m) {
    if (m[0] !== 0x01 || m.length < 7 || !this.decodeur) return;
    this.stats.images++;
    const cle = (m[1] & 1) === 1;
    const { donnees, sps, pps } = versAvcc(m.subarray(6));
    if (cle && sps && pps) {
      const codec = codecAvc(sps), desc = avcC(sps, pps), id = codec + ':' + Array.from(desc).join(',');
      if (id !== this.cleConfig) {
        if (this.decodeur.state === 'closed') this.creerDecodeur();
        this.decodeur.configure({ codec, description: desc, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
        this.cleConfig = id;
      }
      this.attenteCle = false;
    }
    if (this.attenteCle || this.decodeur.state !== 'configured') return;
    // Décodeur en retard : on saute jusqu'à la prochaine image clé, demandée tout de suite.
    if (!cle && this.decodeur.decodeQueueSize > 4) { this.stats.sautees++; this.attenteCle = true; this.demanderCle(); return; }
    try {
      this.decodeur.decode(new EncodedVideoChunk({ type: cle ? 'key' : 'delta', timestamp: Math.round(performance.now() * 1000), data: donnees }));
    } catch { this.creerDecodeur(); this.demanderCle(); }
  }

  envoyer(octets) { if (this.ws.readyState === 1) this.ws.send(octets); }
  touche(vk, bas, mods = this.etatMods()) {
    const b = new Uint8Array(5); b[0] = 0x10; b[1] = bas ? 1 : 0; b[2] = vk & 0xff; b[3] = vk >> 8; b[4] = mods & 0x1f;
    this.envoyer(b);
  }
  etatMods() { let m = 0; for (const c of this.modsEnvoyes) m |= MOD[c] || 0; return m; }

  // Une touche physique d'ici, rejouée telle quelle dans l'invité.
  physique(code, bas) {
    const vk = VK[code];
    if (!vk) return;
    if (bas) this.enfoncees.set(code, vk); else this.enfoncees.delete(code);
    if (MOD[code]) { if (bas) this.modsEnvoyes.add(code); else this.modsEnvoyes.delete(code); }
    this.touche(vk, bas, this.etatMods() | (ETENDUES.has(code) ? ETENDU : 0));
  }

  // Un caractère, sur les touches qui le donnent dans la disposition de la VM.
  caractere(ch, d) {
    const suite = appuis(ch, d);
    if (!suite) { this.surIntapable(ch); return; }
    this.relacherMods();
    for (const [code, maj, altgr] of suite) {
      if (maj) this.touche(VK.ShiftLeft, true, 1);
      if (altgr) this.touche(VK.AltRight, true, (maj ? 1 : 0) | 4 | ETENDU);
      const m = (maj ? 1 : 0) | (altgr ? 4 : 0);
      this.touche(VK[code], true, m); this.touche(VK[code], false, m);
      if (altgr) this.touche(VK.AltRight, false, (maj ? 1 : 0) | ETENDU);
      if (maj) this.touche(VK.ShiftLeft, false, 0);
    }
  }
  envoyerMods() { for (const c of this.modsTenus) if (!this.modsEnvoyes.has(c)) { this.modsEnvoyes.add(c); this.touche(VK[c], true, this.etatMods() | (ETENDUES.has(c) ? ETENDU : 0)); } }
  relacherMods() { for (const c of [...this.modsEnvoyes]) { this.modsEnvoyes.delete(c); this.touche(VK[c], false, this.etatMods() | (ETENDUES.has(c) ? ETENDU : 0)); } }
  combinaison(lettre, maj, code) {
    const ctrl = !this.modsEnvoyes.has('ControlLeft') && !this.modsEnvoyes.has('ControlRight');
    if (ctrl) this.touche(VK.ControlLeft, true, 2);
    if (maj) this.touche(VK.ShiftLeft, true, 3);
    const vk = VK[code] || 0;
    if (vk) { this.touche(vk, true, 2 | (maj ? 1 : 0)); this.touche(vk, false, 2 | (maj ? 1 : 0)); }
    if (maj) this.touche(VK.ShiftLeft, false, 2);
    if (ctrl) this.touche(VK.ControlLeft, false, 0);
  }
  ctrlAltSuppr() {
    this.relacherMods();
    this.touche(VK.ControlLeft, true, 2); this.touche(VK.AltLeft, true, 6); this.touche(VK.Delete, true, 6 | ETENDU);
    this.touche(VK.Delete, false, 6 | ETENDU); this.touche(VK.AltLeft, false, 2); this.touche(VK.ControlLeft, false, 0);
  }
  relacher() {
    for (const [code, vk] of this.enfoncees) this.touche(vk, false, ETENDUES.has(code) ? ETENDU : 0);
    this.enfoncees.clear(); this.relacherMods(); this.modsTenus.clear();
    for (const n of this.boutons) this.envoyer(Uint8Array.of(0x12, 0, n));
    this.boutons.clear();
  }

  position(e) {
    const r = this.toile.getBoundingClientRect();
    const k = Math.min(r.width / this.largeur, r.height / this.hauteur) || 1;
    const x = (e.clientX - r.left - (r.width - this.largeur * k) / 2) / k, y = (e.clientY - r.top - (r.height - this.hauteur * k) / 2) / k;
    return [Math.max(0, Math.min(this.largeur - 1, Math.round(x))), Math.max(0, Math.min(this.hauteur - 1, Math.round(y)))];
  }

  brancher() {
    const t = this.toile;
    this.boutons = new Set();
    let derniere = 0, attente = null;
    const bouger = e => {
      if (!this.actif) return;
      const [x, y] = this.position(e);
      const b = new Uint8Array(5); b[0] = 0x11; new DataView(b.buffer).setUint16(1, x); new DataView(b.buffer).setUint16(3, y);
      // Au plus un mouvement toutes les 4 ms : la souris reste fluide sans noyer la liaison.
      const now = performance.now();
      if (now - derniere >= 4) { derniere = now; this.envoyer(b); } else { clearTimeout(attente); attente = setTimeout(() => { derniere = performance.now(); this.envoyer(b); }, 4); }
    };
    const BOUTON = [1, 2, 3, 4, 5];
    t.addEventListener('pointermove', bouger);
    t.addEventListener('pointerdown', e => {
      t.focus({ preventScroll: true });
      if (!this.actif) return;
      e.preventDefault();
      bouger(e); this.envoyerMods();
      const n = BOUTON[e.button] || 1; this.boutons.add(n);
      this.envoyer(Uint8Array.of(0x12, 1, n));
      try { t.setPointerCapture(e.pointerId); } catch { /* pas de capture */ }
    });
    t.addEventListener('pointerup', e => {
      if (!this.actif) return;
      const n = BOUTON[e.button] || 1; this.boutons.delete(n);
      this.envoyer(Uint8Array.of(0x12, 0, n));
    });
    t.addEventListener('contextmenu', e => e.preventDefault());
    let restY = 0, restX = 0;
    t.addEventListener('wheel', e => {
      if (!this.actif) return;
      e.preventDefault();
      const f = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      restY += -e.deltaY * f * 1.2; restX += e.deltaX * f * 1.2;
      const dy = Math.trunc(restY), dx = Math.trunc(restX);
      if (!dy && !dx) return;
      restY -= dy; restX -= dx;
      const b = new Uint8Array(5); b[0] = 0x13;
      new DataView(b.buffer).setInt16(1, Math.max(-1200, Math.min(1200, dy))); new DataView(b.buffer).setInt16(3, Math.max(-1200, Math.min(1200, dx)));
      this.envoyer(b);
    }, { passive: false });
    const modColler = e => (this.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;
    t.addEventListener('keydown', e => {
      if (!this.actif) return;
      if (this.surTouche(e)) { e.preventDefault(); this.avalees.add(e.code); return; }
      const lettre = e.key.length === 1 ? e.key.toLowerCase() : '';
      if (modColler(e) && lettre === 'v' && this.surColler) {
        // Pas de preventDefault : le collage natif doit avoir lieu, dans le piège.
        if (e.repeat) return;
        this.relacher();
        this.piege.value = '';
        this.collage = setTimeout(() => { if (!this.collage) return; this.collage = null; this.toile.focus({ preventScroll: true }); this.surColler(null); }, 500);
        this.piege.focus({ preventScroll: true });
        return;
      }
      e.preventDefault();
      const d = this.disposition();
      if (!d) { this.physique(e.code, true); return; }
      if (e.code === 'CapsLock') return;
      if (/^(Shift|Control|Alt)/.test(e.code)) { this.modsTenus.add(e.code); return; }
      if (e.key === 'Dead') return;
      const altgr = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
      const ch = [...e.key].length === 1 && !e.metaKey && (!e.ctrlKey || altgr) && (!e.altKey || altgr || this.mac) ? e.key : null;
      if (ch !== null) { this.caractere(ch, d); return; }
      // ⌘ (Mac) ou Ctrl + lettre : Ctrl + la touche qui porte cette lettre dans la VM.
      if ((this.mac ? e.metaKey : e.ctrlKey) && lettre && appuis(lettre, d)) { if (!e.repeat) this.combinaison(lettre, e.shiftKey, appuis(lettre, d)[0][0]); return; }
      if (this.mac && /^Meta/.test(e.code)) { this.metaSeul = e.code; return; }
      if (this.mac && e.metaKey && e.code === 'Tab') { if (!e.repeat) { this.touche(VK.AltLeft, true, 4); this.touche(VK.Tab, true, 4); this.touche(VK.Tab, false, 4); this.touche(VK.AltLeft, false, 0); } return; }
      this.metaSeul = null;
      this.envoyerMods();
      this.physique(e.code, true);
    });
    t.addEventListener('keyup', e => {
      if (!this.actif) return;
      e.preventDefault();
      if (this.avalees.delete(e.code)) return;
      const d = this.disposition();
      if (!d) { this.physique(e.code, false); return; }
      if (/^(Shift|Control|Alt)/.test(e.code)) { this.modsTenus.delete(e.code); if (this.modsEnvoyes.has(e.code)) { this.modsEnvoyes.delete(e.code); this.touche(VK[e.code], false, this.etatMods() | (ETENDUES.has(e.code) ? ETENDU : 0)); } return; }
      if (this.mac && /^Meta/.test(e.code)) { if (this.metaSeul === e.code) { this.touche(VK.MetaLeft, true, 8 | ETENDU); this.touche(VK.MetaLeft, false, ETENDU); } this.metaSeul = null; return; }
      if (this.enfoncees.has(e.code)) this.physique(e.code, false);
    });
    t.addEventListener('blur', () => this.relacher());
    this.piege.addEventListener('paste', e => {
      e.preventDefault();
      if (!this.collage) return;
      clearTimeout(this.collage); this.collage = null;
      this.toile.focus({ preventScroll: true });
      this.surColler(e.clipboardData?.getData('text/plain') ?? '');
    });
    this.piege.addEventListener('keydown', e => { if (!/^(Meta|Control|Shift)/.test(e.key) && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); this.toile.focus({ preventScroll: true }); } });
  }

  fermer() {
    this.actif = false;
    try { this.relacher(); } catch { /* fermé */ }
    try { this.decodeur?.close(); } catch { /* fermé */ }
    try { this.ws.close(); } catch { /* fermé */ }
  }
  detruire() { this.fermer(); }
}
