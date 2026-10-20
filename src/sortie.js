// Téléchargements sortants de ProxLab : une image ISO prise à une adresse
// (manuel, SEC-CSRF-004 et SEC-FILE-008).
//
//   - https seulement, sans identifiants dans l'adresse ;
//   - le nom est résolu, chaque adresse classée, puis la connexion part vers
//     l'adresse jugée, jamais vers une seconde résolution (pas de rebond DNS
//     entre le contrôle et la connexion) ;
//   - adresse privée, boucle locale, lien local, métadonnées de nuage,
//     multicast et plages réservées : toujours refusées — une image du réseau
//     local s'envoie depuis l'ordinateur ;
//   - redirections revérifiées à chaque saut, quatre au plus ; délai borné.
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const REFUSEES = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) REFUSEES.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 96], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) REFUSEES.addSubnet(a, p, 'ipv6');
REFUSEES.addAddress('::1', 'ipv6');

export class DestinationRefusee extends Error {
  constructor(message) { super(message); this.name = 'DestinationRefusee'; this.status = 400; }
}

// Une IPv4 glissée dans une IPv6 (::ffff:a.b.c.d, ou sa forme hexadécimale
// que produit l'analyseur d'URL) est jugée comme l'IPv4 qu'elle porte.
function ipv4Portee(ip) {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return null;
  if (m[1]) return m[1];
  const n = (parseInt(m[2], 16) << 16 >>> 0) + parseInt(m[3], 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Vrai pour une adresse publique joignable ; faux pour tout le reste. */
export function publique(ip) {
  let a = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  a = ipv4Portee(a) || a;
  if (net.isIPv4(a)) return !REFUSEES.check(a, 'ipv4');
  if (net.isIPv6(a)) return !REFUSEES.check(a, 'ipv6') && /^[23][0-9a-f]{0,3}:/.test(a);
  return false;
}

export function lireUrl(brut) {
  let url;
  try { url = new URL(String(brut)); } catch { throw new DestinationRefusee('Adresse invalide.'); }
  if (url.protocol !== 'https:') throw new DestinationRefusee('Adresse en https seulement.');
  if (url.username || url.password) throw new DestinationRefusee('Pas d’identifiants dans l’adresse.');
  return url;
}

// Les essais remplacent la résolution et la connexion (aucun réseau).
let resolveur = (nom, cb) => dns.lookup(nom, { all: true }, cb);
let transport = null;
export function configurer({ resolveur: r, transport: t } = {}) {
  if (r !== undefined) resolveur = r || ((nom, cb) => dns.lookup(nom, { all: true }, cb));
  if (t !== undefined) transport = t;
}

// L'adresse à laquelle se connecter : la première publique, ou un refus qui dit pourquoi.
async function resoudre(url) {
  const hote = url.hostname.replace(/^\[|\]$/g, '');
  const adresses = net.isIP(hote) ? [{ address: hote, family: net.isIPv4(hote) ? 4 : 6 }]
    : await new Promise((ok, ko) => resolveur(hote, (e, l) => (e ? ko(new DestinationRefusee(`${hote} : résolution impossible (${e.code || e.message}).`)) : ok(l))));
  const bonne = adresses.find(a => publique(a.address));
  if (!bonne) throw new DestinationRefusee(`${hote} mène à une adresse privée ou réservée (${adresses[0]?.address || 'aucune'}) : refusé. Une image du réseau local s’envoie depuis l’ordinateur.`);
  return bonne;
}

function connecter(url, adresse, { signal, delai }) {
  return new Promise((ok, ko) => {
    const lookup = (_nom, options, cb) => (options?.all ? cb(null, [adresse]) : cb(null, adresse.address, adresse.family));
    const req = https.request(url, { method: 'GET', headers: { 'user-agent': 'ProxLab', accept: '*/*' }, lookup, agent: false, signal }, res => ok({ statut: res.statusCode, entetes: res.headers, flux: res }));
    req.setTimeout(delai, () => req.destroy(new Error('le serveur ne répond plus (délai dépassé)')));
    req.on('error', ko);
    req.end();
  });
}

/**
 * GET vers une adresse publique, redirections suivies et revérifiées. Rend
 * { statut, entetes, flux, url } ; le flux reste à lire (ou à détruire).
 */
export async function telecharger(adresse, { signal, delai = 30000 } = {}) {
  let url = lireUrl(adresse);
  for (let saut = 0; ; saut++) {
    const r = await (transport || connecter)(url, await resoudre(url), { signal, delai });
    if (![301, 302, 303, 307, 308].includes(r.statut) || !r.entetes.location) return { ...r, url: url.href };
    r.flux.destroy();
    if (saut >= 4) throw new DestinationRefusee('Trop de redirections.');
    url = lireUrl(new URL(r.entetes.location, url).href);
  }
}
