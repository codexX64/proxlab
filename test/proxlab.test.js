import { EventEmitter } from 'node:events';
import { test, before, after } from 'node:test';
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
import { Connexion } from '../src/websocket.js';
import { corpsTicket, urgence } from '../src/alerte.js';
import { desChiffrer, reponseVnc } from '../src/des.js';
import { longueurMessageClient } from '../src/ecran.js';
import { dispositionDe, lireSortie, detecterClavier } from '../src/clavier.js';

const JETON_HUB = 'jeton-du-hub-pour-les-essais-de-proxlab-0123';
const INSTALL = 'jeton-installation-proxlab-essai';
const SILENCE = { info() {}, warn() {}, error() {} };
const CLE = crypto.randomBytes(32).toString('base64');
let s, pve, admin, membre, lecteur, base, journalServeur = [];

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
  await adminComplet(admin, { jeton: INSTALL });
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
  assert.deepEqual(Object.keys(e.noeuds[0]).sort(), ['cpu', 'disk', 'maxcpu', 'maxdisk', 'maxmem', 'mem', 'node', 'status', 'uptime']);
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
  for (const forme of ['x11 ', 'vc ', "gnome [('xkb', '"]) assert.ok(lireSortie(forme + 'x'.repeat(5000) + "')]\nvariante " + 'y'.repeat(5000)).brut.length <= 129, `sortie ${forme.trim()} bornée`);
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
