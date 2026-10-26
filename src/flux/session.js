// Une session d'écran fluide : ProxLab, client Moonlight de Sunshine, lance le
// bureau, fait la poignée RTSP, ouvre le contrôle chiffré et reçoit la vidéo.
// Il en sort des images H.264/HEVC complètes, et il y entre des touches et des
// gestes de souris.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Rtsp, ENC } from './rtsp.js';
import { Controle, CANAL } from './controle.js';
import { FluxVideo } from './video.js';
import { ErreurFlux, lookupInterne } from './hote.js';
import net from 'node:net';

// L'adresse de Sunshine, résolue une fois par la résolution gardée : les
// sockets UDP (contrôle, vidéo, son) visent cette adresse, jamais un nom.
const resoudre = hote => (net.isIP(hote) ? Promise.resolve(hote) : new Promise((ok, ko) => lookupInterne(hote, {}, (e, a) => (e ? ko(e) : ok(a)))));

const TAILLE_PAQUET = 1392;
const IDR_MIN_MS = 250;
const PREMIERE_IMAGE_MS = 12000;

// Paquets d'entrée GameStream (en-tête : taille BE sans elle-même, type LE).
const entete = (taille, type) => { const b = Buffer.alloc(taille); b.writeUInt32BE(taille - 4, 0); b.writeUInt32LE(type >>> 0, 4); return b; };
export const ENTREE = {
  touche(vk, bas, mods = 0) {
    const b = entete(14, bas ? 0x03 : 0x04);
    b[8] = 0; b.writeUInt16LE(vk & 0xffff, 9); b[11] = mods & 0x1f; b.writeUInt16LE(0, 12);
    return b;
  },
  position(x, y, largeur, hauteur) {
    const b = entete(18, 0x05);
    b.writeInt16BE(x, 8); b.writeInt16BE(y, 10); b.writeInt16BE(0, 12);
    b.writeInt16BE(Math.max(1, largeur - 1), 14); b.writeInt16BE(Math.max(1, hauteur - 1), 16);
    return b;
  },
  bouton(n, bas) { const b = entete(9, bas ? 0x08 : 0x09); b[8] = n; return b; },
  molette(quantite) { const b = entete(14, 0x0a); b.writeInt16BE(quantite, 8); b.writeInt16BE(quantite, 10); b.writeInt16BE(0, 12); return b; },
  moletteH(quantite) { const b = entete(10, 0x55000001); b.writeInt16BE(quantite, 8); return b; },
};

export class SessionFlux extends EventEmitter {
  constructor({ hote, appId, largeur, hauteur, ips = 60, debitKbps = 20000, hevc = false }) {
    super();
    Object.assign(this, { hote, appId, largeur, hauteur, ips, debitKbps, hevc });
    this.cle = crypto.randomBytes(16);
    this.cleId = crypto.randomInt(0, 0x7fffffff);
    this.dernierIdr = 0; this.fini = false;
  }

  async demarrer() {
    // Le bureau tourne déjà dans Sunshine (session précédente, quittée sans
    // l'arrêter) : on le reprend. Une autre application : arrêtée d'abord.
    const infos = await this.hote.infos({ chiffre: true });
    if (infos.sessionEnCours && infos.sessionEnCours !== this.appId) await this.hote.arreter();
    const reprendre = infos.sessionEnCours === this.appId;
    const url = await this.hote.lancer({ appId: this.appId, largeur: this.largeur, hauteur: this.hauteur, ips: this.ips, cle: this.cle, cleId: this.cleId, reprendre });
    if (this.fini) throw new ErreurFlux('session arrêtée');
    const rtsp = new Rtsp({ url, cle: this.cle });
    // L'adresse que l'URL de session annonce n'est pas suivie : seul l'hôte
    // réglé (réseau interne) est joint ; l'URL ne donne que le port.
    rtsp.hote = await resoudre(this.hote.hote);
    const r = await rtsp.poignee({ largeur: this.largeur, hauteur: this.hauteur, ips: this.ips, debitKbps: this.debitKbps, taillePaquet: TAILLE_PAQUET, hevc: this.hevc });
    if (this.fini) throw new ErreurFlux('session arrêtée');
    this.codec = r.hevc ? 'hevc' : 'h264';
    this.controle = new Controle({ cle: this.cle });
    this.controle.on('fin', m => this.finir(m));
    await this.controle.demarrer({ hote: rtsp.hote, port: r.portControle, donnees: r.donneeConnexion });
    this.video = new FluxVideo({ hote: rtsp.hote, portVideo: r.portVideo, portAudio: r.portAudio, pingVideo: r.pingVideo, pingAudio: r.pingAudio, cle: this.cle, chiffre: !!(r.chiffrement & ENC.VIDEO), taillePaquet: r.taillePaquet });
    this.video.on('image', i => this.emit('image', i));
    this.video.on('perte', () => this.demanderImageComplete());
    this.video.on('erreur', e => this.finir(`vidéo : ${e.message}`));
    await this.video.demarrer();
    this.chiffrementVideo = !!(r.chiffrement & ENC.VIDEO);
    // Sans première image en quelques secondes, la session ne sert à rien.
    this.chien = setTimeout(() => { if (!this.video.file.stats.images) this.finir('aucune image reçue de Sunshine'); }, PREMIERE_IMAGE_MS);
    // Un léger mouvement réveille l'écran de la machine.
    this.entreeSouris(ENTREE.position(1, 1, this.largeur, this.hauteur));
    return { codec: this.codec, largeur: this.largeur, hauteur: this.hauteur, ips: this.ips, chiffre: this.chiffrementVideo };
  }

  demanderImageComplete() {
    const t = Date.now();
    if (t - this.dernierIdr < IDR_MIN_MS) return;
    this.dernierIdr = t;
    this.controle?.demanderImageComplete();
  }

  entreeClavier(paquet) { return this.controle?.entree(paquet, CANAL.CLAVIER); }
  entreeSouris(paquet) { return this.controle?.entree(paquet, CANAL.SOURIS); }

  stats() { return { ...(this.video?.file.stats || {}), son: this.video?.sonRecu || 0 }; }

  finir(raison = null) {
    if (this.fini) return;
    this.fini = true;
    clearTimeout(this.chien);
    try { this.controle?.fermer(); } catch { /* déjà fermé */ }
    try { this.video?.fermer(); } catch { /* déjà fermé */ }
    this.emit('fin', raison);
  }

  // Fin côté ProxLab : le flux s'arrête, le bureau reste « lancé » dans
  // Sunshine et la prochaine ouverture le reprend. L'arrêter ici ferait la
  // course avec une réouverture (changement de qualité) et couperait la neuve.
  async arreter() {
    this.finir(null);
  }
}
