// WebSocket écrit à la main (RFC 6455) : côté serveur pour le terminal du
// navigateur, côté client vers le termproxy de Proxmox.
//
// Ce que cette implémentation garantit, parce qu'un flux binaire bidirectionnel
// est une surface d'attaque à part entière :
//   - poignée de main correcte (Sec-WebSocket-Accept), version 13 seulement ;
//   - contrôle de l'en-tête Origin contre les origines du service ;
//   - session du socle exigée et rôle vérifié AVANT la mise à niveau (fait par
//     l'appelant, qui ne nous passe la socket qu'une fois le droit établi) ;
//   - trames : masquage client obligatoire (une trame non masquée ferme la
//     connexion), taille de trame et de message bornées, fragmentation gérée ;
//   - ping/pong et fermeture propres.
import crypto from 'node:crypto';
import { connecter as connecterTls } from './tls.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_TRAME = 4 * 1024 * 1024;      // une trame de plus de 4 Mio n'est pas un flux normal
const MAX_MESSAGE = 16 * 1024 * 1024;   // message réassemblé borné
const OP = { suite: 0x0, texte: 0x1, binaire: 0x2, fermeture: 0x8, ping: 0x9, pong: 0xa };

function acceptation(cle) {
  return crypto.createHash('sha1').update(cle + GUID).digest('base64');
}

// Contrôle préalable : version, clé, et Origin admise. Renvoie { ok } ou
// { erreur, code }.
export function verifierUpgrade(req, { origines = [] } = {}) {
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') return { erreur: 'upgrade attendu', code: 400 };
  if (String(req.headers['sec-websocket-version'] || '') !== '13') return { erreur: 'version WebSocket non supportée', code: 426 };
  const cle = req.headers['sec-websocket-key'];
  if (!cle || Buffer.from(cle, 'base64').length !== 16) return { erreur: 'clé WebSocket invalide', code: 400 };
  const o = req.headers.origin;
  // Un Origin présent doit être l'une des origines du service : une page d'un
  // autre site n'ouvre pas de tunnel. Absent (client non-navigateur), on laisse
  // l'authentification décider.
  if (o !== undefined && !origines.includes(o)) return { erreur: 'origine refusée', code: 403 };
  return { ok: true, cle };
}

export function refuser(socket, code = 400, message = 'Bad Request') {
  try {
    socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* socket déjà fermée */ }
  try { socket.destroy(); } catch { /* idem */ }
}

// Réalise la poignée de main (101) et rend une Connexion. sousProtocole : celui
// offert par le client que l'on accepte (ex. « binary »).
export function accepter(req, socket, { sousProtocole = null } = {}) {
  const entetes = [
    'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptation(req.headers['sec-websocket-key'])}`,
  ];
  if (sousProtocole) entetes.push(`Sec-WebSocket-Protocol: ${sousProtocole}`);
  socket.write(entetes.join('\r\n') + '\r\n\r\n');
  return new Connexion(socket);
}

export class Connexion {
  // role : « serveur » (reçoit masqué, émet en clair) ou « client » (l'inverse).
  constructor(socket, { role = 'serveur' } = {}) {
    this.socket = socket;
    this.role = role;
    this.tampon = Buffer.alloc(0);
    this.morceaux = [];        // fragments d'un message en cours
    this.tailleMessage = 0;
    this.opCourant = null;
    this.ferme = false;
    this.gest = { message: null, binaire: null, texte: null, fermeture: null };
    socket.on('data', d => this._recevoir(d));
    socket.on('close', () => this._finir());
    socket.on('error', () => this._finir());
    socket.setTimeout(0);
  }

  on(evt, fn) { this.gest[evt] = fn; return this; }

  _recevoir(d) {
    if (this.ferme) return;
    this.tampon = this.tampon.length ? Buffer.concat([this.tampon, d]) : d;
    try { while (this._trame()); } catch (e) { this.fermerCode(1002, String(e.message).slice(0, 100)); }
  }

  _trame() {
    const b = this.tampon;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const opcode = b[0] & 0x0f;
    const masque = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let i = 2;
    if (rsv) throw new Error('bits réservés non nuls');
    // Client → serveur : masquage OBLIGATOIRE ; serveur → client : INTERDIT
    // (RFC 6455 §5.1). Une trame qui viole le sens attendu ferme la connexion.
    if (this.role === 'serveur' && !masque) throw new Error('trame client non masquée');
    if (this.role === 'client' && masque) throw new Error('trame serveur masquée');
    if (len === 126) { if (b.length < i + 2) return false; len = b.readUInt16BE(i); i += 2; }
    else if (len === 127) { if (b.length < i + 8) return false; const g = b.readBigUInt64BE(i); if (g > BigInt(MAX_TRAME)) throw new Error('trame démesurée'); len = Number(g); i += 8; }
    if (len > MAX_TRAME) throw new Error('trame démesurée');
    // Trame de contrôle (fermeture, ping, pong) : jamais fragmentée, 125 octets
    // au plus (RFC 6455 §5.5) ; un ping plus gros serait renvoyé tel quel.
    if (opcode >= 0x8 && (!fin || len > 125)) throw new Error('trame de contrôle invalide');
    const entete = i + (masque ? 4 : 0);
    if (b.length < entete + len) return false;
    let charge;
    if (masque) {
      const cle = b.subarray(i, i + 4);
      charge = Buffer.allocUnsafe(len);
      for (let k = 0; k < len; k++) charge[k] = b[entete + k] ^ cle[k & 3];
    } else {
      charge = Buffer.from(b.subarray(entete, entete + len));
    }
    this.tampon = b.subarray(entete + len);

    if (opcode === OP.ping) { this._envoyer(OP.pong, charge); return true; }
    if (opcode === OP.pong) return true;
    if (opcode === OP.fermeture) { this.gest.fermeture?.(); this.fermerCode(1000); return false; }

    // Données (texte/binaire) et continuation.
    if (opcode === OP.texte || opcode === OP.binaire) {
      if (this.opCourant !== null) throw new Error('nouvelle trame de données sans clôture');
      this.opCourant = opcode; this.morceaux = []; this.tailleMessage = 0;
    } else if (opcode === OP.suite) {
      if (this.opCourant === null) throw new Error('continuation sans début');
    } else {
      throw new Error('opcode inconnu');
    }
    this.tailleMessage += len;
    if (this.tailleMessage > MAX_MESSAGE) throw new Error('message démesuré');
    this.morceaux.push(charge);
    if (fin) {
      const message = this.morceaux.length === 1 ? this.morceaux[0] : Buffer.concat(this.morceaux);
      const estTexte = this.opCourant === OP.texte;
      this.opCourant = null; this.morceaux = [];
      if (estTexte) this.gest.texte?.(message.toString('utf8'));
      else this.gest.binaire?.(message);
      this.gest.message?.(message, estTexte);
    }
    return true;
  }

  // Émission : le serveur n'ajoute jamais de masque, le client en met un.
  _envoyer(opcode, charge = Buffer.alloc(0)) {
    if (this.ferme || this.socket.destroyed) return;
    const client = this.role === 'client';
    const len = charge.length;
    const bitMasque = client ? 0x80 : 0;
    let tete;
    if (len < 126) { tete = Buffer.from([0x80 | opcode, bitMasque | len]); }
    else if (len < 65536) { tete = Buffer.alloc(4); tete[0] = 0x80 | opcode; tete[1] = bitMasque | 126; tete.writeUInt16BE(len, 2); }
    else { tete = Buffer.alloc(10); tete[0] = 0x80 | opcode; tete[1] = bitMasque | 127; tete.writeBigUInt64BE(BigInt(len), 2); }
    let sortie;
    if (client) {
      const cle = crypto.randomBytes(4);
      const masquee = Buffer.allocUnsafe(len);
      for (let k = 0; k < len; k++) masquee[k] = charge[k] ^ cle[k & 3];
      sortie = Buffer.concat([tete, cle, masquee]);
    } else {
      sortie = Buffer.concat([tete, charge]);
    }
    try { this.socket.write(sortie); } catch { this._finir(); }
  }

  envoyerBinaire(buf) { this._envoyer(OP.binaire, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); }
  envoyerTexte(str) { this._envoyer(OP.texte, Buffer.from(String(str), 'utf8')); }
  ping() { this._envoyer(OP.ping); }

  fermerCode(code = 1000, raison = '') {
    if (this.ferme) return;
    const r = Buffer.from(String(raison), 'utf8').subarray(0, 120);
    const charge = Buffer.alloc(2 + r.length); charge.writeUInt16BE(code, 0); r.copy(charge, 2);
    this._envoyer(OP.fermeture, charge);
    this._finir();
  }
  close() { this.fermerCode(1000); }

  _finir() {
    if (this.ferme) return;
    this.ferme = true;
    this.gest.fermeture?.();
    try { this.socket.end(); } catch { /* déjà fermée */ }
    try { this.socket.destroy(); } catch { /* idem */ }
  }
}

// Client WebSocket vers Proxmox : la socket vient de la liaison (autorité ou
// empreinte vérifiée avant le premier octet), puis la poignée de main est menée
// ici et rend une Connexion « client ».
export function connecter(liaison, chemin, { entetes = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const cle = crypto.randomBytes(16).toString('base64');
    const lignes = [
      `GET ${chemin} HTTP/1.1`, `Host: ${liaison.hote}:${liaison.port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${cle}`, 'Sec-WebSocket-Version: 13',
    ];
    for (const [k, v] of Object.entries(entetes)) lignes.push(`${k}: ${v}`);
    connecterTls(liaison, { timeout }).then(socket => {
      let tampon = Buffer.alloc(0);
      const surErreur = e => { try { socket.destroy(); } catch { /* déjà fermé */ } reject(e); };
      const surDonnees = d => {
        tampon = Buffer.concat([tampon, d]);
        const sep = tampon.indexOf('\r\n\r\n');
        if (sep < 0) { if (tampon.length > 16384) surErreur(new Error('réponse WebSocket démesurée')); return; }
        const tete = tampon.subarray(0, sep).toString('latin1');
        if (!/^HTTP\/1\.1 101 /.test(tete)) return surErreur(new Error('mise à niveau refusée : ' + tete.split('\r\n')[0].slice(0, 80)));
        const m = /sec-websocket-accept:\s*(.+)\r?/i.exec(tete);
        if (!m || m[1].trim() !== acceptation(cle)) return surErreur(new Error('Sec-WebSocket-Accept invalide'));
        socket.removeListener('data', surDonnees);
        socket.removeListener('error', surErreur);
        const conn = new Connexion(socket, { role: 'client' });
        const reste = tampon.subarray(sep + 4);
        if (reste.length) conn._recevoir(reste);
        resolve(conn);
      };
      socket.on('error', surErreur);
      socket.on('data', surDonnees);
      socket.write(lignes.join('\r\n') + '\r\n\r\n');
    }, reject);
  });
}
