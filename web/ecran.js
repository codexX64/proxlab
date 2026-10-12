// Écran d'une machine virtuelle : un client RFB (VNC) minimal, dessiné dans un
// <canvas>. ProxLab a déjà fait la poignée avec Proxmox ; ce client reprend à
// ClientInit. Pixels en 32 bits (rouge, vert, bleu, rien), encodages Raw et
// CopyRect, changement de taille, et la touche étendue de QEMU : le code
// physique de chaque touche part avec elle, si bien que la disposition du
// clavier est celle de la machine invitée (AZERTY reste AZERTY).

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

const ENCODAGES = [1, 0, -223, -258];   // CopyRect, Raw, DesktopSize, touche étendue QEMU

export class Ecran {
  constructor(hote, ws, { surEtat = () => {} } = {}) {
    this.ws = ws; this.surEtat = surEtat;
    this.morceaux = []; this.dispo = 0;
    this.etat = 'init'; this.rects = 0; this.rect = null;
    this.qemu = false; this.enfoncees = new Map(); this.boutons = 0;
    this.toile = document.createElement('canvas');
    this.toile.className = 'ecran';
    this.toile.tabIndex = 0;
    this.toile.width = 640; this.toile.height = 400;
    this.toile.setAttribute('role', 'img');
    this.toile.setAttribute('aria-label', 'Écran de la machine : cliquer pour lui donner le clavier');
    this.ctx = this.toile.getContext('2d', { alpha: false });
    hote.replaceChildren(this.toile);
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
      return true;
    }
    if (this.etat === 'message') {
      const t = this.regarder(1); if (!t) return false;
      if (t[0] === 0) { const h = this.prendre(4); if (!h) return false; this.rects = new DataView(h.buffer).getUint16(2); this.etat = 'rect'; if (!this.rects) this.finImage(); return true; }
      if (t[0] === 1) { const h = this.regarder(6); if (!h) return false; const n = new DataView(h.buffer).getUint16(4); return !!this.prendre(6 + 6 * n); }
      if (t[0] === 2) { this.prendre(1); return true; }
      if (t[0] === 3) { const h = this.regarder(8); if (!h) return false; const n = new DataView(h.buffer).getUint32(4); if (n > 1 << 20) throw new Error('presse-papiers démesuré'); return !!this.prendre(8 + n); }
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

  touche(e, bas) {
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
    const b = new DataView(new ArrayBuffer(6));
    b.setUint8(0, 5); b.setUint8(1, masque);
    b.setUint16(2, Math.max(0, Math.min(this.toile.width - 1, Math.round(x))));
    b.setUint16(4, Math.max(0, Math.min(this.toile.height - 1, Math.round(y))));
    this.envoyer(b.buffer);
  }
  position(e) {
    const r = this.toile.getBoundingClientRect();
    return [(e.clientX - r.left) * this.toile.width / r.width, (e.clientY - r.top) * this.toile.height / r.height];
  }
  // Ctrl+Alt+Suppr : la combinaison que le navigateur garde pour lui.
  ctrlAltSuppr() {
    const seq = [['ControlLeft', 'Control'], ['AltLeft', 'Alt'], ['Delete', 'Delete']];
    for (const [code, key] of seq) this.touche({ code, key }, true);
    for (const [code, key] of seq.reverse()) this.touche({ code, key }, false);
  }
  relacher() { for (const [code, key] of this.enfoncees) this.touche({ code, key }, false); this.enfoncees.clear(); }

  brancher() {
    const t = this.toile;
    t.addEventListener('keydown', e => {
      e.preventDefault();
      if (e.repeat && !this.enfoncees.has(e.code)) return;
      this.enfoncees.set(e.code, e.key);
      this.touche(e, true);
    });
    t.addEventListener('keyup', e => {
      e.preventDefault();
      const key = this.enfoncees.get(e.code) ?? e.key;
      this.enfoncees.delete(e.code);
      this.touche({ code: e.code, key }, false);
    });
    t.addEventListener('blur', () => this.relacher());
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
