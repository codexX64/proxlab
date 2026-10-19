// Émulateur de terminal (VT100 et l'essentiel de xterm) pour la console d'une
// machine ou d'un nœud. Le rendu est fait nœud par nœud : une ligne est un
// <div>, une suite de cellules de même apparence un <span> dont le texte est
// posé par textContent. Les seize couleurs de base sont des classes ; les
// couleurs 256 et RVB passent par le CSSOM, jamais par un attribut de style.
//
// Copier : sélectionner à la souris (le rendu attend la fin du geste), puis
// ⌘C, Ctrl+Maj+C, le bouton Copier ou le menu du navigateur. Coller : ⌘V,
// Ctrl+Maj+V ou le bouton Coller ; en mode « collage encadré » (2004) le
// texte part entre ses balises, comme dans un vrai terminal.
function xterm256(n) {
  if (n < 16) return null;
  if (n < 232) { n -= 16; const lv = [0, 95, 135, 175, 215, 255]; return `rgb(${lv[Math.floor(n / 36) % 6]},${lv[Math.floor(n / 6) % 6]},${lv[n % 6]})`; }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const TOUCHES = {
  Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~', Delete: '\x1b[3~', Insert: '\x1b[2~',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS', F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

const vierge = () => ({ f: null, b: null, gras: false, inv: false, pale: false });

export class Terminal {
  constructor(hote, { surSaisie, surTaille, surCopie = () => {}, surRefus = () => {} } = {}) {
    this.surSaisie = surSaisie; this.surTaille = surTaille; this.surCopie = surCopie; this.surRefus = surRefus;
    this.encadre = false; this.glisse = false;
    this.mac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
    this.cols = 80; this.lignes = 24; this.x = 0; this.y = 0;
    this.attr = vierge(); this.etat = 'texte'; this.params = ''; this.haut = 0; this.bas = 23;
    this.sauve = null; this.alt = null; this.sale = new Set(); this.prevu = false;
    this.ecran = document.createElement('div');
    this.ecran.className = 'terminal';
    this.ecran.tabIndex = 0;
    this.ecran.setAttribute('role', 'log');
    this.ecran.setAttribute('aria-label', 'Sortie de la console');
    this.saisie = document.createElement('textarea');
    this.saisie.className = 'terminal-saisie';
    this.saisie.setAttribute('aria-label', 'Saisie de la console');
    this.saisie.autocapitalize = 'off'; this.saisie.spellcheck = false;
    hote.replaceChildren(this.ecran, this.saisie);
    this.tampon = this.nouveauTampon(this.lignes, this.cols);
    this.rangs = [];
    this.lier();
    // Un clic donne le clavier ; un glissé sélectionne, et la sélection reste.
    this.ecran.addEventListener('mousedown', e => { if (e.button === 0) this.glisse = true; });
    document.addEventListener('mouseup', this.finGlisse = () => {
      if (!this.glisse) return;
      this.glisse = false;
      if (!this.selection()) this.saisie.focus(); else this.ecran.focus({ preventScroll: true });
      this.prevoir();
    });
    this.ecran.addEventListener('focus', () => { if (!this.glisse && !this.selection()) this.saisie.focus(); });
    this.ecran.addEventListener('copy', e => { const t = this.selection(); if (t) { e.preventDefault(); e.clipboardData.setData('text/plain', t); this.surCopie([...t].length); } });
    this.observateur = new ResizeObserver(() => this.mesurer());
    this.observateur.observe(this.ecran);
    this.mesurer();
    this.peindre(true);
  }

  cellule(a) { return { c: ' ', f: a.f, b: a.b, gras: a.gras, inv: a.inv, pale: a.pale }; }
  nouvelleLigne(cols) { return Array.from({ length: cols }, () => this.cellule(vierge())); }
  nouveauTampon(l, c) { return Array.from({ length: l }, () => this.nouvelleLigne(c)); }
  toutSale() { for (let y = 0; y < this.lignes; y++) this.sale.add(y); }
  focus() { this.saisie.focus(); }
  detruire() { this.observateur.disconnect(); document.removeEventListener('mouseup', this.finGlisse); }

  // Le texte sélectionné dans l'écran du terminal, lignes sans leurs blancs de fin.
  selection() {
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !this.ecran.contains(sel.getRangeAt(0).commonAncestorContainer)) return '';
    return sel.toString().split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  }
  async copier() {
    const t = this.selection();
    if (!t) { this.surCopie(0); return; }
    try { await navigator.clipboard.writeText(t); this.surCopie([...t].length); } catch {
      if (document.execCommand?.('copy')) return;
      this.surRefus('Le navigateur refuse d\'écrire le presse-papiers : utilise le menu Copier.');
    }
  }
  coller(texte) {
    if (!texte) return;
    const t = String(texte).replace(/\r?\n/g, '\r');
    this.surSaisie?.(this.encadre ? `\x1b[200~${t.replace(/\x1b\[20[01]~/g, '')}\x1b[201~` : t);
    window.getSelection?.()?.removeAllRanges();
    this.saisie.focus();
  }
  async collerPressePapiers() {
    try { this.coller(await navigator.clipboard.readText()); } catch { this.surRefus(`Le navigateur n'a pas donné le presse-papiers : clique dans la console puis ${this.mac ? '⌘V' : 'Ctrl+Maj+V'}.`); }
  }

  mesurer() {
    const sonde = document.createElement('span');
    sonde.className = 'terminal-sonde';
    sonde.textContent = '0'.repeat(80);
    this.ecran.append(sonde);
    const r = sonde.getBoundingClientRect();
    sonde.remove();
    const cw = r.width / 80 || 8, ch = r.height || 17;
    const cols = Math.max(20, Math.min(300, Math.floor((this.ecran.clientWidth - 20) / cw)));
    const lignes = Math.max(6, Math.min(120, Math.floor((this.ecran.clientHeight - 20) / ch)));
    if (cols !== this.cols || lignes !== this.lignes) this.redimensionner(cols, lignes);
  }

  redimensionner(cols, lignes) {
    const ancien = this.tampon;
    this.cols = cols; this.lignes = lignes;
    this.tampon = this.nouveauTampon(lignes, cols);
    for (let y = 0; y < Math.min(lignes, ancien.length); y++) for (let x = 0; x < Math.min(cols, ancien[y].length); x++) this.tampon[y][x] = ancien[y][x];
    this.x = Math.min(this.x, cols - 1); this.y = Math.min(this.y, lignes - 1);
    this.haut = 0; this.bas = lignes - 1;
    this.surTaille?.(cols, lignes);
    this.peindre(true);
  }

  lier() {
    const envoyer = s => this.surSaisie?.(s);
    // Une touche : rend vrai si elle a été traitée (et son défaut empêché).
    const clavier = e => {
      const l = e.key.length === 1 ? e.key.toLowerCase() : '';
      // Copier / coller : ⌘ sur Mac, Ctrl+Maj ailleurs (Ctrl+C reste l'interruption).
      if ((this.mac ? e.metaKey : e.ctrlKey && e.shiftKey) && !e.altKey && l === 'c') { e.preventDefault(); this.copier(); return true; }
      if ((this.mac ? e.metaKey : e.ctrlKey && e.shiftKey) && !e.altKey && l === 'v') return 'coller'; // l'événement paste suit
      if (e.metaKey) return false;
      if (e.ctrlKey && !e.altKey && e.key.length === 1) {
        const c = l.charCodeAt(0);
        if (c >= 97 && c <= 122) { e.preventDefault(); envoyer(String.fromCharCode(c - 96)); return true; }
        if (e.key === ' ') { e.preventDefault(); envoyer('\x00'); return true; }
      }
      if (e.altKey && !e.ctrlKey && e.key.length === 1 && !this.mac) { e.preventDefault(); envoyer('\x1b' + e.key); return true; }
      if (TOUCHES[e.key]) { e.preventDefault(); envoyer(TOUCHES[e.key]); return true; }
      return false;
    };
    this.saisie.addEventListener('input', () => { if (this.saisie.value) { envoyer(this.saisie.value); this.saisie.value = ''; } });
    this.saisie.addEventListener('keydown', clavier);
    this.saisie.addEventListener('paste', e => { e.preventDefault(); this.coller(e.clipboardData.getData('text')); });
    // L'écran garde le clavier tant qu'une sélection existe : copier la prend,
    // toute autre touche la lâche et repart dans la saisie.
    this.ecran.addEventListener('keydown', e => {
      const r = clavier(e);
      if (r === true) return;
      if (r === 'coller') { e.preventDefault(); this.collerPressePapiers(); return; }
      if (/^(Shift|Control|Alt|Meta)/.test(e.key) || e.metaKey) return;
      window.getSelection?.()?.removeAllRanges();
      this.saisie.focus();
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey) { e.preventDefault(); envoyer(e.key); }
    });
    this.ecran.addEventListener('paste', e => { e.preventDefault(); this.coller(e.clipboardData.getData('text')); });
  }

  ecrire(texte) {
    for (const ch of texte) this.pas(ch);
    this.prevoir();
  }

  pas(ch) {
    const code = ch.codePointAt(0);
    if (this.etat === 'osc') { if (ch === '\x07' || ch === '\x1b') this.etat = 'texte'; return; }
    if (this.etat === 'esc') {
      this.etat = 'texte';
      if (ch === '[') { this.etat = 'csi'; this.params = ''; }
      else if (ch === ']') this.etat = 'osc';
      else if (ch === 'M') this.indexInverse();
      else if (ch === '7') this.sauve = { x: this.x, y: this.y, attr: { ...this.attr } };
      else if (ch === '8') { if (this.sauve) ({ x: this.x, y: this.y } = this.sauve), this.attr = { ...this.sauve.attr }; }
      else if ('()#'.includes(ch)) this.etat = 'saute';
      return;
    }
    if (this.etat === 'saute') { this.etat = 'texte'; return; }
    if (this.etat === 'csi') {
      if (code >= 0x40 && code <= 0x7e) { this.csi(ch); this.etat = 'texte'; } else if (this.params.length < 64) this.params += ch;
      return;
    }
    if (ch === '\x1b') { this.etat = 'esc'; return; }
    this.sale.add(this.y);
    if (ch === '\r') { this.x = 0; return; }
    if (ch === '\n' || ch === '\x0b' || ch === '\x0c') { this.saut(); return; }
    if (ch === '\b') { this.x = Math.max(0, this.x - 1); return; }
    if (ch === '\t') { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); return; }
    if (code < 32) return;
    if (this.x >= this.cols) { this.x = 0; this.saut(); }
    const c = this.cellule(this.attr);
    c.c = ch;
    this.tampon[this.y][this.x++] = c;
    this.sale.add(this.y);
  }

  saut() { if (this.y === this.bas) this.defiler(); else this.y = Math.min(this.lignes - 1, this.y + 1); this.sale.add(this.y); }
  indexInverse() {
    if (this.y === this.haut) { this.tampon.splice(this.haut, 0, this.nouvelleLigne(this.cols)); this.tampon.splice(this.bas + 1, 1); this.toutSale(); }
    else this.y = Math.max(0, this.y - 1);
  }
  defiler(n = 1) {
    for (let i = 0; i < n; i++) { this.tampon.splice(this.haut, 1); this.tampon.splice(this.bas, 0, this.nouvelleLigne(this.cols)); }
    this.toutSale();
  }

  csi(fin) {
    const prive = /^[?>!]/.test(this.params);
    const p = this.params.replace(/^[?>!]/, '').split(';').map(v => (v === '' ? 0 : parseInt(v, 10)));
    const n = (i, d) => (!p[i] || Number.isNaN(p[i]) ? d : p[i]);
    const ligne = this.tampon[this.y];
    this.sale.add(this.y);
    switch (fin) {
      case 'A': this.y = Math.max(this.haut, this.y - n(0, 1)); break;
      case 'B': this.y = Math.min(this.bas, this.y + n(0, 1)); break;
      case 'C': this.x = Math.min(this.cols - 1, this.x + n(0, 1)); break;
      case 'D': this.x = Math.max(0, this.x - n(0, 1)); break;
      case 'E': this.y = Math.min(this.bas, this.y + n(0, 1)); this.x = 0; break;
      case 'F': this.y = Math.max(this.haut, this.y - n(0, 1)); this.x = 0; break;
      case 'G': case '`': this.x = Math.min(this.cols - 1, n(0, 1) - 1); break;
      case 'd': this.y = Math.min(this.lignes - 1, n(0, 1) - 1); break;
      case 'H': case 'f': this.y = Math.min(this.lignes - 1, n(0, 1) - 1); this.x = Math.min(this.cols - 1, n(1, 1) - 1); break;
      case 'J': this.effacerEcran(p[0] || 0); break;
      case 'K': this.effacerLigne(p[0] || 0); break;
      case 'L': for (let i = 0; i < n(0, 1); i++) { this.tampon.splice(this.y, 0, this.nouvelleLigne(this.cols)); this.tampon.splice(this.bas + 1, 1); } this.toutSale(); break;
      case 'M': for (let i = 0; i < n(0, 1); i++) { this.tampon.splice(this.y, 1); this.tampon.splice(this.bas, 0, this.nouvelleLigne(this.cols)); } this.toutSale(); break;
      case 'P': ligne.splice(this.x, n(0, 1)); while (ligne.length < this.cols) ligne.push(this.cellule(this.attr)); break;
      case '@': for (let i = 0; i < n(0, 1); i++) ligne.splice(this.x, 0, this.cellule(this.attr)); ligne.length = this.cols; break;
      case 'X': for (let i = 0; i < n(0, 1) && this.x + i < this.cols; i++) ligne[this.x + i] = this.cellule(this.attr); break;
      case 'S': this.defiler(n(0, 1)); break;
      case 'T': for (let i = 0; i < n(0, 1); i++) this.indexInverse(); break;
      case 'r': this.haut = Math.max(0, n(0, 1) - 1); this.bas = Math.min(this.lignes - 1, (p[1] || this.lignes) - 1); this.x = 0; this.y = this.haut; break;
      case 's': this.sauve = { x: this.x, y: this.y, attr: { ...this.attr } }; break;
      case 'u': if (this.sauve) { this.x = this.sauve.x; this.y = this.sauve.y; this.attr = { ...this.sauve.attr }; } break;
      case 'm': this.sgr(this.params.split(';')); break;
      case 'h': if (prive && p.includes(1049)) this.entrerAlt(); if (prive && p.includes(2004)) this.encadre = true; break;
      case 'l': if (prive && p.includes(1049)) this.sortirAlt(); if (prive && p.includes(2004)) this.encadre = false; break;
      default: break;
    }
    this.sale.add(this.y);
  }

  entrerAlt() { if (this.alt) return; this.alt = { tampon: this.tampon, x: this.x, y: this.y }; this.tampon = this.nouveauTampon(this.lignes, this.cols); this.x = 0; this.y = 0; this.toutSale(); }
  sortirAlt() { if (!this.alt) return; ({ tampon: this.tampon, x: this.x, y: this.y } = this.alt); this.alt = null; this.toutSale(); }

  effacerEcran(mode) {
    if (mode === 2 || mode === 3) { this.tampon = this.nouveauTampon(this.lignes, this.cols); this.toutSale(); return; }
    if (mode === 0) { this.effacerLigne(0); for (let y = this.y + 1; y < this.lignes; y++) this.tampon[y] = this.nouvelleLigne(this.cols); }
    else { this.effacerLigne(1); for (let y = 0; y < this.y; y++) this.tampon[y] = this.nouvelleLigne(this.cols); }
    this.toutSale();
  }
  effacerLigne(mode) {
    const l = this.tampon[this.y];
    const de = mode === 0 ? this.x : 0, a = mode === 1 ? this.x : this.cols - 1;
    for (let x = de; x <= a; x++) l[x] = this.cellule(this.attr);
  }

  sgr(parts) {
    for (let i = 0; i < parts.length; i++) {
      const v = parseInt(parts[i] || '0', 10);
      if (v === 0) this.attr = vierge();
      else if (v === 1) this.attr.gras = true;
      else if (v === 2) this.attr.pale = true;
      else if (v === 7) this.attr.inv = true;
      else if (v === 22) { this.attr.gras = false; this.attr.pale = false; }
      else if (v === 27) this.attr.inv = false;
      else if (v >= 30 && v <= 37) this.attr.f = v - 30;
      else if (v === 39) this.attr.f = null;
      else if (v >= 40 && v <= 47) this.attr.b = v - 40;
      else if (v === 49) this.attr.b = null;
      else if (v >= 90 && v <= 97) this.attr.f = v - 90 + 8;
      else if (v >= 100 && v <= 107) this.attr.b = v - 100 + 8;
      else if (v === 38 || v === 48) {
        const mode = parseInt(parts[i + 1], 10);
        let c = null;
        if (mode === 5) { const k = parseInt(parts[i + 2], 10) || 0; c = k < 16 ? k : xterm256(k); i += 2; }
        else if (mode === 2) { c = `rgb(${borne(+parts[i + 2])},${borne(+parts[i + 3])},${borne(+parts[i + 4])})`; i += 4; }
        if (v === 38) this.attr.f = c; else this.attr.b = c;
      }
    }
  }

  prevoir() {
    if (this.prevu || this.glisse) return;
    this.prevu = true;
    requestAnimationFrame(() => { this.prevu = false; this.peindre(); });
  }

  // Une ligne sale est refaite : suites de cellules de même apparence en <span>.
  peindre(tout = false) {
    if (tout || this.rangs.length !== this.lignes) {
      this.rangs = Array.from({ length: this.lignes }, () => { const d = document.createElement('div'); d.className = 'terminal-ligne'; return d; });
      this.ecran.replaceChildren(...this.rangs);
      this.toutSale();
    }
    if (this.dernierCurseur !== undefined) this.sale.add(this.dernierCurseur);
    this.sale.add(this.y);
    for (const y of this.sale) {
      const rang = this.rangs[y], ligne = this.tampon[y];
      if (!rang || !ligne) continue;
      const morceaux = [];
      let courant = null, cle = null;
      for (let x = 0; x < this.cols; x++) {
        const c = ligne[x] || this.cellule(vierge());
        let f = c.f, b = c.b;
        if (c.inv) { const t = f ?? 'fond'; f = b ?? 'texte-inv'; b = t; }
        const curseur = y === this.y && x === this.x;
        const k = `${f}|${b}|${c.gras}|${c.pale}|${curseur}`;
        if (k !== cle) {
          courant = document.createElement('span');
          if (typeof f === 'number') courant.classList.add(`t-f${f}`); else if (f === 'texte-inv') courant.classList.add('t-inv'); else if (f) courant.style.color = f;
          if (typeof b === 'number') courant.classList.add(`t-b${b}`); else if (b === 'fond') courant.classList.add('t-bfond'); else if (b) courant.style.background = b;
          if (c.gras) courant.classList.add('t-gras');
          if (c.pale) courant.classList.add('t-pale');
          if (curseur) courant.classList.add('t-curseur');
          courant.textContent = '';
          morceaux.push(courant); cle = k;
        }
        courant.textContent += c.c;
      }
      rang.replaceChildren(...morceaux);
    }
    this.dernierCurseur = this.y;
    this.sale.clear();
  }
}

function borne(v) { return Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0; }
