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
import { fauxSunshine } from '../test/faux-sunshine.js';

const [port = '8191', gamme = 'soma'] = process.argv.slice(2);
const pve = await fauxProxmox({ ecran: [1024, 640] });
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

// Un faux Sunshine pour l'écran fluide, sur une autre adresse de bouclage et
// aux ports habituels : l'interface n'y demande que l'adresse. Le PIN est
// « saisi dans Sunshine » une seconde après son affichage, et des images
// (synthétiques : le parcours remplace le décodeur du navigateur) partent à
// 30 i/s dès qu'une session est ouverte, une image clé toutes les deux secondes
// ou à la demande.
let sun = null;
try { sun = await fauxSunshine({ hote: '127.0.0.2', portHttp: 47989, portHttps: 47984 }); } catch (e) { console.log(`(écran fluide sans faux Sunshine : ${e.code || e.message})`); }
if (sun) {
  setInterval(() => {
    for (const a of s.api.fluide.appairages.values()) if (a.etat === 'attente' && !a.vu && Date.now() - a.debut > 1000) { a.vu = true; sun.saisirPin(a.pin); }
  }, 200).unref();
  let n = 0, cles = 0;
  const sps = Buffer.from('0000000167640028acd940780227e5c044000003000400000300f03c60c658', 'hex'), pps = Buffer.from('0000000168ebe3cb22c0', 'hex');
  setInterval(() => {
    if (!sun.clientVideo || !sun.taillePaquet) return;
    const demande = (sun.imagesClesDemandees || 0) !== cles;
    cles = sun.imagesClesDemandees || 0;
    const cle = n++ % 60 === 0 || demande;
    sun.envoyerImage(cle ? Buffer.concat([sps, pps, Buffer.from('0000000165', 'hex'), crypto.randomBytes(6000)]) : Buffer.concat([Buffer.from('0000000141', 'hex'), crypto.randomBytes(900)]), { cle });
  }, 33).unref();
}
console.log(`ProxLab ${gamme} : http://localhost:${port}`);
console.log(`JETON=${JETON_INSTALLATION}`);
console.log(`PVE=${pve.hote}:${pve.port} JETON_ID=${JETON.id} SECRET=${JETON.secret} UTILISATEUR=${UTILISATEUR.nom} MDP=${UTILISATEUR.motDePasse}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await s.arreter(); await pve.fermer(); await sun?.fermer(); fs.rmSync(dossier, { recursive: true, force: true }); process.exit(0); });
