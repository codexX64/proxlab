import { EventEmitter } from 'node:events';
import { test, before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { demarrer } from '../src/main.js';
import { Client } from '../socle/essai/client.js';
import { adminComplet, membreInvite } from '../socle/essai/inscription.js';
import { fauxProxmox, JETON, UTILISATEUR } from './faux-pve.js';
import { chemin } from '../src/pve.js';
import { connecter as connecterTls, empreinte } from '../src/tls.js';
import { registerHooks } from 'node:module';
// Le navigateur charge le socle sous /socle/ (web/socle/… vu de web/) ; ici, depuis socle/web/.
registerHooks({ resolve: (spec, ctx, suite) => (/\/web\/[^/]+\.js$/.test(ctx.parentURL || '') && spec.startsWith('./socle/') ? suite(new URL(`../socle/web/${spec.slice(8)}`, import.meta.url).href, ctx) : suite(spec, ctx)) });
const { Inflate, encodages } = await import('../web/ecran.js');
import { Connexion } from '../src/websocket.js';
import { corpsTicket, urgence } from '../src/alerte.js';
import { desChiffrer, reponseVnc } from '../src/des.js';
import { longueurMessageClient, relayerEcran } from '../src/ecran.js';
import { relayer } from '../src/console.js';
import { dispositionDe, lireSortie, detecterClavier, SCRIPT_CLAVIER } from '../src/clavier.js';

const JETON_HUB = 'jeton-du-hub-pour-les-essais-de-proxlab-0123';
const INSTALL = 'jeton-installation-proxlab-essai';
const SILENCE = { info() {}, warn() {}, error() {} };
const CLE = crypto.randomBytes(32).toString('base64');
let s, pve, admin, cleAdmin, membre, lecteur, base, journalServeur = [];

async function lancer(dossier, extra = {}) {
  const env = { PORT: '0', HOTE: '127.0.0.1', DATA_DIR: dossier, PROXLAB_HUB_TOKEN: JETON_HUB, PROXLAB_INTERVAL: '3600', SOCLE_CLE: CLE, SOCLE_JETON_INSTALLATION: INSTALL, ...extra };
  const log = { info() {}, warn: (...a) => journalServeur.push(a.join(' ')), error: (...a) => journalServeur.push(a.join(' ')) };
  const x = await demarrer(env, { log });
  return { ...x, port: x.serveur.address().port, client: () => new Client(x.serveur.address().port) };
}
const machine = (n = 'pve-a', t = 'qemu', v = 101) => `/api/machines/${n}/${t}/${v}`;
const hub = (methode, chemin, corps, jeton = JETON_HUB) => new Client(s.port).req(methode, chemin, corps, { entetes: { authorization: `Bearer ${jeton}` }, origine: null });

// Le renfort de l'administrateur retiré le temps d'un essai, puis rendu.
async function sansRenfort(fn) {
  const q = "SELECT id, renfort FROM socle_sessions WHERE compte = (SELECT id FROM socle_comptes WHERE identifiant = 'ana')";
  const sessions = s.db.prepare(q).all();
  s.db.prepare("UPDATE socle_sessions SET renfort = 0 WHERE compte = (SELECT id FROM socle_comptes WHERE identifiant = 'ana')").run();
  try { return await fn(); } finally { for (const x of sessions) s.db.prepare('UPDATE socle_sessions SET renfort = ? WHERE id = ?').run(x.renfort, x.id); }
}

async function relier(c = admin, extra = {}) {
  const sonde = await c.post('/api/liaison/sonde', { hote: pve.hote, port: pve.port });
  assert.equal(sonde.status, 200, JSON.stringify(sonde.json));
  return c.put('/api/liaison', { hote: pve.hote, port: pve.port, confiance: 'epingle', fp: sonde.json.fp, jetonId: JETON.id, secret: JETON.secret, utilisateur: UTILISATEUR.nom, motDePasse: UTILISATEUR.motDePasse, ...extra });
}

// Une console : mise à niveau WebSocket écrite à la main, comme un navigateur.
function ouvrirWs(client, passe, { origine = client.origine } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(s.port, '127.0.0.1', () => {
      const cle = crypto.randomBytes(16).toString('base64');
      const lignes = [`GET /ws/console?passe=${encodeURIComponent(passe)} HTTP/1.1`, `Host: localhost:${s.port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${cle}`, 'Sec-WebSocket-Version: 13',
        `Cookie: ${[...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ')}`, ...(origine ? [`Origin: ${origine}`] : [])];
      socket.write(lignes.join('\r\n') + '\r\n\r\n');
    });
    let tampon = Buffer.alloc(0);
    const surDonnees = d => {
      tampon = Buffer.concat([tampon, d]);
      const i = tampon.indexOf('\r\n\r\n');
      if (i < 0) return;
      const tete = tampon.subarray(0, i).toString();
      socket.removeListener('data', surDonnees);
      const code = Number(tete.split(' ')[1]);
      if (code !== 101) { socket.destroy(); return resolve({ code }); }
      const conn = new Connexion(socket, { role: 'client' });
      const recu = [], bruts = [];
      conn.on('message', (m, texte) => { recu.push(m.toString('utf8')); bruts.push({ m, texte }); });
      const reste = tampon.subarray(i + 4);
      if (reste.length) conn._recevoir(reste);
      resolve({ code, conn, recu, bruts, texte: () => recu.join(''), octets: () => Buffer.concat(bruts.filter(b => !b.texte).map(b => b.m)) });
    };
    socket.on('data', surDonnees);
    socket.on('error', reject);
  });
}
const attendre = async (cond, ms = 4000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('délai dépassé'); await new Promise(r => setTimeout(r, 25)); } };

before(async () => {
  pve = await fauxProxmox();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'proxlab-'));
  s = await lancer(base);
  admin = s.client();
  ({ auth: cleAdmin } = await adminComplet(admin, { jeton: INSTALL }));
  ({ client: membre } = await membreInvite(admin, () => s.client(), { identifiant: 'bruno' }));
  ({ client: lecteur } = await membreInvite(admin, () => s.client(), { identifiant: 'lea', role: 'lecture' }));
});
after(async () => { await s?.arreter(); await pve?.fermer(); });

test('en-têtes de sécurité, nonce, sonde publique minimale, security.txt', async () => {
  const r = await new Promise(recu => http.get({ host: '127.0.0.1', port: s.port, path: '/', agent: false, headers: { host: `localhost:${s.port}` } }, recu));
  let page = ''; for await (const m of r) page += m;
  const csp = r.headers['content-security-policy'];
  const nonce = /'nonce-([^']+)'/.exec(csp)[1];
  assert.match(page, new RegExp(`nonce="${nonce.replace(/[+/]/g, '\\$&')}"`));
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
  for (const h of ['x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy']) assert.ok(r.headers[h], h);
  assert.equal(r.headers['x-powered-by'], undefined);
  for (const f of ['proxlab.db', 'proxlab.db-wal']) assert.equal(fs.statSync(path.join(base, f)).mode & 0o777, 0o600, f);
  assert.equal(fs.statSync(base).mode & 0o077, 0, 'dossier des données fermé aux autres');
  // Une base remise dans le volume avec d'autres droits (restauration) est refermée à l'ouverture.
  const { ouvrirBase } = await import('../src/base.js');
  const ailleurs = fs.mkdtempSync(path.join(os.tmpdir(), 'proxlab-droits-'));
  const premiere = ouvrirBase(ailleurs); premiere.close();
  for (const f of fs.readdirSync(ailleurs)) fs.chmodSync(path.join(ailleurs, f), 0o644);
  ouvrirBase(ailleurs).close();
  for (const f of fs.readdirSync(ailleurs)) assert.equal(fs.statSync(path.join(ailleurs, f)).mode & 0o777, 0o600, f);
  fs.rmSync(ailleurs, { recursive: true, force: true });
  // L'interface sous /v/<version>/ : la page pointe la version en cours, gardée un an ; une autre version n'est pas figée.
  const { VERSION } = await import('../src/config.js');
  assert.match(page, new RegExp(`src="/v/${VERSION.replace(/\./g, '\\.')}/app\\.js"`));
  const servi = chemin => new Promise(ok => http.get({ host: '127.0.0.1', port: s.port, path: chemin, agent: false, headers: { host: `localhost:${s.port}` } }, r => { r.resume(); ok(r); }));
  const courant = await servi(`/v/${VERSION}/app.js`);
  assert.equal(courant.statusCode, 200);
  assert.match(courant.headers['cache-control'], /immutable/);
  assert.equal((await servi(`/v/${VERSION}/socle/compte.js`)).statusCode, 200, 'le socle suit le même préfixe (imports relatifs)');
  const autre = await servi('/v/0.0.1/app.js');
  assert.equal(autre.headers['cache-control'], 'no-cache');
  assert.equal((await servi(`/v/${VERSION}/../src/config.js`)).statusCode, 404);
  const sante = await s.client().get('/api/health');
  assert.deepEqual(sante.json, { ok: true });
  const st = await s.client().get('/.well-known/security.txt');
  assert.match(st.texte, /Contact: https:\/\/github\.com\/CodexX64\/proxlab\/security\/advisories\/new/);
  assert.match(st.texte, /Expires: /);
});

test('autorisation : chaque route refuse l\'anonyme, la lecture et le membre selon son rôle déclaré, et le Hub ne vaut jamais session', async () => {
  const anonyme = s.client();
  const rang = { lecture: 0, membre: 1, admin: 2 };
  const exemple = p => p.replace(':noeud', 'pve-a').replace(':type', 'qemu').replace(':vmid', '101').replace(':nom', 'avant-maj').replace(':stockage', 'local').replace(':upid', 'UPID:pve-a:00000001:00000002:00000003:qmstart:101:essai@pve:');
  let n = 0;
  for (const route of s.api.routeur.routes) {
    const p = route.re.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, ':x');
    const motif = route.re.source;
    const original = s.api.routeur.routes.find(x => x === route);
    const chemin = exemple(p.replace(/:x/g, m => m)).replace(/:x/g, 'x');
    if (route.options.public) continue;
    n++;
    const methode = route.methode;
    const viaChemin = (() => {
      const segs = motif.replace(/^\^/, '').replace(/\$$/, '').split('\\/').filter(Boolean);
      const valeurs = { 0: 'pve-a', 1: 'qemu', 2: '101', 3: 'avant-maj' };
      let i = 0;
      return '/' + segs.map(x => x === '([^/]+)' ? (route.cles[i] === 'upid' ? 'UPID:pve-a:00000001:00000002:00000003:qmstart:101:essai@pve:' : ({ noeud: 'pve-a', type: 'qemu', vmid: '101', nom: 'avant-maj', stockage: 'local' })[route.cles[i++] ?? ''] ?? 'x') : x).join('/');
    })();
    void original; void chemin;
    const corps = methode === 'GET' || methode === 'DELETE' ? undefined : {};
    const r0 = await anonyme.req(methode, viaChemin, corps);
    assert.equal(r0.status, 401, `${methode} ${viaChemin} anonyme : ${r0.status}`);
    if (route.options.hub) {
      const rs = await admin.req(methode, viaChemin, corps);
      assert.equal(rs.status, 401, `${methode} ${viaChemin} : une session n'ouvre pas une route du Hub`);
      continue;
    }
    const exige = rang[route.options.role];
    assert.ok(exige !== undefined, `${methode} ${viaChemin} déclare son rôle`);
    const rh = await hub(methode, viaChemin, corps);
    assert.ok([401, 403].includes(rh.status), `${methode} ${viaChemin} : le jeton du Hub n'ouvre pas une route de session (${rh.status})`);
    if (exige >= 1) { const rl = await lecteur.req(methode, viaChemin, corps); assert.equal(rl.status, 403, `${methode} ${viaChemin} lecture : ${rl.status}`); }
    if (exige >= 2) { const rm = await membre.req(methode, viaChemin, corps); assert.equal(rm.status, 403, `${methode} ${viaChemin} membre : ${rm.status}`); }
  }
  assert.ok(n >= 25, `routes balayées : ${n}`);
});

test('requêtes : écriture sans jeton anti-CSRF ni bonne origine refusée, corps bornés et en JSON, configuration invalide refusée au démarrage', async () => {
  const { lireConfigProxlab } = await import('../src/config.js');
  assert.equal((await membre.post(machine() + '/alimentation', { action: 'start' }, { sansCsrf: true })).status, 403, 'sans jeton anti-CSRF');
  assert.equal((await membre.post(machine() + '/alimentation', { action: 'start' }, { origine: 'https://evil.example' })).status, 403, 'autre origine');
  assert.equal((await membre.req('POST', machine() + '/alimentation', undefined, { brut: 'action=start', entetes: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415, 'JSON seulement');
  assert.equal((await membre.post(machine() + '/instantanes', { nom: 'gros', description: 'x'.repeat(70 * 1024) })).status, 413, 'corps borné');
  assert.equal((await membre.post(machine() + '/alimentation', { action: 'start', en_trop: 1 })).status, 400, 'champ inconnu refusé');
  for (const [k, v] of [['PROXLAB_HUB_TOKEN', 'court'], ['PROXLAB_INTERVAL', '5'], ['PROXLAB_EVENTS_DAYS', '0'], ['PORT', 'quatre-vingt']]) {
    assert.throws(() => lireConfigProxlab({ [k]: v }), new RegExp(k), `${k}=${v}`);
  }
  const vide = path.join(base, 'cle-vide');
  fs.writeFileSync(vide, '');
  assert.throws(() => lireConfigProxlab({ SOCLE_CLE_FILE: vide }), /est vide/);
  fs.rmSync(vide);
});

test('liaison : sonde, empreinte épinglée, essai en direct, secrets scellés, jamais rendus', async () => {
  const avant = await admin.get('/api/etat');
  assert.equal(avant.json.relie, false);
  const sonde = await admin.post('/api/liaison/sonde', { hote: pve.hote, port: pve.port });
  assert.equal(sonde.json.fp, empreinte(pve.empreinte));
  assert.equal(sonde.json.autorite, false, 'l\'autorité de la grappe n\'est pas celle du système');
  // L'autorité du système ne reconnaît pas la grappe : refus, rien d'enregistré.
  const parAutorite = await admin.put('/api/liaison', { hote: pve.hote, port: pve.port, confiance: 'autorite', jetonId: JETON.id, secret: JETON.secret });
  assert.equal(parAutorite.status, 502);
  assert.equal((await admin.get('/api/liaison')).json.liaison, null);
  // Une empreinte fausse : refus, et Proxmox n'a reçu aucune requête.
  const n0 = pve.appels.length;
  const fausse = await admin.put('/api/liaison', { hote: pve.hote, port: pve.port, confiance: 'epingle', fp: 'sha256:' + 'ab'.repeat(32), jetonId: JETON.id, secret: JETON.secret });
  assert.equal(fausse.status, 502);
  assert.match(fausse.json.error, /empreinte/);
  assert.equal(pve.appels.length, n0, 'aucun octet applicatif avant la vérification de l\'empreinte');
  // Identifiants faux : refus.
  const mauvais = await admin.put('/api/liaison', { hote: pve.hote, port: pve.port, confiance: 'epingle', fp: sonde.json.fp, jetonId: JETON.id, secret: 'mauvais-secret' });
  assert.equal(mauvais.status, 502);
  // Adresses interdites.
  for (const hote of ['169.254.169.254', '0.0.0.0', '224.0.0.1']) assert.equal((await admin.post('/api/liaison/sonde', { hote, port: 8006 })).status, 400, hote);
  const ok = await relier();
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.version, '8.4.1');
  assert.equal(ok.json.noeuds, 2);
  const lue = (await admin.get('/api/liaison')).json.liaison;
  assert.deepEqual([lue.aSecret, lue.aMotDePasse, lue.confiance], [true, true, 'epingle']);
  assert.ok(!JSON.stringify(lue).includes(JETON.secret) && !JSON.stringify(lue).includes(UTILISATEUR.motDePasse));
  const brut = JSON.stringify(s.db.prepare("SELECT valeur FROM reglages WHERE cle = 'liaison'").get());
  assert.ok(!brut.includes(JETON.secret) && !brut.includes(UTILISATEUR.motDePasse), 'secrets scellés en base');
  // Un champ secret laissé vide garde la valeur ; un changement d'hôte l'oublie.
  const garde = await admin.put('/api/liaison', { hote: pve.hote, port: pve.port, confiance: 'epingle', fp: sonde.json.fp, jetonId: JETON.id, utilisateur: UTILISATEUR.nom });
  assert.equal(garde.status, 200, JSON.stringify(garde.json));
  const ailleurs = await admin.put('/api/liaison', { hote: 'localhost', port: pve.port, confiance: 'epingle', fp: sonde.json.fp, jetonId: JETON.id, utilisateur: UTILISATEUR.nom });
  assert.equal(ailleurs.status, 400, 'un secret ne suit pas un changement de destination');
  // Le lecteur et le membre ne voient pas la liaison ; sans renfort, l'admin ne la change pas.
  assert.equal((await membre.get('/api/liaison')).status, 403);
  const sans = await sansRenfort(() => admin.put('/api/liaison', { hote: pve.hote, port: pve.port, confiance: 'epingle', fp: sonde.json.fp, jetonId: JETON.id }));
  assert.equal(sans.status, 403);
  assert.ok(sans.json.details?.renfort);
});

test('état de la grappe et fiche d\'une machine : champs choisis, rien de sensible de la configuration', async () => {
  const e = (await lecteur.get('/api/etat')).json;
  assert.equal(e.relie, true);
  assert.equal(e.noeuds.length, 2);
  assert.ok(e.machines.some(m => m.vmid === 9000 && m.template));
  assert.deepEqual(Object.keys(e.noeuds[0]).sort(), ['alias', 'cpu', 'disk', 'maxcpu', 'maxdisk', 'maxmem', 'mem', 'node', 'status', 'uptime']);
  const f = (await lecteur.get(machine())).json;
  assert.equal(f.name, 'passerelle');
  for (const k of ['cipassword', 'sshkeys', 'ciuser', 'digest']) assert.equal(f.config[k], undefined, k);
  assert.equal(f.config.cores, '2');
  assert.deepEqual(f.instantanes.map(x => x.name), ['avant-maj']);
  assert.equal((await lecteur.get(machine() + '/rrd?tf=day')).status, 200);
  assert.equal((await lecteur.get(machine() + '/rrd?tf=siecle')).status, 400);
  assert.equal((await lecteur.get(machine() + '/rrd?tf=hour&limit=100000')).status, 400, 'paramètre non déclaré');
  const r = (await lecteur.get('/api/noeuds/pve-a/reseau')).json;
  assert.equal(r[0].iface, 'eno1');
  const t = (await lecteur.get('/api/taches?limite=5')).json;
  assert.ok(Array.isArray(t));
});

test('réseau : adresse MAC de chaque interface, lue dans la seule section `ip address` du rapport, demandée une fois', async () => {
  const rapports = () => pve.appels.filter(a => /^\/nodes\/[^/]+\/report$/.test(a.chemin)).length;
  const n0 = rapports();
  const [a, b] = await Promise.all([lecteur.get('/api/noeuds/pve-a/reseau/mac'), lecteur.get('/api/noeuds/pve-a/reseau/mac')]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, {
    eno1: { mac: '00:00:5e:00:53:01', autresNoms: ['enp3s0f0'] },
    eno2: { mac: '00:00:5e:00:53:02', autresNoms: ['enp3s0f1'] },
    vmbr0: { mac: '00:00:5e:00:53:01', autresNoms: [] },
  }, 'adresse d’usine d’une carte d’agrégat, ni bouclage, ni nom hors format, ni adresse malformée, ni leurre hors section');
  assert.deepEqual(b.json, a.json);
  assert.equal((await lecteur.get('/api/noeuds/pve-a/reseau/mac')).status, 200);
  assert.equal(rapports() - n0, 1, 'une seule demande de rapport, même concurrente');
  assert.ok(!JSON.stringify(a.json).includes('192.0.2'), 'rien d’autre du rapport ne sort');
  const refus = await lecteur.get('/api/noeuds/pve-b/reseau/mac');
  assert.equal(refus.status, 502);
  assert.match(refus.json.erreur || refus.json.message || JSON.stringify(refus.json), /Sys\.Audit/);
  assert.equal((await lecteur.get('/api/noeuds/pve-b/reseau/mac')).status, 502);
  assert.equal(rapports() - n0, 2, 'un refus est retenu aussi : Proxmox n’est pas relancé à chaque affichage');
  assert.equal((await lecteur.get('/api/noeuds/-pve/reseau/mac')).status, 404);
  assert.equal(rapports() - n0, 2);
});

test('chemins : un segment hors format n\'atteint jamais Proxmox', async () => {
  const n0 = pve.appels.length;
  for (const p of ['/api/machines/pve-a/qemu/1', '/api/machines/pve-a/qemu/101abc', '/api/machines/pve-a/kvm/101', '/api/machines/..%2F..%2Fnodes/qemu/101',
    '/api/machines/pve-a/qemu/101%2F..%2F..', '/api/noeuds/-pve/reseau', '/api/taches/pve-a/pas-un-upid', '/api/stockages/pve-a/..%2Fetc/contenu']) {
    const r = await lecteur.get(p);
    assert.ok([400, 404].includes(r.status), `${p} : ${r.status}`);
  }
  assert.equal(pve.appels.length, n0);
  assert.throws(() => chemin('nodes', '..', 'qemu'), /refusé/);
  assert.throws(() => chemin('nodes', 'pve..a'), /refusé/, '« .. » au milieu d\'un segment');
  assert.throws(() => chemin('nodes', 'a?b=c'), /refusé/);
  assert.equal(chemin('nodes', 'pve-a', 'qemu', 101), '/nodes/pve-a/qemu/101');
});

test('alimentation : le membre démarre et arrête proprement ; forcer exige l\'admin sous renfort ; chaque geste est un événement', async () => {
  const d = await membre.post(machine('pve-b', 'qemu', 130) + '/alimentation', { action: 'start' });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.match(d.json.upid, /^UPID:pve-b:/);
  assert.equal(pve.etat.machines.find(m => m.vmid === 130).status, 'running');
  assert.equal((await membre.post(machine('pve-b', 'qemu', 130) + '/alimentation', { action: 'stop' })).status, 403);
  assert.equal((await lecteur.post(machine('pve-b', 'qemu', 130) + '/alimentation', { action: 'start' })).status, 403);
  assert.equal((await membre.post(machine('pve-b', 'qemu', 130) + '/alimentation', { action: 'detruire' })).status, 400);
  assert.equal((await membre.post(machine('pve-b', 'qemu', 130) + '/alimentation', { action: 'start', vmid: 1 })).status, 400, 'champ inconnu refusé');
  const sans = await sansRenfort(() => admin.post(machine('pve-b', 'qemu', 130) + '/alimentation', { action: 'stop' }));
  assert.equal(sans.status, 403);
  const force = await admin.post(machine('pve-b', 'qemu', 130) + '/alimentation', { action: 'stop' });
  assert.equal(force.status, 200);
  assert.equal((await admin.post(machine('pve-a', 'lxc', 110) + '/alimentation', { action: 'reset' })).status, 400, 'pas de réinitialisation d\'un conteneur');
  // Démarrer une machine déjà en marche : l'erreur de Proxmox, courte et référencée.
  const deja = await membre.post(machine() + '/alimentation', { action: 'start' });
  assert.equal(deja.status, 502);
  assert.match(deja.json.error, /^Proxmox : VM 101 already running \(réf\. [0-9a-f]{8}\)\.$/);
  const ev = (await lecteur.get('/api/evenements?limite=10')).json;
  assert.ok(ev.some(e => e.kind === 'guest.started' && e.target === 'qemu/130' && e.by === 'bruno'));
  assert.ok(ev.some(e => e.kind === 'guest.stopped' && e.title.includes('de force') && e.by === 'ana'));
  const j = s.db.prepare("SELECT * FROM socle_journal WHERE action = 'machine.alimentation'").all();
  assert.equal(j.length, 1, 'un arrêt forcé est au journal de sécurité');
});

test('instantanés, sauvegardes, configuration, migration : rôle, renfort et validation', async () => {
  const cree = await membre.post(machine() + '/instantanes', { nom: 'essai-1', description: 'avant', avecMemoire: true });
  assert.equal(cree.status, 200, JSON.stringify(cree.json));
  assert.equal(pve.appels.at(-1).params.vmstate, '1');
  assert.equal((await membre.post(machine() + '/instantanes', { nom: '1-mauvais' })).status, 400);
  assert.equal((await membre.post(machine() + '/instantanes/essai-1/retour', {})).status, 403);
  assert.equal((await admin.post(machine() + '/instantanes/essai-1/retour', {})).status, 200);
  assert.equal((await membre.del(machine() + '/instantanes/essai-1')).status, 403);
  assert.equal((await admin.del(machine() + '/instantanes/essai-1')).status, 200);
  const inconnu = await admin.del(machine() + '/instantanes/inconnu');
  assert.equal(inconnu.status, 502);

  const sv = await membre.post(machine() + '/sauvegardes', { stockage: 'sauvegardes', mode: 'snapshot', compression: 'zstd' });
  assert.equal(sv.status, 200);
  const liste = (await lecteur.get(machine() + '/sauvegardes')).json;
  assert.ok(liste.stockages.includes('sauvegardes'));
  assert.ok(liste.sauvegardes.length >= 2);
  const volid = liste.sauvegardes[0].volid;
  assert.equal((await membre.del(`/api/sauvegardes/pve-a/sauvegardes?volid=${encodeURIComponent(volid)}`)).status, 403);
  assert.equal((await admin.del(`/api/sauvegardes/pve-a/local?volid=${encodeURIComponent(volid)}`)).status, 400, 'volume hors du stockage nommé');
  assert.equal((await admin.del(`/api/sauvegardes/pve-a/sauvegardes?volid=${encodeURIComponent('sauvegardes:backup/../../etc/passwd')}`)).status, 400);
  assert.equal((await admin.del(`/api/sauvegardes/pve-a/sauvegardes?volid=${encodeURIComponent(volid)}`)).status, 200);
  // Une erreur de Proxmox qui cite un chemin de l'hyperviseur : le chemin ne sort pas.
  const absent = await admin.del(`/api/sauvegardes/pve-a/sauvegardes?volid=${encodeURIComponent(volid)}`);
  assert.equal(absent.status, 502);
  assert.doesNotMatch(absent.json.error, /\/mnt\/pve/);
  assert.ok(journalServeur.some(l => l.includes('/mnt/pve/sauvegardes/dump')), 'le détail va au journal du serveur');

  assert.equal((await membre.put(machine() + '/configuration', { nom: 'routeur' })).status, 403);
  assert.equal((await admin.put(machine() + '/configuration', { nom: 'routeur', memoire: 3072 })).status, 200);
  assert.deepEqual([pve.appels.at(-1).params.name, pve.appels.at(-1).params.memory], ['routeur', '3072']);
  assert.equal((await admin.put(machine() + '/configuration', { cipassword: 'x' })).status, 400, 'champ non modifiable');
  assert.equal((await admin.put(machine() + '/configuration', { memoire: 'beaucoup' })).status, 400);
  assert.equal((await admin.put(machine() + '/configuration', {})).status, 400);

  assert.equal((await membre.post(machine('pve-a', 'lxc', 110) + '/migration', { cible: 'pve-b' })).status, 403);
  assert.equal((await admin.post(machine('pve-a', 'lxc', 110) + '/migration', { cible: 'pve-a' })).status, 400);
  const mig = await admin.post(machine('pve-a', 'lxc', 110) + '/migration', { cible: 'pve-b', enLigne: true });
  assert.equal(mig.status, 200);
  assert.equal(pve.appels.at(-1).params.restart, '1', 'un conteneur se migre en redémarrant');
  assert.equal(pve.etat.machines.find(m => m.vmid === 110).node, 'pve-b');
});

test('console : passe à usage unique liée à la session, origine contrôlée, shell d\'un nœud sous renfort', async () => {
  const p = await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101' });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  // Une autre session, ou une autre origine, ne s'en sert pas.
  assert.equal((await ouvrirWs(admin, p.json.passe)).code, 403);
  const p2 = await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101' });
  assert.equal((await ouvrirWs(membre, p2.json.passe, { origine: 'https://evil.example' })).code, 403);
  const p3 = await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101' });
  const ws = await ouvrirWs(membre, p3.json.passe);
  assert.equal(ws.code, 101);
  await attendre(() => ws.texte().includes('invite-101:~#'));
  assert.ok(!ws.texte().startsWith('OK'), 'l\'accusé de Proxmox n\'est pas une sortie');
  ws.conn.envoyerTexte(JSON.stringify({ r: [100, 30] }));
  ws.conn.envoyerTexte(JSON.stringify({ i: 'hostname\r' }));
  await attendre(() => ws.texte().includes('\x1b[32minvite-101'));
  ws.conn.envoyerTexte(JSON.stringify({ r: [99999, 1] }));
  ws.conn.envoyerTexte('pas du json');
  ws.conn.envoyerTexte(JSON.stringify({ r: [80, 24] }));
  await attendre(() => pve.consoles.at(-1).tailles.length >= 2);
  assert.deepEqual(pve.consoles.at(-1).tailles, [[100, 30], [80, 24]], 'une taille hors bornes n\'est pas transmise');
  ws.conn.close();
  // La passe a déjà servi.
  assert.equal((await ouvrirWs(membre, p3.json.passe)).code, 403);
  // Le shell d'un nœud : administrateur sous renfort.
  assert.equal((await membre.post('/api/console', { noeud: 'pve-a', type: 'node' })).status, 403);
  const sans = await sansRenfort(() => admin.post('/api/console', { noeud: 'pve-a', type: 'node' }));
  assert.equal(sans.status, 403);
  const pn = await admin.post('/api/console', { noeud: 'pve-a', type: 'node' });
  const wn = await ouvrirWs(admin, pn.json.passe);
  await attendre(() => wn.texte().includes('root@pve-a:~#'));
  wn.conn.close();
  assert.equal((await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu' })).status, 400, 'VMID requis');
  assert.ok(s.db.prepare("SELECT count(*) n FROM socle_journal WHERE action = 'console.ouverte'").get().n >= 2);
  // Sans session, pas de console même avec une passe.
  const p4 = await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101' });
  assert.equal((await ouvrirWs(s.client(), p4.json.passe)).code, 401);
  const refus = s.db.prepare("SELECT details FROM socle_journal WHERE action = 'console.refusee'").all();
  for (const motif of ['passe', 'origine ou poignée', 'session']) assert.ok(refus.some(r => JSON.parse(r.details).raison === motif), `refus de console au journal : ${motif}`);
  assert.ok(!refus.some(r => [p.json.passe, p2.json.passe, p3.json.passe, p4.json.passe].some(x => String(r.details).includes(x))), 'jamais la passe au journal');
});

test('écran d\'une VM : poignée VNC faite par ProxLab, le ticket ne sort jamais, seuls les messages d\'un client RFB passent', async () => {
  // DES : vecteurs de référence, puis la réponse VNC (clé aux bits inversés).
  assert.equal(desChiffrer(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex')).toString('hex'), '85e813540f0ab405');
  assert.equal(desChiffrer(Buffer.from('0101010101010101', 'hex'), Buffer.from('95F8A5E5DD31D900', 'hex')).toString('hex'), '8000000000000000');
  assert.equal(reponseVnc('PVEVNC:6ABCDEF', Buffer.from([...Array(16).keys()])).toString('hex'), '6cd546c0dcc738ca6c0274eae59a2bf2');
  // Filtre du sens navigateur → Proxmox.
  assert.equal(longueurMessageClient(Buffer.from([3, 1, 0]), false), 0, 'demande incomplète : attendre');
  assert.equal(longueurMessageClient(Buffer.alloc(10, 0).fill(3, 0, 1), false), 10);
  assert.equal(longueurMessageClient(Buffer.from([2, 0, 0xff, 0xff]), false), -1, 'trop d\'encodages');
  assert.equal(longueurMessageClient(Buffer.from([6, 0, 0, 0, 0x10, 0, 0, 0]), false), -1, 'presse-papiers démesuré');
  assert.equal(longueurMessageClient(Buffer.from([255, 1]), false), -1, 'seule la touche étendue de QEMU passe');
  assert.equal(longueurMessageClient(Buffer.from([7]), false), -1);
  // SetDesktopSize : un écran de 1920 × 1080, entier et borné.
  const taille = Buffer.alloc(24); taille.writeUInt8(251, 0); taille.writeUInt16BE(1920, 2); taille.writeUInt16BE(1080, 4); taille.writeUInt8(1, 6);
  assert.equal(longueurMessageClient(taille, false), 24);
  assert.equal(longueurMessageClient(taille.subarray(0, 12), false), 0, 'écran incomplet : attendre');
  const sansEcran = Buffer.from(taille); sansEcran.writeUInt8(0, 6);
  assert.equal(longueurMessageClient(sansEcran, false), -1, 'au moins un écran');
  const geant = Buffer.from(taille); geant.writeUInt16BE(9000, 2);
  assert.equal(longueurMessageClient(geant, false), -1, 'taille bornée');
  const trop = Buffer.from(taille); trop.writeUInt8(17, 6);
  assert.equal(longueurMessageClient(trop, false), -1, 'seize écrans au plus');

  assert.equal((await membre.post('/api/console', { noeud: 'pve-a', type: 'lxc', vmid: '200', mode: 'ecran' })).status, 400, 'un conteneur n\'a pas d\'écran');
  assert.equal((await lecteur.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101', mode: 'ecran' })).status, 403);
  const p = await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101', mode: 'ecran' });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const ws = await ouvrirWs(membre, p.json.passe);
  assert.equal(ws.code, 101);
  await attendre(() => ws.recu.some(t => t.includes('"pret":true')));
  const e = pve.ecrans.at(-1);
  assert.equal(e.authentifie, true, 'réponse au défi calculée avec le ticket');
  assert.equal(e.cible, 'qemu/101');
  // Une souris qui bouge avant ClientInit : laissée de côté, la poignée continue.
  ws.conn.envoyerBinaire(Buffer.from([5, 0, 0, 10, 0, 10]));
  ws.conn.envoyerBinaire(Buffer.from([1]));                                     // ClientInit
  await attendre(() => ws.octets().length >= 24);
  const init = ws.octets();
  assert.deepEqual([init.readUInt16BE(0), init.readUInt16BE(2)], [4, 2]);
  assert.equal(init.subarray(24).toString(), 'invite-101');
  const pf = Buffer.alloc(20); pf.set([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16]);
  const enc = Buffer.alloc(12); enc[0] = 2; enc.writeUInt16BE(2, 2); enc.writeInt32BE(0, 4); enc.writeInt32BE(-258, 8);
  const demande = Buffer.from([3, 0, 0, 0, 0, 0, 0, 4, 0, 2]);
  // Un message coupé en deux trames arrive entier.
  ws.conn.envoyerBinaire(Buffer.concat([pf, enc, demande.subarray(0, 4)]));
  ws.conn.envoyerBinaire(demande.subarray(4));
  await attendre(() => ws.octets().length >= init.length + 16 + 48);
  const ack = ws.octets().subarray(init.length, init.length + 16);
  assert.equal(ack.readInt32BE(12), -258, 'QEMU accuse la touche étendue');
  const image = ws.octets().subarray(init.length + 16);
  assert.deepEqual([image[0], image.readUInt16BE(2), image.readInt32BE(12)], [0, 1, 0], 'une image brute de 4 × 2');
  const touche = Buffer.alloc(12); touche[0] = 255; touche.writeUInt16BE(1, 2); touche.writeUInt32BE(0x61, 4); touche.writeUInt32BE(0x10, 8);
  ws.conn.envoyerBinaire(touche);
  await attendre(() => e.messages.length >= 4);
  assert.deepEqual(e.messages.map(m => m[0]), [0, 2, 3, 255]);
  assert.ok(!ws.texte().includes('PVEVNC'), 'le ticket de vncproxy ne part jamais vers le navigateur');
  // Tout autre message ferme l'écran.
  ws.conn.envoyerBinaire(Buffer.from([7, 0, 0, 0]));
  await attendre(() => ws.recu.some(t => t.includes('message refusé')));
  assert.equal(e.messages.length, 4, 'le message refusé n\'atteint pas Proxmox');
  const ligne = s.db.prepare("SELECT details FROM socle_journal WHERE action = 'console.ouverte' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(JSON.parse(ligne.details).mode, 'ecran');
});

test('écran : presse-papiers étendu dans les deux sens, ancien presse-papiers, reprise quand Proxmox coupe la poignée, ticket demandé au nom de l\'utilisateur', async () => {
  // Filtre : le ClientCutText étendu (longueur négative) passe, borné.
  const etendu = Buffer.alloc(16); etendu[0] = 6; etendu.writeInt32BE(-8, 4);
  assert.equal(longueurMessageClient(etendu, false), 16);
  const enorme = Buffer.alloc(8); enorme[0] = 6; enorme.writeInt32BE(-(1 << 20), 4);
  assert.equal(longueurMessageClient(enorme, false), -1);
  const court = Buffer.alloc(8); court[0] = 6; court.writeInt32BE(-2, 4);
  assert.equal(longueurMessageClient(court, false), -1, 'un message étendu a au moins ses drapeaux');

  pve.coupures.ecran = 1;   // la première connexion est coupée pendant la poignée
  const p = await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101', mode: 'ecran' });
  const ws = await ouvrirWs(membre, p.json.passe);
  await attendre(() => ws.recu.some(t => t.includes('"pret":true')));
  assert.equal(pve.coupures.ecran, 0, 'la seconde tentative a pris');
  const vnc = pve.appels.filter(a => /vncproxy$/.test(a.chemin)).at(-1);
  assert.equal(vnc.auth, 'ticket', 'vncproxy demandé avec le ticket de session, pas le jeton : sinon Proxmox refuse le WebSocket');
  const e = pve.ecrans.at(-1);
  ws.conn.envoyerBinaire(Buffer.from([1]));
  await attendre(() => ws.octets().length >= 24);
  const n0 = ws.octets().length;
  const enc = Buffer.alloc(12); enc[0] = 2; enc.writeUInt16BE(2, 2); enc.writeInt32BE(-258, 4); enc.writeInt32BE(0xC0A1E5CE | 0, 8);
  ws.conn.envoyerBinaire(enc);
  // L'accusé de la touche étendue, puis les capacités du serveur.
  await attendre(() => ws.octets().length >= n0 + 16 + 16);
  const caps = ws.octets().subarray(n0 + 16);
  assert.equal(caps[0], 3);
  assert.ok(caps.readInt32BE(4) < 0, 'ServerCutText étendu');
  assert.ok(caps.readUInt32BE(8) & (1 << 24), 'capacités');
  const coupe = (flags, donnees = Buffer.alloc(0)) => { const t = Buffer.alloc(12); t[0] = 6; t.writeInt32BE(-(4 + donnees.length), 4); t.writeUInt32BE(flags >>> 0, 8); return Buffer.concat([t, donnees]); };
  // Invité → navigateur : avis, demande, fourniture (zlib, UTF-8).
  const n1 = ws.octets().length;
  e.copierInvite('bonjour é → ok\nligne 2');
  await attendre(() => ws.octets().length >= n1 + 12);
  assert.equal(ws.octets().readUInt32BE(n1 + 8), (1 << 27) | 1, 'avis : du texte est copié');
  const n2 = ws.octets().length;
  ws.conn.envoyerBinaire(coupe((1 << 25) | 1));
  await attendre(() => ws.octets().length > n2 + 12);
  await attendre(() => { const o = ws.octets().subarray(n2); return o.length >= 8 && o.length >= 8 + Math.abs(o.readInt32BE(4)); });
  const fourni = ws.octets().subarray(n2);
  assert.equal(fourni.readUInt32BE(8), (1 << 28) | 1);
  const z = zlib.inflateSync(fourni.subarray(12, 8 + Math.abs(fourni.readInt32BE(4))));
  assert.equal(z.subarray(4, 4 + z.readUInt32BE(0)).toString('utf8'), 'bonjour é → ok\r\nligne 2\0');
  // Navigateur → invité : avis, le serveur demande, le navigateur fournit.
  const n3 = ws.octets().length;
  ws.conn.envoyerBinaire(coupe((1 << 27) | 1));
  await attendre(() => ws.octets().length >= n3 + 12);
  assert.equal(ws.octets().readUInt32BE(n3 + 8), (1 << 25) | 1, 'le serveur demande le texte');
  const texte = Buffer.from('mot de passe : Été-2026!\r\n\0');
  const brut = Buffer.alloc(4); brut.writeUInt32BE(texte.length);
  ws.conn.envoyerBinaire(coupe((1 << 28) | 1, zlib.deflateSync(Buffer.concat([brut, texte]))));
  await attendre(() => e.presse !== null);
  assert.equal(e.presse, 'mot de passe : Été-2026!\n');
  // L'ancien ClientCutText (Latin-1) passe aussi.
  const ancien = Buffer.from('ancien'); const ent = Buffer.alloc(8); ent[0] = 6; ent.writeUInt32BE(ancien.length, 4);
  ws.conn.envoyerBinaire(Buffer.concat([ent, ancien]));
  await attendre(() => e.presse === 'ancien');
  ws.conn.close();
});

test('console d\'une VM sans port série : refus clair avant Proxmox, ajout par l\'administrateur, presse-papiers branché sur l\'affichage', async () => {
  const sans = await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '102' });
  assert.equal(sans.status, 409);
  assert.equal(sans.json.details?.sansSerie, true);
  assert.match(sans.json.error, /port série/);
  assert.ok(!pve.appels.some(a => a.chemin === '/nodes/pve-a/qemu/102/termproxy'), 'Proxmox n\'est pas appelé pour rien');
  const fiche = await membre.get(machine('pve-a', 'qemu', 101));
  assert.equal(fiche.json.config.serial0, 'socket');
  assert.equal(fiche.json.config.vga, 'std,clipboard=vnc');
  const acces = machine('pve-a', 'qemu', 102) + '/acces';
  assert.equal((await membre.post(acces, { portSerie: true })).status, 403);
  assert.equal((await sansRenfort(() => admin.post(acces, { portSerie: true }))).status, 403);
  assert.equal((await admin.post(acces, {})).status, 400);
  assert.equal((await admin.post(machine('pve-a', 'lxc', 110) + '/acces', { portSerie: true })).status, 400);
  const r = await admin.post(acces, { portSerie: true, pressePapiers: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.champs.sort(), ['serial0', 'vga']);
  const vm102 = pve.etat.machines.find(m => m.vmid === 102);
  assert.deepEqual([vm102.attente.serial0, vm102.attente.vga], ['socket', 'std,clipboard=vnc'], 'en attente du prochain démarrage');
  assert.equal((await admin.post(acces, { portSerie: true, pressePapiers: true })).json.deja, true, 'rien à refaire');
  // Tant que la VM n'a pas redémarré : rien d'actif, et la fiche le dit.
  const enAttente = await membre.get(machine('pve-a', 'qemu', 102));
  assert.equal(enAttente.json.config.serial0, undefined, 'la fiche montre la configuration en vigueur');
  assert.deepEqual(enAttente.json.enAttente.sort(), ['serial0', 'vga']);
  const avant = await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '102' });
  assert.equal(avant.status, 409);
  assert.equal(avant.json.details?.prevu, true);
  assert.match(avant.json.error, /redémarre/);
  assert.equal((await membre.post(machine('pve-a', 'qemu', 102) + '/alimentation', { action: 'reboot' })).status, 200);
  assert.deepEqual([vm102.conf.serial0, vm102.conf.vga], ['socket', 'std,clipboard=vnc']);
  assert.deepEqual((await membre.get(machine('pve-a', 'qemu', 102))).json.enAttente, []);
  // Un affichage SPICE (qxl) ne prend pas le presse-papiers VNC ; les options existantes sont gardées.
  pve.etat.machines.find(m => m.vmid === 130).conf = { vga: 'qxl,memory=32' };
  assert.equal((await admin.post(machine('pve-b', 'qemu', 130) + '/acces', { pressePapiers: true })).status, 409);
  pve.etat.machines.find(m => m.vmid === 130).conf = { vga: 'virtio,memory=32,clipboard=foo' };
  await admin.post(machine('pve-b', 'qemu', 130) + '/acces', { pressePapiers: true });
  const vm130 = pve.etat.machines.find(m => m.vmid === 130);
  assert.equal(vm130.attente?.vga ?? vm130.conf.vga, 'virtio,memory=32,clipboard=vnc');
  // L'écran à la taille de la fenêtre : l'affichage passe en VirtIO-GPU, ses
  // options restent, et la fiche dit le genre du prochain démarrage.
  vm130.conf = { vga: 'std,memory=32,clipboard=vnc' }; delete vm130.attente;
  const aj = await admin.post(machine('pve-b', 'qemu', 130) + '/acces', { ajustement: true });
  assert.deepEqual(aj.json.champs, ['vga'], JSON.stringify(aj.json));
  assert.equal(vm130.attente?.vga ?? vm130.conf.vga, 'virtio,memory=32,clipboard=vnc');
  assert.equal((await membre.get(machine('pve-b', 'qemu', 130))).json.vgaSuivant, 'virtio');
  assert.equal((await admin.post(machine('pve-b', 'qemu', 130) + '/acces', { ajustement: true })).json.deja, true, 'déjà en VirtIO-GPU');
  vm130.conf = { vga: 'serial0' }; delete vm130.attente;
  assert.equal((await admin.post(machine('pve-b', 'qemu', 130) + '/acces', { ajustement: true })).status, 409, 'pas d\'écran graphique');
  vm130.conf = { vga: 'virtio,memory=32,clipboard=vnc' };
  // Avec le port série, la console s'ouvre.
  const p = await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '102' });
  assert.equal(p.status, 200);
  const ws = await ouvrirWs(membre, p.json.passe);
  await attendre(() => ws.texte().includes('invite-102:~#'));
  ws.conn.close();
  const tp = pve.appels.filter(a => /termproxy$/.test(a.chemin)).at(-1);
  assert.equal(tp.auth, 'ticket', 'termproxy demandé avec le ticket de session');
});

test('clavier de la VM : demandé à l\'agent QEMU par un script fixe, disposition reconnue, agent ajouté par l\'administrateur', async t => {
  for (const [brut, d] of [['fr', 'fr'], ['fr+oss', 'fr'], ['fr+latin9', 'fr'], ['fr-latin9', 'fr'], ['fr-azerty', 'fr'], ['fr+azerty', 'fr'], ['us', 'us'], ['us+altgr-intl', 'us'], ['fr+bepo', null], ['us+intl', null], ['de', null], ['', null]]) assert.equal(dispositionDe(brut), d, brut);
  assert.deepEqual(lireSortie("gnome [('xkb', 'us'), ('xkb', 'fr+oss')]\n"), { brut: 'us', source: 'gnome' });
  assert.deepEqual(lireSortie('x11 fr\nvariante oss\nvc fr\n'), { brut: 'fr+oss', source: 'système' });
  assert.deepEqual(lireSortie('vc fr-latin9\n'), { brut: 'fr-latin9', source: 'console' });
  // KDE, Hyprland, Sway, Xfce : la disposition de la session passe avant celle du système.
  assert.deepEqual(lireSortie('session fr\nvariante oss\n'), { brut: 'fr+oss', source: 'session' });
  assert.deepEqual(lireSortie('session us\nx11 fr\n'), { brut: 'us', source: 'session' });
  assert.equal(dispositionDe(lireSortie('session fr\n').brut), 'fr');
  assert.equal(spawnSync('sh', ['-n'], { input: SCRIPT_CLAVIER }).status, 0, 'le script lu par l’agent est du sh valide');
  for (const forme of ['session ', 'x11 ', 'vc ', "gnome [('xkb', '"]) assert.ok(lireSortie(forme + 'x'.repeat(5000) + "')]\nvariante " + 'y'.repeat(5000)).brut.length <= 129, `sortie ${forme.trim()} bornée`);
  const refuse = { get: async () => ({ agent: '1' }), post: async () => { throw new Error('Permission check failed (/vms/101, VM.GuestAgent.Unrestricted)'); } };
  const sansDroit = await detecterClavier(refuse, '/nodes/pve1/qemu/101');
  assert.equal(sansDroit.raison, 'droit');
  assert.match(sansDroit.message, /VM\.GuestAgent\.Unrestricted/);
  const url = machine('pve-a', 'qemu', 102) + '/clavier';
  assert.equal((await lecteur.get(url)).status, 403);
  assert.equal((await membre.get(machine('pve-a', 'lxc', 110) + '/clavier')).status, 400);
  assert.equal((await membre.get(url + '?script=id')).status, 400, 'paramètre non déclaré refusé, même sans lecture en cache');
  const vm = pve.etat.machines.find(m => m.vmid === 102);
  // Sans agent coché : dit, sans rien exécuter.
  const sans = await membre.get(url);
  assert.equal(sans.status, 200);
  assert.deepEqual([sans.json.disposition, sans.json.raison], [null, 'agent']);
  assert.ok(!pve.appels.some(a => /agent\/exec$/.test(a.chemin)));
  // L'administrateur coche l'agent (au prochain démarrage), en gardant les autres options.
  vm.conf = { ...vm.conf, agent: 'fstrim_cloned_disks=1' };
  assert.equal((await membre.post(machine('pve-a', 'qemu', 102) + '/acces', { agent: true })).status, 403);
  assert.equal((await admin.post(machine('pve-a', 'qemu', 102) + '/acces', { agent: true })).status, 200);
  assert.equal(vm.attente.agent, 'enabled=1,fstrim_cloned_disks=1');
  assert.equal(pve.appels.findLast(a => a.methode === 'PUT' && a.chemin.endsWith('/qemu/102/config')).params.digest, 'abc', 'écriture liée à la configuration lue');
  await membre.post(machine('pve-a', 'qemu', 102) + '/alimentation', { action: 'reboot' });
  // Agent coché mais absent de la VM : la raison, pas une erreur.
  const absent = await membre.get(url);
  assert.deepEqual([absent.json.disposition, absent.json.raison], [null, 'injoignable']);
  // Relancée trop vite : la VM n'est pas interrogée de nouveau.
  const n0 = pve.appels.filter(a => /agent\/exec$/.test(a.chemin)).length;
  vm.clavierInvite = 'us';
  assert.equal((await membre.get(url + '?relire=1')).json.raison, 'injoignable');
  assert.equal(pve.appels.filter(a => /agent\/exec$/.test(a.chemin)).length, n0, 'cinq secondes entre deux lectures');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const plusTard = () => t.mock.timers.tick(6000);
  plusTard();
  // Une session GNOME en QWERTY : reconnue.
  const us = await membre.get(url + '?relire=1');
  assert.deepEqual([us.json.disposition, us.json.brut, us.json.source], ['us', 'us', 'gnome']);
  const appel = pve.appels.filter(a => /agent\/exec$/.test(a.chemin)).at(-1);
  assert.equal(appel.params.command, 'sh', 'une seule commande, le script sur l\'entrée standard');
  assert.match(appel.params['input-data'], /gsettings get org\.gnome\.desktop\.input-sources/);
  // Gardée deux minutes : pas de nouvel appel à l'agent.
  const n = pve.appels.length;
  vm.clavierInvite = 'fr+oss';
  assert.equal((await membre.get(url)).json.disposition, 'us');
  assert.ok(!pve.appels.slice(n).some(a => /agent\/exec$/.test(a.chemin)));
  plusTard();
  assert.equal((await membre.get(url + '?relire=1')).json.disposition, 'fr');
  vm.clavierInvite = 'fr+bepo';
  plusTard();
  const bepo = await membre.get(url + '?relire=1');
  assert.deepEqual([bepo.json.disposition, bepo.json.raison, bepo.json.brut], [null, 'inconnue', 'fr+bepo']);
  assert.equal((await membre.get(url + '?relire=2')).status, 400, 'paramètre borné');
  // Une sortie démesurée de la VM n'est pas reprise telle quelle.
  vm.clavierInvite = 'x'.repeat(5000);
  plusTard();
  const long = await membre.get(url + '?relire=1');
  assert.equal(long.json.disposition, null);
  assert.ok(String(long.json.brut || '').length <= 64);
  t.mock.timers.reset();
  assert.ok(s.db.prepare("SELECT count(*) n FROM socle_journal WHERE action = 'machine.clavier'").get().n >= 1, 'lecture du clavier au journal');
});

test('surveillance : une machine tombée est un événement et un ticket signé ; un arrêt depuis ProxLab ne sonne pas', async () => {
  const recus = [];
  const recepteur = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { recus.push({ entetes: req.headers, corps: JSON.parse(b), brut: b }); res.end(JSON.stringify({ ref: 'T-1' })); }); });
  await new Promise(r => recepteur.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${recepteur.address().port}/tickets`;
  for (const mauvaise of ['http://169.254.169.254/latest', 'file:///etc/passwd', 'http://u:p@127.0.0.1/']) assert.equal((await admin.put('/api/alertes', { actif: true, url: mauvaise })).status, 400, mauvaise);
  const a = await admin.put('/api/alertes', { actif: true, url, format: 'ticket', entete: 'X-API-Key', cle: 'cle-du-recepteur-essai', secret: 'secret-hmac-du-recepteur-essai', stockage: 95 });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.alertes.aCle, true);
  assert.ok(!JSON.stringify(s.db.prepare("SELECT valeur FROM reglages WHERE cle = 'alertes'").get()).includes('cle-du-recepteur-essai'));
  assert.equal((await admin.post('/api/alertes/essai', {})).status, 200);
  assert.equal(recus.at(-1).corps.titre, 'Essai de liaison ProxLab');

  await s.surveillance.passe(); // état de référence
  const nb = recus.length;
  pve.etat.machines.find(m => m.vmid === 102).status = 'stopped';
  await membre.post(machine('pve-a', 'lxc', 110).replace('pve-a', 'pve-b') + '/alimentation', { action: 'shutdown' });
  await s.surveillance.passe();
  const t = recus.slice(nb);
  assert.equal(t.length, 1, JSON.stringify(t.map(x => x.corps.titre)));
  assert.equal(t[0].corps.dedup_key, 'proxlab-down-qemu-102');
  assert.equal(t[0].corps.urgence, 'p2');
  assert.equal(t[0].entetes['x-api-key'], 'cle-du-recepteur-essai');
  assert.equal(t[0].entetes['x-signature'], 'sha256=' + crypto.createHmac('sha256', 'secret-hmac-du-recepteur-essai').update(t[0].brut).digest('hex'));
  // Toujours arrêtée : pas de second ticket. Revenue : un événement, et la clé se réarme.
  await s.surveillance.passe();
  assert.equal(recus.length, nb + 1);
  pve.etat.machines.find(m => m.vmid === 102).status = 'running';
  await s.surveillance.passe();
  const ev = (await lecteur.get('/api/evenements?limite=20')).json;
  assert.ok(ev.some(e => e.kind === 'guest.down' && e.target === 'qemu/102' && e.severity === 'critique'));
  assert.ok(ev.some(e => e.kind === 'guest.recovered' && e.target === 'qemu/102'));
  assert.ok(!ev.some(e => e.kind === 'guest.down' && e.target === 'lxc/110'), 'arrêt voulu');
  // Un nœud perdu, et une tâche de création lue au journal de Proxmox.
  pve.etat.noeuds[1].status = 'offline';
  pve.etat.taches.unshift({ upid: 'UPID:pve-a:0000FFFF:0000AB12:6A000000:qmcreate:140:root@pam:', node: 'pve-a', type: 'qmcreate', id: '140', user: 'root@pam', starttime: Math.floor(Date.now() / 1000), endtime: Math.floor(Date.now() / 1000) + 5, status: 'OK' });
  await s.surveillance.passe();
  pve.etat.noeuds[1].status = 'online';
  const ev2 = (await lecteur.get('/api/evenements?limite=20')).json;
  assert.ok(ev2.some(e => e.kind === 'node.offline' && e.node === 'pve-b'));
  assert.ok(ev2.some(e => e.kind === 'vm.created' && e.target === 'qemu/140'));
  recepteur.close();
});

test('synthèse : ce qui reste à traiter, vingt-huit nuits de sauvegardes, sept jours de disponibilité', async () => {
  const y = (await lecteur.get('/api/synthese')).json;
  assert.equal(y.sauvegardes.jours.length, 28);
  assert.equal(y.sauvegardes.jours.reduce((a, j) => a + j.echec, 0), 1, 'la nuit en échec');
  assert.ok(y.sauvegardes.jours.reduce((a, j) => a + j.ok, 0) >= 50);
  assert.equal(y.disponibilite.heures.length, 168);
  assert.equal(y.disponibilite.heures.at(-1), 'incident', 'la panne de l\'essai précédent est sur la carte, à l\'heure en cours');
  assert.ok(y.actives.some(a => a.kind === 'node.offline' && a.node === 'pve-b'), JSON.stringify(y.actives));
  // Revenu : il n'est plus à traiter.
  await s.surveillance.passe();
  assert.ok(!(await lecteur.get('/api/synthese')).json.actives.some(a => a.kind === 'node.offline'));
  assert.equal((await lecteur.get('/api/synthese?jours=90')).status, 400, 'paramètre non déclaré');
});

test('Hub : jeton de service, état et événements en lecture, seulement trois gestes d\'alimentation', async () => {
  // Le manifeste installe l'image de cette version : version, étiquette par défaut et serveur d'accord.
  const manifeste = JSON.parse(fs.readFileSync(new URL('../hub.json', import.meta.url), 'utf8'));
  const paquet = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifeste.version, paquet.version);
  assert.equal(manifeste.config.find(c => c.key === 'IMAGE_TAG').default, paquet.version, 'le Hub installe l\'image de cette version');
  assert.equal((await import('../src/config.js')).VERSION, paquet.version);
  // Derrière Relay (réseau Docker du Hub), le HTTPS n'est reconnu que si le relais est de confiance.
  const proxys = manifeste.config.find(c => c.key === 'SOCLE_PROXYS').default;
  assert.ok(proxys, 'relais de confiance vide : ProxLab se croirait en HTTP derrière Relay');
  const relais = new net.BlockList();
  for (const p of proxys.split(',')) { const [a, l] = p.trim().split('/'); relais.addSubnet(a, Number(l)); }
  assert.ok(relais.check('172.18.0.5') && !relais.check('10.0.0.11'), 'le réseau Docker du Hub, pas le réseau local');
  const e = await hub('GET', '/api/hub/etat');
  assert.equal(e.status, 200);
  assert.equal(e.json.relie, true);
  assert.equal(e.json.machines, 5, 'le modèle ne compte pas');
  assert.deepEqual([e.json.noeuds_hors_ligne, typeof e.json.a_traiter, e.json.stockage_pct], [0, 'number', 47], 'le stockage partagé compte une fois');
  const ev = await hub('GET', '/api/hub/evenements?limite=5');
  assert.ok(ev.json.length <= 5 && ev.json[0].id);
  const al = (await hub('GET', '/api/hub/alertes?limite=50')).json;
  assert.ok(al.length >= 2 && al.every(x => ['critique', 'avertissement'].includes(x.severity)), 'les alertes seules');
  assert.ok(al.some(x => x.kind === 'guest.down'));
  assert.deepEqual(Object.keys(al[0]).sort(), ['at', 'by', 'id', 'kind', 'message', 'node', 'severity', 'target', 'title']);
  assert.equal((await hub('POST', machine('pve-b', 'qemu', 130) + '/alimentation', { action: 'start' })).status, 401, 'le jeton n\'ouvre pas les routes de session');
  assert.equal((await hub('POST', '/api/hub/machines/pve-b/qemu/130/alimentation', { action: 'stop' })).status, 400);
  assert.equal((await hub('POST', '/api/hub/machines/pve-b/qemu/130/alimentation', { action: 'start' })).status, 200);
  assert.ok((await lecteur.get('/api/evenements?limite=3')).json.some(x => x.by === 'Hub'));
  assert.equal((await hub('GET', '/api/hub/etat', undefined, 'faux-jeton-de-service-0000000000000')).status, 401);
  // Chaque jeton faux compte pour l'adresse : dix échecs bloquent, même le bon jeton.
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await hub('GET', '/api/hub/etat', undefined, `faux-jeton-de-service-${String(i).padStart(14, '0')}`)).status);
  assert.ok(codes.includes(429), codes.join(' '));
  assert.equal((await hub('GET', '/api/hub/etat')).status, 429, 'adresse bloquée');
  s.db.prepare("DELETE FROM socle_essais WHERE cle LIKE 'ip:machine:%'").run();
  assert.equal((await hub('GET', '/api/hub/etat')).status, 200);
  assert.equal((await new Client(s.port).req('GET', '/api/hub/etat', undefined, { origine: null })).status, 401);
  assert.ok(s.db.prepare("SELECT count(*) n FROM socle_journal WHERE action = 'connexion.jeton' AND resultat = 'refus'").get().n >= 1);
});

test('alerte : schéma de ticket, urgence dérivée de l\'impact et de la portée', () => {
  assert.equal(urgence({ impact: 'bloquant', portee: 'site' }), 'p1');
  assert.equal(urgence({ impact: 'inconnu', portee: 'groupe' }), 'p4');
  const t = corpsTicket({ titre: 'x', impact: 'degrade', portee: 'service', zone: { host: 'pve-a' } }, { service: 'grappe', lien: 'https://proxlab.exemple.org' });
  assert.deepEqual([t.urgence, t.service, t.source.systeme, t.liens[0].url], ['p2', 'grappe', 'proxlab', 'https://proxlab.exemple.org']);
});

test('TLS épinglé : la socket n\'est rendue qu\'après l\'empreinte, jamais avec une autre', async () => {
  const bon = await connecterTls({ hote: pve.hote, port: pve.port, confiance: 'epingle', fp: pve.empreinte });
  bon.destroy();
  await assert.rejects(connecterTls({ hote: pve.hote, port: pve.port, confiance: 'epingle', fp: 'sha256:' + '00'.repeat(32) }), /empreinte/);
  await assert.rejects(connecterTls({ hote: pve.hote, port: pve.port, confiance: 'epingle', fp: '' }), /aucune empreinte/);
  await assert.rejects(connecterTls({ hote: pve.hote, port: pve.port, confiance: 'autorite' }), e => /certificate|UNABLE|self/i.test(e.code + e.message));
  await assert.rejects(connecterTls({ hote: '169.254.169.254', port: 443, confiance: 'autorite' }), /interdite/);
});

test('données d\'un compte : ses gestes exportés, neutralisés à sa suppression', async () => {
  const { client: chloe, compteId } = await membreInvite(admin, () => s.client(), { identifiant: 'chloe' });
  await chloe.post(machine('pve-b', 'qemu', 130) + '/alimentation', { action: 'reboot' });
  assert.equal(s.evenements.donneesDe(compteId).evenements.length, 1);
  const sup = await admin.del(`/api/compte/admin/comptes/${compteId}`);
  assert.equal(sup.status, 200, JSON.stringify(sup.json));
  assert.equal(s.evenements.donneesDe(compteId).evenements.length, 0);
  assert.ok((await lecteur.get('/api/evenements?limite=10')).json.some(e => e.by === 'compte supprimé'));
});

test('paramètres : un paramètre inconnu est refusé, même quand la route rend avant de le lire', async () => {
  // Une route d'essai qui rend sans lire ses paramètres, retirée ensuite.
  const routes = s.api.routeur.routes;
  s.api.routeur.get('/api/essai-parametres', () => ({ ok: true }), { role: 'lecture', requete: { a: { type: 'chaine', max: 4 } } });
  try {
    assert.equal((await lecteur.get('/api/essai-parametres?a=x')).status, 200);
    assert.equal((await lecteur.get('/api/essai-parametres?a=x&script=id')).status, 400);
  } finally { routes.pop(); }
});

test('console série muette : la connexion activée dans la VM par l\'agent QEMU, commande fixe, administrateur et renfort', async () => {
  const vm = pve.etat.machines.find(m => m.vmid === 101);
  const url = machine('pve-a', 'qemu', 101) + '/console-serie';
  vm.conf.agent = '1'; vm.clavierInvite = 'fr'; vm.sansGetty = true;
  assert.equal((await membre.post(url)).status, 403, 'un membre ne lance rien dans la VM');
  assert.equal((await sansRenfort(() => admin.post(url))).status, 403, 'renfort exigé');
  assert.equal((await admin.post(url, { commande: 'rm -rf /' })).status, 400, 'aucun paramètre accepté');
  const r = await admin.post(url);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(vm.sansGetty, false);
  const appel = pve.appels.filter(a => /101\/agent\/exec$/.test(a.chemin)).at(-1);
  assert.deepEqual([appel.params.command, appel.params['input-data']], ['sh', 'systemctl enable --now serial-getty@ttyS0.service\n']);
  const j = (await admin.get('/api/compte/admin/journal')).json;
  assert.ok(j.lignes.some(l => l.action === 'machine.console_serie' && l.resultat === 'ok'));
  vm.conf.agent = '0';
  const sans = await admin.post(url);
  assert.deepEqual([sans.json.ok, sans.json.raison], [false, 'agent']);
  assert.equal((await admin.post(machine('pve-a', 'lxc', 110) + '/console-serie')).status, 400);
  vm.conf.agent = '1';
});

// Une image ISO 9660 minimale : « CD001 » au secteur 16, le reste au hasard.
function isoFactice(n) { const b = crypto.randomBytes(n); b.write('\x01CD001', 32768, 'latin1'); return b; }

// La clé d'accès de l'administrateur, comme le navigateur la présente.
async function renforcerParCle(c = admin) {
  const o = await c.post('/api/compte/renfort/options');
  const r = await c.post('/api/compte/renfort', { methode: 'cle', reponse: cleAdmin.signer(o.json, c.origine) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

test('suppression d\'une machine : administrateur, nom recopié, machine arrêtée, et une confirmation par clé pour elle seule', async () => {
  const vm = machine('pve-b', 'qemu', 130);
  for (const m of pve.etat.machines.filter(x => [120, 130].includes(x.vmid))) m.status = 'stopped';   // démarrées par les essais d'avant
  assert.equal((await membre.post(vm + '/suppression', { nom: 'bureau-essai' })).status, 403);
  await renforcerParCle();
  const faux = await admin.post(vm + '/suppression', { nom: 'bureau-essa' });
  assert.equal(faux.status, 400);
  assert.match(faux.json.error, /Recopie exactement « bureau-essai »/);
  const enMarche = await admin.post(machine() + '/suppression', { nom: pve.etat.machines.find(m => m.vmid === 101).name });
  assert.equal(enMarche.status, 409, 'une machine en marche ne se supprime pas');
  const n0 = pve.appels.length;
  const ok = await admin.post(vm + '/suppression', { nom: 'bureau-essai' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const appel = pve.appels.slice(n0).find(a => a.methode === 'DELETE');
  assert.deepEqual([appel.chemin, appel.params.purge, appel.params['destroy-unreferenced-disks']], ['/nodes/pve-b/qemu/130', '1', '1']);
  assert.ok(!pve.etat.machines.some(m => m.vmid === 130));
  // La même confirmation ne sert pas deux fois : la suivante redemande la clé.
  const encore = await admin.post(machine('pve-b', 'lxc', 120) + '/suppression', { nom: 'supervision' });
  assert.equal(encore.status, 403);
  assert.ok(encore.json.details?.renfort);
  assert.deepEqual(encore.json.details.methodes, ['cle'], 'la clé d\'accès, facteur le plus fort de l\'administrateur');
  assert.ok(pve.etat.machines.some(m => m.vmid === 120));
  // Une confirmation de plus de deux minutes ne vaut plus pour une suppression.
  await renforcerParCle();
  s.db.prepare("UPDATE socle_sessions SET renfort = renfort - 180000 WHERE compte = (SELECT id FROM socle_comptes WHERE identifiant = 'ana')").run();
  assert.equal((await admin.post(machine('pve-b', 'lxc', 120) + '/suppression', { nom: 'supervision' })).status, 403);
  await renforcerParCle();
  assert.equal((await admin.post(machine('pve-b', 'lxc', 120) + '/suppression', { nom: 'supervision' })).status, 200);
  const ev = (await admin.get('/api/evenements')).json;
  assert.ok(ev.some(e => e.kind === 'vm.delete_requested' && /130 « bureau-essai »/.test(e.title) && e.by === 'ana'));
  assert.ok(s.db.prepare("SELECT 1 FROM socle_journal WHERE action = 'machine.suppression'").get(), 'au journal de sécurité');
});

test('images ISO : inventaire avec les lecteurs qui les tiennent, téléchargement, envoi, lecteur CD, suppression', async () => {
  const inv = (await lecteur.get('/api/isos')).json;
  assert.equal(inv.relie, true);
  assert.deepEqual(inv.stockages.map(x => `${x.node}/${x.storage}`).sort(), ['pve-a/local', 'pve-b/local']);
  const debian = inv.isos.find(i => i.nom.startsWith('debian'));
  assert.deepEqual(debian.utilisePar.map(u => [u.vmid, u.lecteur]), [[101, 'ide2']]);
  assert.equal((await membre.post('/api/isos/pve-a/local/telechargement', { url: 'https://exemple.test/a.iso', nom: 'a.iso' })).status, 403);

  // Importer depuis une adresse : https public seulement, résolu puis épinglé ;
  // ProxLab lit l'image, en contrôle la signature et la somme, et la remet à Proxmox.
  const { configurer } = await import('../src/sortie.js');
  const { Readable } = await import('node:stream');
  const fedora = isoFactice(400000), html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(40000, ' '));
  const noms = { 'miroir.exemple': '203.0.114.10', 'interne.exemple': '10.0.0.5', 'meta.exemple': '169.254.169.254', 'v6.exemple': '::ffff:127.0.0.1' };
  const pages = {
    'https://miroir.exemple/images/fedora-43.iso': { statut: 200, entetes: { 'content-length': String(fedora.length) }, corps: fedora },
    'https://miroir.exemple/page.iso': { statut: 200, entetes: { 'content-length': String(html.length) }, corps: html },
    'https://miroir.exemple/sans-taille.iso': { statut: 200, entetes: {}, corps: fedora },
    'https://miroir.exemple/vers-interne.iso': { statut: 302, entetes: { location: 'https://interne.exemple/a.iso' }, corps: Buffer.alloc(0) },
    'https://miroir.exemple/vers-http.iso': { statut: 301, entetes: { location: 'http://miroir.exemple/images/fedora-43.iso' }, corps: Buffer.alloc(0) },
  };
  const connexions = [];
  configurer({
    resolveur: (nom, cb) => (noms[nom] ? cb(null, [{ address: noms[nom], family: noms[nom].includes(':') ? 6 : 4 }]) : cb(Object.assign(new Error('introuvable'), { code: 'ENOTFOUND' }))),
    transport: async (url, adresse) => { connexions.push([url.href, adresse.address]); const p = pages[url.href]; if (!p) return { statut: 404, entetes: {}, flux: Readable.from([]) }; return { statut: p.statut, entetes: p.entetes, flux: Readable.from([p.corps]) }; },
  });
  try {
    const importer = (url, nom = 'a.iso', extra = {}) => admin.post('/api/isos/pve-a/local/telechargement', { url, nom, ...extra });
    for (const url of ['file:///etc/passwd', 'http://miroir.exemple/a.iso', 'https://moi:secret@miroir.exemple/a.iso', 'pas une adresse']) assert.equal((await importer(url)).status, 400, url);
    assert.equal((await importer('https://miroir.exemple/a.iso', '../a.iso')).status, 400);
    assert.equal((await importer('https://miroir.exemple/a.iso', 'a.exe')).status, 400);
    assert.equal((await importer('https://miroir.exemple/a.iso', 'a.iso', { somme: 'ab' })).status, 400);
    assert.equal((await importer('https://miroir.exemple/a.iso', 'a.iso', { somme: 'ab'.repeat(20) })).status, 400, 'longueur de la somme selon l’algorithme');
    assert.equal((await membre.post('/api/isos/pve-a/local/telechargement', { url: 'https://miroir.exemple/a.iso', nom: 'a.iso' })).status, 403);
    const apercu = await admin.get(`/api/isos/apercu?url=${encodeURIComponent('https://miroir.exemple/images/fedora-43.iso')}`);
    assert.deepEqual([apercu.json.nom, apercu.json.taille], ['fedora-43.iso', fedora.length]);
    const fin = async id => { for (let i = 0; i < 200; i++) { const l = (await admin.get('/api/isos/importations')).json; const t = l.find(x => x.id === id); if (t.etat !== 'en cours') return t; await new Promise(r => setTimeout(r, 25)); } throw new Error('importation sans fin'); };
    // Adresses internes, métadonnées, IPv4 glissée dans une IPv6, redirection vers l'interne : refusées, rien n'est demandé au serveur interne.
    for (const [url, motif] of [['https://interne.exemple/a.iso', /privée ou réservée/], ['https://meta.exemple/a.iso', /privée ou réservée/], ['https://169.254.169.254/latest/a.iso', /privée ou réservée/], ['https://v6.exemple/a.iso', /privée ou réservée/], ['https://miroir.exemple/vers-interne.iso', /interne\.exemple mène à une adresse privée/], ['https://miroir.exemple/vers-http.iso', /https seulement/]]) {
      const r = await importer(url);
      assert.equal(r.status, 200, url);
      const t = await fin(r.json.importation);
      assert.deepEqual([t.etat, motif.test(t.erreur)], ['échec', true], `${url} : ${t.erreur}`);
    }
    assert.ok(!connexions.some(([, ip]) => ip.startsWith('10.') || ip.startsWith('169.254') || ip.includes('127.')), 'aucune connexion vers une adresse interne');
    // Pas une image de disque, ou sans taille annoncée : refusée avant d'envoyer un octet à Proxmox.
    const n0 = pve.etat.isos.length;
    assert.match((await fin((await importer('https://miroir.exemple/page.iso', 'page.iso')).json.importation)).erreur, /pas une image de disque/);
    assert.match((await fin((await importer('https://miroir.exemple/sans-taille.iso', 'x.iso')).json.importation)).erreur, /Taille de l’image inconnue/);
    assert.equal(pve.etat.isos.length, n0);
    // Somme différente : l'image est retirée du stockage.
    const fausse = await fin((await importer('https://miroir.exemple/images/fedora-43.iso', 'fedora-43.iso', { somme: '0'.repeat(64) })).json.importation);
    assert.deepEqual([fausse.etat, /Somme de contrôle différente/.test(fausse.erreur)], ['échec', true]);
    assert.ok(!pve.etat.isos.some(i => i.volid === 'local:iso/fedora-43.iso'), 'retirée après coup');
    // La bonne : remise entière, somme vérifiée.
    const bonne = await fin((await importer('https://miroir.exemple/images/fedora-43.iso', 'fedora-43.iso', { somme: crypto.createHash('sha256').update(fedora).digest('hex') })).json.importation);
    assert.deepEqual([bonne.etat, bonne.octets, bonne.taille], ['terminée', fedora.length, fedora.length], bonne.erreur);
    assert.ok(pve.etat.isos.find(i => i.volid === 'local:iso/fedora-43.iso').octets.equals(fedora));
    assert.equal((await lecteur.get('/api/isos/importations')).status, 403);
    // Les classes d'adresses, et le nom d'une image revérifié au relais même.
    const { publique } = await import('../src/sortie.js');
    assert.deepEqual(['203.0.114.10', '::ffff:203.0.114.10', '2a00:1450::1', '::ffff:7f00:1', '::1', '2001:db8::1', 'fd00::1', '100.64.0.1', '0.0.0.0', 'pas-une-ip'].map(publique), [true, true, true, false, false, false, false, false, false, false]);
    await assert.rejects(s.api.images.relayer({ noeud: 'pve-a', stockage: 'local', nom: '../evil.iso', flux: Readable.from([fedora]), taille: fedora.length }), /Nom d’image/);
  } finally { configurer({ resolveur: null, transport: null }); }

  // Envoi depuis le navigateur : relayé tel quel en multipart, octet pour octet.
  const fichier = isoFactice(300000);
  const pasIso = await admin.req('PUT', '/api/isos/pve-b/local/envoi?nom=faux.iso', undefined, { brut: crypto.randomBytes(50000), entetes: { 'content-type': 'application/octet-stream' } });
  assert.equal(pasIso.status, 415, 'un fichier qui n’est pas une image de disque est refusé');
  const envoi = n => admin.req('PUT', `/api/isos/pve-b/local/envoi?nom=${encodeURIComponent(n)}`, undefined, { brut: fichier, entetes: { 'content-type': 'application/octet-stream' } });
  assert.equal((await envoi('x/../a.iso')).status, 400);
  const e = await envoi('outils-v2.iso');
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const recue = pve.etat.isos.find(i => i.volid === 'local:iso/outils-v2.iso');
  assert.ok(recue.octets.equals(fichier), 'le fichier arrive entier');
  assert.equal((await envoi('outils-v2.iso')).status, 409, 'une image du même nom n’est jamais écrasée');
  s.api.images.relais = 3;
  assert.equal((await envoi('autre.iso')).status, 429, 'trois images en route au plus');
  s.api.images.relais = 0;
  // Un flux plus long ou plus court que la taille annoncée n'arrive jamais entier chez Proxmox.
  const n0 = pve.etat.isos.length;
  const flux = octets => Readable.from([octets]);
  await assert.rejects(s.proxmox.envoyerFichier('/nodes/pve-b/storage/local/upload', { champs: { content: 'iso' }, champFichier: 'filename', nom: 'trop.iso', flux: flux(Buffer.alloc(20)), taille: 10 }), /plus long/);
  await assert.rejects(s.proxmox.envoyerFichier('/nodes/pve-b/storage/local/upload', { champs: { content: 'iso' }, champFichier: 'filename', nom: 'court.iso', flux: flux(Buffer.alloc(5)), taille: 10 }), /interrompu/);
  assert.equal(pve.etat.isos.length, n0);
  assert.equal(recue.node, 'pve-b');

  // Lecteur CD : insérer, éjecter ; un conteneur n'en a pas.
  assert.equal((await admin.post(machine() + '/lecteur', { volid: 'local:iso/../../etc/passwd' })).status, 400);
  assert.equal((await admin.post(machine('pve-a', 'lxc', 110) + '/lecteur', { volid: 'local:iso/alpine-virt-3.22.iso' })).status, 400);
  const ins = await admin.post(machine() + '/lecteur', { volid: 'local:iso/alpine-virt-3.22.iso' });
  assert.deepEqual([ins.status, ins.json.lecteur, pve.appels.at(-1).params.ide2], [200, 'ide2', 'local:iso/alpine-virt-3.22.iso,media=cdrom']);

  // Supprimer : refusé tant qu'une VM la tient ; possible une fois éjectée.
  const tenue = await admin.del(`/api/isos/pve-a/local?volid=${encodeURIComponent('local:iso/alpine-virt-3.22.iso')}`);
  assert.equal(tenue.status, 409);
  assert.match(tenue.json.error, new RegExp(`101 \\(${pve.etat.machines.find(m => m.vmid === 101).name}\\)`));
  assert.equal((await admin.post(machine() + '/lecteur', { volid: '' })).status, 200);
  assert.equal(pve.appels.at(-1).params.ide2, 'none,media=cdrom');
  assert.equal((await membre.del(`/api/isos/pve-a/local?volid=${encodeURIComponent('local:iso/alpine-virt-3.22.iso')}`)).status, 403);
  assert.equal((await admin.del(`/api/isos/pve-a/sauvegardes?volid=${encodeURIComponent('local:iso/alpine-virt-3.22.iso')}`)).status, 400, 'hors du stockage nommé');
  assert.equal((await admin.del(`/api/isos/pve-a/local?volid=${encodeURIComponent('local:iso/alpine-virt-3.22.iso')}`)).status, 200);
  assert.ok(!pve.etat.isos.some(i => i.volid === 'local:iso/alpine-virt-3.22.iso'));
  assert.ok(s.db.prepare("SELECT 1 FROM socle_journal WHERE action = 'iso.suppression'").get());
});

test('créer une VM : choix revérifiés contre le nœud, configuration par système, démarrée à la demande', async () => {
  const o = await admin.get('/api/machines/options?noeud=pve-a');
  assert.equal(o.status, 200, JSON.stringify(o.json));
  assert.deepEqual([o.json.stockages.map(x => x.storage), o.json.ponts], [['local-lvm'], ['vmbr0']]);
  assert.ok(o.json.isos.some(i => i.volid === 'local:iso/debian-13.1.0-amd64-netinst.iso'));
  assert.equal((await membre.get('/api/machines/options?noeud=pve-a')).status, 403);
  const base = { noeud: 'pve-a', nom: 'labo-debian', systeme: 'linux', coeurs: 2, memoire: 2048, disque: 20, stockage: 'local-lvm', iso: 'local:iso/debian-13.1.0-amd64-netinst.iso', pont: 'vmbr0', demarrer: true };
  assert.equal((await membre.post('/api/machines', base)).status, 403);
  for (const [extra, motif] of [[{ coeurs: 64 }, /n’a que 16 cœurs/], [{ memoire: 1048576 }, /Mio de mémoire/], [{ stockage: 'local' }, /ne prend pas de disque/], [{ disque: 100 }, /Pas assez de place/],
    [{ pont: 'vmbr9' }, /Pas de pont vmbr9/], [{ iso: 'local:iso/ubuntu-24.04.3-live-server-amd64.iso' }, /pas visible de ce nœud/], [{ nom: 'nom avec espaces' }, /./], [{ iso: 'local:iso/../x.iso' }, /./]]) {
    const r = await admin.post('/api/machines', { ...base, ...extra });
    assert.ok([400, 409].includes(r.status), `${JSON.stringify(extra)} : ${r.status}`);
    assert.match(r.json.error, motif);
  }
  const n0 = pve.etat.machines.length;
  const r = await admin.post('/api/machines', base);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const vm = pve.etat.machines.find(m => m.vmid === r.json.vmid);
  assert.equal(pve.etat.machines.length, n0 + 1);
  assert.deepEqual([vm.name, vm.status, r.json.demarree], ['labo-debian', 'running', true]);
  const c = vm.creation;
  assert.deepEqual([c.ostype, c.scsi0, c.ide2, c.net0, c.serial0, c.vga, c.boot, c.cores, c.memory], ['l26', 'local-lvm:20,iothread=1,discard=on', 'local:iso/debian-13.1.0-amd64-netinst.iso,media=cdrom', 'virtio,bridge=vmbr0', 'socket', 'virtio', 'order=scsi0;ide2;net0', '2', '2048']);
  // Windows : UEFI, TPM, disque SATA et carte e1000 ; sans image, lecteur vide ; pas démarrée.
  const w = await admin.post('/api/machines', { ...base, nom: 'labo-windows', systeme: 'windows', memoire: 4096, iso: '', demarrer: false });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const cw = pve.etat.machines.find(m => m.vmid === w.json.vmid);
  assert.deepEqual([cw.status, cw.creation.bios, cw.creation.machine, cw.creation.ostype, cw.creation.sata0, cw.creation.net0, cw.creation.ide2, cw.creation.tpmstate0, cw.creation.efidisk0],
    ['stopped', 'ovmf', 'q35', 'win11', 'local-lvm:20', 'e1000,bridge=vmbr0', 'none,media=cdrom', 'local-lvm:1,version=v2.0', 'local-lvm:1,efitype=4m,pre-enrolled-keys=1']);
  assert.ok(s.db.prepare("SELECT 1 FROM socle_journal WHERE action = 'machine.creation'").get());
  const echec = await admin.post('/api/machines', { ...base, nom: 'tache-en-echec' });
  assert.equal(echec.status, 502);
  assert.match(echec.json.error, /Proxmox n’a pas créé la VM : .*insufficient free space/);
  assert.doesNotMatch(echec.json.error, /\/dev\/pve/, 'sans chemin de l’hyperviseur');
  // Créée sans renfort récent : refusée.
  await sansRenfort(async () => assert.equal((await admin.post('/api/machines', { ...base, nom: 'sans-renfort' })).status, 403));

});

test('nom affiché d\'une image : gardé par ProxLab, par nœud pour un stockage local ; vide, le nom du fichier revient', async () => {
  const v = 'local:iso/debian-13.1.0-amd64-netinst.iso';
  assert.equal((await membre.put('/api/isos/nom', { noeud: 'pve-a', volid: v, nom: 'Debian 13' })).status, 403);
  assert.equal((await admin.put('/api/isos/nom', { noeud: 'pve-a', volid: v, nom: '<script>' })).status, 400);
  assert.equal((await admin.put('/api/isos/nom', { noeud: 'pve-b', volid: v, nom: 'Debian 13' })).status, 404, 'cette image n’est pas sur pve-b');
  assert.equal((await admin.put('/api/isos/nom', { noeud: 'pve-a', volid: v, nom: '  Debian 13   (installeur réseau) ' })).status, 200);
  const inv = (await lecteur.get('/api/isos')).json.isos.find(i => i.volid === v);
  assert.deepEqual([inv.alias, inv.nom], ['Debian 13 (installeur réseau)', 'debian-13.1.0-amd64-netinst.iso']);
  assert.equal((await admin.get('/api/machines/options?noeud=pve-a')).json.isos.find(i => i.volid === v).alias, 'Debian 13 (installeur réseau)');
  assert.equal((await admin.put('/api/isos/nom', { noeud: 'pve-a', volid: v, nom: '' })).status, 200);
  assert.equal((await lecteur.get('/api/isos')).json.isos.find(i => i.volid === v).alias, '');
});

test('étiquettes : posées par ProxLab sur une image, une interface, un stockage ou un nœud, sans rien renommer dans Proxmox', async () => {
  pve.etat.reseau['pve-a'].push({ iface: 'vmbr1', type: 'bridge', bridge_ports: 'eno2', comments: 'ghost\n', active: 1 });
  try {
    const n0 = pve.appels.length;
    const poser = (c, genre, objet, etiquette, noeud = 'pve-a') => c.put('/api/etiquettes', { genre, noeud, objet, etiquette });
    // Rôle, renfort, format : refusés avant Proxmox.
    assert.equal((await membre.put('/api/etiquettes', { genre: 'reseau', noeud: 'pve-a', objet: 'vmbr1', etiquette: 'Ghost' })).status, 403);
    await sansRenfort(async () => assert.equal((await poser(admin, 'reseau', 'vmbr1', 'Ghost')).status, 403));
    for (const [genre, objet, etiquette] of [['reseau', '../vmbr1', 'x'], ['stockage', 'local/../x', 'x'], ['noeud', 'pve a', 'x'], ['iso', 'local:iso/../x.iso', 'x'], ['disque', 'vmbr1', 'x'], ['reseau', 'vmbr1', '<b>Ghost</b>'], ['reseau', 'vmbr1', 'x'.repeat(81)]]) {
      assert.equal((await poser(admin, genre, objet, etiquette)).status, 400, `${genre} ${objet} ${etiquette.slice(0, 12)}`);
    }
    assert.equal(pve.appels.length, n0, 'rien n’a atteint Proxmox');
    // Un objet qui n'existe pas sur ce nœud : refusé.
    assert.equal((await poser(admin, 'reseau', 'vmbr1', 'Ghost', 'pve-b')).status, 404);
    assert.equal((await poser(admin, 'stockage', 'local-lvm', 'Disques', 'pve-b')).status, 404);
    assert.equal((await poser(admin, 'noeud', 'pve-b', 'Rack', 'pve-a')).status, 404);
    // Posées : rendues partout où l'objet apparaît.
    const ecrits = pve.appels.filter(a => a.methode !== 'GET').length;
    assert.equal((await poser(admin, 'reseau', 'vmbr1', '  Ghost   (Tor) ')).json.etiquette, 'Ghost (Tor)');
    assert.equal((await poser(admin, 'stockage', 'local-lvm', 'Disques rapides')).status, 200);
    assert.equal((await poser(admin, 'stockage', 'sauvegardes', 'NAS', 'pve-b')).status, 200);
    assert.equal((await poser(admin, 'noeud', 'pve-a', 'R730')).status, 200);
    assert.equal((await poser(admin, 'iso', 'local:iso/debian-13.1.0-amd64-netinst.iso', 'Debian')).status, 200);
    assert.equal(pve.appels.filter(a => a.methode !== 'GET').length, ecrits, 'Proxmox n’a rien reçu à écrire');
    const r = (await lecteur.get('/api/noeuds/pve-a/reseau')).json;
    assert.deepEqual(r.find(i => i.iface === 'vmbr1'), { iface: 'vmbr1', type: 'bridge', cidr: '', gateway: '', ports: 'eno2', active: true, alias: 'Ghost (Tor)', commentaire: 'ghost' });
    assert.equal(r.find(i => i.iface === 'vmbr0').alias, '');
    assert.equal((await lecteur.get('/api/noeuds/pve-b/reseau')).json.find(i => i.iface === 'vmbr1'), undefined);
    const e = (await lecteur.get('/api/etat')).json;
    assert.deepEqual(e.noeuds.map(n => [n.node, n.alias]), [['pve-a', 'R730'], ['pve-b', '']]);
    assert.deepEqual(e.stockages.map(x => [x.node, x.storage, x.alias]), [['pve-a', 'local', ''], ['pve-a', 'local-lvm', 'Disques rapides'], ['pve-b', 'local', ''], ['pve-b', 'sauvegardes', 'NAS']]);
    const o = (await admin.get('/api/machines/options?noeud=pve-a')).json;
    assert.deepEqual(o.ponts, ['vmbr0', 'vmbr1'], 'la liste d’avant reste la même');
    assert.deepEqual(o.pontsDetail, [{ iface: 'vmbr0', alias: '', commentaire: '' }, { iface: 'vmbr1', alias: 'Ghost (Tor)', commentaire: 'ghost' }]);
    assert.equal(o.stockages.find(x => x.storage === 'local-lvm').alias, 'Disques rapides');
    assert.equal((await lecteur.get('/api/isos')).json.isos.find(i => i.volid === 'local:iso/debian-13.1.0-amd64-netinst.iso').alias, 'Debian');
    // Une VM créée sur un pont étiqueté garde le vrai nom du pont.
    const vm = await admin.post('/api/machines', { noeud: 'pve-a', nom: 'labo-ghost', stockage: 'local-lvm', pont: 'vmbr1', demarrer: false, disque: 8 });
    assert.equal(vm.status, 200, JSON.stringify(vm.json));
    assert.equal(pve.etat.machines.find(m => m.vmid === vm.json.vmid).creation.net0, 'virtio,bridge=vmbr1');
    assert.ok(s.db.prepare("SELECT 1 FROM socle_journal WHERE action = 'etiquette.reseau' AND objet = 'pve-a/vmbr1'").get());
    // Vide : l'étiquette disparaît ; le nom de Proxmox revient.
    for (const [genre, objet, noeud] of [['reseau', 'vmbr1', 'pve-a'], ['stockage', 'local-lvm', 'pve-a'], ['stockage', 'sauvegardes', 'pve-b'], ['noeud', 'pve-a', 'pve-a'], ['iso', 'local:iso/debian-13.1.0-amd64-netinst.iso', 'pve-a']]) {
      assert.equal((await poser(admin, genre, objet, '', noeud)).json.etiquette, '');
    }
    assert.equal((await lecteur.get('/api/noeuds/pve-a/reseau')).json.find(i => i.iface === 'vmbr1').alias, '');
    assert.ok((await lecteur.get('/api/etat')).json.noeuds.every(n => n.alias === '' ) && (await lecteur.get('/api/etat')).json.stockages.every(x => x.alias === ''));
  } finally { pve.etat.reseau['pve-a'] = []; }
});

test('dupliquer une machine : copie complète par Proxmox, de son état actuel ou d\'un instantané, administrateur sous renfort', async () => {
  const url = machine() + '/duplication';
  assert.equal((await membre.post(url, { nom: 'copie' })).status, 403);
  await sansRenfort(async () => assert.equal((await admin.post(url, { nom: 'copie' })).status, 403));
  const n0 = pve.appels.length;
  for (const corpsFaux of [{ nom: 'avec espace' }, { nom: '' }, { nom: 'copie', instantane: '../x' }, { nom: 'copie', stockage: 'local/../x' }, { nom: 'copie', complet: 0 }]) {
    assert.equal((await admin.post(url, corpsFaux)).status, 400, JSON.stringify(corpsFaux));
  }
  assert.equal(pve.appels.length, n0, 'rien n’a atteint Proxmox');
  // Instantané inconnu : refusé avant toute copie.
  assert.equal((await admin.post(url, { nom: 'copie', instantane: 'nexiste-pas' })).status, 404);
  assert.ok(!pve.appels.some(a => /\/clone$/.test(a.chemin)));
  const avant = pve.etat.machines.length;
  const r = await admin.post(url, { nom: 'passerelle-copie' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.noeud, r.json.type, r.json.fini], ['pve-a', 'qemu', true]);
  const c = pve.etat.machines.find(x => x.vmid === r.json.vmid);
  assert.deepEqual([c.name, c.status, c.clone.full, c.clone.snapname, c.clone.source], ['passerelle-copie', 'stopped', '1', undefined, 101]);
  assert.equal(pve.etat.machines.length, avant + 1);
  const i = await admin.post(url, { nom: 'depuis-instantane', instantane: 'avant-maj', stockage: 'local-lvm' });
  assert.equal(i.status, 200, JSON.stringify(i.json));
  const ci = pve.etat.machines.find(x => x.vmid === i.json.vmid);
  assert.deepEqual([ci.clone.snapname, ci.clone.storage, ci.clone.full], ['avant-maj', 'local-lvm', '1']);
  // Un conteneur : son nom va dans hostname.
  const ct = pve.etat.machines.find(x => x.type === 'lxc');
  const rc = await admin.post(`/api/machines/${ct.node}/lxc/${ct.vmid}/duplication`, { nom: 'ct-copie' });
  assert.equal(rc.status, 200, JSON.stringify(rc.json));
  assert.equal(pve.etat.machines.find(x => x.vmid === rc.json.vmid).clone.hostname, 'ct-copie');
  // Une copie qui échoue dans sa tâche : dite, sans chemin de l'hyperviseur.
  const e = await admin.post(url, { nom: 'tache-en-echec' });
  assert.equal(e.status, 502);
  assert.match(e.json.error, /n’a pas dupliqué la machine : .*insufficient free space/);
  assert.doesNotMatch(e.json.error, /\/dev\/pve/);
  assert.ok(s.db.prepare("SELECT 1 FROM socle_journal WHERE action = 'machine.duplication' AND objet = 'qemu/101'").get());
  for (const v of [r.json.vmid, i.json.vmid, rc.json.vmid]) pve.etat.machines.splice(pve.etat.machines.findIndex(x => x.vmid === v), 1);
});

test('battement : un écran ou une console immobile garde sa connexion, de bout en bout', async () => {
  const faux = () => Object.assign(new EventEmitter(), { textes: [], pings: 0, envoyerTexte(t) { this.textes.push(t); }, envoyerBinaire() {}, ping() { this.pings++; }, close() { this.ferme = true; } });
  const nav = faux(), amont = faux();
  relayerEcran(nav, async () => ({ amont, deja: Buffer.alloc(0) }), { battementMs: 30 });
  await new Promise(r => setTimeout(r, 110));
  assert.ok(nav.textes.filter(t => t === '{"b":1}').length >= 2, 'le navigateur reçoit le battement');
  assert.ok(nav.pings >= 2 && amont.pings >= 2, 'ping des deux côtés');
  nav.emit('fermeture');
  const n = nav.textes.length;
  await new Promise(r => setTimeout(r, 80));
  assert.equal(nav.textes.length, n, 'plus rien une fois fermé');
  const navC = faux(), amontC = faux();
  relayer(navC, async () => amontC, { battementMs: 30 });
  await new Promise(r => setTimeout(r, 110));
  assert.ok(navC.pings >= 2 && amontC.textes.filter(t => t === '2').length >= 2, 'console : ping au navigateur, « 2 » à termproxy');
  assert.ok(!navC.textes.some(t => t.includes('"b"')), 'rien d\'autre dans le terminal');
  navC.emit('fermeture');
});

test('frappe par ProxLab : le texte tapé dans la VM par sa propre connexion VNC, touches de la disposition de la VM, la page peut partir', async () => {
  const url = '/api/machines/pve-a/qemu/101/frappe';
  const attendreFin = async (c = membre) => { for (let i = 0; i < 400; i++) { const e = (await c.get(url)).json; if (e.etat !== 'en cours') return e; await new Promise(r => setTimeout(r, 25)); } throw new Error('frappe sans fin'); };
  const avant = pve.ecrans.length;
  const texte = 'Aé@ ê\nz';
  const r = await membre.post(url, { texte, disposition: 'fr' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.etat, 'en cours');
  assert.equal(r.json.total, [...texte].length);
  assert.ok(!JSON.stringify(r.json).includes('ê'), 'l’état ne rend jamais le texte');
  const fin = await attendreFin();
  assert.equal(fin.etat, 'terminée', JSON.stringify(fin));
  assert.equal(fin.tapes, [...texte].length);
  const e = pve.ecrans.slice(avant).find(x => x.messages.some(m => m[0] === 255));
  assert.ok(e && e.authentifie && e.cible === 'qemu/101', 'connexion VNC à elle, authentifiée par le ticket de vncproxy');
  assert.deepEqual(e.messages[0].slice(0, 4), [2, 0, 0, 1], 'touche étendue de QEMU demandée');
  const touches = e.messages.filter(m => m[0] === 255).map(m => { const b = Buffer.from(m); return `${b.readUInt16BE(2) ? '+' : '-'}${b.readUInt32BE(8).toString(16)}`; });
  // A = Maj + Q ; é = 2 ; @ = Alt Gr + 0 ; espace ; ê = ^ puis e ; Entrée ; z = W.
  assert.deepEqual(touches.join(' '), '+2a +10 -10 -2a +3 -3 +b8 +b -b -b8 +39 -39 +1a -1a +12 -12 +1c -1c +11 -11');
  assert.equal(Buffer.from(e.messages.filter(m => m[0] === 255)[1]).readUInt32BE(4), 'A'.charCodeAt(0), 'keysym en majuscule : QEMU ne bascule pas Verr. Maj');
  assert.ok(e.ferme, 'la connexion est fermée à la fin');
  const j = s.db.prepare("SELECT action, details FROM socle_journal WHERE action LIKE 'machine.frappe%'").all();
  assert.deepEqual(j.map(x => x.action).sort(), ['machine.frappe', 'machine.frappe.fin']);
  assert.ok(!j.some(x => /@|Aé|ê/.test(String(x.details))), 'jamais le texte au journal');
  assert.equal(JSON.parse(j.find(x => x.action === 'machine.frappe').details).caracteres, [...texte].length);

  // Une frappe longue : une seule à la fois par VM, arrêtée à la demande.
  const long = 'abcdefghij'.repeat(300);
  assert.equal((await membre.post(url, { texte: long, disposition: 'us' })).status, 200);
  assert.equal((await membre.post(url, { texte: 'x', disposition: 'us' })).status, 409);
  await new Promise(r => setTimeout(r, 120));
  const arret = await membre.del(url);
  assert.equal(arret.status, 200);
  const coupe = await attendreFin();
  assert.equal(coupe.etat, 'arrêtée');
  assert.ok(coupe.tapes > 0 && coupe.tapes < long.length, `${coupe.tapes}`);
  assert.ok(coupe.msParCaractere < 30, 'texte long : plus vite qu’un texte court');
  const derniere = pve.ecrans.at(-1).messages.filter(m => m[0] === 255);
  const enfoncees = new Set();
  for (const m of derniere) { const b = Buffer.from(m); if (b.readUInt16BE(2)) enfoncees.add(b.readUInt32BE(8)); else enfoncees.delete(b.readUInt32BE(8)); }
  assert.equal(enfoncees.size, 0, 'rien ne reste enfoncé dans la VM');

  // Droits et refus.
  assert.equal((await lecteur.post(url, { texte: 'x', disposition: 'fr' })).status, 403);
  assert.equal((await lecteur.get(url)).status, 403);
  assert.equal((await membre.post('/api/machines/pve-a/lxc/110/frappe', { texte: 'x', disposition: 'fr' })).status, 400);
  const vm102 = pve.etat.machines.find(m => m.vmid === 102);
  vm102.status = 'stopped';
  try { assert.equal((await membre.post('/api/machines/pve-a/qemu/102/frappe', { texte: 'x', disposition: 'fr' })).status, 409, 'VM arrêtée'); } finally { vm102.status = 'running'; }
  assert.equal((await membre.post(url, { texte: 'x', disposition: 'de' })).status, 400);
  assert.equal((await membre.post(url, { texte: '', disposition: 'fr' })).status, 400);
  assert.equal((await membre.post(url, { texte: 'x'.repeat(100001), disposition: 'fr' })).status, 400);
  assert.equal((await membre.get('/api/machines/pve-a/qemu/102/frappe')).json.etat, 'aucune');
});

test('écran : flux zlib de Tight décompressé ici, morceau par morceau, comme le vide QEMU', async () => {
  const vider = (d, buf) => new Promise(ok => { const p = [], prendre = c => p.push(c); d.on('data', prendre); d.write(buf); d.flush(zlib.constants.Z_SYNC_FLUSH, () => setImmediate(() => { d.off('data', prendre); ok(Buffer.concat(p)); })); });
  // Textes répétitifs (renvois loin en arrière, d'un morceau à l'autre), octets
  // au hasard (blocs bruts), petits morceaux (blocs fixes), niveaux 0 à 9.
  for (const niveau of [0, 1, 6, 9]) {
    const d = zlib.createDeflate({ level: niveau }), f = new Inflate();
    const morceaux = [Buffer.from('écran '.repeat(5000)), crypto.randomBytes(70000), Buffer.from('ab'), Buffer.alloc(200000, 7), Buffer.concat([crypto.randomBytes(100), Buffer.from('écran '.repeat(5000))]), Buffer.from('z')];
    for (const m of morceaux) assert.deepEqual(Buffer.from(f.lire(await vider(d, m), m.length)), m, `niveau ${niveau}, ${m.length} octets`);
  }
  // Annoncé plus court ou plus long que ce qui sort : refusé, rien n'est rendu.
  const d = zlib.createDeflate(), z = await vider(d, Buffer.alloc(1000, 1));
  assert.throws(() => new Inflate().lire(z, 999), /plus de données/);
  assert.throws(() => new Inflate().lire(z, 1001), /moins de données/);
  assert.throws(() => new Inflate().lire(z.subarray(0, z.length - 3), 1000), /tronquées|moins/);
  assert.throws(() => new Inflate().lire(Buffer.from([0x78, 0x9c, 0xff, 0xff]), 10), /./);
  assert.throws(() => new Inflate().lire(Buffer.from([0x12, 0x34, 0]), 1), /en-tête/);
});

test('écran : qualité JPEG demandée par défaut, image sans perte en « Qualité nette »', () => {
  const qualites = l => l.filter(x => x >= -32 && x <= -23);
  assert.deepEqual(qualites(encodages(false)), [-24]);
  assert.deepEqual(qualites(encodages(true)), []);
  for (const n of [false, true]) assert.ok(encodages(n).includes(7) && encodages(n).includes(-261) && encodages(n).includes(-308));
});

// --- Écran fluide (Sunshine dans la VM, ProxLab client Moonlight) ---

test('écran fluide, briques : certificat, Reed-Solomon de nanors, RTSP et contrôle chiffrés, entrées bornées, adresses internes', async () => {
  const { nouvelleIdentite, signatureDe } = await import('../src/flux/certificat.js');
  const { encoder, decoder } = await import('../src/flux/rs.js');
  const { sceller, desceller, analyserUrl } = await import('../src/flux/rtsp.js');
  const { scellerControle, ouvrirControle } = await import('../src/flux/controle.js');
  const { lireEntree, lireDebut } = await import('../src/flux/relais.js');
  const { HoteSunshine, adresseInterne } = await import('../src/flux/hote.js');
  const { Fluide } = await import('../src/fluide.js');
  // Un certificat autosigné que Node relit et vérifie ; sa signature fait 256 octets.
  const id = nouvelleIdentite();
  const x = new crypto.X509Certificate(id.certPem);
  assert.ok(x.verify(x.publicKey));
  assert.equal(signatureDe(id.certPem).length, 256);
  // Parité identique à celle de nanors (vecteur tiré de sa bibliothèque), données retrouvées.
  const ref = Buffer.from('466431296486ed9cd71fc207254820a2c4a85aeb0b2041494f8bf1f8cd30f113ee3a2cfe8a88d3d89bccec689af825ac', 'hex');
  const morceaux = Array.from({ length: 6 }, (_, i) => new Uint8Array(ref.subarray(i * 8, i * 8 + 8)));
  assert.deepEqual(encoder(morceaux.slice(0, 4), 2, 8).map(b => Buffer.from(b).toString('hex')), [morceaux[4], morceaux[5]].map(b => Buffer.from(b).toString('hex')));
  const pertes = [morceaux[0], null, morceaux[2], null, morceaux[4], morceaux[5]];
  assert.ok(decoder(pertes, 4, 2, 8));
  assert.deepEqual(Buffer.from(pertes[1]), Buffer.from(morceaux[1]));
  assert.equal(decoder([null, null, null, morceaux[3], morceaux[4], morceaux[5]], 4, 2, 8), false, 'trois pertes, deux paritités : impossible');
  // RTSP : scellé côté client (« CR »), refusé s'il est altéré ou présenté comme venant de l'hôte.
  const cle = crypto.randomBytes(16);
  const sc = sceller('OPTIONS rtsp://x RTSP/1.0\r\n\r\n', cle, 1);
  assert.throws(() => desceller(sc, cle), /falsifiée/, 'un message du client ne passe pas pour une réponse de l\'hôte');
  const iv = Buffer.alloc(12); iv.writeUInt32LE(7, 0); iv[10] = 0x48; iv[11] = 0x52;
  const c = crypto.createCipheriv('aes-128-gcm', cle, iv), clair = Buffer.from('RTSP/1.0 200 OK\r\n\r\n');
  const ch = Buffer.concat([c.update(clair), c.final()]);
  const h = Buffer.alloc(24); h.writeUInt32BE((0x80000000 | clair.length) >>> 0, 0); h.writeUInt32BE(7, 4); c.getAuthTag().copy(h, 8);
  assert.match(desceller(Buffer.concat([h, ch]), cle), /^RTSP\/1\.0 200/);
  const altere = Buffer.concat([h, ch]); altere[30] ^= 1;
  assert.throws(() => desceller(altere, cle), /falsifiée/);
  assert.throws(() => desceller(Buffer.concat([Buffer.from('RTSP/1.0 200 OK\r\n'), Buffer.alloc(20)]), cle), /non chiffrée/);
  assert.deepEqual(analyserUrl('rtspenc://[fd00::5]:48010'), { chiffre: true, hote: 'fd00::5', port: 48010, url: 'rtspenc://[fd00::5]:48010' });
  // Contrôle : le message du client (« CC ») ne s'ouvre pas comme un message de l'hôte (« HC »).
  assert.equal(ouvrirControle(scellerControle(0x0206, Buffer.from([1, 2, 3]), cle, 0), cle), null);
  // Entrées : formats exacts, bornes, rien d'autre.
  const taille = { largeur: 1920, hauteur: 1080 };
  const t = lireEntree(Buffer.from([0x10, 1, 0x41, 0, 0]), taille).clavier;
  assert.equal(t.toString('hex'), '0000000a03000000004100000000', 'touche A enfoncée, en paquet GameStream');
  assert.equal(lireEntree(Buffer.from([0x10, 1, 0xff, 0, 0]), taille), null, 'code de touche hors plage');
  assert.equal(lireEntree(Buffer.from([0x10, 2, 0x41, 0, 0]), taille), null);
  assert.equal(lireEntree(Buffer.from([0x11, 0x07, 0x80, 0, 1]), taille), null, 'position hors de l\'image');
  assert.equal(lireEntree(Buffer.from([0x11, 0, 10, 0, 20]), taille).souris.toString('hex'), '0000000e05000000000a00140000077f0437');
  assert.equal(lireEntree(Buffer.from([0x12, 1, 6]), taille), null, 'bouton inconnu');
  assert.equal(lireEntree(Buffer.from([0x13, 0x7f, 0xff, 0, 0]), taille).souris.length, 1, 'molette bornée');
  assert.equal(lireEntree(Buffer.from([0x99]), taille), null);
  assert.deepEqual(lireDebut('{"debut":{"largeur":1921,"hauteur":1080,"ips":60,"debit":20000}}'), { largeur: 1920, hauteur: 1080, ips: 60, debit: 20000 });
  for (const mauvais of ['{"debut":{"largeur":99999,"hauteur":1080,"ips":60,"debit":20000}}', '{"debut":{"largeur":1920,"hauteur":1080,"ips":61,"debit":20000}}', '{"debut":{"largeur":1920,"hauteur":1080,"ips":60,"debit":999999}}', 'pas du json', '{}']) assert.equal(lireDebut(mauvais), null, mauvais);
  // Sunshine n'est joint que sur le réseau interne.
  assert.ok(adresseInterne('127.0.0.1') && adresseInterne('10.0.0.11') && !adresseInterne('8.8.8.8') && !adresseInterne('169.254.169.254'));
  assert.throws(() => new HoteSunshine({ hote: '8.8.8.8', identite: id }), /réseau interne/);
  assert.deepEqual(Fluide.adressesDe([{ name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1' }] }, { name: 'ens18', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.0.0.11' }, { 'ip-address-type': 'ipv4', 'ip-address': '203.0.113.9' }, { 'ip-address-type': 'ipv6', 'ip-address': 'fd00::1' }] }]), [{ interface: 'ens18', adresse: '10.0.0.11' }]);
});

test('écran fluide, file des images : paquets perdus retrouvés par la parité, image perdue → rien avant la prochaine image clé', async () => {
  const { FileImages } = await import('../src/flux/video.js');
  const { encoder } = await import('../src/flux/rs.js');
  const tp = 512, bloc = tp + 16, utile = tp - 16;
  let seq = 100;
  const paquets = (numero, annexB, cle) => {
    const tete = Buffer.alloc(8); tete[0] = 1; tete[3] = cle ? 2 : 1;
    let dernier = (annexB.length + 8) % utile; if (!dernier) dernier = utile; tete.writeUInt16LE(dernier, 4);
    const charge = Buffer.concat([tete, annexB]), d = Math.ceil(charge.length / utile), p = 2;
    const donnees = Array.from({ length: d }, (_, i) => { const s = Buffer.alloc(bloc); s.writeUInt32LE(numero, 20); s[24] = 1; charge.copy(s, 32, i * utile, Math.min(charge.length, (i + 1) * utile)); return s; });
    const tous = [...donnees, ...encoder(donnees, p, bloc).map(x => Buffer.from(x))];
    tous.forEach((s, i) => { s.writeUInt16BE((seq + i) & 0xffff, 2); s.writeUInt32LE(numero, 20); s[27] = 0; s.writeUInt32LE(((i << 12) | (d << 22) | (Math.round(p * 100 / d) << 4)) >>> 0, 28); });
    seq += tous.length;
    return tous;
  };
  const file = new FileImages({ taillePaquet: tp });
  const sorties = [];
  let pertes = 0;
  file.on('image', i => sorties.push(i));
  file.on('perte', () => pertes++);
  const image = n => crypto.randomBytes(n);
  const a = image(1500), b = image(1500), c = image(700), d = image(900);
  // 1 : image clé, deux paquets de données perdus, retrouvés.
  const p1 = paquets(1, a, true);
  for (const [i, q] of p1.entries()) if (i !== 0 && i !== 2) file.ajouter(q);
  assert.equal(sorties.length, 1); assert.ok(sorties[0].cle); assert.deepEqual(sorties[0].donnees, a);
  assert.equal(file.stats.recuperes, 2);
  // 2 : trop de pertes (trois sur deux paritiés) ; 3 arrive : image 2 perdue, 3 (non clé) retenue.
  const p2 = paquets(2, b, false);
  for (const [i, q] of p2.entries()) if (i > 2) file.ajouter(q);
  for (const q of paquets(3, c, false)) file.ajouter(q);
  assert.equal(sorties.length, 1, 'rien après une perte tant qu\'aucune image clé n\'arrive');
  assert.ok(pertes >= 1);
  // 4 : image clé : elle sort, le flux reprend.
  for (const q of paquets(4, d, true)) file.ajouter(q);
  assert.equal(sorties.length, 2); assert.deepEqual(sorties[1].donnees, d); assert.equal(sorties[1].numero, 4);
  // Doublons et paquets d'images passées : ignorés.
  for (const q of paquets(4, d, true)) file.ajouter(q);
  assert.equal(sorties.length, 2);
});

test('écran fluide : réglage et appairage par PIN sous renfort, droits par rôle, PIN faux refusé, rien du réglage pour le membre', async () => {
  const { fauxSunshine } = await import('./faux-sunshine.js');
  const sun = await fauxSunshine();
  try {
    const url = machine('pve-a', 'qemu', 101) + '/fluide';
    assert.deepEqual((await membre.get(url)).json, { configure: false, appairage: null });
    assert.equal((await lecteur.get(url)).status, 403, 'lecture : pas d\'écran');
    assert.equal((await membre.post(url, { hote: '127.0.0.1' })).status, 403, 'membre : ne règle pas');
    assert.equal((await sansRenfort(() => admin.post(url, { hote: '127.0.0.1', portHttp: sun.portHttp, portHttps: sun.portHttps }))).status, 403, 'renfort exigé');
    assert.equal((await admin.post(url, { hote: '8.8.8.8' })).status, 400, 'adresse publique refusée');
    assert.equal((await admin.get(machine('pve-a', 'lxc', 110) + '/fluide')).status, 400, 'conteneur : non');
    // Rien n'écoute : la cause est dite.
    const ferme = await new Promise(ok => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => ok(p)); }); });
    const direct = await admin.post(url, { hote: '127.0.0.1', portHttp: ferme });
    assert.equal(direct.status, 502);
    assert.match(direct.json.error, new RegExp(`127\\.0\\.0\\.1:${ferme} : connexion refusée : rien n'écoute`));
    assert.equal((await admin.get(url)).json.configure, false, 'adresse injoignable : rien d\'enregistré');
    const pose = await admin.post(url, { hote: '127.0.0.1', portHttp: sun.portHttp, portHttps: sun.portHttps });
    assert.equal(pose.status, 200, JSON.stringify(pose.json));
    assert.equal(pose.json.configure, true); assert.equal(pose.json.appaire, false); assert.equal(pose.json.version, '7.1.431.-1');
    // Session refusée tant que Sunshine n'est pas appairé.
    assert.equal((await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101', mode: 'fluide' })).status, 409);
    // PIN faux : Sunshine répond, la preuve ne tient pas, rien n'est épinglé.
    let a = await admin.post(url + '/appairage');
    assert.match(a.json.appairage.pin, /^\d{4}$/);
    assert.equal((await membre.get(url)).json.appairage.pin, undefined, 'le PIN ne se montre qu\'à l\'administrateur');
    sun.saisirPin(a.json.appairage.pin === '0000' ? '1111' : '0000');
    await attendre(() => false, 0).catch(() => {});
    let etat;
    for (let i = 0; i < 200; i++) { etat = (await admin.get(url)).json; if (etat.appairage?.etat !== 'attente') break; await new Promise(r => setTimeout(r, 20)); }
    assert.equal(etat.appairage.etat, 'echec'); assert.match(etat.appairage.message, /PIN incorrect/);
    assert.equal(etat.appaire, false);
    // Le bon PIN : appairé, certificat de Sunshine épinglé.
    a = await admin.post(url + '/appairage');
    sun.saisirPin(a.json.appairage.pin);
    for (let i = 0; i < 200; i++) { etat = (await admin.get(url)).json; if (etat.appairage?.etat !== 'attente') break; await new Promise(r => setTimeout(r, 20)); }
    assert.equal(etat.appairage.etat, 'reussi', JSON.stringify(etat)); assert.equal(etat.appaire, true);
    assert.match(etat.empreinte, /^sha256:[0-9a-f]{64}$/);
    const vu = (await membre.get(url)).json;
    assert.equal(vu.appaire, true); assert.equal(vu.hote, undefined); assert.equal(vu.empreinte, undefined, 'adresse et empreinte : administrateur seulement');
    // La clé privée de ProxLab est scellée dans la base, jamais en clair.
    const identite = JSON.parse(s.db.prepare("SELECT valeur FROM reglages WHERE cle = 'fluide-identite'").get().valeur);
    assert.ok(identite.cle_scellee && !/PRIVATE KEY/.test(JSON.stringify(identite)));
    const actions = s.db.prepare("SELECT action FROM socle_journal WHERE action LIKE 'machine.fluide%'").all().map(l => l.action);
    assert.ok(actions.includes('machine.fluide.adresse') && actions.includes('machine.fluide.appairage'));
  } finally { await sun.fermer(); }
});

test('écran fluide de bout en bout : vidéo chiffrée relayée, parité, image clé redemandée, entrées transmises, fin par Sunshine', async () => {
  const { fauxSunshine } = await import('./faux-sunshine.js');
  const sun = await fauxSunshine();
  try {
    const url = machine('pve-a', 'qemu', 101) + '/fluide';
    await admin.post(url, { hote: '127.0.0.1', portHttp: sun.portHttp, portHttps: sun.portHttps });
    const a = await admin.post(url + '/appairage');
    sun.saisirPin(a.json.appairage.pin);
    await attendre(() => !!sun.appaire);
    for (let i = 0; i < 100 && !(await admin.get(url)).json.appaire; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal((await lecteur.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101', mode: 'fluide' })).status, 403);
    const { passe } = (await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101', mode: 'fluide' })).json;
    const w = await ouvrirWs(membre, passe);
    assert.equal(w.code, 101);
    w.conn.envoyerTexte(JSON.stringify({ debut: { largeur: 1280, hauteur: 720, ips: 60, debit: 15000 } }));
    await attendre(() => w.recu.some(m => m.includes('"pret"')), 8000);
    const pret = JSON.parse(w.recu.find(m => m.includes('"pret"'))).pret;
    assert.deepEqual(pret, { codec: 'h264', largeur: 1280, hauteur: 720, ips: 60, chiffre: true });
    assert.equal(sun.lancement.mode, '1280x720x60'); assert.equal(sun.lancement.corever, '1');
    assert.equal(sun.donneesConnexion, 4660, 'X-SS-Connect-Data portée par la connexion ENet');
    assert.equal(sun.chiffre & 3, 3, 'contrôle et vidéo chiffrés');
    await attendre(() => sun.clientVideo && sun.pings.audio > 0);
    const images = () => w.bruts.filter(b => !b.texte && b.m[0] === 1).map(b => b.m);
    // Une image clé, deux paquets perdus et retrouvés par la parité.
    const sps = Buffer.from('0000000167640028acd940780227e5c044000003000400000300f03c60c658', 'hex'), pps = Buffer.from('0000000168ebe3cb22c0', 'hex');
    const idr = Buffer.concat([sps, pps, Buffer.from('0000000165', 'hex'), crypto.randomBytes(4000)]);
    sun.envoyerImage(idr, { cle: true, perdre: [1, 3] });
    await attendre(() => images().length === 1);
    assert.equal(images()[0][1] & 1, 1, 'image clé');
    assert.deepEqual(images()[0].subarray(6), idr);
    // Une image perdue (trop de paquets manquants) : la suivante attend une image clé, demandée à Sunshine.
    const demandes = sun.imagesClesDemandees || 0;
    sun.envoyerImage(crypto.randomBytes(3000), { perdre: [0, 1, 2, 3] });
    sun.envoyerImage(Buffer.concat([Buffer.from('0000000141', 'hex'), crypto.randomBytes(500)]));
    await attendre(() => (sun.imagesClesDemandees || 0) > demandes);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(images().length, 1, 'rien ne sort après une perte');
    sun.envoyerImage(idr, { cle: true });
    await attendre(() => images().length === 2);
    // Entrées : touche, position, clic, molette → paquets GameStream sur les bons canaux.
    w.conn.envoyerBinaire(Buffer.from([0x10, 1, 0x41, 0, 0]));
    w.conn.envoyerBinaire(Buffer.from([0x10, 0, 0x41, 0, 0]));
    w.conn.envoyerBinaire(Buffer.from([0x11, 0, 100, 0, 50]));
    w.conn.envoyerBinaire(Buffer.from([0x12, 1, 1]));
    w.conn.envoyerBinaire(Buffer.from([0x13, 0, 120, 0, 0]));
    await attendre(() => sun.entrees.length >= 5);
    const [bas, haut, pos, clic, molette] = sun.entrees.slice(-5);
    assert.deepEqual([bas.canal, haut.canal, pos.canal, clic.canal, molette.canal], [2, 2, 3, 3, 3]);
    assert.equal(bas.paquet.readUInt32LE(4), 3); assert.equal(bas.paquet.readUInt16LE(9), 0x41); assert.equal(haut.paquet.readUInt32LE(4), 4);
    assert.equal(pos.paquet.readInt16BE(8), 100); assert.equal(pos.paquet.readInt16BE(10), 50); assert.equal(pos.paquet.readInt16BE(14), 1279);
    assert.equal(clic.paquet.readUInt32LE(4), 8); assert.equal(clic.paquet[8], 1);
    assert.equal(molette.paquet.readInt16BE(8), 120);
    assert.ok(!sun.controleFalsifie, 'chaque message de contrôle s\'ouvre avec la clé de la session');
    // Sunshine ferme : le navigateur le sait.
    sun.terminer();
    await attendre(() => w.recu.some(m => m.includes('fermée par Sunshine')));
    await attendre(() => w.conn.ferme);
    const j = s.db.prepare("SELECT action FROM socle_journal WHERE action IN ('machine.fluide.session', 'machine.fluide.fin', 'console.ouverte')").all().map(l => l.action);
    assert.ok(j.includes('machine.fluide.session') && j.includes('machine.fluide.fin'));
    // Un message d'entrée invalide ferme la session.
    const p2 = (await membre.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101', mode: 'fluide' })).json.passe;
    const w2 = await ouvrirWs(membre, p2);
    w2.conn.envoyerTexte(JSON.stringify({ debut: { largeur: 1280, hauteur: 720, ips: 60, debit: 15000 } }));
    await attendre(() => w2.recu.some(m => m.includes('"pret"')), 8000);
    assert.equal(sun.reprises, 1, 'le bureau lancé par la session d\'avant est repris, pas relancé');
    assert.equal(sun.annule || 0, 0, 'fermer l\'écran n\'arrête pas le bureau dans Sunshine');
    w2.conn.envoyerBinaire(Buffer.from([0x10, 1, 0xff, 0x7f, 0]));
    await attendre(() => w2.recu.some(m => m.includes('message refusé')));
    await attendre(() => w2.conn.ferme);
  } finally { await sun.fermer(); }
});

test('rotation de SOCLE_CLE : les secrets de la liaison et des alertes sont rescellés, Proxmox reste joignable', async () => {
  await s.arreter();
  const neuve = crypto.randomBytes(32).toString('base64');
  // Sans l'ancienne clé : arrêt net plutôt que des secrets perdus.
  await assert.rejects(lancer(base, { SOCLE_CLE: neuve }), /SOCLE_CLE/);
  s = await lancer(base, { SOCLE_CLE: neuve, SOCLE_CLE_ANCIENNE: CLE });
  const l = s.reglages.liaison();
  assert.equal(l.secret, JETON.secret);
  assert.equal(s.reglages.alertes().cle, 'cle-du-recepteur-essai');
  assert.equal((await s.client().get('/api/health')).status, 200);
  // L'identité de l'écran fluide (créée par les essais qui précèdent) : rescellée, toujours la même.
  const f = s.reglages.lire('fluide-identite');
  assert.match(s.reglages.ouvrir('fluideCle', f.cle_scellee), /BEGIN PRIVATE KEY/);
  assert.ok((await s.proxmox.get('/version')).version);
  await s.arreter();
  s = await lancer(base, { SOCLE_CLE: neuve });
  assert.equal(s.reglages.liaison().motDePasse, UTILISATEUR.motDePasse, 'sous la seule clé neuve');
});

test('ligne de commande : sauvegarde chiffrée pour une clé publique, restaurée ailleurs ; liaison retirée pour un incident', async () => {
  const { execFileSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const cli = (args, entree) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.resolve(import.meta.dirname, '..', 'src', 'cli.js'), ...args], { input: entree, env: { ...process.env, DATA_DIR: base }, stdio: ['pipe', 'pipe', 'pipe'] });
  const sauv = cli(['sauvegarde'], publicKey);
  assert.ok(!sauv.includes(Buffer.from('SQLite format')), 'la sauvegarde est chiffrée');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'proxlab-restaure-'));
  const pem = path.join(dossier, 'cle.pem');
  fs.writeFileSync(pem, privateKey, { mode: 0o600 });
  cli(['restaurer', pem, path.join(dossier, 'proxlab.db')], sauv);
  const copie = new DatabaseSync(path.join(dossier, 'proxlab.db'), { readOnly: true });
  const liaison = JSON.parse(copie.prepare("SELECT valeur FROM reglages WHERE cle = 'liaison'").get().valeur);
  copie.close();
  assert.ok(liaison.jeton_scelle && !JSON.stringify(liaison).includes(JETON.secret), 'restaurée, secrets toujours scellés');
  assert.throws(() => cli(['restaurer', pem, path.join(dossier, 'proxlab.db')], ''), e => /existe déjà/.test(String(e.stderr)), 'jamais par-dessus une base');
  assert.match(cli(['liaison', 'retirer']).toString(), /révoque aussi le jeton/);
  assert.equal(s.reglages.lire('liaison'), null);
  await assert.rejects(s.proxmox.get('/version'), /pas encore relié/);
  const actions = s.db.prepare("SELECT action FROM socle_journal WHERE action IN ('sauvegarde.faite', 'liaison.retiree')").all().map(x => x.action);
  assert.deepEqual(actions.sort(), ['liaison.retiree', 'sauvegarde.faite']);
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('WebSocket : trames bornées selon le sens — 4 Mio du navigateur, une image entière de Proxmox', () => {
  const faux = () => { const s = new EventEmitter(); Object.assign(s, { ecrit: [], write(b) { s.ecrit.push(b); return true; }, end() { s.fini = true; }, destroy() { s.fini = true; }, setTimeout() {} }); return s; };
  const tete = (n, masque) => { const t = Buffer.alloc(10); t[0] = 0x82; t[1] = 127 | (masque ? 0x80 : 0); t.writeBigUInt64BE(BigInt(n), 2); return masque ? Buffer.concat([t, Buffer.alloc(4)]) : t; };
  const navigateur = new Connexion(faux(), { role: 'serveur' });
  navigateur._recevoir(tete(5 * 1024 * 1024, true));
  assert.equal(navigateur.ferme, true, 'trame de 5 Mio du navigateur : fermée');
  const amont = new Connexion(faux(), { role: 'client' });
  let recu = 0;
  amont.on('message', m => { recu = m.length; });
  const n = 3024 * 1964 * 4;   // image entière d'un écran Retina de 15 pouces
  amont._recevoir(Buffer.concat([tete(n, false), Buffer.alloc(n)]));
  assert.equal(recu, n, 'image entière de Proxmox : passée');
  const geant = new Connexion(faux(), { role: 'client' });
  geant._recevoir(tete(65 * 1024 * 1024, false));
  assert.equal(geant.ferme, true, 'au-delà de 64 Mio : fermée');
});

