// Exercice du runbook d'incident (README, « Sécurité » ; SECURITY.md,
// « Incident runbook ») sur une instance lancée comme en production, reliée à
// un faux Proxmox : chaque geste de confinement et de reprise est joué par son
// vrai chemin, et son effet vérifié. Dure une vingtaine de secondes.
//   node outils/exercice-incident.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const RACINE = path.resolve(import.meta.dirname, '..');
const { Client, connexion } = await import(`${RACINE}/socle/essai/client.js`);
const { adminComplet, membreInvite, MDP_ESSAI } = await import(`${RACINE}/socle/essai/inscription.js`);
const { fauxProxmox, JETON: JETON_PVE, UTILISATEUR } = await import(`${RACINE}/test/faux-pve.js`);

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'exercice-incident-')), DONNEES = path.join(D, 'data');
const PORT = 19000 + crypto.randomInt(1000), JETON = crypto.randomBytes(24).toString('base64url');
const SOCLE_CLE = crypto.randomBytes(32).toString('base64');
const rapport = [];
let proc, sortie = '';
const pve = await fauxProxmox();
const fin = async code => { try { proc?.kill('SIGKILL'); } catch { /* déjà arrêté */ } await pve.fermer(); fs.rmSync(D, { recursive: true, force: true }); process.exit(code); };
const note = async (ok, quoi) => { rapport.push(`${ok ? 'OK ' : 'ÉCHEC'} ${quoi}`); if (!ok) { console.log(rapport.join('\n')); console.log(sortie.slice(-2000)); await fin(1); } };
const cli = (args, entree) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.js', ...args], { cwd: RACINE, env: { PATH: process.env.PATH, DATA_DIR: DONNEES }, input: entree });

async function demarrer(env) {
  sortie = '';
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.js'], { cwd: RACINE, env: {
    PATH: process.env.PATH, PORT: String(PORT), HOTE: '127.0.0.1', DATA_DIR: DONNEES, SOCLE_CLE, SOCLE_JETON_INSTALLATION: JETON, PROXLAB_INTERVAL: '3600', ...env,
  } });
  proc.stdout.on('data', d => { sortie += d; }); proc.stderr.on('data', d => { sortie += d; });
  for (let i = 0; i < 100; i++) {
    if ((await fetch(`http://127.0.0.1:${PORT}/api/health`).then(x => x.status, () => 0)) === 200) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
const arreter = () => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); });
const hub = jeton => ({ entetes: { authorization: `Bearer ${jeton}` }, origine: null });

const HUB1 = crypto.randomBytes(24).toString('base64url'), HUB2 = crypto.randomBytes(24).toString('base64url');
await note(await demarrer({ PROXLAB_HUB_TOKEN: HUB1 }), 'démarrage : jeton du Hub n° 1');
const admin = new Client(PORT);
const { auth } = await adminComplet(admin, { jeton: JETON });
const { client: membre } = await membreInvite(admin, () => new Client(PORT), { identifiant: 'bruno' });
const sonde = (await admin.post('/api/liaison/sonde', { hote: pve.hote, port: pve.port })).json;
await note((await admin.put('/api/liaison', { hote: pve.hote, port: pve.port, confiance: 'epingle', fp: sonde.fp, jetonId: JETON_PVE.id, secret: JETON_PVE.secret, utilisateur: UTILISATEUR.nom, motDePasse: UTILISATEUR.motDePasse })).status === 200, 'ProxLab relié à la grappe');
await note((await membre.post('/api/machines/pve-a/qemu/101/alimentation', { action: 'reboot' })).status === 200, 'le membre agit sur une machine');

// 1. Détecter
await note((await membre.post('/api/machines/pve-a/qemu/101/alimentation', { action: 'stop' })).status === 403, 'un geste interdit (arrêt forcé par un membre) est refusé');
const journal = (await admin.get('/api/compte/admin/journal')).json;
await note(journal.lignes.some(l => l.action === 'acces.refuse') && journal.integrite.ok, 'détecter : le refus est au journal, chaîne intacte');
// 2. Fermer toutes les sessions sauf la sienne
await note((await admin.post('/api/compte/admin/sessions/fermer-tout')).status === 200, 'toutes les sessions fermées');
await note((await membre.get('/api/etat')).status === 401 && (await admin.get('/api/etat')).status === 200, 'la session du membre est morte, pas celle de l’administrateur');
// 3. Couper le Hub
await arreter();
await note(await demarrer({ PROXLAB_HUB_TOKEN: HUB2 }), 'redéploiement : jeton du Hub n° 2');
await note((await new Client(PORT).req('GET', '/api/hub/etat', undefined, hub(HUB1))).status === 401 && (await new Client(PORT).req('GET', '/api/hub/etat', undefined, hub(HUB2))).status === 200, 'l’ancien jeton du Hub ne vaut plus rien, le nouveau ouvre');
// 4. Retirer la liaison à Proxmox (le jeton se révoque aussi dans Proxmox)
const n0 = pve.appels.length;
const retrait = cli(['liaison', 'retirer']);
await note(retrait.status === 0 && /liaison à Proxmox retirée/.test(String(retrait.stdout)), 'liaison retirée en ligne de commande, service en marche');
await note((await admin.get('/api/etat')).json?.relie === false && (await admin.post('/api/machines/pve-a/qemu/101/alimentation', { action: 'start' })).status === 409 && pve.appels.length === n0, 'plus aucun appel ne part vers Proxmox');
// 5. Forcer un nouveau mot de passe
const comptes = (await admin.get('/api/compte/admin/comptes')).json.comptes;
const bruno = comptes.find(x => x.identifiant === 'bruno');
const reinit = await admin.post(`/api/compte/admin/comptes/${bruno.id}/reinit`);
await note(reinit.status === 200, 'lien de réinitialisation émis pour le membre');
const nouveau = MDP_ESSAI + ' après incident';
await note((await new Client(PORT).post('/api/compte/jeton', { usage: 'reinit', jeton: reinit.json.lien.split('#reinit=')[1], motDePasse: nouveau })).status === 200, 'le membre pose un nouveau mot de passe');
await note((await connexion(new Client(PORT), 'bruno', MDP_ESSAI + ' bruno')).status === 401, 'l’ancien mot de passe ne vaut plus rien');
await note((await connexion(new Client(PORT), 'bruno', nouveau)).json?.etape === 'second', 'le nouveau ouvre, et le second facteur reste exigé');
// 6. Restaurer depuis une sauvegarde
const paire = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const sauv = cli(['sauvegarde'], paire.publicKey);
await note(sauv.status === 0 && sauv.stdout.length > 0, 'sauvegarde chiffrée tirée pendant que le service tourne');
await note((await admin.get('/api/compte/admin/journal')).json.lignes.some(l => l.action === 'sauvegarde.faite'), 'la sauvegarde est inscrite au journal');
await arreter();
const prive = path.join(D, 'prive.pem'), restauree = path.join(D, 'restauree.db');
fs.writeFileSync(prive, paire.privateKey);
await note(cli(['restaurer', prive, restauree], sauv.stdout).status === 0, 'restaurée ailleurs avec la clé privée seule');
for (const f of ['proxlab.db', 'proxlab.db-wal', 'proxlab.db-shm']) fs.rmSync(path.join(DONNEES, f), { force: true });
fs.copyFileSync(restauree, path.join(DONNEES, 'proxlab.db'));
fs.chmodSync(path.join(DONNEES, 'proxlab.db'), 0o600);
await note(await demarrer({ PROXLAB_HUB_TOKEN: HUB2 }), 'redémarrage sur la base restaurée');
const c = new Client(PORT);
const options = await c.post('/api/compte/connexion/cle/options');
await note((await c.post('/api/compte/connexion/cle', { reponse: auth.signer(options.json, c.origine) })).json?.niveau === 'complet', 'l’administrateur se reconnecte avec sa clé d’accès');
await note((await c.get('/api/evenements?limite=50')).json.some(e => e.kind === 'guest.rebooted' && e.by === 'bruno'), 'les événements de la grappe sont revenus');
// 7. Vérifier la chaîne du journal
const apres = (await c.get('/api/compte/admin/journal')).json;
await note(apres.integrite.ok && ['sessions.toutes_fermees', 'liaison.retiree', 'compte.reinit_emis'].every(a => apres.lignes.some(l => l.action === a)), 'base restaurée : chaîne du journal intacte, chaque geste d’avant la sauvegarde inscrit');
await arreter();
console.log(`Exercice du runbook d'incident, ${new Date().toISOString()}\n${rapport.join('\n')}\n${rapport.length} vérifications réussies.`);
await fin(0);
