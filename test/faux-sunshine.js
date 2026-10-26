// Un faux Sunshine pour les essais de l'écran fluide : HTTP et HTTPS de
// GameStream (appairage par PIN, liste des applications, lancement), RTSP
// chiffré, contrôle ENet chiffré et vidéo RTP chiffrée avec FEC. Il suit le
// protocole tel que Sunshine le parle ; le vrai a été éprouvé à part.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { nouvelleIdentite, signatureDe } from '../src/flux/certificat.js';
import { encoder as rsEncoder } from '../src/flux/rs.js';

const xml = (champs, statut = 200, message = 'OK') => `<?xml version="1.0" encoding="utf-8"?><root status_code="${statut}" status_message="${message}">${Object.entries(champs).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</root>`;
const ecouter = (serveur, hote = '127.0.0.1', port = 0) => new Promise((r, rej) => { serveur.once('error', rej); serveur.listen(port, hote, () => r(serveur.address().port)); });

// hote, portHttp, portHttps : la vitrine le pose sur une autre adresse de bouclage, aux ports habituels.
export async function fauxSunshine({ version = '7.1.431.-1', chiffrementVideo = true, hote = '127.0.0.1', portHttp = 0, portHttps = 0 } = {}) {
  const id = nouvelleIdentite({ cn: 'Sunshine Gamestream Host' });
  const f = {
    version, pin: null, pinAttendu: null, appaire: null, sessions: 0, controle: [], entrees: [], pings: { video: 0, audio: 0 },
    pret: null, clientVideo: null, perdre: new Set(), chiffrementVideo, hote,
  };
  let paire = {};                                   // l'appairage en cours

  // --- HTTP (en clair) : serverinfo et étapes de l'appairage.
  const srvHttp = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams);
    const fin = corps => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(corps); };
    if (u.pathname === '/serverinfo') return fin(xml({ hostname: 'sunshine-essai', appversion: f.version, GfeVersion: '3.23.0.74', PairStatus: 0, currentgame: 0, ServerCodecModeSupport: 1 }));
    if (u.pathname === '/unpair') { paire = {}; return fin(xml({ paired: 0 })); }
    if (u.pathname !== '/pair') return fin(xml({}, 404, 'inconnu'));
    try {
      if (q.phrase === 'getservercert') {
        // Le PIN est saisi « dans l'interface » : l'essai le pose par saisirPin().
        for (let i = 0; i < 400 && !f.pin; i++) await new Promise(r => setTimeout(r, 10));
        if (!f.pin) return fin(xml({ paired: 0 }));
        const sel = Buffer.from(q.salt, 'hex');
        paire = { cle: crypto.createHash('sha256').update(Buffer.concat([sel, Buffer.from(f.pin)])).digest().subarray(0, 16), certClient: Buffer.from(q.clientcert, 'hex').toString() };
        f.pin = null;
        return fin(xml({ paired: 1, plaincert: Buffer.from(id.certPem).toString('hex') }));
      }
      const aes = (sens, d) => { const c = (sens ? crypto.createCipheriv : crypto.createDecipheriv)('aes-128-ecb', paire.cle, null); c.setAutoPadding(false); return Buffer.concat([c.update(d), c.final()]); };
      if (q.clientchallenge) {
        const defi = aes(false, Buffer.from(q.clientchallenge, 'hex'));
        paire.secretServeur = crypto.randomBytes(16); paire.defiServeur = crypto.randomBytes(16);
        const h = crypto.createHash('sha256').update(Buffer.concat([defi, signatureDe(id.certPem), paire.secretServeur])).digest();
        return fin(xml({ paired: 1, challengeresponse: aes(true, Buffer.concat([h, paire.defiServeur])).toString('hex') }));
      }
      if (q.serverchallengeresp) {
        paire.hashClient = aes(false, Buffer.from(q.serverchallengeresp, 'hex')).subarray(0, 32);
        const sig = crypto.sign('sha256', paire.secretServeur, id.clePem);
        return fin(xml({ paired: 1, pairingsecret: Buffer.concat([paire.secretServeur, sig]).toString('hex') }));
      }
      if (q.clientpairingsecret) {
        const b = Buffer.from(q.clientpairingsecret, 'hex'), secret = b.subarray(0, 16), sig = b.subarray(16);
        const ok = crypto.verify('sha256', secret, new crypto.X509Certificate(paire.certClient).publicKey, sig)
          && crypto.createHash('sha256').update(Buffer.concat([paire.defiServeur, signatureDe(paire.certClient), secret])).digest().equals(paire.hashClient);
        if (ok) f.appaire = paire.certClient;
        return fin(xml({ paired: ok ? 1 : 0 }));
      }
    } catch { /* étape invalide */ }
    return fin(xml({ paired: 0 }));
  });
  f.portHttp = await ecouter(srvHttp, hote, portHttp);

  // --- HTTPS : le certificat client appairé est exigé.
  const srvHttps = https.createServer({ cert: id.certPem, key: id.clePem, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    const u = new URL(req.url, 'https://x'), q = Object.fromEntries(u.searchParams);
    const fin = corps => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(corps); };
    const c = req.socket.getPeerCertificate();
    if (!f.appaire || !c?.raw || !c.raw.equals(new crypto.X509Certificate(f.appaire).raw)) return fin(xml({}, 401, 'The client is not authorized'));
    if (u.pathname === '/serverinfo') return fin(xml({ hostname: 'sunshine-essai', appversion: f.version, PairStatus: 1, currentgame: f.enCours || 0, ServerCodecModeSupport: 1 }));
    if (u.pathname === '/pair') return fin(xml({ paired: 1 }));
    if (u.pathname === '/applist') return fin(xml({ App: '<AppTitle>Steam Big Picture</AppTitle><ID>1093255277</ID></App><App><AppTitle>Desktop</AppTitle><ID>881448767</ID>' }));
    if (u.pathname === '/launch' || u.pathname === '/resume') {
      // Comme Sunshine : lancer quand une application tourne est refusé, la reprendre non.
      if (u.pathname === '/launch' && f.enCours) return fin(xml({}, 400, 'An app is already running on this host'));
      if (u.pathname === '/resume' && !f.enCours) return fin(xml({}, 503, 'Nothing to resume'));
      f.enCours = Number(q.appid) || f.enCours;
      f.reprises = (f.reprises || 0) + (u.pathname === '/resume' ? 1 : 0);
      f.sessions++;
      f.cle = Buffer.from(q.rikey, 'hex');
      f.lancement = q;
      return fin(xml({ sessionUrl0: `rtspenc://${hote}:${f.portRtsp}`, gamesession: 1 }));
    }
    if (u.pathname === '/cancel') { f.annule = (f.annule || 0) + 1; f.enCours = 0; return fin(xml({ cancel: 1 })); }
    return fin(xml({}, 404, 'inconnu'));
  });
  f.portHttps = await ecouter(srvHttps, hote, portHttps);

  // --- RTSP chiffré.
  let seqHote = 0;
  const repondre = (socket, texte) => {
    const clair = Buffer.from(texte);
    const iv = Buffer.alloc(12); iv.writeUInt32LE(++seqHote, 0); iv[10] = 0x48; iv[11] = 0x52;
    const c = crypto.createCipheriv('aes-128-gcm', f.cle, iv);
    const chiffre = Buffer.concat([c.update(clair), c.final()]);
    const h = Buffer.alloc(24); h.writeUInt32BE((0x80000000 | clair.length) >>> 0, 0); h.writeUInt32BE(seqHote, 4); c.getAuthTag().copy(h, 8);
    socket.end(Buffer.concat([h, chiffre]));
  };
  const srvRtsp = net.createServer(socket => {
    let tampon = Buffer.alloc(0);
    socket.on('data', d => {
      tampon = Buffer.concat([tampon, d]);
      if (tampon.length < 24) return;
      const lg = tampon.readUInt32BE(0) & 0x7fffffff;
      if (tampon.length < 24 + lg) return;
      const iv = Buffer.alloc(12); iv.writeUInt32LE(tampon.readUInt32BE(4), 0); iv[10] = 0x43; iv[11] = 0x52;
      const dc = crypto.createDecipheriv('aes-128-gcm', f.cle, iv); dc.setAuthTag(tampon.subarray(8, 24));
      let texte;
      try { texte = Buffer.concat([dc.update(tampon.subarray(24, 24 + lg)), dc.final()]).toString(); } catch { socket.destroy(); return; }
      const [ligne] = texte.split('\r\n'), [commande, cible] = ligne.split(' ');
      const cseq = /CSeq: (\d+)/.exec(texte)?.[1] || '0';
      const tete = ['RTSP/1.0 200 OK', `CSeq: ${cseq}`];
      let corps = '';
      if (commande === 'DESCRIBE') corps = `v=0\r\na=x-ss-general.featureFlags:3\r\na=x-ss-general.encryptionSupported:${f.chiffrementVideo ? 7 : 5}\r\na=x-ss-general.encryptionRequested:0\r\n`;
      if (commande === 'SETUP') {
        tete.push('Session: DEADBEEFCAFE;timeout = 90');
        if (cible.startsWith('streamid=audio')) tete.push(`Transport: server_port=${f.portAudio}`, 'X-SS-Ping-Payload: AUDIOPINGPAYLOAD');
        if (cible.startsWith('streamid=video')) tete.push(`Transport: server_port=${f.portVideo}`, 'X-SS-Ping-Payload: VIDEOPINGPAYLOAD');
        if (cible.startsWith('streamid=control')) tete.push(`Transport: server_port=${f.portControle}`, 'X-SS-Connect-Data: 4660');
      }
      if (commande === 'ANNOUNCE') {
        const corpsAnnonce = texte.slice(texte.indexOf('\r\n\r\n') + 4);
        f.annonce = corpsAnnonce;
        f.taillePaquet = Number(/x-nv-video\[0\]\.packetSize:(\d+)/.exec(corpsAnnonce)?.[1] || 0);
        f.chiffre = Number(/x-ss-general\.encryptionEnabled:(\d+)/.exec(corpsAnnonce)?.[1] || 0);
      }
      if (corps) tete.push('Content-type: application/sdp', `Content-length: ${corps.length}`);
      repondre(socket, tete.join('\r\n') + '\r\n\r\n' + corps);
    });
  });
  f.portRtsp = await ecouter(srvRtsp, hote);

  // --- Contrôle : ENet côté hôte, juste ce qu'il faut.
  const enet = dgram.createSocket('udp4');
  await new Promise(r => enet.bind(0, hote, r));
  f.portControle = enet.address().port;
  let pairClient = null, seqHoteFiable = 0, seqCtl = 0;
  const envoyerEnet = (corps, dest) => {
    const h = Buffer.alloc(4); h.writeUInt16BE(0x8000 | 0, 0); h.writeUInt16BE(Date.now() & 0xffff, 2);
    enet.send(Buffer.concat([h, corps]), dest.port, dest.address);
  };
  enet.on('message', (m, rinfo) => {
    if (m.length < 4) return;
    let pos = m.readUInt16BE(0) & 0x8000 ? 4 : 2;
    const temps = m.readUInt16BE(2);
    while (pos + 4 <= m.length) {
      const type = m[pos] & 0x0f, canal = m[pos + 1], seq = m.readUInt16BE(pos + 2), avecAck = m[pos] & 0x80;
      const tailles = [0, 8, 48, 44, 8, 4, 6, 8, 24, 8, 12, 16, 24];
      let fin = pos + tailles[type];
      if (type === 6) fin += m.readUInt16BE(pos + 4);
      if (type === 9 || type === 7) fin += m.readUInt16BE(pos + 6);
      const cmd = m.subarray(pos, fin);
      if (avecAck) { const a = Buffer.alloc(8); a[0] = 1; a[1] = canal; a.writeUInt16BE(seq, 2); a.writeUInt16BE(seq, 4); a.writeUInt16BE(temps, 6); envoyerEnet(a, rinfo); }
      if (type === 2) {
        pairClient = { address: rinfo.address, port: rinfo.port, donnees: cmd.readUInt32BE(44) };
        f.donneesConnexion = pairClient.donnees;
        const v = Buffer.alloc(44);
        v[0] = 3 | 0x80; v[1] = 0xff; v.writeUInt16BE(++seqHoteFiable, 2);
        v.writeUInt16BE(0, 4); v[6] = 0; v[7] = 0;
        cmd.copy(v, 8, 8, 40);                        // mtu, fenêtre, canaux, bandes, régulation
        cmd.copy(v, 40, 40, 44);                      // connectID
        envoyerEnet(v, rinfo);
      }
      if (type === 6) {
        const donnees = cmd.subarray(6);
        if (donnees.readUInt16LE(0) === 1) {
          const iv = Buffer.alloc(12); iv.writeUInt32LE(donnees.readUInt32LE(4), 0); iv[10] = 0x43; iv[11] = 0x43;
          const dc = crypto.createDecipheriv('aes-128-gcm', f.cle, iv); dc.setAuthTag(donnees.subarray(8, 24));
          try {
            const clair = Buffer.concat([dc.update(donnees.subarray(24)), dc.final()]);
            const t = clair.readUInt16LE(0), charge = clair.subarray(4, 4 + clair.readUInt16LE(2));
            f.controle.push(t);
            if (t === 0x0206) f.entrees.push({ canal, paquet: Buffer.from(charge) });
            if (t === 0x0302) f.imagesClesDemandees = (f.imagesClesDemandees || 0) + 1;
          } catch { f.controleFalsifie = (f.controleFalsifie || 0) + 1; }
        }
      }
      if (type === 4) f.deconnecte = true;
      pos = fin;
    }
  });
  // Fin de session annoncée par l'hôte (0x0109, code de fermeture normale).
  f.terminer = () => {
    if (!pairClient) return;
    const charge = Buffer.alloc(4); charge.writeUInt32BE(0x80030023, 0);
    const clair = Buffer.alloc(4 + charge.length); clair.writeUInt16LE(0x0109, 0); clair.writeUInt16LE(charge.length, 2); charge.copy(clair, 4);
    const iv = Buffer.alloc(12); iv.writeUInt32LE(seqCtl, 0); iv[10] = 0x48; iv[11] = 0x43;
    const c = crypto.createCipheriv('aes-128-gcm', f.cle, iv);
    const chiffre = Buffer.concat([c.update(clair), c.final()]);
    const e = Buffer.alloc(8); e.writeUInt16LE(1, 0); e.writeUInt16LE(4 + 16 + chiffre.length, 2); e.writeUInt32LE(seqCtl++, 4);
    const corps = Buffer.concat([e, c.getAuthTag(), chiffre]);
    const r = Buffer.alloc(6); r[0] = 6 | 0x80; r[1] = 0; r.writeUInt16BE(1, 2); r.writeUInt16BE(corps.length, 4);
    envoyerEnet(Buffer.concat([r, corps]), pairClient);
  };

  // --- Vidéo et son : les pings donnent l'adresse du client.
  const video = dgram.createSocket('udp4'), audio = dgram.createSocket('udp4');
  await Promise.all([new Promise(r => video.bind(0, hote, r)), new Promise(r => audio.bind(0, hote, r))]);
  f.portVideo = video.address().port; f.portAudio = audio.address().port;
  video.on('message', (m, rinfo) => { if (m.subarray(0, 16).toString() === 'VIDEOPINGPAYLOAD') { f.pings.video++; f.clientVideo = rinfo; } });
  audio.on('message', m => { if (m.subarray(0, 16).toString() === 'AUDIOPINGPAYLOAD') f.pings.audio++; });

  // Une image : en-tête court, découpe en paquets, parité Reed-Solomon,
  // chiffrement ; « perdre » retire des paquets (indices) à l'envoi.
  let numero = 0, seqRtp = 0, ivVideo = 0n;
  f.envoyerImage = (annexB, { cle = false, perdre = [] } = {}) => {
    if (!f.clientVideo || !f.taillePaquet) return false;
    numero++;
    const tp = f.taillePaquet, bloc = tp + 16, utile = tp - 16;
    const tete = Buffer.alloc(8); tete[0] = 0x01; tete.writeUInt16LE(5, 1); tete[3] = cle ? 2 : 1;
    let dernier = (annexB.length + 8) % utile; if (!dernier) dernier = utile;
    tete.writeUInt16LE(dernier, 4);
    const charge = Buffer.concat([tete, annexB]);
    const d = Math.ceil(charge.length / utile), p = Math.max(2, Math.ceil(d * 20 / 100));
    const donnees = [];
    for (let i = 0; i < d; i++) {
      const s = Buffer.alloc(bloc);
      s.writeUInt32LE(((seqRtp + i) & 0xffffff) << 8 >>> 0, 16);
      s.writeUInt32LE(numero, 20);
      s[24] = 0x1 | (i === 0 ? 0x4 : 0) | (i === d - 1 ? 0x2 : 0);
      s[26] = 0x10; s[27] = 0;
      charge.copy(s, 32, i * utile, Math.min(charge.length, (i + 1) * utile));
      donnees.push(s);
    }
    const parite = rsEncoder(donnees, p, bloc).map(x => Buffer.from(x));
    const pct = Math.round(p * 100 / d);
    [...donnees, ...parite].forEach((s, i) => {
      s[0] = 0x80 | 0x10; s.writeUInt16BE((seqRtp + i) & 0xffff, 2); s.writeUInt32BE(numero * 1500, 4);
      s.writeUInt32LE(numero, 20); s[27] = 0;
      s.writeUInt32LE(((i << 12) | (d << 22) | (pct << 4)) >>> 0, 28);
      if (perdre.includes(i)) return;
      let paquet = s;
      if (f.chiffre & 2) {
        const iv = Buffer.alloc(12); iv.writeBigUInt64LE(ivVideo++, 0); iv[11] = 0x56;
        const c = crypto.createCipheriv('aes-128-gcm', f.cle, iv);
        const chiffre = Buffer.concat([c.update(s), c.final()]);
        const pre = Buffer.alloc(32); iv.copy(pre, 0); pre.writeUInt32LE(numero, 12); c.getAuthTag().copy(pre, 16);
        paquet = Buffer.concat([pre, chiffre]);
      }
      video.send(paquet, f.clientVideo.port, f.clientVideo.address);
    });
    seqRtp = (seqRtp + d + p) & 0xffff;
    return true;
  };

  f.saisirPin = pin => { f.pin = String(pin); };
  f.fermer = async () => {
    for (const x of [srvHttp, srvHttps, srvRtsp]) { x.closeAllConnections?.(); await new Promise(r => x.close(() => r())); }
    for (const x of [enet, video, audio]) { try { x.close(); } catch { /* fermée */ } }
  };
  return f;
}
