// Vitrine locale : ProxLab relié à un faux Proxmox (celui des essais), avec
// une semaine d'événements, pour le parcours dans le navigateur et les
// captures. Rien de réel : grappe, adresses (192.0.2.0/24) et noms sont fictifs.
// Usage : node outils/vitrine.mjs [port] [gamme]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { demarrer } from '../src/main.js';
import { fauxProxmox, JETON, UTILISATEUR } from '../test/faux-pve.js';

const [port = '8191', gamme = 'soma'] = process.argv.slice(2);
const pve = await fauxProxmox();
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'proxlab-vitrine-'));
const JETON_INSTALLATION = crypto.randomBytes(18).toString('base64url');
const s = await demarrer({
  PORT: port, HOTE: '127.0.0.1', DATA_DIR: dossier, PROXLAB_HUB_TOKEN: crypto.randomBytes(24).toString('base64url'),
  PROXLAB_INTERVAL: '15', SOCLE_CLE: crypto.randomBytes(32).toString('base64'), SOCLE_JETON_INSTALLATION: JETON_INSTALLATION, SOCLE_THEME: gamme,
}, { log: { info: m => console.log(m), warn() {}, error: (...a) => console.error(...a) } });

// Une semaine passée : quelques pannes, un stockage plein, des retours.
const ins = s.db.prepare('INSERT INTO evenements(ref, genre, niveau, titre, corps, cible, noeud, acteur, acteur_compte, cree) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)');
const t = Date.now(), h = 3600e3;
for (const [il_y_a, genre, niveau, titre, cible, noeud] of [
  [150, 'guest.down', 'critique', 'supervision est arrêtée', 'lxc/120', 'pve-b'], [149, 'guest.recovered', 'info', 'supervision est de nouveau en marche', 'lxc/120', 'pve-b'],
  [96, 'storage.threshold', 'avertissement', 'Stockage local-lvm à 91 %', 'storage/local-lvm', 'pve-a'], [71, 'node.memory', 'avertissement', 'Mémoire du nœud pve-a à 93 %', 'node/pve-a', 'pve-a'],
  [30, 'vm.created', 'info', 'qemu/130 créée sur pve-b', 'qemu/130', 'pve-b'], [5, 'snapshot.created', 'info', 'Instantané « avant-maj » de qemu/101', 'qemu/101', 'pve-a'],
]) ins.run(crypto.randomBytes(9).toString('base64url'), genre, niveau, titre, '', cible, noeud, null, t - il_y_a * h);

console.log(`ProxLab ${gamme} : http://localhost:${port}`);
console.log(`JETON=${JETON_INSTALLATION}`);
console.log(`PVE=${pve.hote}:${pve.port} JETON_ID=${JETON.id} SECRET=${JETON.secret} UTILISATEUR=${UTILISATEUR.nom} MDP=${UTILISATEUR.motDePasse}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await s.arreter(); await pve.fermer(); fs.rmSync(dossier, { recursive: true, force: true }); process.exit(0); });
