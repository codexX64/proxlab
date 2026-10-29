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
const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] });
// Le Chromium du parcours ne décode pas le H.264 (codec propriétaire) : un
// décodeur de remplacement reçoit les images de l'écran fluide et en peint une
// mire, pour éprouver tout le reste (relais, configuration, entrées).
await contexte.addInitScript(() => {
  window.__fluide = { configure: [], images: 0, cles: 0 };
  window.VideoDecoder = class {
    constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.decodeQueueSize = 0; }
    configure(c) { this.state = 'configured'; window.__fluide.configure.push({ codec: c.codec, description: c.description?.byteLength || 0 }); }
    decode(chunk) {
      window.__fluide.images++; if (chunk.type === 'key') window.__fluide.cles++;
      const t = new OffscreenCanvas(1920, 1080), g = t.getContext('2d'), n = window.__fluide.images;
      const d = g.createLinearGradient(0, 0, 1920, 1080); d.addColorStop(0, '#1d3557'); d.addColorStop(1, '#457b9d'); g.fillStyle = d; g.fillRect(0, 0, 1920, 1080);
      g.fillStyle = '#f1faee'; g.fillRect((n * 12) % 1800, 500, 120, 80);
      this.output(new VideoFrame(t, { timestamp: chunk.timestamp }));
    }
    close() { this.state = 'closed'; }
  };
});
const page = await contexte.newPage();
contexte.setDefaultTimeout(12000);
const erreurs = [];
// Seul refus attendu : le rapport de pve-b, que la vitrine refuse (Sys.Audit) pour montrer l'avis.
const ATTENDU = /\/api\/noeuds\/pve-b\/reseau\/mac$/;
page.on('console', m => { if (m.type() === 'error' && !ATTENDU.test(m.location()?.url || '')) erreurs.push(m.text()); });
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
await page.getByRole('tab', { name: 'Écran', exact: true }).click();
await page.getByText('ouvert · 1024 × 640').waitFor();
await page.locator('canvas.ecran').click({ position: { x: 40, y: 40 } });
await page.keyboard.type('ana');
await controle('ecran');
// Frappe au caractère : clavier QWERTY ici (Playwright), VM en AZERTY. « a »
// doit partir sur la touche Q de la VM, « Q » sur Maj+A, « 1 » sur Maj+1.
await page.getByRole('button', { name: 'Actions', exact: true }).click();
await page.getByRole('menuitem', { name: /^AZERTY/ }).click();
await page.evaluate(() => {
  window.__touches = [];
  const envoyer = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    const b = d instanceof ArrayBuffer ? new Uint8Array(d) : null;
    if (b && b[0] === 255 && b.length === 12 && b[3] === 1) window.__touches.push(new DataView(d).getUint32(8));
    return envoyer.call(this, d);
  };
});
await page.locator('canvas.ecran').click({ position: { x: 40, y: 40 } });
await page.keyboard.type('aQ1');
const touches = await page.evaluate(() => window.__touches.map(x => x.toString(16)).join(' '));
if (touches !== '10 2a 1e 2a 2') erreurs.push(`frappe au caractère : ${touches} au lieu de 10 2a 1e 2a 2`);
// Le clavier de la VM, dit en haut de l'écran : un clic passe à l'autre, et « a » suit.
const dispoVm = page.locator('button.dispo-vm');
if ((await dispoVm.innerText()).trim() !== 'AZERTY') erreurs.push(`clavier de la VM affiché : « ${(await dispoVm.innerText()).trim()} » au lieu de « AZERTY »`);
await dispoVm.click();
await page.locator('button.dispo-vm', { hasText: /^QWERTY$/ }).waitFor();
await page.evaluate(() => { window.__touches = []; });
await page.locator('canvas.ecran').click({ position: { x: 40, y: 40 } });
await page.keyboard.type('a');
const enQwerty = await page.evaluate(() => window.__touches.map(x => x.toString(16)).join(' '));
if (enQwerty !== '1e') erreurs.push(`« a » vers une VM QWERTY : ${enQwerty} au lieu de 1e`);
await dispoVm.click();
await page.locator('button.dispo-vm', { hasText: /^AZERTY$/ }).waitFor();
// Taper un texte : ProxLab le tape lui-même, la barre de l'écran suit la frappe.
await page.getByRole('button', { name: 'Actions', exact: true }).click();
await page.getByRole('menuitem', { name: 'Taper un texte…' }).click();
await page.locator('textarea.presse-envoi').fill('Bonjour depuis ProxLab, texte collé puis tapé par le serveur. '.repeat(12));
await page.getByRole('button', { name: 'Taper dans la VM' }).click();
await page.locator('.frappe-chip', { hasText: /Frappe \d+\/\d+/ }).waitFor();
await controle('ecran-frappe');
// Un collage de trop : Suppr dans l'écran arrête la frappe, et ne part pas dans la VM.
await page.evaluate(() => { window.__suppr = 0; const envoyer = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { const b = d instanceof ArrayBuffer ? new Uint8Array(d) : d instanceof Uint8Array ? d : null; if (b && b[0] === 255 && b.length === 12 && b[3] === 1 && new DataView(b.buffer, b.byteOffset).getUint32(4) === 0xffff) window.__suppr++; return envoyer.call(this, d); }; });
await page.locator('canvas.ecran').first().focus();
await page.keyboard.press('Delete');
await page.getByText('Frappe arrêtée.').waitFor();
await page.locator('.frappe-chip').first().waitFor({ state: 'hidden' });
if (await page.evaluate(() => window.__suppr)) erreurs.push('Suppr parti dans la VM pendant la frappe');
await page.getByRole('button', { name: 'Actions', exact: true }).click();
await page.getByRole('menuitem', { name: 'Masquer le presse-papiers' }).click();
// Écran dans une fenêtre à part : le menu Actions de la fiche la pilote.
// Les avis passés d'abord : posés en bas à droite, ils couvraient le menu.
await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 });
const [aPart] = await Promise.all([page.waitForEvent('popup'), (async () => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Ouvrir dans une fenêtre à part' }).click();
})()]);
await aPart.locator('canvas.ecran').waitFor();
await page.getByText('dans une fenêtre à part', { exact: true }).waitFor();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Actions', exact: true }).click();
if (await page.getByRole('menuitem', { name: 'Échap' }).isDisabled()) throw new Error('Actions de la fiche grisées avec la fenêtre à part');
await page.getByRole('menuitem', { name: 'Échap' }).click();
await aPart.close();
await page.locator('span.note', { hasText: /^ouvert · / }).first().waitFor();
// Écran fluide : réglé et appairé depuis l'interface, contre le faux Sunshine
// de la vitrine (127.0.0.2), puis ouvert ; les touches partent en codes VK
// selon le clavier de la VM (AZERTY : « a » sur la touche Q).
// Reliée depuis ProxLab : « Relier » ouvre le shell du nœud (joué par la
// vitrine), les lignes du script s'affichent, puis l'écran s'ouvre. Avant, la
// commande à coller (repliée) est copiée et vérifiée ; le réglage à la main
// reste replié.
await page.getByRole('tab', { name: 'Écran fluide' }).click();
await page.getByRole('button', { name: 'Relier', exact: true }).waitFor();
if (await page.getByLabel('Adresse de Sunshine dans la VM').isVisible()) erreurs.push('écran fluide : réglage à la main déplié d\'office');
await controle('fluide-reglage');
await page.getByText('Réglage à la main : adresse et PIN').click();
await page.getByLabel('Adresse de Sunshine dans la VM').waitFor();
await controle('fluide-manuel');
await page.getByText('Réglage à la main : adresse et PIN').click();
await page.getByText('Ou par une commande à coller').click();
const terminalNoeud = page.getByLabel('Commande qui ouvre un terminal root sur le nœud');
await terminalNoeud.waitFor();
if (await terminalNoeud.inputValue() !== 'ssh root@10.0.0.11') erreurs.push(`écran fluide : terminal proposé ${await terminalNoeud.inputValue()}`);
await terminalNoeud.fill('ssh -J rebond root@10.0.0.11');
await page.getByRole('button', { name: 'Copier la commande' }).click();
await page.getByText(/En attente de la commande/).waitFor();
const zoneCommande = page.getByLabel('Commande à copier');
const commandeCopiee = await zoneCommande.isVisible() ? await zoneCommande.inputValue() : await page.evaluate(() => navigator.clipboard.readText());
if (!/^curl -fsS 'http:\/\/localhost:\d+\/api\/fluide\/script\/[A-Za-z0-9_-]{43}' \| ssh -J rebond root@10\.0\.0\.11 bash\n$/.test(commandeCopiee)) erreurs.push(`écran fluide : commande copiée inattendue (${commandeCopiee.slice(0, 120)})`);
await page.waitForTimeout(2600);
if (await terminalNoeud.inputValue() !== 'ssh -J rebond root@10.0.0.11') erreurs.push('écran fluide : terminal remis à zéro pendant l\'attente');
await controle('fluide-commande');
await page.getByRole('button', { name: 'Relier', exact: true }).click();
await page.getByText(/ProxLab relie la VM/).waitFor();
if (!await page.getByRole('button', { name: 'Relier', exact: true }).isDisabled()) erreurs.push('écran fluide : « Relier » encore cliquable pendant qu\'il relie');
await controle('fluide-relier');
await page.locator('span.note', { hasText: /ouvert · \d+ × 1080 · 60 i\/s · chiffré/ }).waitFor({ timeout: 20000 });
{
  // Le flux aux proportions de l'écran : 1080 de haut, la largeur suit.
  const { l, attendu } = await page.evaluate(() => ({ l: Number(/ouvert · (\d+) × 1080/.exec([...document.querySelectorAll('span.note')].map(n => n.textContent).join(' '))?.[1]), attendu: Math.round(1080 * screen.width / screen.height / 2) * 2 }));
  if (l !== attendu) erreurs.push(`écran fluide : flux de ${l} de large, ${attendu} attendu (proportions de l'écran)`);
}
await page.waitForFunction(() => window.__fluide.images > 10 && window.__fluide.cles >= 1);
const conf = await page.evaluate(() => window.__fluide.configure[0]);
if (!/^avc1\.640028$/.test(conf.codec) || !conf.description) erreurs.push(`écran fluide : décodeur configuré ${JSON.stringify(conf)}`);
await page.locator('span.note', { hasText: /i\/s reçues · .*réseau \d+ ms/ }).waitFor({ timeout: 8000 }).catch(() => erreurs.push('écran fluide : mesures absentes de la barre'));
await controle('ecran-fluide');
if (await page.evaluate(() => getComputedStyle(document.querySelector('canvas.fluide')).cursor) !== 'none') erreurs.push('écran fluide : curseur du poste encore affiché sur l\'image');
await page.evaluate(() => {
  window.__fluideEnvois = [];
  const envoyer = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { if (d instanceof Uint8Array && d[0] === 0x10 && d[1] === 1) window.__fluideEnvois.push(d[2] | d[3] << 8); return envoyer.call(this, d); };
});
await page.locator('canvas.fluide').click({ position: { x: 60, y: 60 } });
await page.keyboard.type('aQ1');
await page.waitForTimeout(200);
const vks = await page.evaluate(() => window.__fluideEnvois.map(x => x.toString(16)).join(' '));
if (vks !== '51 a0 41 a0 31') erreurs.push(`écran fluide, touches : ${vks} au lieu de 51 a0 41 a0 31`);
await page.getByLabel('Qualité de l\'écran fluide').selectOption('legere');
await page.getByLabel('Qualité de l\'écran fluide').selectOption('legere');
await page.locator('span.note', { hasText: /ouvert · \d+ × 720 · 30 i\/s/ }).waitFor({ timeout: 20000 });
await page.locator('.card', { hasText: 'Écran fluide' }).getByRole('button', { name: 'Fermer', exact: true }).click();
await page.locator('.card', { hasText: 'Écran fluide' }).getByRole('button', { name: 'Rouvrir', exact: true }).waitFor();
await page.getByLabel('Qualité de l\'écran fluide').selectOption('haute');
await page.getByRole('tab', { name: 'Écran', exact: true }).click();
await page.locator('span.note', { hasText: /^ouvert · / }).first().waitFor();
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
// Adresses MAC lues après coup ; un nœud sans Sys.Audit le dit sous sa table.
await page.locator('td', { hasText: '00:00:5e:00:53:01' }).first().waitFor();
await page.locator('td', { hasText: 'enp3s0f0' }).waitFor();
await page.locator('.card .hint', { hasText: /Adresses MAC illisibles.*PVEAuditor/ }).waitFor();
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
