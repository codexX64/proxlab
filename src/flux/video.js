// La vidéo d'une session Sunshine : paquets RTP sur UDP, chiffrés (AES-GCM)
// quand la session l'a négocié, regroupés par image et par bloc de FEC ; les
// paquets perdus sont retrouvés par Reed-Solomon quand la parité suffit. Une
// image complète sort en H.264/HEVC Annex B ; après une perte, rien ne sort
// avant la prochaine image complète (IDR), demandée aussitôt.
//
// Le son est reçu (Sunshine coupe la session sans son ping) et compté, pas
// relayé.
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { decoder as rsDecoder } from './rs.js';

const RTP = 16;                     // en-tête RTP (12) et son extension (4)
const NV = 16;                      // en-tête vidéo GameStream
const PREFIXE_CHIFFRE = 32;         // iv (12), numéro d'image (4), étiquette (16)
const ENTETE_IMAGE = 8;             // en-tête court de Sunshine, au début de l'image
const PING_MS = 500;
const IMAGE_MAX = 16 * 1024 * 1024;
const F = { DONNEES: 0x1, FIN: 0x2, DEBUT: 0x4 };

export const avant32 = (a, b) => ((a - b) | 0) < 0;
export const avant16 = (a, b) => (((a - b) & 0xffff) >= 0x8000);

export function ouvrirPaquetVideo(brut, cle) {
  if (brut.length <= PREFIXE_CHIFFRE) return null;
  const d = crypto.createDecipheriv('aes-128-gcm', cle, brut.subarray(0, 12));
  d.setAuthTag(brut.subarray(16, 32));
  try { return Buffer.concat([d.update(brut.subarray(PREFIXE_CHIFFRE)), d.final()]); } catch { return null; }
}

// La file des images : paquets → images complètes. Sans réseau, pour les essais.
export class FileImages extends EventEmitter {
  constructor({ taillePaquet }) {
    super();
    this.bloc = taillePaquet + RTP;               // taille de chaque paquet (données et parité)
    this.utile = taillePaquet - NV;               // charge d'un paquet de données
    this.image = 1;                               // prochaine image attendue
    this.blocAttendu = 0;                         // son prochain bloc de FEC
    this.courant = null;                          // bloc en cours de réception
    this.blocsFaits = [];                         // charges des blocs complets de l'image
    this.attenteIdr = true;                       // rien ne sort avant une image complète (IDR)
    this.stats = { paquets: 0, images: 0, recuperes: 0, perdues: 0, rejetes: 0 };
  }

  ajouter(p) {
    this.stats.paquets++;
    if (p.length < RTP + NV || p.length > this.bloc + 64) { this.stats.rejetes++; return; }
    const seq = p.readUInt16BE(2);
    const image = p.readUInt32LE(RTP + 4);
    const mfb = p[RTP + 11], fecInfo = p.readUInt32LE(RTP + 12);
    const numBloc = (mfb >> 4) & 3, dernierBloc = (mfb >> 6) & 3;
    const indexFec = (fecInfo >>> 12) & 0x3ff, d = fecInfo >>> 22, pct = (fecInfo >>> 4) & 0xff;
    if (d < 1 || d > 255 || numBloc > dernierBloc) { this.stats.rejetes++; return; }
    if (this.courant && (this.courant.image !== image || this.courant.numBloc !== numBloc)) {
      if (avant32(image, this.courant.image) || (image === this.courant.image && numBloc < this.courant.numBloc)) return;
      this.perte(this.courant.image);              // bloc abandonné : l'image est perdue
    }
    if (avant32(image, this.image) || (image === this.image && numBloc < this.blocAttendu)) return;
    if (!this.courant) {
      if (image !== this.image) {                  // images entières jamais reçues
        this.stats.perdues += Math.min(1000, (image - this.image) >>> 0);
        this.image = image; this.blocAttendu = 0; this.blocsFaits = [];
        this.marquerPerte();
      }
      if (numBloc !== this.blocAttendu) { this.perte(image); return; }
      const nbParite = Math.min(255 - d, Math.floor((d * pct + 99) / 100));
      this.courant = { image, numBloc, dernierBloc, debutSeq: (seq - indexFec) & 0xffff, d, p: nbParite, paquets: new Array(d + nbParite).fill(null), recus: 0 };
    }
    const k = this.courant;
    const i = (seq - k.debutSeq) & 0xffff;
    if (i >= k.d + k.p || k.paquets[i]) return;
    const copie = Buffer.alloc(this.bloc);
    p.copy(copie, 0, 0, Math.min(p.length, this.bloc));
    k.paquets[i] = copie; k.recus++;
    if (k.recus >= k.d) this.terminerBloc();
  }

  terminerBloc() {
    const k = this.courant;
    let manquants = 0;
    for (let i = 0; i < k.d; i++) if (!k.paquets[i]) manquants++;
    if (manquants) {
      if (!rsDecoder(k.paquets, k.d, k.p, this.bloc)) return;       // attendre plus de parité
      this.stats.recuperes += manquants;
    }
    for (let i = 0; i < k.d; i++) {
      const q = k.paquets[i];
      this.blocsFaits.push(Buffer.from(q.buffer, q.byteOffset + RTP + NV, this.utile));
    }
    this.courant = null;
    if (k.numBloc < k.dernierBloc) { this.blocAttendu = k.numBloc + 1; return; }
    this.sortir(k.image);
  }

  sortir(image) {
    const charges = this.blocsFaits; this.blocsFaits = [];
    this.image = (image + 1) >>> 0; this.blocAttendu = 0;
    const premier = charges[0];
    if (!premier || premier[0] !== 0x01) { this.stats.perdues++; this.marquerPerte(); return; }
    const genre = premier[3];                                         // 2 : IDR
    let dernier = premier.readUInt16LE(4);
    if (!dernier || dernier > this.utile) dernier = this.utile;
    const total = (charges.length - 1) * this.utile + dernier;
    if (total <= ENTETE_IMAGE || total > IMAGE_MAX) { this.stats.perdues++; this.marquerPerte(); return; }
    const donnees = Buffer.concat(charges, total).subarray(ENTETE_IMAGE);
    const cle = genre === 2;
    if (this.attenteIdr && !cle) return;
    this.attenteIdr = false;
    this.stats.images++;
    this.emit('image', { donnees, cle, numero: image, latenceHote: premier.readUInt16LE(1) });
  }

  perte(image) {
    this.stats.perdues++;
    if (!avant32(image, this.image)) { this.image = (image + 1) >>> 0; this.blocAttendu = 0; }
    this.courant = null; this.blocsFaits = [];
    this.marquerPerte();
  }
  marquerPerte() {
    this.attenteIdr = true;
    this.emit('perte');
  }
}

// Les sockets : vidéo (et son, pour le ping), envoi des pings, déchiffrement.
export class FluxVideo extends EventEmitter {
  constructor({ hote, portVideo, portAudio, pingVideo, pingAudio, cle, chiffre, taillePaquet }) {
    super();
    Object.assign(this, { hote, portVideo, portAudio, pingVideo, pingAudio, cle, chiffre });
    this.file = new FileImages({ taillePaquet });
    this.file.on('image', i => this.emit('image', i));
    this.file.on('perte', () => this.emit('perte'));
    this.sonRecu = 0; this.premierPaquet = 0;
  }

  async demarrer() {
    const famille = this.hote.includes(':') ? 'udp6' : 'udp4';
    const ouvrir = (port, surMessage) => new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: famille, recvBufferSize: 8 * 1024 * 1024 });
      s.on('message', (m, info) => { if (info.address === this.hote || info.address === `::ffff:${this.hote}`) surMessage(m); });
      s.once('error', reject);
      s.bind(0, () => { s.removeListener('error', reject); s.on('error', e => this.emit('erreur', e)); resolve(s); });
    });
    this.sVideo = await ouvrir(this.portVideo, m => this.paquet(m));
    this.sAudio = await ouvrir(this.portAudio, () => { this.sonRecu++; });
    try { this.sVideo.setRecvBufferSize(8 * 1024 * 1024); } catch { /* le noyau borne la taille */ }
    let n = 0;
    const pinguer = () => {
      n++;
      for (const [s, port, charge] of [[this.sVideo, this.portVideo, this.pingVideo], [this.sAudio, this.portAudio, this.pingAudio]]) {
        let msg;
        if (charge) { msg = Buffer.alloc(20); msg.write(charge, 0, 16, 'latin1'); msg.writeUInt32BE(n, 16); } else msg = Buffer.from('PING');
        s.send(msg, port, this.hote);
      }
    };
    pinguer();
    this.minuteur = setInterval(pinguer, PING_MS);
  }

  paquet(m) {
    if (!this.premierPaquet) this.premierPaquet = Date.now();
    let p = m;
    if (this.chiffre) {
      if (m.length <= PREFIXE_CHIFFRE) return;
      const numero = m.readUInt32LE(12);
      if (numero && avant32(numero, this.file.image)) return;          // image passée : pas la peine de déchiffrer
      p = ouvrirPaquetVideo(m, this.cle);
      if (!p) { this.file.stats.rejetes++; return; }
    }
    this.file.ajouter(p);
  }

  fermer() {
    clearInterval(this.minuteur);
    for (const s of [this.sVideo, this.sAudio]) { try { s?.close(); } catch { /* déjà fermée */ } }
  }
}
