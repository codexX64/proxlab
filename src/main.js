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
import {
  Debit, ErreurHttp, demarrerSocle, entetesSecurite, envelopper, nonceCsp, politiqueContenu,
  repondreErreur, repondreJson, servirFichier, origineDe, adresseClient,
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
      if (url.pathname.startsWith('/socle/') && servirFichier(req, res, path.join(RACINE, 'socle', 'web'), url.pathname.slice(6), { nonce, cache: 'public, max-age=3600' })) return;
      const fichier = url.pathname === '/' ? '/index.html' : url.pathname;
      if (servirFichier(req, res, path.join(RACINE, 'web'), fichier, { nonce, gamme: socle.cfg.gamme })) return;
      repondreJson(res, 404, { error: 'Introuvable.' });
    } catch (e) { repondreErreur(res, e, { journal: log }); }
  }));

  // Console : origine contrôlée, session du socle exigée et passe à usage unique
  // (tirée par POST /api/console, où le rôle et le renfort ont été vérifiés)
  // AVANT la mise à niveau.
  const ouvertes = new Set();
  serveur.on('upgrade', (req, socket) => {
    try {
      const url = new URL(req.url, 'http://proxlab');
      if (!debit.prendre(adresseClient(req, socle.portail.proxys))) return refuser(socket, 429, 'Too Many Requests');
      if (url.pathname !== '/ws/console') return refuser(socket, 404, 'Not Found');
      const origines = [origineDe(req, socle.portail.proxys), ...socle.portail.originesEnPlus].filter(Boolean);
      const v = verifierUpgrade(req, { origines });
      if (!v.ok) return refuser(socket, v.code, v.erreur);
      const ctx = socle.portail.contexte(req, null);
      try { socle.portail.exiger(ctx, { role: 'membre' }); } catch { return refuser(socket, 401, 'Unauthorized'); }
      const cible = api.prendrePasse(url.searchParams.get('passe'), ctx.session.id);
      if (!cible) return refuser(socket, 403, 'Forbidden');
      if (ouvertes.size >= CONSOLES_MAX) return refuser(socket, 503, 'Service Unavailable');
      const ws = accepter(req, socket);
      ouvertes.add(ws);
      const sessionId = ctx.session.id, jeton = ctx.jeton;
      socle.journal.ecrire({ acteur: ctx.session.compte, action: 'console.ouverte', objet: cible.type === 'node' ? `node/${cible.noeud}` : `${cible.type}/${cible.vmid}`, ip: ctx.ip, details: { noeud: cible.noeud } });
      relayer(ws, () => ouvrirTermproxy(proxmox, cible), {
        vivante: () => socle.comptes.session(jeton)?.id === sessionId,
        surFin: () => ouvertes.delete(ws),
      });
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
    serveur.close(() => { db.close(); r(); }); serveur.closeAllConnections?.();
  });
  return { serveur, socle, cfg, db, reglages, evenements, proxmox, surveillance, api, arreter };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demarrer().then(({ arreter }) => {
    for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => arreter().then(() => process.exit(0)));
  }).catch(e => { console.error(e.message); process.exit(1); });
}
