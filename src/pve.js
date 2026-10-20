// Client de l'API de Proxmox VE. Chaque requête passe par l'agent TLS de la
// liaison (autorité ou empreinte épinglée, vérifiée avant le premier octet) ;
// l'authentification est un jeton d'API, ou à défaut un ticket obtenu avec
// l'utilisateur et son mot de passe — que la console exige de toute façon,
// le WebSocket de Proxmox refusant les jetons.
//
// Un chemin n'est jamais assemblé ici à partir d'une requête : les routes
// valident chaque segment (nœud, VMID, nom) puis appellent chemin(), qui
// refuse tout ce qui sortirait de l'API.
import crypto from 'node:crypto';
import https from 'node:https';
import { agentProxmox } from './tls.js';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:@~%!-]{0,399}$/;
const REPONSE_MAX = 16 * 1024 * 1024;
const CERTIFICAT_NON_RECONNU = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const TICKET_DUREE = 100 * 60e3; // un ticket Proxmox vaut deux heures : on le renouvelle avant

export class ErreurProxmox extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// '/nodes', 'pve1', 'qemu', 101 → '/nodes/pve1/qemu/101'. Un segment hors motif,
// ou « .. », arrête tout : l'appelant valide déjà, ceci est la seconde barrière.
export function chemin(...segments) {
  const morceaux = segments.flatMap(s => String(s).split('/')).filter(Boolean);
  for (const m of morceaux) if (!SEGMENT.test(m) || m.includes('..')) throw new ErreurProxmox('segment de chemin refusé', 400);
  return '/' + morceaux.join('/');
}

export class Proxmox {
  constructor({ reglages, timeout = 20000 } = {}) {
    this.reglages = reglages; this.timeout = timeout;
    this.agent = null; this.cle = null; this.ticket = null;
  }

  // La liaison en vigueur ; l'agent est refait quand elle change.
  liaison() {
    const l = this.reglages.liaison();
    if (!l) throw new ErreurProxmox('Proxmox n\'est pas encore relié : un administrateur le règle dans Réglages.', 409);
    const cle = JSON.stringify([l.hote, l.port, l.confiance, l.fp, l.jeton_id, l.utilisateur, l.jeton_scelle, l.mdp_scelle]);
    if (cle !== this.cle) { this.agent?.destroy(); this.agent = agentProxmox(l); this.cle = cle; this.ticket = null; }
    return l;
  }
  oublier() { this.agent?.destroy(); this.agent = null; this.cle = null; this.ticket = null; }

  get(p, q) { return this.appel('GET', p, q); }
  post(p, q) { return this.appel('POST', p, q); }
  put(p, q) { return this.appel('PUT', p, q); }
  del(p, q) { return this.appel('DELETE', p, q); }
  // Au nom de l'utilisateur, par ticket, même quand un jeton est réglé : le
  // ticket de vncproxy et de termproxy est lié à qui le demande, et le
  // WebSocket qui le présente est ouvert avec le ticket de session.
  postSession(p, q) { return this.appel('POST', p, q, { parTicket: true }); }

  async appel(methode, p, params = {}, { relance = true, parTicket = false } = {}) {
    const l = this.liaison();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
    const corps = methode === 'GET' || methode === 'DELETE' ? null : qs.toString();
    const url = '/api2/json' + p + (corps === null && qs.size ? '?' + qs : '');
    const entetes = { Accept: 'application/json', ...(await this.authentification(l, methode, parTicket)) };
    if (corps !== null) Object.assign(entetes, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(corps) });
    const r = await brut({ agent: this.agent, hote: l.hote, port: l.port, methode, url, entetes, corps, timeout: this.timeout });
    if (r.status === 401 && relance && (!l.jeton_id || parTicket)) { this.ticket = null; return this.appel(methode, p, params, { relance: false, parTicket }); }
    let json = null;
    try { json = JSON.parse(r.texte); } catch { /* page d'erreur HTML */ }
    if (r.status >= 400) {
      const detail = json?.message || (json?.errors && JSON.stringify(json.errors)) || r.message || `HTTP ${r.status}`;
      throw new ErreurProxmox(String(detail).trim().slice(0, 500), r.status === 401 || r.status === 403 ? 502 : r.status >= 500 ? 502 : r.status);
    }
    return json ? json.data : null;
  }

  /**
   * Un fichier envoyé tel qu'il arrive (une image ISO de plusieurs Gio) :
   * enveloppé en multipart/form-data autour du flux, sans jamais le garder en
   * mémoire. `taille` est annoncée par le navigateur et sert de longueur à
   * Proxmox ; un flux qui s'arrête avant coupe l'envoi.
   */
  async envoyerFichier(p, { champs = {}, champFichier, nom, flux, taille }) {
    const l = this.liaison();
    const borne = '----proxlab' + crypto.randomBytes(12).toString('hex');
    const entree = Buffer.from(Object.entries(champs).map(([k, v]) => `--${borne}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')
      + `--${borne}\r\nContent-Disposition: form-data; name="${champFichier}"; filename="${nom}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const sortie = Buffer.from(`\r\n--${borne}--\r\n`);
    const entetes = {
      Accept: 'application/json', ...(await this.authentification(l, 'POST')),
      'Content-Type': `multipart/form-data; boundary=${borne}`, 'Content-Length': entree.length + taille + sortie.length,
    };
    const r = await new Promise((resolve, reject) => {
      const req = https.request({ host: l.hote, port: l.port, method: 'POST', path: '/api2/json' + p, agent: this.agent, headers: entetes, timeout: 120000 }, res => {
        const morceaux = [];
        res.on('data', c => { if (morceaux.reduce((n, x) => n + x.length, 0) < 65536) morceaux.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, message: res.statusMessage, texte: Buffer.concat(morceaux).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new ErreurProxmox('Proxmox ne reçoit plus l\'envoi (délai dépassé).')));
      req.on('error', e => reject(e instanceof ErreurProxmox ? e : new ErreurProxmox(`Proxmox injoignable (${e.code || e.message}).`)));
      let recu = 0;
      req.write(entree);
      flux.on('data', c => { recu += c.length; if (recu > taille) { req.destroy(new ErreurProxmox('Fichier plus long qu\'annoncé.', 400)); flux.destroy(); return; } if (!req.write(c)) { flux.pause(); req.once('drain', () => flux.resume()); } });
      flux.on('end', () => { if (recu !== taille) { req.destroy(new ErreurProxmox('Envoi interrompu avant la fin du fichier.', 400)); return; } req.end(sortie); });
      flux.on('error', () => req.destroy(new ErreurProxmox('Envoi interrompu par le navigateur.', 400)));
      flux.on('close', () => { if (recu !== taille) req.destroy(new ErreurProxmox('Envoi interrompu par le navigateur.', 400)); });
    });
    let json = null;
    try { json = JSON.parse(r.texte); } catch { /* page d'erreur HTML */ }
    if (r.status >= 400) throw new ErreurProxmox(String(json?.message || (json?.errors && JSON.stringify(json.errors)) || r.message || `HTTP ${r.status}`).trim().slice(0, 500), r.status >= 500 || r.status === 401 || r.status === 403 ? 502 : r.status);
    return json ? json.data : null;
  }

  async authentification(l, methode, parTicket = false) {
    if (l.jeton_id && l.secret && !parTicket) return { Authorization: `PVEAPIToken=${l.jeton_id}=${l.secret}` };
    const t = await this.obtenirTicket();
    return { Cookie: `PVEAuthCookie=${encodeURIComponent(t.ticket)}`, ...(methode !== 'GET' ? { CSRFPreventionToken: t.csrf } : {}) };
  }

  // Ticket de session Proxmox (utilisateur + mot de passe), gardé en mémoire.
  async obtenirTicket({ forcer = false } = {}) {
    const l = this.liaison();
    if (!forcer && this.ticket && this.ticket.expire > Date.now()) return this.ticket;
    if (!l.utilisateur || !l.motDePasse) throw new ErreurProxmox('Utilisateur et mot de passe Proxmox requis pour cette opération (console).', 409);
    const corps = new URLSearchParams({ username: l.utilisateur, password: l.motDePasse }).toString();
    const r = await brut({
      agent: this.agent, hote: l.hote, port: l.port, methode: 'POST', url: '/api2/json/access/ticket', corps, timeout: this.timeout,
      entetes: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(corps) },
    });
    if (r.status !== 200) throw new ErreurProxmox('Proxmox a refusé l\'utilisateur et le mot de passe.', 502);
    const d = JSON.parse(r.texte).data;
    this.ticket = { ticket: d.ticket, csrf: d.CSRFPreventionToken, expire: Date.now() + TICKET_DUREE };
    return this.ticket;
  }
}

function brut({ agent, hote, port, methode, url, entetes, corps, timeout }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: hote, port, method: methode, path: url, agent, headers: entetes, timeout }, res => {
      const morceaux = []; let taille = 0;
      res.on('data', c => {
        taille += c.length;
        if (taille > REPONSE_MAX) { req.destroy(new ErreurProxmox('réponse de Proxmox trop volumineuse')); return; }
        morceaux.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, message: res.statusMessage, texte: Buffer.concat(morceaux).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ErreurProxmox('Proxmox ne répond pas (délai dépassé).')));
    req.on('error', e => reject(e instanceof ErreurProxmox ? e : new ErreurProxmox(
      e.code === 'EEMPREINTE' ? e.message
        : CERTIFICAT_NON_RECONNU.has(e.code) ? `certificat non reconnu par les autorités du système (${e.code}) : épingler son empreinte.`
          : `Proxmox injoignable (${e.code || e.message}).`)));
    if (corps) req.write(corps);
    req.end();
  });
}
