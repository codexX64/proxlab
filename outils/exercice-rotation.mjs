// Exercice de rotation de bout en bout : ProxLab lancé comme en production
// (processus à part, clé maîtresse lue dans un fichier _FILE), un compte avec
// TOTP, clé d'accès et codes de secours, la liaison à un faux Proxmox (jeton
// d'API et mot de passe scellés, empreinte épinglée) et un récepteur d'alertes
// à clé et secret de signature ; puis SOCLE_CLE tournée comme le dit le README,
// et tout ce qui existait revérifié par les vrais chemins (connexion, lecture
// de la grappe, console, ticket signé). Dure un peu plus de trente secondes
// (un pas TOTP).
//   node outils/exercice-rotation.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
const RACINE = path.resolve(import.meta.dirname, '..');
const { Client, connexion } = await import(`${RACINE}/socle/essai/client.js`);
const { Authentificateur } = await import(`${RACINE}/socle/essai/authentificateur.js`);
const totp = await import(`${RACINE}/socle/src/totp.js`);
const { Connexion } = await import(`${RACINE}/src/websocket.js`);
const { fauxProxmox, JETON: JETON_PVE, UTILISATEUR } = await import(`${RACINE}/test/faux-pve.js`);

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'exercice-')), S = path.join(D, 'secrets');
fs.mkdirSync(S, { mode: 0o700 });
const PORT = 18000 + crypto.randomInt(1000), JETON = crypto.randomBytes(24).toString('base64url'), MDP = 'phrase de passe de l’exercice de rotation';
const SECRET_HMAC = 'secret-de-signature-de-l-exercice';
const cle = () => crypto.randomBytes(32).toString('base64');
const poser = (f, v) => fs.writeFileSync(path.join(S, f), v, { mode: 0o600 });
const lire = f => fs.readFileSync(path.join(S, f), 'utf8');
const rapport = [];
let proc, sortie = '';
const pve = await fauxProxmox();
const recus = [];
const recepteur = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { recus.push({ entetes: req.headers, brut: b }); res.end('{"ref":"T-1"}'); }); });
await new Promise(r => recepteur.listen(0, '127.0.0.1', r));
const fin = async code => { try { proc?.kill('SIGKILL'); } catch { /* déjà arrêté */ } await pve.fermer(); recepteur.close(); fs.rmSync(D, { recursive: true, force: true }); process.exit(code); };
const note = async (ok, quoi) => { rapport.push(`${ok ? 'OK ' : 'ÉCHEC'} ${quoi}`); if (!ok) { console.log(rapport.join('\n')); console.log(sortie.slice(-2000)); await fin(1); } };
const jusqua = async (cond, ms = 4000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 20)); } return true; };

poser('socle_cle', cle()); poser('socle_cle_ancienne', '');
async function demarrer() {
  sortie = '';
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], { cwd: RACINE, env: {
    PATH: process.env.PATH, PORT: String(PORT), HOTE: '127.0.0.1', DATA_DIR: path.join(D, 'data'),
    SOCLE_CLE_FILE: path.join(S, 'socle_cle'), SOCLE_CLE_ANCIENNE_FILE: path.join(S, 'socle_cle_ancienne'),
    SOCLE_JETON_INSTALLATION: JETON, PROXLAB_INTERVAL: '3600',
  } });
  proc.stdout.on('data', d => { sortie += d; }); proc.stderr.on('data', d => { sortie += d; });
  const arret = new Promise(r => proc.on('exit', c => r({ code: c })));
  for (let i = 0; i < 100; i++) {
    const r = await Promise.race([fetch(`http://127.0.0.1:${PORT}/api/health`).then(x => x.status, () => 0), arret]);
    if (r === 200) return { code: null };
    if (typeof r === 'object') return r;
    await new Promise(r => setTimeout(r, 200));
  }
  return { code: 'délai' };
}
const arreter = () => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); });

// La grappe se lit avec le jeton scellé ; la console s'ouvre avec le mot de
// passe scellé (le WebSocket de Proxmox refuse les jetons).
const grappeLue = async c => { const e = (await c.get('/api/etat')).json; return e?.relie === true && e.noeuds.length === 2; };
async function consoleOuvre(c) {
  const { passe } = (await c.post('/api/console', { noeud: 'pve-a', type: 'qemu', vmid: '101' })).json || {};
  if (!passe) return false;
  return new Promise(resolve => {
    const socket = net.connect(PORT, '127.0.0.1', () => socket.write([`GET /ws/console?passe=${encodeURIComponent(passe)} HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Origin: http://127.0.0.1:${PORT}`, `Cookie: ${[...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ')}`].join('\r\n') + '\r\n\r\n'));
    let tampon = Buffer.alloc(0);
    const sur = d => {
      tampon = Buffer.concat([tampon, d]);
      const i = tampon.indexOf('\r\n\r\n'); if (i < 0) return;
      socket.removeListener('data', sur);
      if (!tampon.subarray(0, i).toString().includes(' 101 ')) { socket.destroy(); return resolve(false); }
      const ws = new Connexion(socket, { role: 'client' }); const texte = [];
      ws.on('message', m => texte.push(m.toString('utf8')));
      if (tampon.length > i + 4) ws._recevoir(tampon.subarray(i + 4));
      jusqua(() => texte.join('').includes('invite-101:~#')).then(ok => { ws.close(); resolve(ok); });
    };
    socket.on('data', sur); socket.on('error', () => resolve(false));
  });
}
async function ticketSigne(c) {
  const n = recus.length;
  if ((await c.post('/api/alertes/essai', {})).status !== 200 || recus.length !== n + 1) return false;
  const r = recus.at(-1);
  return r.entetes['x-api-key'] === 'cle-du-recepteur-de-l-exercice' && r.entetes['x-signature'] === 'sha256=' + crypto.createHmac('sha256', SECRET_HMAC).update(r.brut).digest('hex');
}

await note((await demarrer()).code === null, 'démarrage sous la SOCLE_CLE initiale (lue dans un fichier)');
const a = new Client(PORT), auth = new Authentificateur();
await note((await a.post('/api/compte/installation', { jeton: JETON, identifiant: 'ana', motDePasse: MDP })).status === 200, 'installation du premier compte');
const secret = (await a.post('/api/compte/totp')).json.secret;
await note((await a.post('/api/compte/totp/confirmer', { code: totp.code(secret, totp.pasCourant(Date.now())) })).status === 200, 'TOTP inscrit');
const o = await a.post('/api/compte/cles/options');
await note((await a.post('/api/compte/cles', { reponse: auth.creer(o.json, a.origine), nom: 'Exercice' })).json?.niveau === 'complet', 'clé d’accès inscrite');
const codes = (await a.post('/api/compte/secours')).json.codes;
const sonde = (await a.post('/api/liaison/sonde', { hote: pve.hote, port: pve.port })).json;
const liaison = await a.put('/api/liaison', { hote: pve.hote, port: pve.port, confiance: 'epingle', fp: sonde.fp, jetonId: JETON_PVE.id, secret: JETON_PVE.secret, utilisateur: UTILISATEUR.nom, motDePasse: UTILISATEUR.motDePasse });
await note(liaison.status === 200, 'liaison à Proxmox : empreinte épinglée, jeton et mot de passe scellés');
const al = await a.put('/api/alertes', { actif: true, url: `http://127.0.0.1:${recepteur.address().port}/tickets`, cle: 'cle-du-recepteur-de-l-exercice', secret: SECRET_HMAC });
await note(al.status === 200, 'récepteur d’alertes : clé et secret de signature scellés');
await note(await grappeLue(a), 'grappe lue avec le jeton scellé');
await note(await consoleOuvre(a), 'console ouverte avec le mot de passe scellé');
await note(await ticketSigne(a), 'ticket d’essai reçu, clé et signature attendues');
await arreter();

poser('socle_cle_ancienne', lire('socle_cle')); poser('socle_cle', cle());
await note((await demarrer()).code === null, 'redémarrage avec la clé neuve et l’ancienne posée');
await note(/\[coffre\] Clé tournée : 1 secret\(s\) TOTP rescellé\(s\), 10 code\(s\) de secours/.test(sortie), 'socle : ' + (sortie.match(/\[coffre\] Clé tournée : [^.]*\./)?.[0] || 'aucune trace'));
await note(/\[coffre\] 4 secret\(s\) de ProxLab rescellé\(s\) sous SOCLE_CLE\./.test(sortie), 'ProxLab : ' + (sortie.match(/\[coffre\] \d+ secret\(s\) de ProxLab[^.]*\./)?.[0] || 'aucune trace'));
let c = new Client(PORT);
await note((await connexion(c, 'ana', MDP)).json?.etape === 'second', 'mot de passe accepté');
await new Promise(r => setTimeout(r, 31_000));
await note((await c.post('/api/compte/connexion/totp', { code: totp.code(secret, totp.pasCourant(Date.now())) })).json?.niveau === 'complet', 'TOTP inscrit avant la rotation accepté');
await note(await grappeLue(c), 'grappe lue : jeton rescellé');
c = new Client(PORT); await connexion(c, 'ana', MDP);
await note((await c.post('/api/compte/connexion/secours', { code: codes[4] })).status === 200, 'code de secours d’avant la rotation accepté');
await arreter();

poser('socle_cle_ancienne', '');
await note((await demarrer()).code === null, 'redémarrage, ancienne clé retirée');
c = new Client(PORT);
const oc = await c.post('/api/compte/connexion/cle/options');
await note((await c.post('/api/compte/connexion/cle', { reponse: auth.signer(oc.json, c.origine) })).json?.niveau === 'complet', 'connexion par clé d’accès');
await note(await grappeLue(c) && await consoleOuvre(c), 'jeton et mot de passe de Proxmox lisibles sous la seule clé neuve');
await note(await ticketSigne(c), 'clé et secret du récepteur lisibles sous la seule clé neuve');
await arreter();

poser('socle_cle', cle());
const r = await demarrer();
await note(r.code !== null && /n’est pas la clé qui a écrit cette base/.test(sortie), 'clé inconnue : démarrage refusé');
console.log(`Exercice de rotation, ${new Date().toISOString()}\n${rapport.join('\n')}\n${rapport.length} vérifications réussies.`);
await fin(0);
