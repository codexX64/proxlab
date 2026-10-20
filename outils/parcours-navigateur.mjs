// Parcours réel de ProxLab dans Chromium (clé d'accès virtuelle) contre la
// vitrine (faux Proxmox), et contrôle de mise en page à chaque largeur.
// Usage :
//   node outils/vitrine.mjs 8191 &            (affiche JETON= et PVE=)
//   node outils/parcours-navigateur.mjs http://localhost:8191 JETON HOTE:PORT [DOSSIER]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { chevauchements, LARGEURS } from '../socle/essai/mise-en-page.mjs';
import { JETON, UTILISATEUR } from '../test/faux-pve.js';

const [base, jeton, grappe, sortie = '/tmp/captures-proxlab'] = process.argv.slice(2);
const [hotePve, portPve] = grappe.split(':');
fs.mkdirSync(sortie, { recursive: true });
const MDP = 'phrase de passe pour proxlab en local';
const navigateur = await chromium.launch();
const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 860 } });
const page = await contexte.newPage();
contexte.setDefaultTimeout(12000);
const erreurs = [];
page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
page.on('pageerror', e => erreurs.push(String(e)));
const cdp = await contexte.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

const rapport = [];
async function controle(nom) {
  for (const w of LARGEURS) {
    await page.setViewportSize({ width: w, height: w < 500 ? 780 : 900 });
    await page.waitForTimeout(260);
    const defauts = await page.evaluate(chevauchements);
    const brut = await page.evaluate(() => (document.body.innerText.match(/\b(null|undefined|NaN|Infinity)\b/) || [])[0]);
    if (brut) defauts.push({ type: 'texte-brut', detail: `« ${brut} » affiché` });
    rapport.push({ ecran: nom, largeur: w, defauts });
    if ([360, 768, 1280].includes(w)) await page.screenshot({ path: `${sortie}/${nom}-${w}.png`, fullPage: w !== 1280 });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
}
const rail = nom => page.locator('.rail').getByRole('button', { name: nom, exact: true }).click();
const titre = t => page.getByRole('heading', { name: t, exact: true }).first().waitFor();

await page.goto(base);
await page.getByLabel('Jeton d’installation').fill(jeton);
await page.getByLabel('Identifiant').fill('ana');
await page.getByLabel('Mot de passe').fill(MDP);
await page.getByRole('button', { name: 'Créer le compte' }).click();
await page.getByRole('button', { name: /Créer la clé maintenant/ }).click();
await page.getByText('J’ai rangé ces codes en lieu sûr.').click();
await page.getByRole('button', { name: 'Terminer' }).click();
await page.locator('.app').waitFor();
await titre('Vue d\'ensemble');
await page.getByText('Proxmox n\'est pas encore relié').waitFor();
await controle('vue-non-reliee');

// Liaison par l'interface : lecture du certificat, empreinte épinglée, essai.
await page.getByRole('button', { name: 'Relier Proxmox' }).click();
await titre('Réglages');
await page.getByLabel('Adresse', { exact: true }).fill(hotePve);
await page.getByLabel('Port', { exact: true }).fill(portPve);
await page.getByRole('button', { name: 'Lire le certificat' }).click();
await page.getByText('n\'est pas reconnu par le système').waitFor();
await page.getByLabel('Jeton d\'API').fill(JETON.id);
await page.getByLabel('Secret du jeton').fill(JETON.secret);
await page.getByLabel('Utilisateur', { exact: true }).fill(UTILISATEUR.nom);
await page.getByLabel('Mot de passe', { exact: true }).fill(UTILISATEUR.motDePasse);
await page.getByRole('button', { name: 'Essayer et enregistrer' }).click();
await page.getByText(/Relié à Proxmox VE 8\.4\.1/).waitFor();
await controle('reglages');

await rail('Vue d\'ensemble');
await titre('Vue d\'ensemble');
await page.getByRole('heading', { name: 'Trafic réseau' }).waitFor();
await page.locator('.g-courbe svg').first().waitFor();
await page.locator('.g-calendrier svg').nth(1).waitFor();
await page.waitForTimeout(16000); // une passe de surveillance : « À traiter » se remplit
await page.getByRole('button', { name: 'Relire' }).click();
await page.waitForTimeout(800);
await controle('vue');
await page.setViewportSize({ width: 1280, height: 2300 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${sortie}/vue-longue-1280.png` });
await page.setViewportSize({ width: 1280, height: 860 });
await page.getByRole('button', { name: '7 j', exact: true }).click();
await page.waitForTimeout(400);

await rail('Machines');
await titre('Machines');
await controle('machines');
await page.locator('tbody tr', { hasText: 'passerelle' }).first().click();
await titre('passerelle');
await page.locator('.g-courbe svg').first().waitFor();
await controle('fiche');
for (const [onglet, nom] of [['Instantanés', 'fiche-instantanes'], ['Sauvegardes', 'fiche-sauvegardes'], ['Configuration', 'fiche-configuration']]) {
  await page.getByRole('tab', { name: onglet }).click();
  await page.waitForTimeout(350);
  await controle(nom);
}
await page.getByRole('tab', { name: 'Instantanés' }).click();
await page.getByRole('button', { name: 'Prendre' }).click();
await page.getByRole('dialog').waitFor();
await controle('instantane-dialogue');
await page.getByRole('dialog').getByRole('button', { name: 'Annuler' }).click();
// L'écran d'une VM en marche s'ouvre lui aussi avec l'onglet.
await page.getByRole('tab', { name: 'Écran' }).click();
await page.getByText('ouvert · 1024 × 640').waitFor();
await page.locator('canvas.ecran').click({ position: { x: 40, y: 40 } });
await page.keyboard.type('ana');
await controle('ecran');
// La console d'une VM en marche s'ouvre d'elle-même avec l'onglet.
await page.getByRole('tab', { name: 'Console' }).click();
await page.locator('.terminal', { hasText: 'invite-101:~#' }).waitFor();
await page.keyboard.type('hostname');
await page.keyboard.press('Enter');
await page.locator('.terminal .t-f2', { hasText: 'invite-101' }).waitFor();
await controle('console');

await rail('Réseau');
await titre('Réseau');
await page.locator('.card', { hasText: 'vmbr0' }).first().waitFor();
await controle('reseau');

await rail('Nœuds');
await titre('Nœuds');
await page.locator('.card', { hasText: 'Mémoire installée' }).first().waitFor();
await controle('noeuds');
await page.getByRole('button', { name: 'Shell' }).first().click();
await page.getByRole('button', { name: 'Ouvrir', exact: true }).click();
await page.locator('.terminal', { hasText: 'root@pve-a:~#' }).waitFor();
await controle('noeuds-shell');

await rail('Stockage');
await titre('Stockage');
await controle('stockage');
await page.locator('tbody tr', { hasText: 'sauvegardes' }).first().click();
await page.getByRole('dialog').waitFor();
await page.waitForTimeout(300);
await controle('stockage-contenu');
await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();

await rail('Images ISO');
await titre('Images ISO');
await controle('isos');
await page.getByRole('button', { name: 'Importer' }).click();
await page.getByRole('dialog').waitFor();
await controle('iso-telecharger');
await page.getByRole('dialog').getByRole('button', { name: 'Annuler' }).click();
await page.getByRole('button', { name: 'Envoyer' }).click();
await page.getByRole('dialog').waitFor();
await controle('iso-envoyer');
await page.getByRole('dialog').getByRole('button', { name: 'Annuler' }).click();

// Créer une VM : le dialogue, sans aller jusqu'au bout.
await rail('Machines');
await page.getByRole('button', { name: 'Nouvelle VM' }).click();
await page.getByRole('dialog').waitFor();
await page.waitForTimeout(400);
await controle('machine-creer');
await page.getByRole('dialog').getByRole('button', { name: 'Annuler' }).click();

// Supprimer une machine arrêtée : le dialogue, sans aller jusqu'au bout.
await rail('Machines');
await page.locator('tbody tr', { hasText: 'bureau-essai' }).first().click();
await titre('bureau-essai');
await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
await page.getByRole('dialog').waitFor();
await controle('machine-supprimer');
await page.getByRole('dialog').getByRole('button', { name: 'Annuler' }).click();

await rail('Tâches');
await titre('Tâches');
await controle('taches');
await page.locator('tbody tr').first().click();
await page.getByRole('dialog').getByText(/Terminée|En cours/).waitFor();
await controle('tache-journal');
await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();

for (const [bouton, nom] of [['Événements', 'evenements'], ['Sécurité', 'securite'], ['Comptes', 'comptes']]) {
  await rail(bouton);
  await titre(bouton);
  await page.waitForTimeout(300);
  await controle(nom);
}

const defauts = rapport.filter(r => r.defauts.length);
fs.writeFileSync(`${sortie}/rapport.json`, JSON.stringify({ rapport, erreurs }, null, 2));
console.log(`écrans×largeurs contrôlés : ${rapport.length}, avec défauts : ${defauts.length}, erreurs console : ${erreurs.length}`);
for (const r of defauts) for (const d of r.defauts.slice(0, 6)) console.log(`  ${r.ecran} @${r.largeur} — ${d.type} : ${d.detail}`);
for (const e of erreurs) console.log('  console :', e);
await navigateur.close();
process.exit(defauts.length || erreurs.length ? 1 : 0);
