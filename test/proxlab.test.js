import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { demarrer } from '../src/main.js';
import { Client } from '../socle/essai/client.js';
import { adminComplet, membreInvite } from '../socle/essai/inscription.js';
import { fauxProxmox, JETON, UTILISATEUR } from './faux-pve.js';
import { chemin } from '../src/pve.js';
import { connecter as connecterTls, empreinte } from '../src/tls.js';
import { Connexion } from '../src/websocket.js';
import { corpsTicket, urgence } from '../src/alerte.js';

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
      const recu = [];
      conn.on('message', m => recu.push(m.toString('utf8')));
      const reste = tampon.subarray(i + 4);
      if (reste.length) conn._recevoir(reste);
      resolve({ code, conn, recu, texte: () => recu.join('') });
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
  await attendre(() => pve.consoles.at(-1).tailles.length >= 1);
  assert.deepEqual(pve.consoles.at(-1).tailles, [[100, 30]], 'une taille hors bornes n\'est pas transmise');
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
  assert.ok(refus.length >= 1, 'les refus de console sont au journal');
  assert.ok(!refus.some(r => [p.json.passe, p2.json.passe, p3.json.passe, p4.json.passe].some(x => String(r.details).includes(x))), 'jamais la passe au journal');
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
