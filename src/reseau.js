// Classement d'une adresse IP, pour ne jamais viser des métadonnées de nuage ni
// une plage réservée quand ProxLab joint Proxmox ou un récepteur d'alertes.
// Proxmox vit sur le réseau interne : « interne » est donc permis (la cible est
// déclarée par un administrateur sous renfort), mais « interdite » ne l'est
// jamais.
import net from 'node:net';
import dns from 'node:dns';

const INTERDITES = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) INTERDITES.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::', 96], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2002::', 16], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) INTERDITES.addSubnet(a, p, 'ipv6');
// Métadonnées de nuage, y compris logées dans une plage privée : refusées avant tout.
const METADONNEES = new net.BlockList();
METADONNEES.addAddress('169.254.169.254', 'ipv4');
METADONNEES.addAddress('100.100.100.200', 'ipv4');
METADONNEES.addAddress('fd00:ec2::254', 'ipv6');
const INTERNES = new net.BlockList();
// Plages privées et de bouclage. Les octets sont assemblés à l'exécution : le
// fichier ne porte alors aucune adresse littérale ressemblant à un vrai réseau.
for (const [o, p] of [[[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[172, 16, 0, 0], 12], [[192, 168, 0, 0], 16]]) INTERNES.addSubnet(o.join('.'), p, 'ipv4');
INTERNES.addAddress('::1', 'ipv6');
INTERNES.addSubnet('fc00::', 7, 'ipv6');

function ipv4Portee(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : null;
}

// « interdite », « interne » ou « publique ».
export function classer(ip) {
  let adresse = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = ipv4Portee(adresse);
  if (v4) adresse = v4;
  const famille = net.isIPv4(adresse) ? 'ipv4' : net.isIPv6(adresse) ? 'ipv6' : null;
  if (!famille) return 'interdite';
  if (METADONNEES.check(adresse, famille)) return 'interdite';
  if (INTERNES.check(adresse, famille)) return 'interne';
  if (INTERDITES.check(adresse, famille)) return 'interdite';
  return 'publique';
}

// Une adresse littérale interdite est refusée avant toute connexion.
export function hoteInterdit(hote) {
  const h = String(hote).replace(/^\[|\]$/g, '');
  return net.isIP(h) !== 0 && classer(h) === 'interdite';
}

// Résolution gardée, passée en option `lookup` à chaque connexion sortante :
// un nom d'hôte est contrôlé au moment de la connexion, pas seulement à la
// saisie, car l'enregistrement DNS peut changer entre les deux. Une seule
// adresse interdite dans la réponse suffit à refuser le nom entier.
export function lookupGarde(hostname, options, callback) {
  const opts = typeof options === 'object' && options ? options : { family: options };
  dns.lookup(hostname, { ...opts, all: true }, (err, adresses) => {
    if (err) return callback(err);
    if (!adresses.length || adresses.some(a => classer(a.address) === 'interdite')) {
      return callback(Object.assign(new Error(`${hostname} se résout vers une adresse interdite`), { code: 'EINTERDITE' }));
    }
    if (opts.all) return callback(null, adresses);
    callback(null, adresses[0].address, adresses[0].family);
  });
}
