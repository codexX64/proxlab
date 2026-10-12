// Administration de ProxLab en ligne de commande, dans le conteneur :
//   docker exec <proxlab> node src/cli.js <commande>
//
// Chaque geste laisse sa trace au journal de sécurité, chaîné comme celui du
// service, qui tourne pendant ce temps : la base est en WAL, les deux écrivent
// sans se bloquer.
//
// La sauvegarde est chiffrée pour une clé publique dont la clé privée ne vit
// pas sur la machine de ProxLab : qui prend la machine ne relit pas les
// sauvegardes. Elle garde les secrets scellés sous SOCLE_CLE : sans une copie
// de cette clé, une base restaurée ne rouvre ni les secrets TOTP ni ceux de la
// liaison à Proxmox.
import fs from 'node:fs';
import { lireConfigProxlab, VERSION } from './config.js';
import { ouvrirBase } from './base.js';
import { Journal, sauvegarder, dechiffrer } from '../socle/src/index.js';

const [, , cmd, ...rest] = process.argv;

function die(m) { console.error('erreur : ' + m); process.exit(1); }

// Sur la machine qui garde la clé privée : aucune base, aucune configuration.
function restaurer(prive, cible) {
  if (!prive || !cible) die('usage : restaurer <clé-privée.pem> <cible.db> < proxlab.sauv');
  if (fs.existsSync(cible)) die(`${cible} existe déjà : la restauration écrit un fichier neuf`);
  let lu;
  try { lu = dechiffrer(fs.readFileSync(0), fs.readFileSync(prive, 'utf8')); } catch (e) { die(`sauvegarde illisible avec cette clé (${e.message})`); }
  if (lu.entete.service !== 'proxlab') die(`sauvegarde de ${lu.entete.service}, pas de ProxLab`);
  fs.writeFileSync(cible, lu.base, { mode: 0o600, flag: 'wx' });
  process.stderr.write(`Base de ProxLab ${lu.entete.version} du ${lu.entete.date} restaurée dans ${cible}.\n`);
}
if (cmd === 'restaurer') { restaurer(rest[0], rest[1]); process.exit(0); }

function usage() {
  console.log(`ProxLab — administration

  liaison retirer               oublie l'adresse, le jeton et le mot de passe de Proxmox
                                (runbook d'incident ; révoquer aussi le jeton dans Proxmox)
  alertes retirer               oublie le récepteur d'alertes, sa clé et son secret
  sauvegarde < clé-publique.pem > proxlab.sauv
  restaurer <clé-privée.pem> <cible.db> < proxlab.sauv     (sur une autre machine)

Les comptes humains se gèrent dans l'interface.`);
}

const db = ouvrirBase(lireConfigProxlab().donnees);
const journal = new Journal(db);
const trace = (action, objet, details) => journal.ecrire({ action, objet, details: { par: 'ligne de commande', ...details } });

// Le réglage disparaît de la base ; le service en marche le relit à chaque usage.
function retirer(cle, action, message) {
  const r = db.prepare('DELETE FROM reglages WHERE cle = ?').run(cle);
  trace(action, null, { retire: r.changes > 0 });
  console.log(r.changes ? message : 'rien à retirer');
}

async function sauvegarde() {
  if (process.stdout.isTTY) die('redirige la sortie : node src/cli.js sauvegarde < sauvegarde.pub > proxlab.sauv');
  let sortie;
  try { sortie = await sauvegarder(db, fs.readFileSync(0, 'utf8'), { service: 'proxlab', version: VERSION }); } catch (e) { die(e.message); }
  trace('sauvegarde.faite', null, { octets: sortie.length });
  process.stdout.write(sortie);
}

switch (cmd) {
  case 'liaison':
    if (rest[0] === 'retirer') retirer('liaison', 'liaison.retiree', 'liaison à Proxmox retirée : révoque aussi le jeton d\'API dans Proxmox (Datacenter › Permissions › API Tokens)');
    else usage();
    break;
  case 'alertes':
    if (rest[0] === 'retirer') retirer('alertes', 'alertes.retirees', 'récepteur d\'alertes retiré');
    else usage();
    break;
  case 'sauvegarde': await sauvegarde(); break;
  default: usage();
}
db.close();
