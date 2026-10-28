// L'écran fluide de ProxLab : son identité de client Moonlight (un certificat,
// clé scellée par le coffre du socle) et, par VM, l'adresse de son Sunshine et
// le certificat épinglé à l'appairage. L'appairage se fait sous renfort : un PIN
// tiré ici est saisi par l'opérateur dans l'interface de Sunshine.
import crypto from 'node:crypto';
import { nouvelleIdentite, empreinteCert } from './flux/certificat.js';
import { HoteSunshine, ErreurFlux, PORT_HTTP, PORT_HTTPS, adresseInterne, nomHoteValide } from './flux/hote.js';
import { scriptConnexion, lireMarque, lireSortie, sansMarque } from './fluide-commande.js';

const APPAIRAGE_MS = 180e3;
const COMMANDE_MS = 15 * 60e3;
const SUIVI_MS = 1500;
const ECART_SESSIONS_MS = 800;
const CLE_VM = vmid => `fluide:${vmid}`;

export class Fluide {
  constructor({ reglages }) {
    this.reglages = reglages;
    this.appairages = new Map();          // vmid → { pin, etat, message, debut, fin }
    this.apps = new Map();                // vmid → identifiant de l'application « Desktop »
    this.finies = new Map();              // vmid → fin de la dernière session
    this.commandes = new Map();           // vmid → { nonce, fin, etat, message, vu }
    this.scripts = new Map();             // jeton → { script, fin, vmid } : lu une fois
  }

  // Sunshine démonte une session en quelques centaines de millisecondes (son,
  // encodeur) : une réouverture collée à la fin d'une session (changement de
  // qualité) attend qu'il ait fini, plutôt que de le prendre de vitesse.
  noterFin(vmid) { this.finies.set(String(vmid), Date.now()); }
  async patienter(vmid, ecartMs = ECART_SESSIONS_MS) {
    const reste = (this.finies.get(String(vmid)) || 0) + ecartMs - Date.now();
    if (reste > 0) await new Promise(r => setTimeout(r, Math.min(reste, ecartMs)));
  }

  // L'identité de ProxLab, créée au premier usage.
  identite() {
    let i = this.reglages.lire('fluide-identite');
    if (!i?.cert || !i?.cle_scellee) {
      const n = nouvelleIdentite();
      i = { cert: n.certPem, cle_scellee: this.reglages.sceller('fluideCle', n.clePem), uniqueId: crypto.randomBytes(8).toString('hex').toUpperCase(), cree: Date.now() };
      this.reglages.ecrire('fluide-identite', i);
    }
    return { certPem: i.cert, clePem: this.reglages.ouvrir('fluideCle', i.cle_scellee), uniqueId: i.uniqueId };
  }

  config(vmid) { return this.reglages.lire(CLE_VM(vmid)); }

  publique(vmid, { admin = false } = {}) {
    const c = this.config(vmid), a = this.appairages.get(String(vmid));
    const appairage = a ? { etat: a.etat, message: a.message || '', ...(admin && a.etat === 'attente' ? { pin: a.pin, expire: a.fin } : {}) } : null;
    const k = this.commandes.get(String(vmid));
    const commande = admin && k ? { mode: k.mode, etat: k.etat === 'attente' && Date.now() > k.fin ? 'expiree' : k.etat, message: k.message || '', expire: k.fin, lignes: k.lignes || [] } : null;
    if (!c) return { configure: false, appairage, ...(commande ? { commande } : {}) };
    return {
      configure: true, appaire: !!c.cert_serveur, hote: admin ? c.hote : undefined,
      empreinte: admin ? c.empreinte || '' : undefined, nom: c.nom || '', version: c.version || '', appaireLe: c.appaire_le || 0, appairage,
      ...(commande ? { commande } : {}),
    };
  }

  hote(vmid, { certServeur } = {}) {
    const c = this.config(vmid);
    if (!c) throw new ErreurFlux('écran fluide non configuré pour cette VM', 'non-configure');
    return new HoteSunshine({ hote: c.hote, portHttp: c.port_http || PORT_HTTP, portHttps: c.port_https || PORT_HTTPS, identite: this.identite(), certServeur: certServeur === undefined ? c.cert_serveur || null : certServeur });
  }

  // L'adresse de Sunshine (réseau interne seulement), vérifiée par son serverinfo.
  async poser(vmid, { hote, portHttp = PORT_HTTP, portHttps = PORT_HTTPS }) {
    const h = String(hote || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
    if (!nomHoteValide(h)) throw new ErreurFlux('adresse invalide', 'invalide');
    const s = new HoteSunshine({ hote: h, portHttp, portHttps, identite: this.identite() });
    const infos = await s.infos({ chiffre: false });
    if (!infos.sunshine) throw new ErreurFlux('cet hôte n\'est pas un Sunshine', 'invalide');
    const avant = this.config(vmid);
    const meme = avant && avant.hote === h && (avant.port_http || PORT_HTTP) === portHttp && (avant.port_https || PORT_HTTPS) === portHttps;
    // Une autre adresse : l'ancien appairage ne vaut plus.
    this.reglages.ecrire(CLE_VM(vmid), {
      hote: h, port_http: portHttp, port_https: portHttps, nom: infos.nom, version: infos.version,
      cert_serveur: meme ? avant.cert_serveur || null : null, empreinte: meme ? avant.empreinte || '' : '', appaire_le: meme ? avant.appaire_le || 0 : 0,
    });
    this.apps.delete(String(vmid));
    return infos;
  }

  oublier(vmid) {
    this.reglages.ecrire(CLE_VM(vmid), null);
    this.appairages.delete(String(vmid)); this.apps.delete(String(vmid)); this.commandes.delete(String(vmid));
    for (const [j, x] of this.scripts) if (x.vmid === String(vmid)) this.scripts.delete(j);
  }

  // Lance l'appairage : rend le PIN tout de suite ; Sunshine répond quand
  // l'opérateur l'a saisi dans son interface (ou au bout de trois minutes).
  appairer(vmid) {
    const cle = String(vmid);
    const enCours = this.appairages.get(cle);
    if (enCours?.etat === 'attente' && Date.now() < enCours.fin) return enCours;
    const c = this.config(vmid);
    if (!c) throw new ErreurFlux('écran fluide non configuré pour cette VM', 'non-configure');
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const a = { pin, etat: 'attente', message: '', debut: Date.now(), fin: Date.now() + APPAIRAGE_MS };
    this.appairages.set(cle, a);
    const hote = this.hote(vmid, { certServeur: null });
    hote.appairer(pin, { versionServeur: c.version, attentePin: APPAIRAGE_MS }).then(r => {
      const actuelle = this.config(vmid);
      if (!actuelle || actuelle.hote !== c.hote) { a.etat = 'echec'; a.message = 'adresse changée pendant l\'appairage'; return; }
      this.reglages.ecrire(CLE_VM(vmid), { ...actuelle, cert_serveur: r.certServeur, empreinte: r.empreinte, appaire_le: Date.now() });
      a.etat = 'reussi'; a.pin = '';
      this.apps.delete(cle);
    }, e => { a.etat = 'echec'; a.message = String(e?.message || e).slice(0, 200); a.pin = ''; });
    return a;
  }

  // Relier une VM, de deux façons. Le nonce n'est valable que pour cette VM et
  // cette fois ; une nouvelle demande remplace la précédente.
  //  - relier() : ProxLab lance lui-même le script dans le shell du nœud
  //    (termproxy, utilisateur root de la liaison) et en lit la sortie ;
  //  - preparerCommande() : le script est servi une fois, à l'adresse d'un jeton
  //    de 256 bits, pour une ligne à coller (curl … | ssh … bash) ; l'empreinte
  //    revient alors par les notes de la VM.
  nouvelle(vmid, mode) {
    const k = { nonce: crypto.randomBytes(16).toString('hex'), fin: Date.now() + COMMANDE_MS, etat: 'attente', message: '', vu: 0, mode, lignes: [] };
    this.commandes.set(String(vmid), k);
    for (const [j, x] of this.scripts) if (x.vmid === String(vmid) || Date.now() > x.fin) this.scripts.delete(j);
    return k;
  }

  preparerCommande(vmid, { noeud, adressesVm, qui }) {
    const k = this.nouvelle(vmid, 'commande');
    const script = scriptConnexion({ vmid, noeud, adressesVm, nonce: k.nonce, qui, certClient: this.identite().certPem, retour: 'notes' });
    const jeton = crypto.randomBytes(32).toString('base64url');
    this.scripts.set(jeton, { script, fin: k.fin, vmid: String(vmid) });
    return { jeton, expire: k.fin };
  }

  // executer(script, surLigne) : lance le script sur le nœud, rend sa sortie.
  relier(vmid, { noeud, adressesVm, qui, executer }) {
    const k = this.nouvelle(vmid, 'auto');
    const script = scriptConnexion({ vmid, noeud, adressesVm, nonce: k.nonce, qui, certClient: this.identite().certPem, retour: 'sortie' });
    k.etat = 'en cours';
    const surLigne = l => {
      // Écho coupé, une ligne peut suivre l'invite du shell : prise où elle commence.
      const t = String(l).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
      const i = t.indexOf('ProxLab · ');
      if (i >= 0 && k.lignes.length < 40) k.lignes.push(t.slice(i + 10, i + 310));
    };
    k.promesse = (async () => {
      try {
        let sortie;
        try { sortie = await executer(script, surLigne); } catch (e) {
          if (!k.lignes.length) throw new ErreurFlux(`le shell du nœud n'a pas lancé le script (la liaison doit utiliser root@pam) : ${String(e?.message || e).slice(0, 120)}`, 'refus');
          throw e;
        }
        const m = lireSortie(sortie, k.nonce);
        if (!m) {
          const arret = k.lignes.find(x => /^arrêt : /.test(x));
          throw new ErreurFlux(arret ? arret.slice(8) : k.lignes.length ? 'le script n\'a pas rendu l\'empreinte de Sunshine' : 'le shell du nœud n\'a pas lancé le script (la liaison doit utiliser root@pam)', 'refus');
        }
        await this.epingler(vmid, k, m);
      } catch (e) {
        k.etat = 'echec'; k.message = String(e?.message || e).slice(0, 300);
      }
      return k.etat;
    })();
    return k;
  }

  // Le script d'un jeton : rendu une fois, puis oublié ; null s'il n'est plus là.
  prendreScript(jeton) {
    const x = this.scripts.get(String(jeton));
    if (!x) return null;
    this.scripts.delete(String(jeton));
    return Date.now() > x.fin ? null : x;
  }

  // L'empreinte reçue par un canal sûr : le certificat présenté doit y
  // correspondre et Sunshine doit reconnaître ProxLab ; puis il est épinglé.
  async epingler(vmid, k, m) {
    if (!adresseInterne(m.hote)) throw new ErreurFlux('adresse annoncée hors du réseau interne', 'interdite');
    const h = new HoteSunshine({ hote: m.hote, portHttp: m.port, portHttps: m.port - 5, identite: this.identite(), empreinte: m.empreinte });
    const infos = await h.infos({ chiffre: true });
    if (!infos.appaire || !h.certVu) throw new ErreurFlux('Sunshine ne reconnaît pas ProxLab', 'refus');
    this.reglages.ecrire(CLE_VM(vmid), {
      hote: m.hote, port_http: m.port, port_https: m.port - 5, nom: infos.nom, version: infos.version,
      cert_serveur: h.certVu, empreinte: m.empreinte, appaire_le: Date.now(),
    });
    this.apps.delete(String(vmid)); this.appairages.delete(String(vmid));
    k.etat = 'reussi'; k.relie = { hote: m.hote, port: m.port, version: infos.version };
  }

  // La commande collée a tourné : l'empreinte de Sunshine est dans les notes de
  // la VM, lues par l'API de Proxmox ; la ligne en est ensuite retirée.
  async suivreCommande(vmid, { lireNotes, ecrireNotes }) {
    const k = this.commandes.get(String(vmid));
    if (!k || k.mode !== 'commande' || k.etat !== 'attente' || Date.now() > k.fin || Date.now() - k.vu < SUIVI_MS) return k?.etat || null;
    k.vu = Date.now();
    const notes = await lireNotes();
    const m = lireMarque(notes, k.nonce);
    if (!m) return k.etat;
    k.etat = 'verification';
    try { await this.epingler(vmid, k, m); } catch (e) { k.etat = 'echec'; k.message = String(e?.message || e).slice(0, 200); }
    try { await ecrireNotes(sansMarque(notes)); } catch { k.notesGardees = true; }
    return k.etat;
  }

  // L'application à lancer : le bureau (« Desktop »), sinon la première.
  async appId(vmid, hote) {
    const cle = String(vmid);
    if (this.apps.has(cle)) return this.apps.get(cle);
    const apps = await hote.applications();
    if (!apps.length) throw new ErreurFlux('Sunshine ne propose aucune application', 'refus');
    const id = (apps.find(a => /^desktop$|^bureau$/i.test(a.titre)) || apps[0]).id;
    this.apps.set(cle, id);
    return id;
  }

  // Les adresses internes de la VM, lues par son agent QEMU (propositions).
  static adressesDe(interfaces) {
    const sortie = [];
    for (const i of Array.isArray(interfaces) ? interfaces : []) {
      if (!i || /^lo$/.test(i.name)) continue;
      for (const a of Array.isArray(i['ip-addresses']) ? i['ip-addresses'] : []) {
        const ip = String(a?.['ip-address'] || '');
        if (a?.['ip-address-type'] === 'ipv4' && adresseInterne(ip) && !ip.startsWith('127.')) sortie.push({ interface: String(i.name).slice(0, 32), adresse: ip, prefixe: Number(a.prefix) || 0 });
      }
    }
    return sortie.slice(0, 16);
  }
}

export { empreinteCert };
