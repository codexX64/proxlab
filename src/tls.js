// TLS vers Proxmox : jamais la vérification désactivée pour le trafic.
//
// Deux confiances possibles, choisies par l'administrateur à la liaison :
//   - « autorité » : le certificat de Proxmox est signé par une autorité que le
//     système reconnaît (ACME, autorité interne installée) ; vérification
//     ordinaire, nom compris ;
//   - « épinglé » : le certificat de pveproxy est signé par l'autorité propre à
//     la grappe (pve-root-ca), qu'aucun système ne connaît. L'empreinte SHA-256
//     de la feuille, lue par la sonde et confirmée par l'administrateur, devient
//     l'identité de Proxmox : chaque connexion la revérifie AVANT d'écrire quoi
//     que ce soit sur la socket, et la coupe sinon.
//
// La seule connexion sans vérification est la sonde, observer(), bornée par les
// trois garanties écrites au-dessus d'elle.
import tls from 'node:tls';
import https from 'node:https';
import net from 'node:net';
import { hoteInterdit, lookupGarde } from './reseau.js';

// Empreinte normalisée : 'sha256:aabb…' en minuscules, sans séparateurs. On
// retire d'abord une étiquette « sha256 » éventuelle : ses caractères hexa ne
// doivent pas se retrouver collés au condensat.
export function empreinte(certOuFp) {
  const brut = typeof certOuFp === 'string' ? certOuFp : (certOuFp?.fingerprint256 || '');
  const hex = String(brut).replace(/^\s*sha-?256\s*[:=]?\s*/i, '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return 'sha256:' + hex;
}
export const empreinteValide = fp => /^sha256:[0-9a-f]{64}$/.test(empreinte(fp));

// Sonde de confiance au premier usage : lire le certificat que présente
// Proxmox pour que l'administrateur en confirme l'empreinte. Sans autorité
// connue, d'où l'absence de vérification sur CETTE connexion, et trois
// garanties qui la bornent :
//   1. Elle n'est atteignable que par une route admin + renfort récent
//      (POST /api/liaison/sonde) : ni membre, ni lecture, ni Hub.
//   2. Elle n'envoie aucune donnée applicative : la poignée TLS se fait, rien
//      n'est écrit sur la socket, fermée dès la poignée finie.
//   3. Elle ne rend que l'empreinte, le sujet, l'émetteur et l'échéance, et
//      dit si une autorité du système reconnaît déjà ce certificat.
export function observer(hote, port, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (hoteInterdit(hote)) return reject(new Error('adresse interdite'));
    const s = tls.connect({
      host: hote, port, servername: net.isIP(hote) ? undefined : hote, lookup: lookupGarde, timeout,
      rejectUnauthorized: false, // sonde de confiance au premier usage : voir les trois garanties
    }, () => {
      const c = s.getPeerCertificate(false);
      const autorite = s.authorized && !tls.checkServerIdentity(hote, c);
      s.end();
      setTimeout(() => s.destroy(), 1000).unref();
      if (!c || !c.raw) return reject(new Error('aucun certificat présenté'));
      resolve({ fp: empreinte(c), sujet: nomDe(c.subject), emetteur: nomDe(c.issuer), expire: c.valid_to || '', autorite });
    });
    s.once('timeout', () => { s.destroy(); reject(new Error('délai dépassé')); });
    s.once('error', e => reject(e));
  });
}

// Une socket TLS vers Proxmox, rendue seulement une fois l'identité établie.
export function connecter({ hote, port, confiance, fp }, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (hoteInterdit(hote)) return reject(new Error('adresse interdite'));
    const epingle = confiance === 'epingle';
    if (epingle && !empreinteValide(fp)) return reject(new Error('aucune empreinte épinglée'));
    const s = tls.connect({
      host: hote, port, servername: net.isIP(hote) ? undefined : hote, lookup: lookupGarde, timeout,
      // Épinglé : l'autorité de la grappe est inconnue, l'empreinte la remplace,
      // contrôlée ci-dessous avant que la socket ne soit rendue à qui que ce soit.
      rejectUnauthorized: !epingle,
    }, () => {
      s.setTimeout(0);
      if (epingle && empreinte(s.getPeerCertificate(false)) !== empreinte(fp)) {
        s.destroy();
        return reject(Object.assign(new Error('empreinte du certificat de Proxmox différente de celle épinglée'), { code: 'EEMPREINTE' }));
      }
      resolve(s);
    });
    s.once('timeout', () => { s.destroy(); reject(new Error('délai dépassé')); });
    s.once('error', reject);
  });
}

// Agent HTTPS dont chaque socket passe par connecter() : la requête n'est
// écrite qu'une fois l'identité de Proxmox vérifiée.
export function agentProxmox(liaison) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  agent.createConnection = (_options, rappel) => {
    connecter(liaison).then(s => rappel(null, s), e => rappel(e));
  };
  return agent;
}

function nomDe(x) {
  if (!x || typeof x !== 'object') return '';
  return String(x.CN || x.O || Object.values(x).join(' ') || '').slice(0, 200);
}
