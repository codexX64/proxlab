// Adresses MAC des interfaces d'un nœud. L'API réseau de Proxmox ne les donne
// pas ; son rapport de nœud (GET /nodes/{node}/report, Sys.Audit, compris dans
// PVEAuditor) porte la sortie de `ip -details -statistics address`. Seule cette
// section est lue, seules l'adresse MAC et les autres noms de chaque interface
// en sortent ; le reste du rapport n'est ni gardé ni journalisé.
const COMMANDE = 'ip -details -statistics address';
const TETE = /^\d+:\s+([^\s:@]+)(?:@[^\s:]+)?:\s+</;
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const INTERFACE = /^[A-Za-z][A-Za-z0-9._-]{0,19}$/;
const NOM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NOMS_MAX = 8;

// Texte du rapport → { iface: { mac, autresNoms } }. Une carte asservie à un
// agrégat porte l'adresse de l'agrégat ; son adresse d'usine (permaddr) prime.
export function adressesMac(rapport) {
  const lignes = String(rapport || '').split('\n');
  const debut = lignes.findIndex(l => l.trim() === `# ${COMMANDE}`);
  const res = {};
  if (debut < 0) return res;
  let courante = null;
  for (const ligne of lignes.slice(debut + 1)) {
    if (/^(#|====)/.test(ligne)) break;
    const tete = TETE.exec(ligne);
    if (tete) { courante = INTERFACE.test(tete[1]) ? (res[tete[1]] = { mac: '', usine: '', autresNoms: [] }) : null; continue; }
    if (!courante) continue;
    const ether = /^\s+link\/ether\s+(\S+)/.exec(ligne);
    if (ether && MAC.test(ether[1].toLowerCase())) courante.mac = ether[1].toLowerCase();
    const usine = /\spermaddr\s+(\S+)/.exec(ligne);
    if (usine && MAC.test(usine[1].toLowerCase())) courante.usine = usine[1].toLowerCase();
    const autre = /^\s+altname\s+(\S+)\s*$/.exec(ligne);
    if (autre && NOM.test(autre[1]) && courante.autresNoms.length < NOMS_MAX) courante.autresNoms.push(autre[1]);
  }
  const sortie = {};
  for (const [iface, x] of Object.entries(res)) {
    const mac = x.usine || x.mac;
    if (mac || x.autresNoms.length) sortie[iface] = { mac, autresNoms: x.autresNoms };
  }
  return sortie;
}

// Le rapport fait tourner une vingtaine de commandes sur le nœud : il est
// demandé au plus une fois par nœud et par période, et une seule demande à la
// fois. Un échec est retenu moins longtemps qu'une réussite.
export class Materiel {
  constructor({ proxmox, chemin, duree = 10 * 60e3, dureeEchec = 60e3, delai = 60e3, horloge = Date.now }) {
    Object.assign(this, { proxmox, chemin, duree, dureeEchec, delai, horloge });
    this.cache = new Map();
  }

  async macs(noeud) {
    const l = this.proxmox.liaison();
    const cle = `${l.hote}:${l.port}/${noeud}`;
    const deja = this.cache.get(cle);
    if (deja && (deja.enCours || this.horloge() < deja.jusqua)) return deja.promesse;
    const promesse = this.proxmox.get(this.chemin('nodes', noeud, 'report'), {}, { delai: this.delai }).then(adressesMac);
    const entree = { promesse, enCours: true, jusqua: 0 };
    this.cache.set(cle, entree);
    promesse.then(
      () => Object.assign(entree, { enCours: false, jusqua: this.horloge() + this.duree }),
      () => Object.assign(entree, { enCours: false, jusqua: this.horloge() + this.dureeEchec }));
    return promesse;
  }
}
