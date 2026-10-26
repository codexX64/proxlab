// L'identité de ProxLab auprès de Sunshine : un certificat X.509 autosigné
// (RSA 2048, SHA-256), comme celui d'un client Moonlight. Node sait signer et
// lire un certificat, pas en fabriquer un : le DER est écrit ici, au plus
// court (version 3, sans extension), et relu par crypto.X509Certificate.
import crypto from 'node:crypto';

const longueur = n => {
  if (n < 0x80) return Buffer.from([n]);
  const octets = [];
  for (let v = n; v > 0; v >>= 8) octets.unshift(v & 0xff);
  return Buffer.from([0x80 | octets.length, ...octets]);
};
const tlv = (etiquette, contenu) => Buffer.concat([Buffer.from([etiquette]), longueur(contenu.length), contenu]);
const suite = (...elements) => tlv(0x30, Buffer.concat(elements));
const ensemble = (...elements) => tlv(0x31, Buffer.concat(elements));
const entier = octets => tlv(0x02, octets[0] & 0x80 ? Buffer.concat([Buffer.from([0]), octets]) : octets);
const oid = texte => {
  const [a, b, ...reste] = texte.split('.').map(Number);
  const octets = [40 * a + b];
  for (const n of reste) {
    const groupe = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groupe.unshift(0x80 | (v & 0x7f));
    octets.push(...groupe);
  }
  return tlv(0x06, Buffer.from(octets));
};
const nul = Buffer.from([0x05, 0x00]);
const utf8 = texte => tlv(0x0c, Buffer.from(texte, 'utf8'));
const heure = date => {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
};
const nom = cn => suite(ensemble(suite(oid('2.5.4.3'), utf8(cn))));
const SHA256_RSA = suite(oid('1.2.840.113549.1.1.11'), nul);

// Un certificat neuf et sa clé, en PEM. Valable vingt ans : Sunshine retient
// le certificat appairé, l'échéance n'y joue pas.
export function nouvelleIdentite({ cn = 'NVIDIA GameStream Client', maintenant = new Date() } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  // Numéro de série positif et en DER minimal : premier octet entre 0x40 et 0x7f.
  const serie = crypto.randomBytes(8); serie[0] = 0x40 | (serie[0] & 0x3f);
  const fin = new Date(maintenant.getTime() + 20 * 365.25 * 864e5);
  const tbs = suite(
    tlv(0xa0, entier(Buffer.from([2]))),
    entier(serie),
    SHA256_RSA,
    nom(cn),
    suite(heure(maintenant), heure(fin)),
    nom(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = suite(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  new crypto.X509Certificate(certPem);   // relu : un DER mal formé s'arrête ici
  return { certPem, clePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// Lecture DER minimale : l'élément à « pos » → [étiquette, début du contenu, fin].
function element(der, pos) {
  if (pos + 2 > der.length) throw new Error('DER tronqué');
  const etiquette = der[pos];
  let n = der[pos + 1], debut = pos + 2;
  if (n & 0x80) {
    const k = n & 0x7f;
    if (k < 1 || k > 4 || debut + k > der.length) throw new Error('DER : longueur invalide');
    n = 0;
    for (let i = 0; i < k; i++) n = n * 256 + der[debut + i];
    debut += k;
  }
  if (debut + n > der.length) throw new Error('DER tronqué');
  return [etiquette, debut, debut + n];
}

// La signature d'un certificat (son BIT STRING final), qu'entre dans les défis
// de l'appairage GameStream.
export function signatureDe(certPem) {
  const der = new crypto.X509Certificate(certPem).raw;
  const [t0, d0] = element(der, 0);
  if (t0 !== 0x30) throw new Error('certificat : pas une SEQUENCE');
  const [, , f1] = element(der, d0);          // tbsCertificate
  const [, , f2] = element(der, f1);          // signatureAlgorithm
  const [t3, d3, f3] = element(der, f2);      // signatureValue
  if (t3 !== 0x03 || der[d3] !== 0) throw new Error('certificat : signature illisible');
  return der.subarray(d3 + 1, f3);
}

export const empreinteCert = certPem => 'sha256:' + crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).raw).digest('hex');
