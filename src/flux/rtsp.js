// La poignée RTSP d'une session Sunshine : une requête par connexion TCP,
// chiffrée (AES-GCM, clé de la session) quand l'URL est « rtspenc:// ».
// OPTIONS, DESCRIBE, SETUP audio/vidéo/contrôle, ANNOUNCE (nos paramètres de
// flux en SDP), PLAY. Rend les ports, les charges de ping et la donnée de
// connexion du contrôle.
import net from 'node:net';
import crypto from 'node:crypto';
import { ErreurFlux, lookupInterne } from './hote.js';

const REPONSE_MAX = 64 * 1024;
const BIT_CHIFFRE = 0x80000000;
export const ENC = { CONTROLE_V2: 0x01, VIDEO: 0x02, AUDIO: 0x04 };
const ML_FF_SESSION_ID_V1 = 0x02;
export const ENTETE_VIDEO_CHIFFREE = 32;

export function analyserUrl(url) {
  const m = /^(rtspenc|rtsp):\/\/(\[[0-9a-fA-F:.]+\]|[^:/\s]+)(?::(\d{1,5}))?/.exec(url || '');
  if (!m) throw new ErreurFlux('URL de session invalide');
  const port = Number(m[3] || 48010);
  if (!port || port > 65535) throw new ErreurFlux('URL de session invalide');
  return { chiffre: m[1] === 'rtspenc', hote: m[2].replace(/^\[|\]$/g, ''), port, url };
}

function iv(seq, origine) {
  const v = Buffer.alloc(12);
  v.writeUInt32LE(seq >>> 0, 0);
  v[10] = origine.charCodeAt(0); v[11] = 'R'.charCodeAt(0);
  return v;
}

export function sceller(texte, cle, seq) {
  const clair = Buffer.from(texte, 'utf8');
  const c = crypto.createCipheriv('aes-128-gcm', cle, iv(seq, 'C'));
  const chiffre = Buffer.concat([c.update(clair), c.final()]);
  const h = Buffer.alloc(24);
  h.writeUInt32BE((BIT_CHIFFRE | clair.length) >>> 0, 0);
  h.writeUInt32BE(seq >>> 0, 4);
  c.getAuthTag().copy(h, 8);
  return Buffer.concat([h, chiffre]);
}

export function desceller(brut, cle) {
  if (brut.length <= 24) throw new ErreurFlux('réponse RTSP chiffrée trop courte');
  const tl = brut.readUInt32BE(0);
  if (!(tl & BIT_CHIFFRE)) throw new ErreurFlux('réponse RTSP non chiffrée refusée');
  const lg = (tl & ~BIT_CHIFFRE) >>> 0;
  if (lg + 24 !== brut.length) throw new ErreurFlux('réponse RTSP chiffrée de longueur incohérente');
  const d = crypto.createDecipheriv('aes-128-gcm', cle, iv(brut.readUInt32BE(4), 'H'));
  d.setAuthTag(brut.subarray(8, 24));
  try { return Buffer.concat([d.update(brut.subarray(24)), d.final()]).toString('utf8'); }
  catch { throw new ErreurFlux('réponse RTSP falsifiée ou mal chiffrée'); }
}

export function analyserReponse(texte) {
  const fin = texte.indexOf('\r\n\r\n');
  const tete = (fin < 0 ? texte : texte.slice(0, fin)).split('\r\n');
  const m = /^RTSP\/1\.0 (\d{3})/.exec(tete[0] || '');
  if (!m) throw new ErreurFlux('réponse RTSP illisible');
  const options = {};
  for (const l of tete.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) options[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { statut: Number(m[1]), options, corps: fin < 0 ? '' : texte.slice(fin + 4) };
}

// Les paramètres de flux que Sunshine attend dans l'ANNOUNCE (SDP).
export function sdp({ adresse, portVideo, largeur, hauteur, ips, debitKbps, taillePaquet, hevc, chiffrement, local = true }) {
  const debit = Math.min(100000, Math.floor(debitKbps * 0.8));
  const a = [
    ['x-ml-general.featureFlags', ML_FF_SESSION_ID_V1],
    ['x-ss-general.encryptionEnabled', chiffrement],
    ['x-ss-video[0].chromaSamplingType', 0],
    ['x-nv-video[0].clientViewportWd', largeur],
    ['x-nv-video[0].clientViewportHt', hauteur],
    ['x-nv-video[0].maxFPS', ips],
    ['x-nv-video[0].packetSize', taillePaquet],
    ['x-nv-video[0].rateControlMode', 4],
    ['x-nv-video[0].timeoutLengthMs', 7000],
    ['x-nv-video[0].framesWithInvalidRefThreshold', 0],
    ['x-nv-video[0].initialBitrateKbps', debit],
    ['x-nv-video[0].initialPeakBitrateKbps', debit],
    ['x-nv-vqos[0].bw.minimumBitrateKbps', debit],
    ['x-nv-vqos[0].bw.maximumBitrateKbps', debit],
    ['x-ml-video.configuredBitrateKbps', debitKbps],
    ['x-nv-vqos[0].fec.enable', 1],
    ['x-nv-vqos[0].videoQualityScoreUpdateTime', 5000],
    ['x-nv-vqos[0].qosTrafficType', local ? 5 : 0],
    ['x-nv-aqos.qosTrafficType', local ? 4 : 0],
    ['x-nv-general.featureFlags', 0x07 | 0x80 | (chiffrement & ENC.AUDIO ? 0x20 : 0)],
    ['x-nv-general.useReliableUdp', 13],
    ['x-nv-vqos[0].fec.minRequiredFecPackets', 2],
    ['x-nv-vqos[0].bllFec.enable', 0],
    ['x-nv-vqos[0].drc.enable', 0],
    ['x-nv-general.enableRecoveryMode', 0],
    ['x-nv-video[0].videoEncoderSlicesPerFrame', 1],
    ['x-nv-clientSupportHevc', hevc ? 1 : 0],
    ['x-nv-vqos[0].bitStreamFormat', hevc ? 1 : 0],
    ['x-nv-video[0].dynamicRangeMode', 0],
    ['x-nv-video[0].maxNumReferenceFrames', 1],
    ['x-nv-video[0].clientRefreshRateX100', ips * 100],
    ['x-nv-audio.surround.numChannels', 2],
    ['x-nv-audio.surround.channelMask', 3],
    ['x-nv-audio.surround.enable', 0],
    ['x-nv-audio.surround.AudioQuality', 0],
    ['x-nv-aqos.packetDuration', 5],
    // Rec. 709, plage limitée : (espace << 1) | plage.
    ['x-nv-video[0].encoderCscMode', 2],
  ];
  const famille = adresse.includes(':') ? 'IPv6' : 'IPv4';
  return `v=0\r\no=android 0 14 IN ${famille} ${adresse}\r\ns=NVIDIA Streaming Client\r\n`
    + a.map(([n, v]) => `a=${n}:${v} \r\n`).join('')
    + `t=0 0\r\nm=video ${portVideo}  \r\n`;
}

const attributUint = (corps, nom) => {
  const i = corps.indexOf(nom);
  if (i < 0) return 0;
  const m = /^[^:]*:\s*(0x[0-9a-fA-F]+|\d+)/.exec(corps.slice(i, i + 80));
  return m ? Number(m[1]) >>> 0 : 0;
};
const portDe = transport => {
  const m = /server_port=(\d{1,5})/.exec(transport || '');
  const p = m ? Number(m[1]) : 0;
  return p > 0 && p <= 65535 ? p : 0;
};

export class Rtsp {
  constructor({ url, cle, timeout = 10000 }) {
    Object.assign(this, analyserUrl(url));
    this.cle = cle; this.timeout = timeout;
    this.cseq = 1; this.seqChiffre = 0; this.session = null;
  }

  requete(commande, cible, options = {}, corps = '') {
    const hoteEntete = this.hote.includes(':') ? `[${this.hote}]` : this.hote;
    const lignes = [`${commande} ${cible} RTSP/1.0`, `CSeq: ${this.cseq++}`, 'X-GS-ClientVersion: 14', `Host: ${hoteEntete}`];
    if (this.session && commande !== 'OPTIONS' && commande !== 'DESCRIBE') lignes.push(`Session: ${this.session}`);
    for (const [k, v] of Object.entries(options)) lignes.push(`${k}: ${v}`);
    if (corps) lignes.push(`Content-length: ${Buffer.byteLength(corps)}`);
    const texte = lignes.join('\r\n') + '\r\n\r\n' + corps;
    return new Promise((resolve, reject) => {
      const morceaux = []; let n = 0;
      const s = net.connect({ host: this.hote, port: this.port, lookup: lookupInterne, timeout: this.timeout }, () => {
        s.setNoDelay(true);
        s.write(this.chiffre ? sceller(texte, this.cle, ++this.seqChiffre) : Buffer.from(texte));
      });
      s.on('data', d => { n += d.length; if (n > REPONSE_MAX) { s.destroy(); reject(new ErreurFlux('réponse RTSP trop longue')); } else morceaux.push(d); });
      s.on('end', () => {
        try {
          const brut = Buffer.concat(morceaux);
          if (!brut.length) throw new ErreurFlux(`RTSP ${commande} : connexion fermée sans réponse`);
          const r = analyserReponse(this.chiffre ? desceller(brut, this.cle) : brut.toString('utf8'));
          if (r.statut !== 200) throw new ErreurFlux(`RTSP ${commande} refusé (${r.statut})`, 'refus');
          resolve(r);
        } catch (e) { reject(e); }
      });
      s.once('timeout', () => { s.destroy(); reject(new ErreurFlux(`RTSP ${commande} : délai dépassé`, 'delai')); });
      s.once('error', e => reject(e instanceof ErreurFlux ? e : new ErreurFlux(`RTSP injoignable : ${e.code || e.message}`, 'injoignable')));
    });
  }

  // La poignée entière. « parametres » complète le SDP (taille, débit, codec).
  async poignee(parametres) {
    const entete = { 'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' };
    await this.requete('OPTIONS', this.url);
    const d = await this.requete('DESCRIBE', this.url, { Accept: 'application/sdp', ...entete });
    const corps = d.corps;
    const hevcPossible = corps.includes('sprop-parameter-sets=AAAAAU');
    const supporte = attributUint(corps, 'x-ss-general.encryptionSupported');
    const demande = attributUint(corps, 'x-ss-general.encryptionRequested');
    // Contrôle chiffré dès que possible ; vidéo chiffrée si Sunshine sait le
    // faire (l'image ne circule jamais en clair) ; son seulement s'il l'exige.
    let chiffrement = 0;
    if (supporte & ENC.CONTROLE_V2) chiffrement |= ENC.CONTROLE_V2;
    if (supporte & ENC.VIDEO || demande & ENC.VIDEO) chiffrement |= ENC.VIDEO;
    if (demande & ENC.AUDIO) chiffrement |= ENC.AUDIO;
    if (!(chiffrement & ENC.CONTROLE_V2)) throw new ErreurFlux('ce Sunshine ne chiffre pas le contrôle : version trop ancienne', 'version');

    const transport = { Transport: 'unicast;X-GS-ClientPort=50000-50001', ...entete };
    const audio = await this.requete('SETUP', 'streamid=audio/0/0', transport);
    const sess = (audio.options.session || '').split(';')[0].trim();
    if (!sess || sess.length > 128) throw new ErreurFlux('RTSP : session absente');
    this.session = sess;
    const video = await this.requete('SETUP', 'streamid=video/0/0', transport);
    const controle = await this.requete('SETUP', 'streamid=control/13/0', transport);
    const ping = v => (v && v.length === 16 ? v : null);
    const r = {
      portAudio: portDe(audio.options.transport) || 48000,
      portVideo: portDe(video.options.transport) || 47998,
      portControle: portDe(controle.options.transport) || 47999,
      pingAudio: ping(audio.options['x-ss-ping-payload']),
      pingVideo: ping(video.options['x-ss-ping-payload']),
      donneeConnexion: Number(controle.options['x-ss-connect-data'] || 0) >>> 0,
      chiffrement, hevcPossible,
    };
    const hevc = !!parametres.hevc && hevcPossible;
    const taillePaquet = parametres.taillePaquet - (chiffrement & ENC.VIDEO ? ENTETE_VIDEO_CHIFFREE : 0);
    await this.requete('ANNOUNCE', 'streamid=control/13/0', { 'Content-type': 'application/sdp' },
      sdp({ adresse: this.hote, portVideo: r.portVideo, ...parametres, hevc, taillePaquet, chiffrement }));
    await this.requete('PLAY', '/');
    return { ...r, hevc, taillePaquet };
  }
}
