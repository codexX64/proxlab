// Un client ENet minimal (UDP fiable), tel que Sunshine l'attend pour son flux
// de contrôle : une connexion, des canaux, des paquets fiables acquittés et
// renvoyés tant qu'ils ne le sont pas, des paquets non séquencés, le ping.
// Pas de compression ni de somme de contrôle : Sunshine n'en pose aucune.
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const C = { ACK: 1, CONNECT: 2, VERIFY_CONNECT: 3, DISCONNECT: 4, PING: 5, RELIABLE: 6, UNRELIABLE: 7, FRAGMENT: 8, UNSEQUENCED: 9, BANDWIDTH: 10, THROTTLE: 11, UNRELIABLE_FRAGMENT: 12 };
const F_ACK = 0x80, F_UNSEQ = 0x40, H_TEMPS = 0x8000;
const TAILLES = [0, 8, 48, 44, 8, 4, 6, 8, 24, 8, 12, 16, 24];
const PAIR_INCONNU = 0xfff;
const MTU = 1392, FENETRE = 65536;
const THROTTLE = [5000, 2, 2];
const PING_MS = 500;
const DELAI_MAX = 10000;
const FRAGMENT_MAX = 64 * 1024;

export class ClientEnet extends EventEmitter {
  constructor({ canaux = 1, horloge = () => Date.now() } = {}) {
    super();
    this.canaux = canaux;
    this.horloge = horloge;
    this.etat = 'ferme';
    this.pairSortant = PAIR_INCONNU;
    this.sessionSortante = 0xff; this.sessionEntrante = 0xff;
    this.connectId = crypto.randomBytes(4).readUInt32BE(0);
    this.seqPair = 0;                                  // canal 0xFF
    this.seqSortants = new Array(canaux).fill(0);
    this.seqEntrants = new Array(canaux).fill(0);
    this.groupeNonSeq = 0;
    this.enAttente = new Map();                        // "canal:seq" → { tampon, envoye, essais, rto }
    this.horsOrdre = Array.from({ length: canaux }, () => new Map());
    this.fragments = new Map();
    this.rtt = 100; this.rttVar = 50;
    this.dernierEnvoi = 0; this.derniereReception = 0;
  }

  // Connexion : CONNECT fiable sur le canal 0xFF, « donnees » portées par la
  // commande (Sunshine y attend son X-SS-Connect-Data).
  connecter(hote, port, { donnees = 0, delai = DELAI_MAX } = {}) {
    return new Promise((resolve, reject) => {
      const famille = hote.includes(':') ? 'udp6' : 'udp4';
      this.socket = dgram.createSocket(famille);
      this.socket.on('message', m => this.recevoir(m));
      this.socket.on('error', e => this.fermer(e));
      this.socket.connect(port, hote, () => {
        this.etat = 'connexion';
        const c = Buffer.alloc(TAILLES[C.CONNECT]);
        c.writeUInt16BE(0, 4);                       // notre identifiant de pair : 0
        c[6] = this.sessionEntrante; c[7] = this.sessionSortante;
        c.writeUInt32BE(MTU, 8); c.writeUInt32BE(FENETRE, 12); c.writeUInt32BE(this.canaux, 16);
        c.writeUInt32BE(0, 20); c.writeUInt32BE(0, 24);
        c.writeUInt32BE(THROTTLE[0], 28); c.writeUInt32BE(THROTTLE[1], 32); c.writeUInt32BE(THROTTLE[2], 36);
        c.writeUInt32LE(this.connectId, 40);         // recopié tel quel par l'hôte
        c.writeUInt32BE(donnees >>> 0, 44);
        this.envoyerFiable(0xff, C.CONNECT, c);
        const chien = setTimeout(() => { this.fermer(new Error('ENet : pas de réponse à la connexion')); }, delai);
        this.once('connecte', () => { clearTimeout(chien); resolve(); });
        this.once('ferme', e => { clearTimeout(chien); reject(e || new Error('ENet : connexion refusée')); });
      });
      this.minuteur = setInterval(() => this.entretenir(), 10);
    });
  }

  entete() {
    const h = Buffer.alloc(4);
    let id = this.pairSortant | H_TEMPS;
    if (this.pairSortant < PAIR_INCONNU) id |= this.sessionSortante << 12;
    h.writeUInt16BE(id & 0xffff, 0);
    h.writeUInt16BE(this.horloge() & 0xffff, 2);
    return h;
  }

  emettre(commande) {
    if (!this.socket || this.etat === 'ferme') return;
    this.dernierEnvoi = this.horloge();
    this.socket.send(Buffer.concat([this.entete(), commande]));
  }

  // Une commande fiable : numérotée par canal (0xFF : par pair), gardée
  // jusqu'à son acquittement et renvoyée sinon.
  envoyerFiable(canal, type, corps) {
    const seq = canal === 0xff ? (this.seqPair = (this.seqPair + 1) & 0xffff) : (this.seqSortants[canal] = (this.seqSortants[canal] + 1) & 0xffff);
    corps[0] = type | F_ACK; corps[1] = canal; corps.writeUInt16BE(seq, 2);
    const t = this.horloge();
    this.enAttente.set(`${canal}:${seq}`, { tampon: corps, envoye: t, premier: t, rto: Math.max(50, this.rtt + 4 * this.rttVar) });
    this.emettre(corps);
  }

  // Données applicatives sur un canal : fiables, ou non séquencées.
  envoyer(canal, donnees, { fiable = true } = {}) {
    if (this.etat !== 'connecte') return false;
    if (canal < 0 || canal >= this.canaux) canal = 0;
    if (donnees.length > MTU - 16) throw new Error('ENet : message trop long pour un datagramme');
    if (fiable) {
      const c = Buffer.alloc(6 + donnees.length);
      c.writeUInt16BE(donnees.length, 4); donnees.copy(c, 6);
      this.envoyerFiable(canal, C.RELIABLE, c);
    } else {
      const c = Buffer.alloc(8 + donnees.length);
      c[0] = C.UNSEQUENCED | F_UNSEQ; c[1] = canal; c.writeUInt16BE(0, 2);
      this.groupeNonSeq = (this.groupeNonSeq + 1) & 0xffff;
      c.writeUInt16BE(this.groupeNonSeq, 4); c.writeUInt16BE(donnees.length, 6); donnees.copy(c, 8);
      this.emettre(c);
    }
    return true;
  }

  acquitter(canal, seq, tempsEnvoi) {
    const a = Buffer.alloc(8);
    a[0] = C.ACK; a[1] = canal; a.writeUInt16BE(seq, 2); a.writeUInt16BE(seq, 4); a.writeUInt16BE(tempsEnvoi, 6);
    this.emettre(a);
  }

  recevoir(m) {
    if (m.length < 2) return;
    const id = m.readUInt16BE(0);
    const avecTemps = !!(id & H_TEMPS);
    if (id & 0x4000) return;                          // compressé : jamais demandé
    const pair = id & 0x0fff;
    if (pair !== 0 && pair !== PAIR_INCONNU) return;
    let pos = avecTemps ? 4 : 2;
    if (m.length < pos) return;
    const tempsEnvoi = avecTemps ? m.readUInt16BE(2) : 0;
    this.derniereReception = this.horloge();
    while (pos + 4 <= m.length) {
      const brut = m[pos], type = brut & 0x0f, canal = m[pos + 1], seq = m.readUInt16BE(pos + 2);
      if (type === 0 || type >= TAILLES.length) return;
      const taille = TAILLES[type];
      if (pos + taille > m.length) return;
      let fin = pos + taille;
      if (type === C.RELIABLE || type === C.UNRELIABLE || type === C.UNSEQUENCED || type === C.FRAGMENT || type === C.UNRELIABLE_FRAGMENT) {
        const lg = m.readUInt16BE(pos + taille - (type === C.RELIABLE ? 2 : type === C.FRAGMENT || type === C.UNRELIABLE_FRAGMENT ? 18 : 2));
        fin += lg;
        if (fin > m.length) return;
      }
      // Traitée d'abord : l'acquittement de VERIFY_CONNECT doit porter notre identifiant de pair.
      this.traiter(type, canal, seq, m.subarray(pos, fin), taille);
      if (brut & F_ACK && this.etat !== 'ferme') this.acquitter(canal, seq, tempsEnvoi);
      pos = fin;
    }
  }

  traiter(type, canal, seq, cmd, taille) {
    switch (type) {
      case C.ACK: {
        const cle = `${canal}:${cmd.readUInt16BE(4)}`, a = this.enAttente.get(cle);
        if (a) {
          this.enAttente.delete(cle);
          const mesure = ((this.horloge() & 0xffff) - cmd.readUInt16BE(6)) & 0xffff;
          if (mesure >= 0 && mesure < 10000) { this.rttVar = (3 * this.rttVar + Math.abs(mesure - this.rtt)) / 4; this.rtt = (7 * this.rtt + mesure) / 8; }
        }
        break;
      }
      case C.VERIFY_CONNECT:
        if (this.etat === 'connecte') return;          // répétée : notre acquittement s'est perdu
        if (this.etat !== 'connexion' || cmd.readUInt32LE(40) !== this.connectId) return this.fermer(new Error('ENet : réponse de connexion invalide'));
        this.pairSortant = cmd.readUInt16BE(4);
        this.sessionEntrante = cmd[6]; this.sessionSortante = cmd[7];
        this.enAttente.delete(`255:1`);
        this.canaux = Math.min(this.canaux, cmd.readUInt32BE(16) || 1);
        this.etat = 'connecte';
        this.emit('connecte');
        break;
      case C.DISCONNECT:
        this.fermer(null, { distant: true });
        break;
      case C.RELIABLE: {
        if (canal >= this.canaux) return;
        const attendu = (this.seqEntrants[canal] + 1) & 0xffff;
        const ecart = (seq - attendu) & 0xffff;
        if (ecart >= 0x8000) return;                  // déjà reçu (doublon)
        const donnees = Buffer.from(cmd.subarray(taille));
        if (ecart > 0) { if (this.horsOrdre[canal].size < 256) this.horsOrdre[canal].set(seq, donnees); return; }
        this.livrer(canal, seq, donnees);
        break;
      }
      case C.UNRELIABLE: case C.UNSEQUENCED:
        if (canal < this.canaux) this.emit('message', canal, Buffer.from(cmd.subarray(taille)));
        break;
      case C.FRAGMENT: case C.UNRELIABLE_FRAGMENT: {
        const debut = cmd.readUInt16BE(4), nb = cmd.readUInt32BE(8), num = cmd.readUInt32BE(12), total = cmd.readUInt32BE(16), off = cmd.readUInt32BE(20);
        const donnees = cmd.subarray(taille);
        if (total > FRAGMENT_MAX || nb > 1024 || num >= nb || off + donnees.length > total) return;
        const cle = `${canal}:${debut}`;
        let f = this.fragments.get(cle);
        if (!f) { if (this.fragments.size > 16) this.fragments.clear(); f = { tampon: Buffer.alloc(total), recus: new Set(), nb }; this.fragments.set(cle, f); }
        if (!f.recus.has(num)) { donnees.copy(f.tampon, off); f.recus.add(num); }
        if (type === C.FRAGMENT && canal < this.canaux) {
          const attendu = (this.seqEntrants[canal] + 1) & 0xffff;
          if (seq === attendu) this.seqEntrants[canal] = seq;
        }
        if (f.recus.size === f.nb) { this.fragments.delete(cle); this.emit('message', canal, f.tampon); }
        break;
      }
      default: break;                                  // PING (acquitté), bande passante, régulation
    }
  }

  livrer(canal, seq, donnees) {
    this.seqEntrants[canal] = seq;
    this.emit('message', canal, donnees);
    const suivant = (seq + 1) & 0xffff, attente = this.horsOrdre[canal].get(suivant);
    if (attente) { this.horsOrdre[canal].delete(suivant); this.livrer(canal, suivant, attente); }
  }

  entretenir() {
    const t = this.horloge();
    for (const [cle, a] of this.enAttente) {
      if (t - a.premier > DELAI_MAX) return this.fermer(new Error('ENet : l\'hôte ne répond plus'));
      if (t - a.envoye >= a.rto) { a.envoye = t; a.rto = Math.min(a.rto * 2, 2000); this.emettre(a.tampon); }
      if (!this.enAttente.has(cle)) break;
    }
    if (this.etat === 'connecte' && t - this.dernierEnvoi >= PING_MS) {
      this.envoyerFiable(0xff, C.PING, Buffer.alloc(4));
    }
    if (this.etat === 'connecte' && this.derniereReception && t - this.derniereReception > DELAI_MAX) this.fermer(new Error('ENet : plus de nouvelles de l\'hôte'));
  }

  fermer(erreur = null, { distant = false } = {}) {
    if (this.etat === 'ferme' && !this.socket) return;
    const etait = this.etat;
    if (etait === 'connecte' && !distant) {
      const d = Buffer.alloc(8);
      d[0] = C.DISCONNECT | F_UNSEQ; d[1] = 0xff;
      try { this.socket.send(Buffer.concat([this.entete(), d])); } catch { /* socket déjà close */ }
    }
    this.etat = 'ferme';
    clearInterval(this.minuteur);
    const s = this.socket; this.socket = null;
    if (s) setTimeout(() => { try { s.close(); } catch { /* déjà fermée */ } }, 50).unref();
    this.enAttente.clear();
    this.emit('ferme', erreur, { distant });
  }
}
