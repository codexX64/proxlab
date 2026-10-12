// Un service ouvert par son adresse IP, même en HTTPS : pas de clé d'accès
// (le navigateur n'en crée ni n'en présente sur une IP), le TOTP prend le relais.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { monterBanc } from './banc.js';
import { adminComplet } from '../essai/inscription.js';
import { connexion } from '../essai/client.js';
import * as totp from '../src/totp.js';

// Le banc écoute en clair : un relais déclaré (127.0.0.1) dit que la connexion était chiffrée.
const s = await monterBanc({ env: { SOCLE_PROXYS: '127.0.0.1/32' } });
after(() => s.fermer());
const MDP = 'phrase de passe pour les essais du service';
// Un client qui joint le service par cet hôte, en HTTPS derrière le relais.
const par = (hote, c = s.client()) => {
  const req = c.req.bind(c);
  c.req = (m, ch, b, o = {}) => req(m, ch, b, { ...o, entetes: { host: hote, 'x-forwarded-proto': 'https', ...(o.entetes || {}) }, origine: `https://${hote}` });
  return c;
};

test('ouvert par son IP en HTTPS : aucune clé proposée ni exigée au renfort, le TOTP suffit ; par son nom, la clé revient', async () => {
  const { secret } = await adminComplet(s.client(), { jeton: s.jeton, maintenant: () => s.horloge.t });
  const ip = par('192.0.2.10:8100');
  const etat = await ip.get('/api/compte/etat');
  assert.equal(etat.json.securise, true);
  assert.equal(etat.json.cles, false, 'la porte ne propose pas de clé sur une IP');

  let r = await connexion(ip, 'ana', MDP);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  s.horloge.t += 31_000;
  r = await ip.post('/api/compte/connexion/totp', { code: totp.code(secret, totp.pasCourant(s.horloge.t)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  s.horloge.t += 6 * 60e3;
  r = await ip.get('/api/dangereux');
  assert.equal(r.status, 403);
  assert.deepEqual(r.json.details.methodes, ['totp'], 'sur une IP, le renfort se fait au TOTP');
  r = await ip.post('/api/compte/renfort', { methode: 'totp', code: totp.code(secret, totp.pasCourant(s.horloge.t)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await ip.post('/api/compte/cles/options');
  assert.equal(r.status, 400, 'aucune clé ne s’inscrit sur une IP');
  assert.match(r.json.error, /pas par une adresse IP/);
  assert.equal((await ip.get('/api/compte/securite')).json.clesPossibles, false, 'la page Sécurité ne propose pas d’en ajouter');

  // La même session ouverte par le nom de sa clé : la clé d'accès est de nouveau la règle.
  s.db.prepare("UPDATE socle_cles SET rp = 'service.exemple.fr'").run();
  const nom = par('service.exemple.fr', Object.assign(s.client(), { cookies: ip.cookies, csrf: ip.csrf }));
  s.horloge.t += 6 * 60e3;
  r = await nom.get('/api/dangereux');
  assert.deepEqual(r.json.details.methodes, ['cle'], 'par un nom, la clé reste exigée');
});
