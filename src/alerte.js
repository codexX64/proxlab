// Envoi d'une alerte à un récepteur de tickets (webhook réglé par un
// administrateur sous renfort).
//
// Deux formats :
//   ticket — schéma de ticket v1 (titre, urgence, impact, portée, zone,
//            métriques, dedup_key, source) ; seul « titre » est requis par le
//            récepteur ;
//   brut   — objet plat { source, at, level, subject, detail, dedup_key }.
//
// Authentification : une clé dans un en-tête dont le nom est réglable, et/ou
// une signature HMAC-SHA256 du corps (X-Signature). La cible est saisie par un
// administrateur : réseau interne permis, métadonnées de nuage et plages
// réservées jamais, au littéral comme à la résolution ; TLS toujours vérifié ;
// aucune redirection suivie ; réponse bornée.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { hoteInterdit, lookupGarde } from './reseau.js';

export const ENTETE = /^[A-Za-z0-9-]{1,64}$/;
const MATRICE = {
  bloquant: { site: 'p1', service: 'p1', groupe: 'p2', utilisateur: 'p3' },
  degrade: { site: 'p2', service: 'p2', groupe: 'p3', utilisateur: 'p3' },
  mineur: { site: 'p3', service: 'p3', groupe: 'p4', utilisateur: 'p4' },
};

export function urgence(ev) {
  const impact = MATRICE[ev.impact] ? ev.impact : 'mineur';
  return MATRICE[impact][ev.portee] || MATRICE[impact].utilisateur;
}

export function corpsTicket(ev, { service = 'proxmox', lien = '' } = {}) {
  const t = {
    type: ev.type || 'incident', titre: ev.titre, urgence: ev.urgence || urgence(ev), impact: ev.impact || 'mineur', portee: ev.portee || 'service',
    service, composant: ev.composant || '', zone: ev.zone || {}, description: ev.description || '',
    detecte_le: new Date().toISOString(), dedup_key: ev.dedup_key || '', source: { systeme: 'proxlab', ref: ev.ref || '' },
  };
  if (ev.symptomes?.length) t.symptomes = ev.symptomes;
  if (ev.metriques?.length) t.metriques = ev.metriques;
  if (lien) t.liens = [{ label: 'ProxLab', url: lien }];
  return t;
}

function corpsBrut(ev) {
  const u = ev.urgence || urgence(ev);
  return { source: 'proxlab', at: Date.now(), level: u === 'p1' ? 'critical' : u === 'p2' ? 'warn' : 'info', subject: ev.titre, detail: ev.description || '', dedup_key: ev.dedup_key || '' };
}

export class Emetteur {
  constructor() { this.pauseJusqua = 0; }

  // reglage : { url, format, entete, cle, secret, service, lien }. Ne lève jamais :
  // rend { ok, ref?, erreur? }.
  async envoyer(ev, reglage, { essai = false } = {}) {
    if (!reglage?.url) return { ok: false, erreur: 'aucun récepteur réglé' };
    if (!essai && Date.now() < this.pauseJusqua) return { ok: false, erreur: 'quota du récepteur atteint' };
    let u;
    try { u = new URL(reglage.url); } catch { return { ok: false, erreur: 'adresse invalide' }; }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return { ok: false, erreur: 'adresse refusée' };
    if (hoteInterdit(u.hostname)) return { ok: false, erreur: 'adresse interdite' };
    const corps = JSON.stringify(reglage.format === 'brut' ? corpsBrut(ev) : corpsTicket(ev, reglage));
    const entetes = {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corps),
      'Idempotency-Key': crypto.randomUUID(), 'User-Agent': 'proxlab',
    };
    if (reglage.cle && ENTETE.test(reglage.entete || '')) entetes[reglage.entete] = reglage.cle;
    if (reglage.secret) entetes['X-Signature'] = 'sha256=' + crypto.createHmac('sha256', reglage.secret).update(corps).digest('hex');
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise(resolve => {
      const req = mod.request({
        host: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', headers: entetes,
        lookup: lookupGarde, timeout: 8000, agent: false,
      }, res => {
        const morceaux = []; let taille = 0;
        res.on('data', c => { taille += c.length; if (taille <= 65536) morceaux.push(c); });
        res.on('end', () => {
          const texte = Buffer.concat(morceaux).toString('utf8').slice(0, 2000);
          if (res.statusCode === 429) {
            const attente = parseInt(res.headers['retry-after'], 10);
            this.pauseJusqua = Date.now() + (Number.isFinite(attente) ? Math.min(attente, 3600) * 1000 : 60e3);
            return resolve({ ok: false, erreur: 'quota du récepteur dépassé' });
          }
          if (res.statusCode >= 300) return resolve({ ok: false, erreur: `le récepteur a répondu ${res.statusCode}` });
          let r = {};
          try { r = JSON.parse(texte); } catch { /* récepteur silencieux */ }
          resolve({ ok: true, ref: typeof r.ref === 'string' ? r.ref.slice(0, 80) : '' });
        });
      });
      req.on('timeout', () => req.destroy(new Error('délai dépassé')));
      req.on('error', e => resolve({ ok: false, erreur: e.code === 'EINTERDITE' ? 'adresse interdite' : String(e.code || e.message).slice(0, 120) }));
      req.end(corps);
    });
  }
}
