// Sunshine, côté HTTP(S) GameStream : l'appairage, la liste des applications,
// le lancement d'une session. ProxLab y est un client Moonlight : son
// certificat (certificat.js) l'identifie, celui de Sunshine est épinglé à
// l'appairage et revérifié à chaque connexion, avant tout octet envoyé.
//
// Sunshine n'est joint que sur le réseau interne (plages privées et bouclage) :
// une adresse publique, ou un nom qui s'y résout, est refusée.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import dns from 'node:dns';
import crypto from 'node:crypto';
import { classer } from '../reseau.js';
import { signatureDe, empreinteCert } from './certificat.js';

export const PORT_HTTP = 47989, PORT_HTTPS = 47984;
const REPONSE_MAX = 256 * 1024;

export class ErreurFlux extends Error {
  constructor(message, code = 'flux') { super(message); this.code = code; }
}

// Ce qui empêche de joindre Sunshine, dit pour qui règle le réseau : rien qui
// écoute, aucune réponse, pas de route.
const ou = (hote, port) => `${net.isIPv6(hote) ? `[${hote}]` : hote}:${port}`;
const silence = (hote, port) => new ErreurFlux(`${ou(hote, port)} ne répond pas (paquets ignorés : pare-feu, ou machine éteinte)`, 'delai');
function injoignable(e, hote, port) {
  const cause = {
    ECONNREFUSED: 'connexion refusée : rien n\'écoute sur ce port (Sunshine arrêté, ou relais absent)',
    ECONNRESET: 'connexion coupée à l\'ouverture',
    EHOSTUNREACH: 'hôte injoignable depuis ProxLab (route ou pare-feu)',
    ENETUNREACH: 'réseau injoignable depuis ProxLab',
    ETIMEDOUT: 'aucune réponse (pare-feu, ou machine éteinte)',
    ENOTFOUND: 'nom inconnu',
    EAI_AGAIN: 'nom non résolu pour l\'instant',
  }[e?.code] || String(e?.code || e?.message || 'erreur').slice(0, 80);
  return new ErreurFlux(`${ou(hote, port)} : ${cause}`, 'injoignable');
}

export function adresseInterne(hote) {
  const h = String(hote || '').replace(/^\[|\]$/g, '');
  return net.isIP(h) !== 0 && classer(h) === 'interne';
}

// Résolution gardée : toutes les adresses d'un nom doivent être internes.
export function lookupInterne(hostname, options, callback) {
  const opts = typeof options === 'object' && options ? options : { family: options };
  dns.lookup(hostname, { ...opts, all: true }, (err, adresses) => {
    if (err) return callback(err);
    if (!adresses.length || adresses.some(a => classer(a.address) !== 'interne')) {
      return callback(new ErreurFlux(`${hostname} ne se résout pas vers le réseau interne`, 'interdite'));
    }
    if (opts.all) return callback(null, adresses);
    callback(null, adresses[0].address, adresses[0].family);
  });
}

export const nomHoteValide = h => typeof h === 'string' && h.length <= 253 && (net.isIP(h) !== 0 || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/i.test(h));

function xml(texte, balise) {
  const m = new RegExp(`<${balise}>([^<]{0,65536})</${balise}>`).exec(texte);
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : null;
}
function verifierStatut(texte) {
  const m = /<root[^>]*status_code="(\d+)"[^>]*>/.exec(texte);
  if (!m) throw new ErreurFlux('réponse de Sunshine illisible');
  if (m[1] !== '200') {
    const msg = /status_message="([^"]{0,200})"/.exec(texte)?.[1] || '';
    throw new ErreurFlux(`Sunshine refuse (${m[1]}${msg ? ` : ${msg}` : ''})`, m[1] === '401' ? 'non-appaire' : 'refus');
  }
}

export class HoteSunshine {
  // identite : { certPem, clePem, uniqueId } ; certServeur : PEM épinglé (null avant appairage).
  // empreinte : à défaut du certificat épinglé, son empreinte reçue par un canal
  // sûr (l'API de Proxmox, connexion en une commande) ; le certificat présenté
  // qui lui correspond est gardé dans certVu.
  constructor({ hote, portHttp = PORT_HTTP, portHttps = PORT_HTTPS, identite, certServeur = null, empreinte = null, timeout = 8000 }) {
    if (!nomHoteValide(hote)) throw new ErreurFlux('adresse de Sunshine invalide', 'invalide');
    if (net.isIP(hote) && !adresseInterne(hote)) throw new ErreurFlux('Sunshine doit être sur le réseau interne (adresse privée)', 'interdite');
    Object.assign(this, { hote, portHttp, portHttps, identite, certServeur, empreinte, timeout, certVu: null });
  }

  url(chemin, args = {}) {
    const q = new URLSearchParams({ uniqueid: this.identite.uniqueId, uuid: crypto.randomUUID().replace(/-/g, ''), ...args });
    return `/${chemin}?${q}`;
  }

  // GET en clair (port HTTP) : serverinfo avant appairage, et les étapes de l'appairage.
  get(chemin, args, { timeout = this.timeout } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: this.hote, port: this.portHttp, path: this.url(chemin, args), method: 'GET', lookup: lookupInterne, timeout, agent: false }, res => lire(res, resolve, reject));
      req.once('timeout', () => req.destroy(silence(this.hote, this.portHttp)));
      req.once('error', e => reject(e instanceof ErreurFlux ? e : injoignable(e, this.hote, this.portHttp)));
      req.end();
    });
  }

  // GET chiffré (port HTTPS) : notre certificat présenté, celui de Sunshine
  // comparé à l'épinglé avant que la requête ne soit écrite.
  getTls(chemin, args, { timeout = this.timeout, certServeur = this.certServeur } = {}) {
    const attendue = certServeur ? empreinteCert(certServeur) : this.empreinte;
    if (!attendue) return Promise.reject(new ErreurFlux('Sunshine n\'est pas appairé', 'non-appaire'));
    return new Promise((resolve, reject) => {
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = (_o, rappel) => {
        const s = tls.connect({
          host: this.hote, port: this.portHttps, lookup: lookupInterne, timeout,
          cert: this.identite.certPem, key: this.identite.clePem,
          // Certificat autosigné de Sunshine : l'empreinte épinglée remplace
          // l'autorité, contrôlée ci-dessous avant de rendre la socket.
          rejectUnauthorized: false,
        }, () => {
          const c = s.getPeerCertificate(false);
          const fp = c?.raw ? 'sha256:' + crypto.createHash('sha256').update(c.raw).digest('hex') : '';
          if (fp !== attendue) { s.destroy(); return rappel(new ErreurFlux(certServeur ? 'le certificat de Sunshine a changé depuis l\'appairage' : 'le certificat de Sunshine n\'est pas celui annoncé par la commande', 'empreinte')); }
          this.certVu = new crypto.X509Certificate(c.raw).toString();
          s.setTimeout(0);
          rappel(null, s);
        });
        s.once('timeout', () => s.destroy(silence(this.hote, this.portHttps)));
        s.once('error', e => rappel(e));
      };
      const req = https.request({ host: this.hote, port: this.portHttps, path: this.url(chemin, args), method: 'GET', agent, timeout }, res => lire(res, resolve, reject));
      req.once('timeout', () => req.destroy(silence(this.hote, this.portHttps)));
      req.once('error', e => reject(e instanceof ErreurFlux ? e : injoignable(e, this.hote, this.portHttps)));
      req.end();
    });
  }

  async infos({ chiffre = !!this.certServeur } = {}) {
    const t = chiffre ? await this.getTls('serverinfo') : await this.get('serverinfo');
    verifierStatut(t);
    const version = xml(t, 'appversion') || '';
    return {
      nom: (xml(t, 'hostname') || '').slice(0, 64),
      version,
      gfe: xml(t, 'GfeVersion') || '',
      appaire: xml(t, 'PairStatus') === '1',
      sessionEnCours: Number(xml(t, 'currentgame') || 0),
      codecs: Number(xml(t, 'ServerCodecModeSupport') || 0),
      // Sunshine se déclare par une version en « .-1 » (GFE donnerait un nombre).
      sunshine: /\.-?1$/.test(version) || version.split('.').length === 4 && Number(version.split('.')[3]) < 0,
    };
  }

  // L'appairage GameStream : le PIN, tapé dans l'interface de Sunshine, fonde
  // une clé ; chacun prouve qu'il la connaît et signe un secret avec sa clé
  // privée. Le certificat de Sunshine n'est épinglé qu'une fois sa signature
  // vérifiée : un intermédiaire sans le PIN échoue.
  async appairer(pin, { versionServeur, nomAppareil = 'ProxLab', attentePin = 120000 } = {}) {
    if (!/^\d{4}$/.test(String(pin))) throw new ErreurFlux('PIN invalide (4 chiffres)', 'invalide');
    const gen = Number(String(versionServeur || '7').split('.')[0]) || 7;
    const algo = gen >= 7 ? 'sha256' : 'sha1', taille = gen >= 7 ? 32 : 20;
    const hash = b => crypto.createHash(algo).update(b).digest();
    const sel = crypto.randomBytes(16);
    const cle = hash(Buffer.concat([sel, Buffer.from(String(pin))])).subarray(0, 16);
    const aes = (sens, donnees) => {
      const c = (sens ? crypto.createCipheriv : crypto.createDecipheriv)('aes-128-ecb', cle, null);
      c.setAutoPadding(false);
      return Buffer.concat([c.update(donnees), c.final()]);
    };
    const etape = async (args, opts) => {
      const t = await this.get('pair', { devicename: nomAppareil, updateState: '1', ...args }, opts);
      verifierStatut(t);
      if (xml(t, 'paired') !== '1') throw new ErreurFlux('appairage refusé par Sunshine', 'refus');
      return t;
    };
    const annuler = () => this.get('unpair').catch(() => {});
    try {
      // 1. Sunshine attend le PIN, tapé dans son interface : la réponse vient alors.
      const t1 = await etape({ phrase: 'getservercert', salt: sel.toString('hex'), clientcert: Buffer.from(this.identite.certPem).toString('hex') }, { timeout: attentePin });
      const certHex = xml(t1, 'plaincert');
      if (!certHex) throw new ErreurFlux('Sunshine est déjà en train d\'appairer un autre appareil', 'occupe');
      const certServeur = Buffer.from(certHex, 'hex').toString('utf8');
      new crypto.X509Certificate(certServeur);
      // 2. Notre défi, chiffré par la clé du PIN.
      const defi = crypto.randomBytes(16);
      const t2 = await etape({ clientchallenge: aes(true, defi).toString('hex') });
      const rep = aes(false, Buffer.from(xml(t2, 'challengeresponse') || '', 'hex'));
      if (rep.length < taille + 16) throw new ErreurFlux('réponse de Sunshine invalide', 'refus');
      const reponseServeur = rep.subarray(0, taille), defiServeur = rep.subarray(taille, taille + 16);
      // 3. Notre réponse à son défi.
      const secretClient = crypto.randomBytes(16);
      const notre = hash(Buffer.concat([defiServeur, signatureDe(this.identite.certPem), secretClient]));
      const rembourre = Buffer.alloc(32); notre.copy(rembourre);
      const t3 = await etape({ serverchallengeresp: aes(true, rembourre).toString('hex') });
      const secretServeur = Buffer.from(xml(t3, 'pairingsecret') || '', 'hex');
      if (secretServeur.length <= 16) throw new ErreurFlux('réponse de Sunshine invalide', 'refus');
      // Le secret de Sunshine est signé par la clé de son certificat : sinon, intermédiaire.
      if (!crypto.verify('sha256', secretServeur.subarray(0, 16), new crypto.X509Certificate(certServeur).publicKey, secretServeur.subarray(16))) {
        throw new ErreurFlux('signature de Sunshine invalide : appairage interrompu', 'empreinte');
      }
      // Sa réponse à notre défi prouve qu'il connaît le PIN.
      const attendu = hash(Buffer.concat([defi, signatureDe(certServeur), secretServeur.subarray(0, 16)]));
      if (!crypto.timingSafeEqual(attendu, reponseServeur)) throw new ErreurFlux('PIN incorrect', 'pin');
      // 4. Notre secret, signé.
      await etape({ clientpairingsecret: Buffer.concat([secretClient, crypto.sign('sha256', secretClient, this.identite.clePem)]).toString('hex') });
      // 5. Confirmation sur le canal chiffré, certificat épinglé.
      const t5 = await this.getTls('pair', { devicename: nomAppareil, updateState: '1', phrase: 'pairchallenge' }, { certServeur });
      verifierStatut(t5);
      if (xml(t5, 'paired') !== '1') throw new ErreurFlux('appairage non confirmé', 'refus');
      this.certServeur = certServeur;
      return { certServeur, empreinte: empreinteCert(certServeur) };
    } catch (e) {
      await annuler();
      throw e;
    }
  }

  async applications() {
    const t = await this.getTls('applist');
    verifierStatut(t);
    const apps = [];
    for (const m of t.matchAll(/<App>([\s\S]{0,4096}?)<\/App>/g)) {
      const id = Number(xml(m[1], 'ID')), titre = xml(m[1], 'AppTitle') || '';
      if (Number.isInteger(id) && id > 0) apps.push({ id, titre: titre.slice(0, 100) });
      if (apps.length >= 100) break;
    }
    return apps;
  }

  // Lance (ou reprend) une session : rend l'URL RTSP. La clé AES et son
  // identifiant chiffrent ensuite le contrôle, les entrées et la vidéo.
  async lancer({ appId, largeur, hauteur, ips, cle, cleId, reprendre = false, sonLocal = false }) {
    const t = await this.getTls(reprendre ? 'resume' : 'launch', {
      appid: String(appId), mode: `${largeur}x${hauteur}x${ips}`, additionalStates: '1', sops: '0',
      rikey: cle.toString('hex'), rikeyid: String(cleId), localAudioPlayMode: sonLocal ? '1' : '0',
      surroundAudioInfo: String(0x3 << 16 | 2), remoteControllersBitmap: '0', gcmap: '0', gcpersist: '0', corever: '1',
    }, { timeout: 20000 });
    verifierStatut(t);
    const url = xml(t, 'sessionUrl0');
    if (!url || !/^rtsp(enc)?:\/\//.test(url)) throw new ErreurFlux('Sunshine n\'a pas donné de session', 'refus');
    return url;
  }

  async arreter() {
    const t = await this.getTls('cancel');
    verifierStatut(t);
  }
}

function lire(res, resolve, reject) {
  const morceaux = []; let n = 0;
  res.on('data', d => {
    n += d.length;
    if (n > REPONSE_MAX) { res.destroy(); return reject(new ErreurFlux('réponse de Sunshine trop longue')); }
    morceaux.push(d);
  });
  res.on('end', () => {
    if (res.statusCode !== 200 && res.statusCode !== 401) return reject(new ErreurFlux(`Sunshine répond ${res.statusCode}`, res.statusCode === 404 ? 'introuvable' : 'refus'));
    resolve(Buffer.concat(morceaux).toString('utf8'));
  });
  res.on('error', reject);
}
