// Configuration de ProxLab, lue et validée une fois au démarrage. Les variables
// SOCLE_* (comptes, relais, clé maîtresse) sont lues par le socle. La liaison
// à Proxmox, elle, se règle dans l'interface (administrateur, renfort récent)
// et se garde scellée en base : elle n'a rien à faire dans l'environnement.
import fs from 'node:fs';
import { lireConfig } from '../socle/src/index.js';

export const VERSION = '2.2.0';

export function lireConfigProxlab(env = process.env) {
  // SOCLE_CLE_FILE posée dit « la clé vient d'un secret » : un fichier vide ne
  // doit pas laisser le socle la tirer dans le volume, à côté de ce qu'elle scelle.
  if (env.SOCLE_CLE_FILE && fs.existsSync(env.SOCLE_CLE_FILE) && !fs.readFileSync(env.SOCLE_CLE_FILE, 'utf8').trim()) {
    throw Object.assign(new Error(`Configuration invalide :\n  - SOCLE_CLE_FILE (${env.SOCLE_CLE_FILE}) est vide : pose la clé maîtresse dans ce secret.`), { erreurs: ['SOCLE_CLE_FILE vide'] });
  }
  return lireConfig({
    port: { env: 'PORT', type: 'entier', min: 0, max: 65535, defaut: 8140 },
    hote: { env: 'HOTE', type: 'chaine', defaut: '0.0.0.0' },
    donnees: { env: 'DATA_DIR', type: 'chaine', defaut: '/app/data' },
    // Jeton de service du Hub : lit l'état de la grappe et les événements,
    // démarre, arrête proprement et redémarre une machine. Jamais un réglage,
    // jamais un compte, jamais une console.
    jetonHub: { env: 'PROXLAB_HUB_TOKEN', type: 'secret', min: 24 },
    // Cadence de la surveillance (machines tombées, nœuds perdus, seuils).
    intervalle: { env: 'PROXLAB_INTERVAL', type: 'entier', min: 15, max: 3600, defaut: 60 },
    // Durée de conservation des événements, en jours.
    retention: { env: 'PROXLAB_EVENTS_DAYS', type: 'entier', min: 1, max: 365, defaut: 30 },
  }, env);
}
