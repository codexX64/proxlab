// Démarrage de ProxLab : configuration validée, base, socle commun (comptes,
// sessions, coffre), liaison à Proxmox, surveillance, serveur HTTP et mise à
// niveau WebSocket de la console.
import http from 'node:http';
import path from 'node:path';
import { lireConfigProxlab, VERSION } from './config.js';
import { ouvrirBase, Reglages, Evenements } from './base.js';
import { Proxmox } from './pve.js';
import { Emetteur } from './alerte.js';
import { Surveillance } from './surveillance.js';
import { creerApi } from './api.js';
import { verifierUpgrade, accepter, refuser } from './websocket.js';
import { ouvrirTermproxy, relayer } from './console.js';
import { ouvrirVnc, relayerEcran } from './ecran.js';
import { relayerFlux } from './flux/relais.js';
import {
  Debit, ErreurHttp, demarrerSocle, entetesSecurite, envelopper, nonceCsp, politiqueContenu,
  repondreErreur, repondreJson, servirFichier, cheminVersionne, origineDe, adresseClient,
} from '../socle/src/index.js';

const RACINE = path.resolve(import.meta.dirname, '..');
const CONSOLE = { info: (...a) => console.log(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };
// Signalement privé d'une faille, sur le dépôt : lu par le mainteneur.
const CONTACT_SECURITE = 'https://github.com/CodexX64/proxlab/security/advisories/new';
const CONSOLES_MAX = 32;

export async function demarrer(env = process.env, { log = CONSOLE } = {}) {
  const cfg = lireConfigProxlab(env);
  const db = ouvrirBase(cfg.donnees);
  const socle = await demarrerSocle({ service: { id: 'proxlab', nom: 'ProxLab', contactSecurite: CONTACT_SECURITE }, db, dossier: cfg.donnees, env, log });

  const reglages = new Reglages(db, { coffre: socle.coffre });
  let bilan;
  try { bilan = reglages.resceller(); } catch (e) { socle.arreter(); db.close(); throw e; }
  if (bilan.rescelles) log.info?.(`[coffre] ${bilan.rescelles} secret(s) de ProxLab rescellé(s) sous SOCLE_CLE.`);
  if (bilan.retires) {
    log.warn?.(`[coffre] ${bilan.retires} secret(s) de ProxLab illisible(s) sous les deux clés, retiré(s) : à ressaisir dans les réglages.`);
    socle.journal.ecrire({ acteur: 'système', action: 'coffre.secrets_retires', resultat: 'erreur', details: { n: bilan.retires } });
  }
  const evenements = new Evenements(db, { retentionJours: cfg.retention });
  const proxmox = new Proxmox({ reglages });
  const emetteur = new Emetteur();
  const surveillance = new Surveillance({ proxmox, reglages, evenements, emetteur, log });
  const api = creerApi({ socle, cfg, reglages, evenements, surveillance, emetteur, proxmox, log });
  // Données d'un compte : exportées à sa demande, neutralisées à sa suppression.
  socle.portail.exporteur = compteId => evenements.donneesDe(compteId);
  socle.comptes.apresSuppression.push(compteId => evenements.oublier(compteId));

  let passeEnCours = false;
  const tour = async () => {
    if (passeEnCours) return;
    passeEnCours = true;
    try { await surveillance.passe(); } catch (e) { log.warn?.(`[surveillance] ${String(e.message).slice(0, 300)}`); } finally { passeEnCours = false; }
  };
  const bSurveillance = setInterval(tour, cfg.intervalle * 1000);
  const bPurge = setInterval(() => { try { evenements.purger(); } catch (e) { log.error?.('purge:', e.message); } }, 3600e3);
  for (const b of [bSurveillance, bPurge]) b.unref?.();

  // Toute requête compte : une page en demande une vingtaine, une rafale des milliers.
  const debit = new Debit({ max: 900 });
  const serveur = http.createServer(envelopper(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://proxlab');
      const ctx = socle.portail.contexte(req, res);
      if (!debit.prendre(ctx.ip)) { socle.journal.rare(`debit:${ctx.ip}`, { action: 'limite.atteinte', objet: 'requetes', ip: ctx.ip, resultat: 'refus' }); throw new ErreurHttp(429, 'Trop de requêtes.'); }
      ctx.url = url;
      const nonce = nonceCsp();
      entetesSecurite(res, { secure: ctx.securise, csp: politiqueContenu({ nonce, secure: ctx.securise, img: ['data:'], connect: ["'self'"] }) });
      if (await socle.portail.traiter(req, res, url, ctx)) return;
      if (await api.traiter(ctx)) return;
      if (!['GET', 'HEAD'].includes(req.method)) return repondreJson(res, 405, { error: 'Méthode non admise.' });
      // L'interface est servie sous /v/<version>/ : une nouvelle version change
      // l'adresse de chaque fichier, et aucun cache (navigateur, mandataire)
      // ne peut garder l'ancien script face à la nouvelle page. Sous la bonne
      // version, les fichiers ne changent plus : gardés un an.
      const { chemin, durable } = cheminVersionne(url.pathname, VERSION);
      const cache = durable ? 'public, max-age=31536000, immutable' : null;
      if (chemin.startsWith('/socle/') && servirFichier(req, res, path.join(RACINE, 'socle', 'web'), chemin.slice(6), { nonce, cache: cache || 'no-cache' })) return;
      const fichier = chemin === '/' ? '/index.html' : chemin;
      if (servirFichier(req, res, path.join(RACINE, 'web'), fichier, { nonce, gamme: socle.cfg.gamme, version: VERSION, ...(cache ? { cache } : {}) })) return;
      repondreJson(res, 404, { error: 'Introuvable.' });
    } catch (e) {
      // Cloudflare remplace les 502 et 504 de l'origine par sa propre page : le
      // message écrit pour l'utilisateur (Sunshine, Proxmox injoignable) devenait
      // « Erreur 502 ». Arrivées par lui, ces erreurs partent en 503, statut
      // d'origine en en-tête.
      if (req.headers['cf-ray'] && e instanceof ErreurHttp && (e.status === 502 || e.status === 504)) {
        res.setHeader('X-Statut-Amont', String(e.status));
        e.status = 503;
      }
      repondreErreur(res, e, { journal: log });
    }
  }));

  // Console : origine contrôlée, session du socle exigée et passe à usage unique
  // (tirée par POST /api/console, où le rôle et le renfort ont été vérifiés)
  // AVANT la mise à niveau.
  const ouvertes = new Set();
  const fluides = new Map();
  serveur.on('upgrade', (req, socket) => {
    try {
      const url = new URL(req.url, 'http://proxlab');
      if (!debit.prendre(adresseClient(req, socle.portail.proxys))) return refuser(socket, 429, 'Too Many Requests');
      if (url.pathname !== '/ws/console') return refuser(socket, 404, 'Not Found');
      const origines = [origineDe(req, socle.portail.proxys), ...socle.portail.originesEnPlus].filter(Boolean);
      const ctx = socle.portail.contexte(req, null);
      // Un refus de console est une tentative : au journal, sans la passe (une
      // ligne par adresse, par motif et par minute : une rafale ne noie pas le reste).
      const refus = (code, texte, motif) => { socle.journal.rare(`console:${ctx.ip}:${motif}`, { acteur: ctx.session?.compte || null, action: 'console.refusee', ip: ctx.ip, resultat: 'refus', details: { raison: motif } }); return refuser(socket, code, texte); };
      const v = verifierUpgrade(req, { origines });
      if (!v.ok) return refus(v.code, v.erreur, 'origine ou poignée');
      try { socle.portail.exiger(ctx, { role: 'membre' }); } catch { return refus(401, 'Unauthorized', 'session'); }
      const cible = api.prendrePasse(url.searchParams.get('passe'), ctx.session.id);
      if (!cible) return refus(403, 'Forbidden', 'passe');
      if (ouvertes.size >= CONSOLES_MAX) return refuser(socket, 503, 'Service Unavailable');
      const ws = accepter(req, socket);
      ouvertes.add(ws);
      const sessionId = ctx.session.id, jeton = ctx.jeton;
      socle.journal.ecrire({ acteur: ctx.session.compte, action: 'console.ouverte', objet: cible.type === 'node' ? `node/${cible.noeud}` : `${cible.type}/${cible.vmid}`, ip: ctx.ip, details: { noeud: cible.noeud, mode: cible.mode } });
      const suivi = { vivante: () => socle.comptes.session(jeton)?.id === sessionId, surFin: () => ouvertes.delete(ws) };
      if (cible.mode === 'fluide') {
        // Une session fluide par VM : une nouvelle ouverture reprend la main.
        fluides.get(cible.vmid)?.finir('écran fluide ouvert ailleurs');
        const relais = relayerFlux(ws, {
          ouvrirHote: async () => { await api.fluide.patienter(cible.vmid); return api.fluide.hote(cible.vmid); },
          appId: hote => api.fluide.appId(cible.vmid, hote),
          vivante: suivi.vivante,
          journal: pret => socle.journal.ecrire({ acteur: ctx.session.compte, action: 'machine.fluide.session', objet: `qemu/${cible.vmid}`, ip: ctx.ip, details: { noeud: cible.noeud, largeur: pret.largeur, hauteur: pret.hauteur, ips: pret.ips, codec: pret.codec, chiffre: pret.chiffre } }),
          surFin: (stats, raison) => {
            if (fluides.get(cible.vmid) === relais) fluides.delete(cible.vmid);
            api.fluide.noterFin(cible.vmid);
            suivi.surFin();
            if (stats) socle.journal.ecrire({ acteur: ctx.session.compte, action: 'machine.fluide.fin', objet: `qemu/${cible.vmid}`, details: { images: stats.images, perdues: stats.perdues, recuperes: stats.recuperes, raison: raison ? String(raison).slice(0, 120) : 'fermé par le navigateur' } });
          },
        });
        fluides.set(cible.vmid, relais);
      } else if (cible.mode === 'ecran') relayerEcran(ws, () => ouvrirVnc(proxmox, cible), suivi);
      else relayer(ws, () => ouvrirTermproxy(proxmox, cible), suivi);
    } catch { try { socket.destroy(); } catch { /* déjà fermé */ } }
  });

  serveur.headersTimeout = 20000;
  serveur.requestTimeout = 0;      // les consoles durent
  serveur.keepAliveTimeout = 5000;
  await new Promise(r => serveur.listen(cfg.port, cfg.hote, r));
  log.info(`ProxLab ${VERSION} à l'écoute sur ${cfg.hote}:${serveur.address().port}`);
  if (!reglages.lire('liaison')) log.info('Proxmox n\'est pas encore relié : un administrateur le règle dans Réglages.');
  setTimeout(tour, 2000).unref?.();

  const arreter = () => new Promise(r => {
    socle.arreter(); clearInterval(bSurveillance); clearInterval(bPurge); proxmox.oublier();
    for (const ws of ouvertes) { try { ws.close(); } catch { /* fermé */ } }
    api.frappes.arreterTout();
    serveur.close(() => { db.close(); r(); }); serveur.closeAllConnections?.();
  });
  return { serveur, socle, cfg, db, reglages, evenements, proxmox, surveillance, api, arreter };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demarrer().then(({ arreter }) => {
    for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => arreter().then(() => process.exit(0)));
  }).catch(e => { console.error(e.message); process.exit(1); });
}
