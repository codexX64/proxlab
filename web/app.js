// Interface de ProxLab : vue d'ensemble de la grappe, machines et leur fiche
// (graphes, instantanés, sauvegardes, configuration, console), nœuds,
// stockage, tâches, événements, réglages. La porte du socle gère la connexion ;
// le serveur revérifie chaque droit, l'interface ne fait que ne pas proposer
// ce qui serait refusé.
//
// Rien n'est injecté comme balisage : tout passe par h() (texte) et par les
// graphiques du socle (nœuds SVG).
import {
  Api, porte, pageSecurite, pageComptes, h, icone, basculeTheme, appliquerTheme,
  toast, confirmer, dialogue, feuille, ajouterPictos, renforcer, confirmerIdentite, raisonCle,
} from './socle/compte.js';
import { courbe, anneau, jauge, calendrier, capacite, tuiles } from './socle/graphes.js';
import { Terminal } from './terminal.js';
import { Ecran, DISPOSITIONS, intapables, estMac } from './ecran.js';
import { EcranFluide } from './fluide.js';

// Le plus long texte que ProxLab tape d'une traite (src/frappe.js).
const FRAPPE_MAX = 100000;
// Pendant qu'une frappe de ProxLab tourne, ces touches dans l'écran l'arrêtent (un ⌘V de trop).
const TOUCHES_ARRET_FRAPPE = new Set(['Delete', 'Backspace', 'Escape']);

appliquerTheme();
const SERVICE = 'ProxLab';
const api = new Api({ surDeconnexion: () => location.reload() });
const session = await porte({ api, service: SERVICE, sousTitre: 'grappe Proxmox VE' });
const moi = session.session.compte;
const admin = moi.role === 'admin';
const membre = moi.role !== 'lecture';

ajouterPictos({
  ciseaux: '<circle cx="6.5" cy="17.5" r="2.6"/><circle cx="17.5" cy="17.5" r="2.6"/><path d="M8.4 15.6 18 4M15.6 15.6 6 4"/>',
  annuler: '<path d="M9 7 4.5 11.5 9 16"/><path d="M5 11.5h9.5a5 5 0 0 1 0 10H12"/>',
  retablir: '<path d="M15 7l4.5 4.5L15 16"/><path d="M19 11.5H9.5a5 5 0 0 0 0 10H12"/>',
  selection: '<path d="M4 8V5.5C4 4.7 4.7 4 5.5 4H8M16 4h2.5c.8 0 1.5.7 1.5 1.5V8M20 16v2.5c0 .8-.7 1.5-1.5 1.5H16M8 20H5.5C4.7 20 4 19.3 4 18.5V16"/><path d="M8.5 12h7"/>',
  presse: '<rect x="5.5" y="4.5" width="13" height="16" rx="2"/><path d="M9 4.5V3.6c0-.6.4-1 1-1h4c.6 0 1 .4 1 1v.9M9 10h6M9 13.5h6M9 17h3.5"/>',
  clavier: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M18 13.5h.01M8.5 14.5h7"/>',
  grappe: '<rect x="3.5" y="4" width="17" height="5" rx="1.6"/><rect x="3.5" y="10" width="17" height="5" rx="1.6"/><rect x="3.5" y="16" width="17" height="4.5" rx="1.6"/><path d="M7 6.5h.01M7 12.5h.01M7 18.2h.01"/>',
  vm: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  ct: '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M4 8l8 4.5L20 8M12 12.5v8"/>',
  noeud: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8h8M8 12h8M8 16h3"/>',
  disque: '<ellipse cx="12" cy="6.5" rx="7.5" ry="2.8"/><path d="M4.5 6.5v11c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-11M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  taches: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
  cloche: '<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.6 5.6 1.6 5.6H4.9S6.5 14 6.5 10z"/><path d="M10.2 18.6a2 2 0 0 0 3.6 0"/>',
  reglages: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="7.5" cy="17" r="2.2"/>',
  vue: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  marche: '<path d="M7 5v14l11-7z"/>',
  arret: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  relance: '<path d="M20 11.4a8.2 8.2 0 1 0-1.9 6.2"/><path d="M20.5 5v5h-5"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7 9l3 3-3 3M12.5 15h4"/>',
  ecran: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  agrandir: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  photo: '<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.4"/>',
  archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5 8.5V20h14V8.5M10 12h4"/>',
  deplacer: '<path d="M4 12h15M14 7l5 5-5 5"/><path d="M4 6v12"/>',
  actions: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  reseau: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M12 11 6 17M12 11l6 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  iso: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.3"/><path d="M12 5.8a6.2 6.2 0 0 1 5.4 3.2"/>',
  envoi: '<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4.5 15v3.5c0 .8.7 1.5 1.5 1.5h12c.8 0 1.5-.7 1.5-1.5V15"/>',
  ejecter: '<path d="M5.5 14 12 6.5l6.5 7.5z"/><path d="M5.5 18h13"/>',
  etiquette: '<path d="M3.5 12V4.8c0-.7.6-1.3 1.3-1.3H12l8.5 8.5-8.5 8.5z"/><circle cx="8" cy="8" r="1.4"/>',
});

const nf = (v, d = 0) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(v);
function octets(v) {
  const u = ['o', 'Kio', 'Mio', 'Gio', 'Tio', 'Pio'];
  let i = 0; v = Number(v) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${nf(v, v < 10 && i ? 1 : 0)} ${u[i]}`;
}
const debit = v => { const b = (Number(v) || 0) * 8; return b >= 1e6 ? `${nf(b / 1e6, 1)} Mb/s` : `${nf(b / 1e3, 0)} kb/s`; };
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
function duree(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const j = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return j ? `${j} j ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`;
}
function age(quand) {
  const t = typeof quand === 'number' ? (quand < 1e12 ? quand * 1000 : quand) : Date.parse(quand);
  if (!t) return '—';
  const d = Math.max(0, (Date.now() - t) / 1000);
  if (d < 10) return 'à l\'instant';
  if (d < 90) return `il y a ${Math.round(d)} s`;
  if (d < 5400) return `il y a ${Math.round(d / 60)} min`;
  if (d < 172800) return `il y a ${Math.round(d / 3600)} h`;
  return `il y a ${Math.round(d / 86400)} j`;
}
const dateHeure = t => new Date(t < 1e12 ? t * 1000 : t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const cibleDe = m => `${m.type}/${m.vmid}`;
const genreMachine = m => (m.type === 'qemu' ? 'VM' : 'CT');

const GENRES = {
  'guest.down': 'Machine tombée', 'guest.recovered': 'Machine revenue', 'guest.started': 'Démarrage', 'guest.stopped': 'Arrêt',
  'guest.rebooted': 'Redémarrage', 'guest.suspended': 'Suspension', 'guest.resumed': 'Reprise', 'node.offline': 'Nœud hors ligne',
  'node.memory': 'Mémoire du nœud', 'node.cpu': 'Charge du nœud', 'storage.threshold': 'Stockage', 'vm.created': 'Création',
  'vm.destroyed': 'Destruction', 'vm.restored': 'Restauration', 'vm.start_failed': 'Démarrage échoué', 'vm.migrated': 'Migration',
  'vm.configured': 'Configuration', 'snapshot.created': 'Instantané', 'snapshot.rolled_back': 'Retour d\'instantané',
  'snapshot.deleted': 'Instantané supprimé', 'backup.started': 'Sauvegarde', 'backup.deleted': 'Sauvegarde supprimée', 'panel.configured': 'Liaison',
  'vm.delete_requested': 'Suppression demandée', 'vm.create_requested': 'Création', 'iso.added': 'Image ISO ajoutée', 'iso.deleted': 'Image ISO supprimée',
};
const tagNiveau = n => h('span', { class: 'tag ' + (n === 'critique' ? 'held' : n === 'avertissement' ? 'warn' : 'idle') }, h('i', { class: 'd' }), n === 'critique' ? 'Critique' : n === 'avertissement' ? 'Avertissement' : 'Info');
function tagMachine(m) {
  if (m.template) return h('span', { class: 'tag idle' }, h('i', { class: 'd' }), 'modèle');
  if (m.status === 'running') return h('span', { class: 'tag' }, h('i', { class: 'd' }), 'en marche');
  if (m.status === 'paused' || m.status === 'suspended') return h('span', { class: 'tag warn' }, h('i', { class: 'd' }), 'suspendue');
  return h('span', { class: 'tag idle' }, h('i', { class: 'd' }), 'arrêtée');
}
function barre(valeur, { alerte = 90, attention = 75 } = {}) {
  const i = h('i');
  i.style.width = `${Math.max(0, Math.min(100, valeur))}%`;
  return h('div', { class: 'jaugette ' + (valeur >= alerte ? 'held' : valeur >= attention ? 'warn' : '') }, h('div', { class: 'rail2' }, i), h('b', { text: `${nf(valeur)} %` }));
}
// Une ligne de tableau qui s'ouvre au clic comme à la touche Entrée.
function ouvrable(tr, ouvrir) {
  tr.tabIndex = 0;
  tr.addEventListener('click', ouvrir);
  tr.addEventListener('keydown', e => { if (e.key === 'Enter') ouvrir(); });
  return tr;
}
const erreur = e => h('div', { class: 'page' }, h('div', { class: 'card' }, h('p', { class: 'vide', text: e.message || String(e) })));
const sur = fn => async e => { e?.stopPropagation?.(); try { await fn(); } catch (x) { toast(x.message, true); } };

// Étiquettes : un nom lisible que ProxLab montre à la place de celui de
// Proxmox, qui garde le sien. Le nom de Proxmox reste écrit dessous.
function nomEtiquete(reel, alias, ...details) {
  const sous = [alias ? reel : '', ...details].filter(Boolean).join(' · ');
  return h('div', { class: 'nom-iso' }, h('b', { text: alias || reel }), sous ? h('small', { class: 'mono', text: sous }) : null);
}
const noeudAffiche = n => E.etat?.noeuds.find(x => x.node === n)?.alias || n;
const QUOI = { iso: 'le fichier', reseau: 'l’interface', stockage: 'le stockage', noeud: 'le nœud' };
async function etiqueter({ genre, noeud, objet, reel = objet, actuel = '' }) {
  const champ = h('input', { class: 'field', maxlength: 80, value: actuel, placeholder: reel, 'aria-label': 'Étiquette' });
  const err = h('p', { class: 'erreur', role: 'alert' });
  return dialogue({ titre: `Étiquette de ${reel}`,
    texte: `Le nom que ProxLab affiche. Dans Proxmox, ${QUOI[genre]} garde son nom (${reel}) : rien n’y est renommé, les VM et la configuration ne voient aucun changement. Vide : plus d’étiquette.`,
    contenu: [champ, err],
    boutons: [{ texte: 'Annuler', classe: 'flat', valeur: false }, { texte: 'Enregistrer', classe: 'solid', agir: async () => {
      try { await api.put('/api/etiquettes', { genre, noeud, objet, etiquette: champ.value }); return true; } catch (e) { err.textContent = e.message; return false; }
    } }] });
}
const boutonEtiquette = (quoi, ouvrir) => h('button', { class: 'btn sm flat', type: 'button', 'aria-label': `Étiquette de ${quoi}`, title: 'Étiquette', onclick: ouvrir }, icone('etiquette', 14));

const stage = h('div', { class: 'stage' });
const navs = {};
const PAGES = {
  over: { titre: 'Vue d\'ensemble', ic: 'vue', rendre: pageVue },
  machines: { titre: 'Machines', ic: 'vm', rendre: pageMachines },
  noeuds: { titre: 'Nœuds', ic: 'noeud', rendre: pageNoeuds },
  reseau: { titre: 'Réseau', ic: 'reseau', rendre: pageReseau },
  stockage: { titre: 'Stockage', ic: 'disque', rendre: pageStockage },
  isos: { titre: 'Images ISO', ic: 'iso', rendre: pageIsos },
  taches: { titre: 'Tâches', ic: 'taches', rendre: pageTaches },
  evenements: { titre: 'Événements', ic: 'cloche', rendre: pageEvenements },
  ...(admin ? { reglages: { titre: 'Réglages', ic: 'reglages', rendre: pageReglages } } : {}),
  securite: { titre: 'Sécurité', ic: 'cadenas', rendre: () => pageSecurite(api, { service: SERVICE, confidentialite: '/confidentialite.txt' }) },
  ...(admin ? { comptes: { titre: 'Comptes', ic: 'utilisateurs', rendre: () => pageComptes(api, { service: SERVICE }) } } : {}),
};
function lien(k) {
  const p = PAGES[k];
  return (navs[k] = h('button', { class: 'nav', type: 'button', 'aria-label': p.titre, onclick: () => aller(k) }, icone(p.ic), h('span', { text: p.titre })));
}
function groupe(nom, cles) {
  const items = cles.filter(k => PAGES[k]);
  return items.length ? h('div', { class: 'grp' }, h('span', { text: nom }), items.map(lien)) : null;
}
const railMarche = h('b', { text: '—' });
const railBarre = h('i');
const app = h('div', { class: 'app' },
  h('nav', { class: 'rail', 'aria-label': 'Navigation' },
    h('div', { class: 'mark' }, h('div', { class: 'g' }, icone('grappe', 15)), h('b', { text: SERVICE }), h('i', { class: 'pulse' })),
    groupe('Grappe', ['over', 'machines', 'noeuds', 'reseau', 'stockage', 'isos']),
    groupe('Activité', ['taches', 'evenements']),
    groupe('Système', ['reglages', 'securite', 'comptes']),
    h('div', { class: 'railcard' },
      h('div', { class: 'row' }, icone('vm', 14), h('span', { class: 'tronque', text: 'En marche' }), railMarche),
      h('div', { class: 'bar' }, railBarre),
      h('div', { class: 'row mt11' }, icone('utilisateurs', 14), h('span', { class: 'tronque', text: moi.identifiant })),
      h('button', { class: 'btn sm flat plein', type: 'button', onclick: async () => { await api.post('/api/compte/deconnexion'); location.reload(); } }, icone('sortie', 14), 'Se déconnecter'))),
  h('div', { class: 'voile-rail', onclick: () => app.classList.remove('menu-ouvert') }),
  h('main', { class: 'main' },
    h('header', { class: 'top' },
      h('button', { class: 'ghost menu', type: 'button', 'aria-label': 'Menu', onclick: () => app.classList.toggle('menu-ouvert') }, icone('menu')),
      h('div', { class: 'topright' }, basculeTheme(), h('div', { class: 'who', title: moi.identifiant, text: moi.identifiant.slice(0, 2).toUpperCase() }))),
    stage));
document.body.append(app);

const E = { etat: null, synthese: null, filtre: 'toutes', q: '', tf: 'hour' };
let courante = { cle: null, maj: null, quitter: null };

async function aller(k, ref = null) {
  if (k !== 'fiche' && !PAGES[k]) k = 'over';
  courante.quitter?.();
  courante = { cle: k, maj: null, quitter: null };
  for (const [n, b] of Object.entries(navs)) b.classList.toggle('on', n === (k === 'fiche' ? 'machines' : k));
  app.classList.remove('menu-ouvert');
  history.replaceState(null, '', '#' + k + (ref ? '/' + ref.join('/') : ''));
  let page;
  try { page = k === 'fiche' ? await pageFiche(...ref) : await PAGES[k].rendre(); } catch (e) { page = erreur(e); }
  if (courante.cle !== k) return;
  stage.replaceChildren(page);
  stage.scrollTop = 0;
}
const enregistrer = (maj, quitter = null) => { courante.maj = maj; courante.quitter = quitter; };

async function rafraichir({ synthese = false } = {}) {
  try {
    E.etat = await api.get('/api/etat');
    if (synthese || !E.synthese) E.synthese = await api.get('/api/synthese');
  } catch (e) { if (!E.etat) E.etat = { relie: false, noeuds: [], machines: [], stockages: [], erreur: e.message }; else E.etat.erreur = e.message; }
  const invites = E.etat.machines.filter(m => !m.template), marche = invites.filter(m => m.status === 'running').length;
  railMarche.textContent = `${marche} / ${invites.length}`;
  railBarre.style.width = `${pct(marche, invites.length || 1)}%`;
  compteur('machines', invites.length);
  compteur('over', E.synthese?.actives.length || 0, true);
  courante.maj?.();
}
function compteur(k, n, alerte = false) {
  const b = navs[k];
  if (!b) return;
  let c = b.querySelector('.cnt');
  if (!n && alerte) { c?.remove(); return; }
  if (!c) { c = h('span', { class: 'cnt' }); b.append(c); }
  c.textContent = String(n);
  c.classList.toggle('alerte', alerte);
}

function nonRelie() {
  return h('div', { class: 'card vide-grand' },
    h('div', { class: 'itile' }, icone('lien', 18)),
    h('h2', { text: 'Proxmox n\'est pas encore relié' }),
    h('p', { class: 'lede', text: admin
      ? 'Indique l\'adresse de la grappe et un jeton d\'API dans Réglages. Le certificat de Proxmox est vérifié, ou son empreinte épinglée, avant le premier échange.'
      : 'Un administrateur doit relier ProxLab à la grappe dans Réglages.' }),
    admin ? h('button', { class: 'btn solid mt14', type: 'button', onclick: () => aller('reglages') }, icone('reglages', 15), 'Relier Proxmox') : null);
}

async function pageVue() {
  const page = h('div', { class: 'page' });
  const peindre = () => page.replaceChildren(...contenuVue());
  enregistrer(peindre);
  peindre();
  return page;
}
const graphesReseau = new Map();
function contenuVue() {
  const et = E.etat, sy = E.synthese || { actives: [], sauvegardes: { jours: [], recentes: { ok: 0, echec: 0 } }, disponibilite: { heures: [] } };
  const tete = h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Vue d\'ensemble' }),
    h('p', { class: 'lede', text: et.relie ? `${et.noeuds.length} nœud${et.noeuds.length > 1 ? 's' : ''}, ${et.machines.filter(m => !m.template).length} invités. Relevé toutes les ${et.intervalle || 60} s.` : 'Grappe Proxmox VE.' })),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: sur(async () => { await rafraichir({ synthese: true }); toast('État relu.'); }) }, icone('relance', 15), 'Relire')));
  if (!et.relie) return [tete, nonRelie()];
  const invites = et.machines.filter(m => !m.template), marche = invites.filter(m => m.status === 'running');
  const st = stockagesUniques(et.stockages), utilise = st.reduce((a, s) => a + s.disk, 0), total = st.reduce((a, s) => a + s.maxdisk, 0);
  const crit = sy.actives.filter(a => a.severity === 'critique').length;
  const fig = (lbl, val, em, delta, classe = '') => h('div', { class: 'fig ' + classe }, h('div', { class: 'tile' + (classe === 'alerte' ? ' warn' : '') }, icone({ 'Invités en marche': 'vm', 'À traiter': 'cloche', 'Stockage utilisé': 'disque', 'Sauvegardes, 24 h': 'archive' }[lbl] || 'vue')),
    h('span', { text: lbl }), h('strong', {}, val, em ? h('em', { text: em }) : null), h('div', { class: 'delta', text: delta }));
  const heures = sy.disponibilite.heures, sansIncident = heures.filter(x => x !== 'incident').length;
  const dispo = heures.length ? sansIncident / heures.length * 100 : 100;
  const enLigne = et.noeuds.filter(n => n.status === 'online');
  const cpu = enLigne.reduce((a, n) => a + n.cpu * n.maxcpu, 0) / (enLigne.reduce((a, n) => a + n.maxcpu, 0) || 1) * 100;
  const mem = pct(enLigne.reduce((a, n) => a + n.mem, 0), enLigne.reduce((a, n) => a + n.maxmem, 0));
  const ligne = (k, v, classe = '') => h('div', { class: 'resume-ligne' }, h('span', { text: k }), h('b', { class: classe, text: v }));
  const echecs = sy.sauvegardes.jours.filter(j => j.echec).map(j => j.jour);

  return [tete,
    h('div', { class: 'figs' },
      fig('Invités en marche', String(marche.length), `/ ${invites.length}`, `${marche.filter(m => m.type === 'qemu').length} VM · ${marche.filter(m => m.type === 'lxc').length} CT`),
      fig('À traiter', String(sy.actives.length), '', crit ? `${crit} critique${crit > 1 ? 's' : ''}` : 'rien de critique', sy.actives.length ? 'alerte' : ''),
      fig('Stockage utilisé', octets(utilise), '', `${pct(utilise, total)} % de ${octets(total)}`),
      fig('Sauvegardes, 24 h', String(sy.sauvegardes.recentes.ok), sy.sauvegardes.recentes.echec ? `/ ${sy.sauvegardes.recentes.ok + sy.sauvegardes.recentes.echec}` : '', sy.sauvegardes.recentes.echec ? `${sy.sauvegardes.recentes.echec} en échec` : 'aucun échec')),
    h('div', { class: 'split' },
      carteReseau(enLigne),
      h('div', { class: 'card carte-pleine' }, h('header', {}, h('h2', { text: 'État de la grappe' }), h('span', { class: 'note', text: '7 jours' })),
        h('div', { class: 'pad etat-grappe' },
          jauge({ valeur: dispo, centre: `${nf(dispo, 1)} %`, sous: 'sans incident', libelle: 'Heures sans incident sur sept jours', etat: dispo >= 99 ? 'g-ok' : dispo >= 95 ? 'g-degrade' : 'g-incident' }),
          h('div', { class: 'resume' },
            ligne('Nœuds en ligne', `${enLigne.length} / ${et.noeuds.length}`, enLigne.length < et.noeuds.length ? 'warn' : ''),
            ligne('Processeur', `${nf(cpu)} %`, cpu >= 85 ? 'warn' : ''),
            ligne('Mémoire', `${mem} %`, mem >= 85 ? 'warn' : ''),
            ligne('Nuits en échec', echecs.length ? String(echecs.length) : 'aucune', echecs.length ? 'warn' : ''))))),
    h('div', { class: 'split mt16' }, carteATraiter(sy.actives), carteJournal()),
    h('div', { class: 'split mt16' }, carteNoeuds(et, sy), h('div', { class: 'card carte-pleine' }, h('header', {}, h('h2', { text: 'Invités' }), h('span', { class: 'note', text: `${et.machines.length} au total` })),
      h('div', { class: 'pad' }, anneau({
        libelle: 'Répartition des invités', centre: String(invites.length), sous: 'invités',
        parts: [
          { nom: 'VM en marche', valeur: marche.filter(m => m.type === 'qemu').length },
          { nom: 'CT en marche', valeur: marche.filter(m => m.type === 'lxc').length },
          { nom: 'Arrêtés', valeur: invites.length - marche.length, classe: 'g-c6' },
          { nom: 'Modèles', valeur: et.machines.length - invites.length, classe: 'g-c5' },
        ],
      })))),
    h('div', { class: 'split mt16' },
      h('div', { class: 'card carte-pleine' }, h('header', {}, h('h2', { text: 'Sauvegardes' }), h('span', { class: 'note', text: '28 nuits' })),
        h('div', { class: 'pad' }, calendrierSauvegardes(sy.sauvegardes.jours), legendeEtats('Réussies', 'Partielles', 'En échec', 'Aucune'))),
      h('div', { class: 'card carte-pleine' }, h('header', {}, h('h2', { text: 'Disponibilité' }), h('span', { class: 'note', text: '7 jours, heure par heure' })),
        h('div', { class: 'pad' }, calendrierDispo(sy.disponibilite), legendeEtats('Sans incident', 'Dégradé', 'Incident')))),
    h('div', { class: 'card mt16' }, h('header', {}, h('h2', { text: 'Stockage' }), h('span', { class: 'note', text: `${octets(utilise)} sur ${octets(total)}` })),
      h('div', { class: 'pad' }, tuiles({ libelle: 'Occupation des stockages', format: octets, parts: st.map(s => ({ nom: `${s.alias || s.storage}${s.shared ? '' : ' · ' + (noeudAffiche(s.node))}`, valeur: s.disk, detail: `${pct(s.disk, s.maxdisk)} % de ${octets(s.maxdisk)}` })) })))];
}

// Un stockage partagé apparaît sous chaque nœud : compté une fois.
function stockagesUniques(liste) {
  const vus = new Map();
  for (const s of liste) { const k = s.shared ? s.storage : `${s.node}/${s.storage}`; if (!vus.has(k) && s.status !== 'unknown') vus.set(k, s); }
  return [...vus.values()].sort((a, b) => b.disk - a.disk);
}

function carteReseau(enLigne) {
  const vues = [['hour', '1 h'], ['day', '24 h'], ['week', '7 j']];
  const zone = h('div', { class: 'graphe-place' }, h('p', { class: 'vide', text: 'Lecture des relevés…' }));
  const releve = h('div', { class: 'releve' });
  const choix = h('div', { class: 'views' }, vues.map(([v, l]) => h('button', { class: 'view' + (E.tf === v ? ' on' : ''), type: 'button', text: l, 'aria-pressed': String(E.tf === v), onclick: () => { E.tf = v; for (const b of choix.children) { b.classList.toggle('on', b.textContent === l); b.setAttribute('aria-pressed', String(b.textContent === l)); } charger(); } })));
  async function charger() {
    const cle = `${E.tf}:${enLigne.map(n => n.node).join(',')}`;
    let donnees = graphesReseau.get(cle);
    if (!donnees || Date.now() - donnees.at > 55e3) {
      const toutes = await Promise.all(enLigne.map(n => api.get(`/api/noeuds/${encodeURIComponent(n.node)}/rrd?tf=${E.tf}`).catch(() => [])));
      const parInstant = new Map();
      for (const l of toutes) for (const p of l || []) { const x = parInstant.get(p.time) || { netin: 0, netout: 0 }; x.netin += p.netin || 0; x.netout += p.netout || 0; parInstant.set(p.time, x); }
      const temps = [...parInstant.keys()].sort((a, b) => a - b);
      donnees = { at: Date.now(), temps, entree: temps.map(t => parInstant.get(t).netin), sortie: temps.map(t => parInstant.get(t).netout) };
      graphesReseau.set(cle, donnees);
    }
    if (!donnees.temps.length) { zone.replaceChildren(h('p', { class: 'vide', text: 'Pas de relevé pour cette période.' })); releve.replaceChildren(); return; }
    const { etiquettes, instants } = axeTemps(donnees.temps, E.tf);
    zone.replaceChildren(courbe({ libelle: 'Trafic réseau de la grappe', hauteur: 210, format: debit, etiquettes, instants, series: [{ nom: 'Entrant', valeurs: donnees.entree }, { nom: 'Sortant', valeurs: donnees.sortie }] }));
    const moy = donnees.entree.reduce((a, v) => a + v, 0) / donnees.entree.length;
    releve.replaceChildren(h('strong', { text: debit(donnees.entree.at(-1)) }), h('span', { text: 'entrants, dernier relevé' }), h('span', { class: 'pousse', text: `pic ${debit(Math.max(...donnees.entree))} · moyenne ${debit(moy)}` }));
  }
  charger().catch(e => zone.replaceChildren(h('p', { class: 'vide', text: e.message })));
  return h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Trafic réseau' }), h('div', { class: 'pousse' }, choix)), h('div', { class: 'pad' }, releve, zone));
}

function axeTemps(temps, tf) {
  const f = tf === 'hour' || tf === 'day' ? { hour: '2-digit', minute: '2-digit' } : tf === 'week' ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' };
  const fmt = t => new Date(t * 1000).toLocaleString('fr-FR', f);
  const n = 6, etiquettes = Array.from({ length: n }, (_, i) => fmt(temps[Math.round(i * (temps.length - 1) / (n - 1))]));
  return { etiquettes, instants: temps.map(t => new Date(t * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })) };
}

function carteATraiter(actives) {
  const vers = a => (/^(qemu|lxc)\/\d+$/.test(a.target || '') ? () => { const m = E.etat.machines.find(x => cibleDe(x) === a.target); if (m) aller('fiche', [m.node, m.type, String(m.vmid)]); } : null);
  return h('div', { class: 'card carte-pleine' }, h('header', {}, h('h2', {}, 'À traiter', h('span', { class: 'compte', text: String(actives.length) })), h('button', { class: 'btn sm flat', type: 'button', onclick: () => aller('evenements') }, 'Événements', icone('fleche', 14))),
    h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Élément' }), h('th', { class: 'cache-m', text: 'Nœud' }), h('th', { text: 'Observation' }), h('th', { class: 'cache-s fin', text: 'Depuis' }))),
      h('tbody', {}, actives.length ? actives.slice(0, 8).map(a => {
        const tr = h('tr', { class: vers(a) ? 'cliquable' : '' },
          h('td', {}, h('b', { class: 'mono fw5 sans-retour', text: a.target || '—' })),
          h('td', { class: 'cache-m dim', text: a.node || '—' }),
          h('td', { class: 'principal' }, h('span', { class: 'obs ' + (a.severity === 'critique' ? 'held' : 'warn') }, h('i', { class: 'd' }), h('span', { class: 'tronque', text: a.title }))),
          h('td', { class: 'cache-s fin mono', text: age(a.since) }));
        const f = vers(a); if (f) ouvrable(tr, f);
        return tr;
      }) : h('tr', {}, h('td', { colspan: 4, class: 'vide', text: 'Rien à traiter.' }))))),
    actives.length && actives.length <= 8 ? h('p', { class: 'vide reste', text: 'Rien d\'autre à traiter.' }) : null);
}

const journal = h('div', { class: 'journal' });
function carteJournal() {
  api.get('/api/evenements?limite=6').then(liste => {
    journal.replaceChildren(...(liste.length ? liste.map(ligneEvenement) : [h('p', { class: 'vide', text: 'Rien pour l\'instant.' })]));
  }).catch(() => {});
  return h('div', { class: 'card carte-pleine' }, h('header', {}, h('h2', { text: 'Journal d\'activité' }), h('span', { class: 'note', text: 'en direct' })), journal);
}
function ligneEvenement(e, { heure = false } = {}) {
  const ic = e.severity === 'critique' ? 'alerte' : /^backup/.test(e.kind) ? 'archive' : /^snapshot/.test(e.kind) ? 'photo' : /^node|^storage/.test(e.kind) ? 'noeud' : 'vm';
  const d = new Date(e.at);
  return h('div', { class: 'evenement ' + e.severity }, h('span', { class: 'ev-ic' }, icone(ic, 14)),
    h('div', { class: 'ev-txt' }, h('b', { text: e.title }), h('span', { text: [GENRES[e.kind] || e.kind, e.node, e.by].filter(Boolean).join(' · ') })),
    h('time', { datetime: e.at, title: d.toLocaleString('fr-FR'), text: heure ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : age(e.at) }));
}
// « Aujourd'hui », « Hier », sinon le jour en toutes lettres.
function jourEvenement(at) {
  const d = new Date(at), j = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ecart = Math.round((j(new Date()) - j(d)) / 864e5);
  if (ecart === 0) return 'Aujourd\'hui';
  if (ecart === 1) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

function carteNoeuds(et, sy) {
  const lignes = et.noeuds.map(n => {
    const ici = et.machines.filter(m => m.node === n.node && !m.template);
    const enPanne = new Set(sy.actives.filter(a => a.kind === 'guest.down' && a.node === n.node).map(a => a.target));
    const ok = ici.filter(m => m.status === 'running').length, incident = ici.filter(m => enPanne.has(cibleDe(m))).length;
    const hors = n.status !== 'online';
    const b = h('div', { class: 'noeud-ligne' },
      h('button', { class: 'noeud-nom', type: 'button', onclick: () => aller('noeuds') }, h('i', { class: 'd ' + (hors ? 'held' : '') }), h('b', { text: n.alias || n.node }), h('small', { text: `${ici.length} invité${ici.length > 1 ? 's' : ''}` })),
      capacite({ ok: hors ? 0 : ok, incident: hors ? ici.length : incident, repos: hors ? 0 : ici.length - ok - incident, libelle: n.node }),
      h('div', { class: 'noeud-ratio' }, h('b', { text: hors ? 'hors ligne' : `${nf(n.cpu * 100)} %` }), h('small', { text: hors ? '' : `CPU · RAM ${pct(n.mem, n.maxmem)} %` })));
    return b;
  });
  return h('div', { class: 'card carte-pleine' }, h('header', {}, h('h2', { text: 'Nœuds' }), h('span', { class: 'note', text: 'invités par état' })),
    h('div', { class: 'pad' }, lignes, legendeEtats('En marche', null, 'En panne', 'Arrêtés')));
}
function legendeEtats(ok, degrade, incident, vide = null) {
  return h('div', { class: 'legende-etats' }, [[ok, 'g-ok'], [degrade, 'g-degrade'], [incident, 'g-incident'], [vide, 'g-vide']].filter(([l]) => l).map(([l, c]) => h('span', {}, h('i', { class: c }), l)));
}
function calendrierSauvegardes(jours) {
  if (!jours.length) return h('p', { class: 'vide', text: 'Pas encore lu.' });
  const premier = new Date(jours[0].jour + 'T00:00:00Z');
  const decalage = (premier.getUTCDay() + 6) % 7; // semaine qui commence lundi
  const cellules = [...Array.from({ length: decalage }, () => ({ etat: 'vide' })), ...jours.map(j => ({
    etat: j.echec && j.ok ? 'degrade' : j.echec ? 'incident' : j.ok ? 'ok' : 'vide',
    titre: `${new Date(j.jour + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} : ${j.ok} réussie${j.ok > 1 ? 's' : ''}${j.echec ? `, ${j.echec} en échec` : ''}`,
  }))];
  return calendrier({ cellules, colonnes: 7, lignes: Array.from({ length: Math.ceil(cellules.length / 7) }, (_, i) => `S${i + 1}`), libelle: 'Sauvegardes des vingt-huit dernières nuits', cote: 22, ecart: 4 });
}
function calendrierDispo({ heures, debut }) {
  if (!heures.length) return h('p', { class: 'vide', text: 'Pas encore lu.' });
  const t0 = Date.parse(debut);
  const cellules = heures.map((x, i) => ({ etat: x, titre: `${new Date(t0 + i * 3600e3).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} : ${x === 'ok' ? 'sans incident' : x === 'degrade' ? 'dégradé' : 'incident'}` }));
  const lignes = Array.from({ length: 7 }, (_, j) => new Date(t0 + j * 864e5).toLocaleDateString('fr-FR', { weekday: 'short' }));
  return calendrier({ cellules, colonnes: 24, lignes, libelle: 'Disponibilité heure par heure sur sept jours', cote: 11, ecart: 3 });
}

async function pageMachines() {
  const filtres = [['toutes', 'Toutes'], ['marche', 'En marche'], ['arretees', 'Arrêtées'], ['modeles', 'Modèles']];
  const choix = h('div', { class: 'views' });
  const corps = h('tbody', {});
  const compte = h('span', { class: 'compte' });
  const q = h('input', { class: 'field fld-sm', type: 'search', placeholder: 'Nom, VMID, nœud, étiquette', 'aria-label': 'Chercher une machine', value: E.q });
  const peindre = () => {
    if (!E.etat.relie) { corps.replaceChildren(h('tr', {}, h('td', { colspan: 6, class: 'vide', text: 'Proxmox n\'est pas encore relié.' }))); compte.textContent = ''; return; }
    let l = E.etat.machines.slice();
    if (E.filtre === 'marche') l = l.filter(m => m.status === 'running');
    else if (E.filtre === 'arretees') l = l.filter(m => m.status !== 'running' && !m.template);
    else if (E.filtre === 'modeles') l = l.filter(m => m.template);
    const t = E.q.toLowerCase().trim();
    if (t) l = l.filter(m => `${m.name} ${m.vmid} ${m.node} ${noeudAffiche(m.node)} ${m.tags}`.toLowerCase().includes(t));
    corps.replaceChildren(...(l.length ? l.map(ligneMachine) : [h('tr', {}, h('td', { colspan: 6, class: 'vide', text: 'Aucune machine.' }))]));
    compte.textContent = `${l.length} machine${l.length > 1 ? 's' : ''}`;
  };
  choix.replaceChildren(...filtres.map(([k, l]) => h('button', { class: 'view' + (E.filtre === k ? ' on' : ''), type: 'button', text: l, onclick: () => { E.filtre = k; [...choix.children].forEach(c => c.classList.toggle('on', c.textContent === l)); peindre(); } })));
  q.addEventListener('input', () => { E.q = q.value; peindre(); });
  enregistrer(peindre);
  peindre();
  return h('div', { class: 'page' },
    h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Machines' }), h('p', { class: 'lede', text: 'Machines virtuelles et conteneurs de la grappe, sur tous les nœuds.' })),
      admin && E.etat.relie ? h('div', { class: 'actions' }, h('button', { class: 'btn solid', type: 'button', onclick: sur(() => creerMachine()) }, icone('plus', 14), h('span', { class: 'cache-s', text: 'Nouvelle VM' }))) : null),
    h('div', { class: 'card' }, h('div', { class: 'barre' }, choix, q, compte),
      h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Machine' }), h('th', { class: 'cache-m', text: 'Nœud' }), h('th', { class: 'cache-l', text: 'Processeur' }), h('th', { class: 'cache-l', text: 'Mémoire' }), h('th', { class: 'cache-s', text: 'En marche depuis' }), h('th', { text: 'État' }))), corps))));
}
function ligneMachine(m) {
  const marche = m.status === 'running';
  const tr = h('tr', { class: 'cliquable' },
    h('td', { class: 'principal' }, h('div', { class: 'who-cell' }, h('span', { class: 'itile' }, icone(m.type === 'qemu' ? 'vm' : 'ct')), h('div', {}, h('b', { text: m.name || `${genreMachine(m)} ${m.vmid}` }), h('small', { class: 'mono', text: `${m.vmid} · ${genreMachine(m)}${m.tags ? ' · ' + m.tags.split(/[;,]/).join(', ') : ''}` })))),
    h('td', { class: 'cache-m dim', text: noeudAffiche(m.node) }),
    h('td', { class: 'cache-l' }, marche ? barre(m.cpu * 100) : h('span', { class: 'dim', text: '—' })),
    h('td', { class: 'cache-l' }, marche ? barre(pct(m.mem, m.maxmem)) : h('span', { class: 'dim', text: octets(m.maxmem) })),
    h('td', { class: 'cache-s mono', text: marche ? duree(m.uptime) : '—' }),
    h('td', {}, tagMachine(m)));
  return ouvrable(tr, () => aller('fiche', [m.node, m.type, String(m.vmid)]));
}

async function pageFiche(noeud, type, vmid) {
  const base = `/api/machines/${encodeURIComponent(noeud)}/${type}/${vmid}`;
  let f = await api.get(base);
  const onglets = [['resume', 'Résumé'], ['instantanes', 'Instantanés'], ['sauvegardes', 'Sauvegardes'], ['configuration', 'Configuration'], ...(membre && type === 'qemu' ? [['ecran', 'Écran'], ['fluide', 'Écran fluide']] : []), ...(membre ? [['console', 'Console']] : [])];
  let onglet = 'resume';
  // L'écran et la console restent ouverts quand on change d'onglet : ils sont
  // cachés, pas fermés. Ils ne se ferment qu'en quittant la fiche.
  const vivants = {};
  const fermerVivant = k => { vivants[k]?.fermer(); vivants[k]?.el.remove(); delete vivants[k]; };
  // Écran en continu : en quittant la fiche, l'écran reste connecté à part et
  // revient tel quel au retour.
  const cleVm = `${noeud}/${vmid}`;
  const fermerConsole = () => {
    for (const k of Object.keys(vivants)) {
      if (k === 'ecran' && ecranContinu()) { garderEcran(cleVm, vivants[k]); vivants[k].el.remove(); delete vivants[k]; } else fermerVivant(k);
    }
  };
  const vivant = (k, creer) => {
    if (!vivants[k] && k === 'ecran' && ECRANS_GARDES.has(cleVm)) {
      vivants[k] = ECRANS_GARDES.get(cleVm); ECRANS_GARDES.delete(cleVm);
      corps.append(vivants[k].el);
    }
    if (!vivants[k]) {
      const slot = { term: null, ws: null };
      const fermer = () => { try { slot.ws?.close(); } catch { /* fermé */ } slot.term?.detruire?.(); slot.term = slot.ws = null; };
      vivants[k] = { el: creer((t, w) => { fermer(); slot.term = t; slot.ws = w; }), fermer };
      corps.append(vivants[k].el);
    }
    return vivants[k].el;
  };
  const statique = h('div', {});
  const corps = h('div', { class: 'dtpane' }, statique);
  const tabs = h('div', { class: 'views', role: 'tablist' });
  const tete = h('div', { class: 'detailhead' });
  const relire = async () => { f = await api.get(base); peindreTete(); if (onglet !== 'console' && onglet !== 'ecran' && onglet !== 'fluide') montrer(onglet); };
  // Après un changement (port série, presse-papiers, agent) : l'onglet refait avec la nouvelle configuration.
  const refaire = k => relire().then(() => { fermerVivant(k); montrer(k); });
  const action = (act, libelle, { danger = false, question = null } = {}) => sur(async () => {
    if (question && !await confirmer(question, `${genreMachine(f)} ${f.vmid} sur ${f.node}.`, { danger, oui: libelle })) return;
    await api.post(base + '/alimentation', { action: act });
    toast(`${libelle} : demandé.`);
    setTimeout(() => { relire().catch(() => {}); rafraichir(); }, 1500);
  });
  function peindreTete() {
    const marche = f.status === 'running';
    const plus = [
      ...(membre && marche && f.type === 'qemu' ? [{ texte: 'Suspendre', agir: action('suspend', 'Suspendre') }] : []),
      ...(membre && (f.status === 'paused' || f.status === 'suspended') ? [{ texte: 'Reprendre', agir: action('resume', 'Reprendre') }] : []),
      ...(admin && marche ? [{ texte: 'Arrêt forcé', danger: true, agir: action('stop', 'Arrêt forcé', { danger: true, question: 'Couper la machine sans l\'arrêter proprement ?' }) }] : []),
      ...(admin && marche && f.type === 'qemu' ? [{ texte: 'Réinitialiser', danger: true, agir: action('reset', 'Réinitialiser', { danger: true, question: 'Réinitialiser la machine comme un bouton reset ?' }) }] : []),
      ...(admin ? [{ texte: 'Dupliquer', agir: sur(() => dupliquer(f, base)) }] : []),
      ...(admin && (E.etat.noeuds.length > 1) ? [{ texte: 'Migrer vers un autre nœud', agir: () => migrer(f, base) }] : []),
    ];
    tete.replaceChildren(
      h('button', { class: 'btn sm flat', type: 'button', 'aria-label': 'Retour aux machines', onclick: () => aller('machines') }, icone('retour', 15)),
      h('div', { class: 'big' }, icone(f.type === 'qemu' ? 'vm' : 'ct', 22)),
      h('div', { class: 'grow1' }, h('h1', { text: f.name || `${genreMachine(f)} ${f.vmid}` }), h('div', { class: 'sub dim' }, `${genreMachine(f)} ${f.vmid} · ${noeudAffiche(f.node)} · `, tagMachine(f))),
      h('div', { class: 'actions' },
        membre && !f.template && !marche ? h('button', { class: 'btn solid', type: 'button', onclick: action('start', 'Démarrer') }, icone('marche', 14), h('span', { class: 'cache-s', text: 'Démarrer' })) : null,
        membre && marche ? h('button', { class: 'btn', type: 'button', onclick: action('shutdown', 'Arrêter', { question: 'Arrêter proprement la machine ?' }) }, icone('arret', 14), h('span', { class: 'cache-s', text: 'Arrêter' })) : null,
        membre && marche ? h('button', { class: 'btn', type: 'button', onclick: action('reboot', 'Redémarrer', { question: 'Redémarrer la machine ?' }) }, icone('relance', 14), h('span', { class: 'cache-s', text: 'Redémarrer' })) : null,
        admin && f.status === 'stopped' ? h('button', { class: 'btn danger', type: 'button', onclick: sur(() => supprimerMachine(f, base)) }, icone('corbeille', 14), h('span', { class: 'cache-s', text: 'Supprimer' })) : null,
        plus.length ? h('button', { class: 'btn', type: 'button', 'aria-label': 'Autres actions', onclick: () => feuille('Autres actions', plus) }, icone('actions', 16)) : null));
  }
  async function montrer(k) {
    onglet = k;
    for (const b of tabs.children) { const on = b.dataset.k === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    history.replaceState(null, '', `#fiche/${noeud}/${type}/${vmid}`);
    const cible = { noeud: f.node, type: f.type, vmid: String(f.vmid) };
    try {
      let el = null;
      if (k === 'console') el = vivant('console', garder => consoleMachine(cible, garder, { f, relire: () => refaire('console'), auto: true }));
      else if (k === 'ecran') el = vivant('ecran', garder => ecranMachine(f, garder, () => refaire('ecran'), { auto: true }));
      else if (k === 'fluide') el = vivant('fluide', garder => ecranFluide(f, garder, () => refaire('fluide'), { auto: true }));
      for (const v of Object.values(vivants)) v.el.hidden = v.el !== el;
      statique.hidden = !!el;
      if (el) { el.dispatchEvent(new CustomEvent('montre')); return; }
      if (k === 'resume') statique.replaceChildren(resumeMachine(f, base));
      else if (k === 'instantanes') statique.replaceChildren(instantanes(f, base, relire));
      else if (k === 'sauvegardes') statique.replaceChildren(await sauvegardes(f, base));
      else if (k === 'configuration') statique.replaceChildren(configuration(f, base, relire));
    } catch (e) { statique.hidden = false; statique.replaceChildren(h('p', { class: 'vide', text: e.message })); }
  }
  tabs.replaceChildren(...onglets.map(([k, l]) => h('button', { class: 'view', type: 'button', role: 'tab', text: l, dataset: { k }, onclick: () => montrer(k) })));
  peindreTete();
  montrer('resume');
  enregistrer(null, fermerConsole);
  return h('div', { class: 'page' }, tete, tabs, corps);
}

function resumeMachine(f, base) {
  const marche = f.status === 'running';
  const fig = (lbl, val, em, delta) => h('div', { class: 'fig' }, h('span', { text: lbl }), h('strong', {}, val, em ? h('em', { text: em }) : null), h('div', { class: 'delta', text: delta }));
  const graphes = h('div', { class: 'grille-graphes' });
  const vues = [['hour', '1 h'], ['day', '24 h'], ['week', '7 j'], ['month', '30 j']];
  let tf = 'hour';
  const choix = h('div', { class: 'views' }, vues.map(([v, l]) => h('button', { class: 'view' + (v === tf ? ' on' : ''), type: 'button', text: l, onclick: () => { tf = v; for (const b of choix.children) b.classList.toggle('on', b.textContent === l); charger(); } })));
  async function charger() {
    graphes.replaceChildren(h('p', { class: 'vide', text: 'Lecture des relevés…' }));
    const p = (await api.get(`${base}/rrd?tf=${tf}`)) || [];
    const pts = p.filter(x => x.time);
    if (!pts.length) { graphes.replaceChildren(h('p', { class: 'vide', text: 'Pas de relevé pour cette période.' })); return; }
    const { etiquettes, instants } = axeTemps(pts.map(x => x.time), tf);
    const carte = (titre, g) => h('div', { class: 'card' }, h('header', {}, h('h2', { text: titre })), h('div', { class: 'pad' }, g));
    graphes.replaceChildren(
      carte('Processeur', courbe({ libelle: 'Processeur', hauteur: 170, max: 100, format: v => `${nf(v)} %`, etiquettes, instants, series: [{ nom: 'Processeur', valeurs: pts.map(x => (x.cpu || 0) * 100) }] })),
      carte('Mémoire', courbe({ libelle: 'Mémoire', hauteur: 170, format: octets, etiquettes, instants, series: [{ nom: 'Utilisée', valeurs: pts.map(x => x.mem || 0) }, { nom: 'Allouée', valeurs: pts.map(x => x.maxmem || 0) }] })),
      carte('Réseau', courbe({ libelle: 'Réseau', hauteur: 170, format: debit, etiquettes, instants, series: [{ nom: 'Entrant', valeurs: pts.map(x => x.netin || 0) }, { nom: 'Sortant', valeurs: pts.map(x => x.netout || 0) }] })),
      carte('Disque', courbe({ libelle: 'Disque', hauteur: 170, format: v => `${octets(v)}/s`, etiquettes, instants, series: [{ nom: 'Lecture', valeurs: pts.map(x => x.diskread || 0) }, { nom: 'Écriture', valeurs: pts.map(x => x.diskwrite || 0) }] })));
  }
  charger().catch(e => graphes.replaceChildren(h('p', { class: 'vide', text: e.message })));
  return h('div', {},
    h('div', { class: 'figs' },
      fig('Processeur', marche ? `${nf(f.cpu * 100)} %` : '—', '', `${f.maxcpu} cœur${f.maxcpu > 1 ? 's' : ''}`),
      fig('Mémoire', marche ? octets(f.mem) : '—', '', `sur ${octets(f.maxmem)}`),
      fig('Disque', octets(f.maxdisk), '', f.disk ? `${octets(f.disk)} occupés` : 'taille allouée'),
      fig('En marche depuis', marche ? duree(f.uptime) : '—', '', marche ? 'sans interruption' : 'arrêtée')),
    h('div', { class: 'rowline mb16' }, h('h2', { class: 'grow1 fs13', text: 'Relevés' }), choix),
    graphes);
}

function instantanes(f, base, relire) {
  const liste = f.instantanes.slice().sort((a, b) => b.snaptime - a.snaptime);
  const prendre = sur(async () => {
    const nom = h('input', { class: 'field', maxlength: 40, placeholder: 'avant-mise-a-jour', 'aria-label': 'Nom', autocomplete: 'off' });
    const desc = h('input', { class: 'field mt9', maxlength: 500, placeholder: 'Description (facultative)', 'aria-label': 'Description' });
    const memoire = h('input', { type: 'checkbox' });
    const err = h('p', { class: 'erreur', role: 'alert' });
    const ok = await dialogue({ titre: 'Prendre un instantané', contenu: [nom, desc, f.type === 'qemu' && f.status === 'running' ? h('label', { class: 'chk mt10' }, memoire, 'Inclure la mémoire vive') : null, h('p', { class: 'hint mt9', text: 'Une lettre d\'abord, puis lettres, chiffres, - ou _ (2 à 40).' }), err],
      boutons: [{ texte: 'Annuler', classe: 'flat', valeur: false }, { texte: 'Prendre', classe: 'solid', agir: async () => {
        if (!/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(nom.value)) { err.textContent = 'Nom refusé : une lettre, puis lettres, chiffres, - ou _.'; return false; }
        try { await api.post(base + '/instantanes', { nom: nom.value, description: desc.value, avecMemoire: memoire.checked }); return true; } catch (e) { err.textContent = e.message; return false; }
      } }] });
    if (ok) { toast('Instantané demandé.'); setTimeout(() => relire().catch(() => {}), 1500); }
  });
  return h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Instantanés' }), h('span', { class: 'note', text: String(liste.length) }), membre ? h('button', { class: 'btn sm solid', type: 'button', onclick: prendre }, icone('photo', 14), 'Prendre') : null),
    h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Nom' }), h('th', { class: 'cache-s', text: 'Pris' }), h('th', { class: 'cache-m', text: 'Description' }), admin ? h('th', { class: 'fin' }) : null)),
      h('tbody', {}, liste.length ? liste.map(s => h('tr', {},
        h('td', { class: 'principal' }, h('b', { class: 'mono fw5', text: s.name }), s.vmstate ? h('small', { class: 'dim bloc', text: 'avec mémoire' }) : null),
        h('td', { class: 'cache-s mono', text: s.snaptime ? dateHeure(s.snaptime) : '—' }),
        h('td', { class: 'cache-m dim', text: s.description || '—' }),
        admin ? h('td', { class: 'fin' }, h('div', { class: 'actions' },
          h('button', { class: 'btn sm flat', type: 'button', 'aria-label': `Dupliquer depuis ${s.name}`, title: 'Une nouvelle machine, telle qu’à cet instantané', onclick: sur(() => dupliquer(f, base, s.name)) }, 'Dupliquer'),
          h('button', { class: 'btn sm', type: 'button', onclick: sur(async () => {
            if (!await confirmer(`Revenir à « ${s.name} » ?`, 'Tout ce qui a changé depuis cet instantané est perdu.', { danger: true, oui: 'Revenir' })) return;
            await api.post(`${base}/instantanes/${encodeURIComponent(s.name)}/retour`, {}); toast('Retour demandé.'); setTimeout(() => relire().catch(() => {}), 1500);
          }) }, 'Revenir'),
          h('button', { class: 'btn sm flat danger', type: 'button', 'aria-label': `Supprimer ${s.name}`, onclick: sur(async () => {
            if (!await confirmer(`Supprimer « ${s.name} » ?`, 'L\'instantané disparaît ; la machine reste telle qu\'elle est.', { danger: true, oui: 'Supprimer' })) return;
            await api.del(`${base}/instantanes/${encodeURIComponent(s.name)}`); toast('Suppression demandée.'); setTimeout(() => relire().catch(() => {}), 1500);
          }) }, icone('corbeille', 14)))) : null))
        : h('tr', {}, h('td', { colspan: admin ? 4 : 3, class: 'vide', text: 'Aucun instantané.' }))))));
}

// Dupliquer une machine : une copie complète, arrêtée, sous un numéro libre,
// de son état actuel ou d'un instantané. L'original n'est pas touché.
async function dupliquer(f, base, depuis = '') {
  const champ = (lbl, el) => h('label', { class: 'lbl-champ' }, h('span', { text: lbl }), el);
  const propose = `${String(f.name || `vm-${f.vmid}`).replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 56)}-copie`;
  const nom = h('input', { class: 'field', maxlength: 63, value: propose, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Nom de la copie' });
  const instant = h('select', { class: 'field', 'aria-label': 'Depuis' },
    h('option', { value: '', text: f.status === 'running' ? 'Son état actuel (copiée en marche)' : 'Son état actuel' }),
    ...f.instantanes.slice().sort((a, b) => b.snaptime - a.snaptime).map(x => h('option', { value: x.name, text: `Instantané « ${x.name} »${x.snaptime ? ` · ${dateHeure(x.snaptime)}` : ''}`, selected: x.name === depuis })));
  const stockage = h('select', { class: 'field', 'aria-label': 'Stockage de la copie' }, h('option', { value: '', text: 'Le même que l’original' }));
  if (f.type === 'qemu') {
    const o = await api.get(`/api/machines/options?noeud=${encodeURIComponent(f.node)}`).catch(() => null);
    for (const x of o?.stockages || []) stockage.append(h('option', { value: x.storage, text: `${x.alias ? `${x.alias} (${x.storage})` : x.storage} — ${octets(x.avail)} libres` }));
  }
  const err = h('p', { class: 'erreur', role: 'alert' });
  const r = await dialogue({ titre: `Dupliquer ${f.name || `${genreMachine(f)} ${f.vmid}`}`, large: true,
    texte: 'Une machine neuve, copie complète de celle-ci (disques compris), créée arrêtée sous un numéro libre. Ses cartes réseau reçoivent une adresse MAC neuve. L’original ne bouge pas.',
    contenu: [champ('Nom de la copie', nom), h('div', { class: 'row2 mt9' }, champ('Depuis', instant), f.type === 'qemu' ? champ('Stockage', stockage) : h('div')), err],
    boutons: [{ texte: 'Annuler', classe: 'flat', valeur: null }, { texte: 'Dupliquer', classe: 'solid', agir: async () => {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/.test(nom.value.trim())) { err.textContent = 'Nom : lettres, chiffres, points et tirets, sans espace.'; return false; }
      err.textContent = 'Copie en cours…';
      try { return await api.post(base + '/duplication', { nom: nom.value.trim(), instantane: instant.value, stockage: stockage.value }); } catch (x) { err.textContent = x.message; return false; }
    } }] });
  if (!r?.vmid) return;
  await rafraichir();
  if (!r.fini) { toast(`Copie ${r.vmid} lancée : une grosse machine prend du temps, suis-la dans Tâches.`); return; }
  toast(`${genreMachine(f)} ${r.vmid} « ${nom.value.trim()} » créée.`);
  aller('fiche', [r.noeud, r.type, String(r.vmid)]);
}

// Créer une VM : nom, système, image, ressources, disque et réseau, avec ce
// que le nœud choisi propose vraiment. Le serveur revérifie chaque choix.
const MEMOIRES = [1024, 2048, 4096, 8192, 16384, 32768, 65536];
async function creerMachine({ iso = '', noeud = '' } = {}) {
  const enLigne = E.etat.noeuds.filter(n => n.status === 'online');
  if (!enLigne.length) { toast('Aucun nœud en ligne.', true); return; }
  const champ = (lbl, el) => h('label', { class: 'lbl-champ' }, h('span', { text: lbl }), el);
  const nom = h('input', { class: 'field', maxlength: 63, placeholder: 'ma-vm', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Nom' });
  const nd = h('select', { class: 'field', 'aria-label': 'Nœud' }, enLigne.map(n => h('option', { value: n.node, text: n.alias ? `${n.alias} (${n.node})` : n.node, selected: n.node === noeud })));
  let systeme = 'linux';
  const systemes = h('div', { class: 'views plein' }, [['linux', 'Linux'], ['windows', 'Windows 11'], ['autre', 'Autre']].map(([v, t]) => h('button', { class: 'view' + (v === systeme ? ' on' : ''), type: 'button', text: t, onclick: e => {
    systeme = v; [...systemes.children].forEach(b => b.classList.toggle('on', b === e.currentTarget));
    if (v === 'windows' && Number(mem.value) < 4096) mem.value = '4096';
    if (v === 'windows' && Number(disque.value) < 64) disque.value = '64';
  } })));
  const image = h('select', { class: 'field', 'aria-label': 'Image ISO' });
  const coeurs = h('input', { class: 'field', type: 'number', min: 1, max: 128, value: 2, 'aria-label': 'Cœurs' });
  const mem = h('select', { class: 'field', 'aria-label': 'Mémoire' }, MEMOIRES.map(m => h('option', { value: String(m), text: `${m / 1024} Gio`, selected: m === 2048 })));
  const disque = h('input', { class: 'field', type: 'number', min: 1, max: 65536, value: 32, 'aria-label': 'Disque en Gio' });
  const stockage = h('select', { class: 'field', 'aria-label': 'Stockage du disque' });
  const pont = h('select', { class: 'field', 'aria-label': 'Réseau' });
  const demarrer = h('input', { type: 'checkbox', checked: true });
  const resume = h('p', { class: 'hint' });
  const err = h('p', { class: 'erreur', role: 'alert' });
  let o = null;
  const charger = async () => {
    err.textContent = '';
    o = await api.get(`/api/machines/options?noeud=${encodeURIComponent(nd.value)}`);
    image.replaceChildren(h('option', { value: '', text: 'Aucune (lecteur vide)' }), ...o.isos.map(i => h('option', { value: i.volid, text: i.alias || i.nom, selected: i.volid === iso })));
    stockage.replaceChildren(...o.stockages.map(x => h('option', { value: x.storage, text: `${x.alias ? `${x.alias} (${x.storage})` : x.storage} — ${octets(x.avail)} libres` })));
    // Le pont par son étiquette, ou le commentaire posé dans Proxmox ; son vrai nom entre parenthèses.
    pont.replaceChildren(...(o.pontsDetail || o.ponts.map(iface => ({ iface }))).map(b => h('option', { value: b.iface, text: b.alias || b.commentaire ? `${b.alias || b.commentaire} (${b.iface})` : b.iface })));
    coeurs.max = o.noeud.maxcpu;
    for (const opt of mem.options) opt.disabled = Number(opt.value) * 1048576 > o.noeud.maxmem;
    resume.textContent = `Numéro proposé : ${o.vmid}. ${noeudAffiche(nd.value)} : ${o.noeud.maxcpu} cœurs, ${octets(o.noeud.maxmem)} de mémoire.`;
    if (!o.stockages.length) err.textContent = `Aucun stockage de ${nd.value} ne prend de disque de VM.`;
  };
  nd.addEventListener('change', () => charger().catch(x => { err.textContent = x.message; }));
  await charger();
  const cree = await dialogue({ titre: 'Nouvelle machine virtuelle', large: true,
    contenu: [
      h('div', { class: 'row2' }, champ('Nom', nom), champ('Nœud', nd)),
      h('div', { class: 'lbl-champ mt9' }, h('span', { text: 'Système' }), systemes),
      h('div', { class: 'mt9' }, champ('Image d’installation', image)),
      h('div', { class: 'row2 mt9' }, champ('Cœurs', coeurs), champ('Mémoire', mem)),
      h('div', { class: 'row2 mt9' }, champ('Disque (Gio)', disque), champ('Stockage du disque', stockage)),
      h('div', { class: 'mt9' }, champ('Réseau', pont)),
      h('label', { class: 'chk mt10' }, demarrer, 'Démarrer une fois créée'),
      resume, err,
    ],
    boutons: [{ texte: 'Annuler', classe: 'flat', valeur: null }, { texte: 'Créer', classe: 'solid', agir: async () => {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/.test(nom.value.trim())) { err.textContent = 'Nom : lettres, chiffres, points et tirets, sans espace.'; return false; }
      err.textContent = 'Création…';
      try {
        return await api.post('/api/machines', { noeud: nd.value, nom: nom.value.trim(), systeme, coeurs: Number(coeurs.value), memoire: Number(mem.value), disque: Number(disque.value), stockage: stockage.value, iso: image.value, pont: pont.value, demarrer: demarrer.checked });
      } catch (x) { err.textContent = x.message; return false; }
    } }] });
  if (!cree?.vmid) return;
  toast(`VM ${cree.vmid} créée${cree.demarree ? ' et démarrée' : ''}.`);
  await rafraichir();
  aller('fiche', [cree.noeud, 'qemu', String(cree.vmid)]);
}

// Supprimer une machine arrêtée : son nom recopié, puis la confirmation
// d'identité (la clé d'accès de l'administrateur) d'un même geste. Le serveur
// revérifie tout et ne prend une confirmation que pour une suppression.
async function supprimerMachine(f, base) {
  const attendu = String((f.type === 'qemu' ? f.config?.name : f.config?.hostname) || f.name || f.vmid);
  const { methodesRenfort: [methode = 'motdepasse'] = [] } = await api.get('/api/compte/securite');
  const champ = h('input', { class: 'field', type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: attendu, 'aria-label': `Recopie ${attendu}` });
  const facteur = methode === 'totp' ? h('input', { class: 'field mt9', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: 'Code de ton application', 'aria-label': 'Code TOTP' })
    : methode === 'motdepasse' ? h('input', { class: 'field mt9', type: 'password', autocomplete: 'current-password', placeholder: 'Mot de passe', 'aria-label': 'Mot de passe' }) : null;
  const err = h('p', { class: 'erreur', role: 'alert' });
  const fini = dialogue({
    titre: `Supprimer ${attendu} ?`,
    texte: `${genreMachine(f)} ${f.vmid} sur ${f.node} : sa configuration, ses disques et ses instantanés sont effacés, sans retour. Ses sauvegardes restent. Recopie son nom${methode === 'cle' ? ', puis confirme avec ta clé d’accès' : ' et confirme ton identité'}.`,
    contenu: [champ, facteur, err].filter(Boolean),
    boutons: [{ texte: 'Annuler', classe: 'flat', valeur: false }, { texte: methode === 'cle' ? 'Supprimer avec ma clé' : 'Supprimer', classe: 'danger solid', agir: async () => {
      if (champ.value.trim() !== attendu) { err.textContent = `Recopie exactement « ${attendu} ».`; return false; }
      try {
        await confirmerIdentite(api, methode, { code: facteur?.value || '', motDePasse: facteur?.value || '' });
        await api.post(base + '/suppression', { nom: champ.value.trim() });
        return true;
      } catch (x) { err.textContent = x instanceof DOMException ? raisonCle(x) : x.message; return false; }
    } }],
  });
  const bouton = document.querySelector('.voile:last-of-type .pied .btn.danger');
  if (bouton) { bouton.disabled = true; champ.addEventListener('input', () => { bouton.disabled = champ.value.trim() !== attendu; }); }
  if (!await fini) return;
  toast(`${attendu} : suppression demandée.`);
  setTimeout(() => rafraichir(), 1500);
  aller('machines');
}

async function sauvegardes(f, base) {
  const d = await api.get(base + '/sauvegardes');
  const lancer = sur(async () => {
    if (!d.stockages.length) { toast('Aucun stockage de sauvegarde sur ce nœud.', true); return; }
    const st = h('select', { class: 'field', 'aria-label': 'Stockage' }, d.stockages.map(s => h('option', { value: s, text: s })));
    const mode = h('select', { class: 'field', 'aria-label': 'Mode' }, [['snapshot', 'À chaud (instantané)'], ['suspend', 'Suspendue'], ['stop', 'Arrêtée']].map(([v, t]) => h('option', { value: v, text: t })));
    const comp = h('select', { class: 'field', 'aria-label': 'Compression' }, [['zstd', 'zstd'], ['lzo', 'lzo'], ['gzip', 'gzip'], ['0', 'aucune']].map(([v, t]) => h('option', { value: v, text: t })));
    const notes = h('input', { class: 'field mt9', maxlength: 200, placeholder: 'Note (facultative)', 'aria-label': 'Note' });
    const err = h('p', { class: 'erreur', role: 'alert' });
    const ok = await dialogue({ titre: 'Sauvegarder maintenant', contenu: [st, h('div', { class: 'row2 mt9' }, mode, comp), notes, err],
      boutons: [{ texte: 'Annuler', classe: 'flat', valeur: false }, { texte: 'Lancer', classe: 'solid', agir: async () => {
        try { await api.post(base + '/sauvegardes', { stockage: st.value, mode: mode.value, compression: comp.value, notes: notes.value }); return true; } catch (e) { err.textContent = e.message; return false; }
      } }] });
    if (ok) toast('Sauvegarde lancée : elle apparaît dans les tâches.');
  });
  return h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Sauvegardes' }), h('span', { class: 'note', text: String(d.sauvegardes.length) }), membre ? h('button', { class: 'btn sm solid', type: 'button', onclick: lancer }, icone('archive', 14), 'Sauvegarder') : null),
    h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Date' }), h('th', { class: 'cache-s', text: 'Stockage' }), h('th', { text: 'Taille' }), h('th', { class: 'cache-m', text: 'Note' }), admin ? h('th', { class: 'fin' }) : null)),
      h('tbody', {}, d.sauvegardes.length ? d.sauvegardes.map(b => h('tr', {},
        h('td', { class: 'principal mono', text: dateHeure(b.ctime) }),
        h('td', { class: 'cache-s dim', text: b.storage }),
        h('td', { class: 'mono', text: octets(b.size) }),
        h('td', { class: 'cache-m dim', text: b.notes || '—' }),
        admin ? h('td', { class: 'fin' }, h('button', { class: 'btn sm flat danger', type: 'button', 'aria-label': 'Supprimer cette sauvegarde', onclick: sur(async () => {
          if (!await confirmer('Supprimer cette sauvegarde ?', `${dateHeure(b.ctime)} sur ${b.storage}. Elle ne pourra plus être restaurée.`, { danger: true, oui: 'Supprimer' })) return;
          await api.del(`/api/sauvegardes/${encodeURIComponent(f.node)}/${encodeURIComponent(b.storage)}?volid=${encodeURIComponent(b.volid)}`);
          toast('Suppression demandée.');
        }) }, icone('corbeille', 14))) : null))
        : h('tr', {}, h('td', { colspan: admin ? 5 : 4, class: 'vide', text: 'Aucune sauvegarde de cette machine.' }))))));
}

const CLES_CONFIG = { name: 'Nom', hostname: 'Nom d\'hôte', ostype: 'Système', cores: 'Cœurs', sockets: 'Sockets', cpu: 'Type de processeur', memory: 'Mémoire (Mio)', swap: 'Échange (Mio)', balloon: 'Ballon (Mio)', onboot: 'Démarrage auto', boot: 'Ordre de démarrage', bios: 'Micrologiciel', machine: 'Modèle de machine', agent: 'Agent invité', scsihw: 'Contrôleur SCSI', tags: 'Étiquettes', description: 'Description', unprivileged: 'Non privilégié', features: 'Fonctions', protection: 'Protection', arch: 'Architecture', rootfs: 'Disque racine' };
function configuration(f, base, relire) {
  const c = f.config || {};
  const cles = Object.keys(c).sort((a, b) => (CLES_CONFIG[a] ? 0 : 1) - (CLES_CONFIG[b] ? 0 : 1) || a.localeCompare(b));
  const modifier = sur(async () => {
    const champ = (lbl, el) => h('label', { class: 'lbl-champ' }, h('span', { text: lbl }), el);
    const nom = h('input', { class: 'field', value: c.name || c.hostname || '', maxlength: 63 });
    const coeurs = h('input', { class: 'field', type: 'number', min: 1, max: 512, value: c.cores || 1 });
    const sockets = h('input', { class: 'field', type: 'number', min: 1, max: 8, value: c.sockets || 1 });
    const memoire = h('input', { class: 'field', type: 'number', min: 16, step: 64, value: c.memory || 512 });
    const auto = h('input', { type: 'checkbox', checked: c.onboot === '1' });
    const tags = h('input', { class: 'field', value: c.tags || '', maxlength: 200, placeholder: 'prod;web' });
    const desc = h('textarea', { class: 'field', maxlength: 2000, rows: 3 }); desc.value = c.description || '';
    const err = h('p', { class: 'erreur', role: 'alert' });
    const ok = await dialogue({ titre: 'Modifier la configuration', large: true,
      contenu: [champ('Nom', nom), h('div', { class: 'row2 mt9' }, champ('Cœurs', coeurs), f.type === 'qemu' ? champ('Sockets', sockets) : champ('Mémoire (Mio)', memoire)), f.type === 'qemu' ? h('div', { class: 'row2 mt9' }, champ('Mémoire (Mio)', memoire), champ('Étiquettes', tags)) : h('div', { class: 'mt9' }, champ('Étiquettes', tags)), h('div', { class: 'mt9' }, champ('Description', desc)), h('label', { class: 'chk mt10' }, auto, 'Démarrer avec le nœud'), h('p', { class: 'hint mt9', text: 'Le changement de processeur ou de mémoire d\'une machine en marche peut attendre son prochain redémarrage.' }), err],
      boutons: [{ texte: 'Annuler', classe: 'flat', valeur: false }, { texte: 'Enregistrer', classe: 'solid', agir: async () => {
        const corps = { nom: nom.value.trim(), coeurs: Number(coeurs.value), memoire: Number(memoire.value), demarrageAuto: auto.checked, etiquettes: tags.value.trim(), description: desc.value };
        if (f.type === 'qemu') corps.sockets = Number(sockets.value);
        try { await api.put(base + '/configuration', corps); return true; } catch (e) { err.textContent = e.message; return false; }
      } }] });
    if (ok) { toast('Configuration enregistrée.'); relire().catch(() => {}); }
  });
  return h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Configuration' }), admin ? h('button', { class: 'btn sm', type: 'button', onclick: modifier }, icone('crayon', 14), 'Modifier') : null),
    h('div', { class: 'cardbody' }, cles.length ? cles.map(k => h('div', { class: 'kv' }, h('span', { text: CLES_CONFIG[k] || k }), h('b', { class: /^(net|scsi|virtio|ide|sata|efidisk|tpmstate|rootfs|mp|unused)\d*$/.test(k) ? 'mono fs12' : '', text: c[k] }))) : h('p', { class: 'vide', text: 'Configuration vide.' })));
}

async function migrer(f, base) {
  const autres = E.etat.noeuds.filter(n => n.node !== f.node && n.status === 'online');
  if (!autres.length) { toast('Aucun autre nœud en ligne.', true); return; }
  const cible = h('select', { class: 'field', 'aria-label': 'Nœud de destination' }, autres.map(n => h('option', { value: n.node, text: `${n.node} — ${pct(n.mem, n.maxmem)} % de mémoire` })));
  const chaud = h('input', { type: 'checkbox', checked: f.status === 'running' });
  const err = h('p', { class: 'erreur', role: 'alert' });
  const ok = await dialogue({ titre: `Migrer ${f.name || f.vmid}`, contenu: [cible, h('label', { class: 'chk mt10' }, chaud, f.type === 'qemu' ? 'À chaud (sans arrêt)' : 'Redémarrer le conteneur sur la destination'), err],
    boutons: [{ texte: 'Annuler', classe: 'flat', valeur: false }, { texte: 'Migrer', classe: 'solid', agir: async () => {
      try { await api.post(base + '/migration', { cible: cible.value, enLigne: chaud.checked }); return true; } catch (e) { err.textContent = e.message; return false; }
    } }] });
  if (ok) toast('Migration lancée : suis-la dans les tâches.');
}

// L'écran d'une VM (VNC) : clavier à la disposition de la machine, souris,
// Ctrl+Alt+Suppr, plein écran, presse-papiers dans les deux sens. Chaque
// ouverture est journalisée.
const lireLocal = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
// Avant de taper un texte dans une VM : jamais la commande de connexion de
// l'écran fluide (elle va dans le terminal de l'ordinateur), et pas sans le
// dire quand des caractères n'existent pas sur le clavier de la VM.
const COMMANDE_FLUIDE = /<<'PROXLAB'|\/api\/fluide\/script\/|proxlab_fluide\(\)/;
async function frappePermise(texte, disposition) {
  if (COMMANDE_FLUIDE.test(texte)) { toast('C\'est la commande de connexion de l\'écran fluide : colle-la dans le terminal de ton ordinateur, jamais dans une VM.', true); return false; }
  if (!disposition || !DISPOSITIONS[disposition]) return true;
  const manque = intapables(texte, disposition);
  if (!manque.length) return true;
  const absents = new Set(manque);
  const n = [...texte].filter(ch => absents.has(ch)).length;
  return confirmer(`${n.toLocaleString('fr-FR')} caractère${n > 1 ? 's' : ''} impossible${n > 1 ? 's' : ''} à taper`,
    `Ils n'existent pas sur le clavier ${DISPOSITIONS[disposition].nom} de la VM et seraient sautés : ${manque.slice(0, 12).join(' ')}${manque.length > 12 ? ' …' : ''}. Le texte tapé ne serait pas le même.`,
    { oui: 'Taper quand même' });
}
const poserLocal = (k, v) => { try { localStorage.setItem(k, v); } catch { /* navigation privée */ } };
const MOD = estMac() ? '⌘' : 'Ctrl+';
const T_MAJ = estMac() ? '⇧⌘' : 'Ctrl+Maj+';

// Un menu déroulant « Actions » : groupes d'actions avec leur raccourci,
// recalculés à chaque ouverture ; l'action part dans le clic (le presse-papiers
// du navigateur l'exige). Échap ferme, les flèches parcourent.
function menuActions(groupes, { titre = 'Actions' } = {}) {
  const liste = h('div', { class: 'menu-actions', role: 'menu', hidden: true });
  const bouton = h('button', { class: 'btn sm', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icone('actions', 14), h('span', { text: titre }));
  const ancre = h('span', { class: 'menu-ancre' }, bouton, liste);
  const dehors = e => { if (!ancre.contains(e.target)) fermer(); };
  function fermer(rendre = false) {
    liste.hidden = true; bouton.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', dehors, true);
    window.removeEventListener('scroll', fermerSurDefilement, true); window.removeEventListener('resize', fermerSurDefilement);
    if (rendre) bouton.focus();
  }
  // Un défilement (la page, ou le bouton amené en vue juste avant le clic) :
  // le menu suit son bouton, et ne se ferme que si le bouton sort de l'écran.
  function fermerSurDefilement(e) {
    if (liste.contains(e.target)) return;
    const r = bouton.getBoundingClientRect();
    if (e.type === 'scroll' && r.bottom > 0 && r.top < innerHeight) placer(); else fermer();
  }
  // Posé par rapport à la fenêtre (une carte coupe ce qui dépasse) : sous le
  // bouton, ou au-dessus s'il y a plus de place ; hauteur bornée à la fenêtre.
  function placer() {
    const r = bouton.getBoundingClientRect(), bas = innerHeight - r.bottom - 12, haut = r.top - 12;
    const dessus = bas < 320 && haut > bas;
    liste.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    liste.style.top = dessus ? 'auto' : `${r.bottom + 6}px`;
    liste.style.bottom = dessus ? `${innerHeight - r.top + 6}px` : 'auto';
    liste.style.maxHeight = `${Math.max(160, dessus ? haut : bas)}px`;
  }
  bouton.addEventListener('click', () => {
    if (!liste.hidden) return fermer();
    liste.replaceChildren(...groupes().filter(g => g.items.length).flatMap((g, i) => [
      i ? h('div', { class: 'menu-sep', role: 'separator' }) : null,
      g.titre ? h('div', { class: 'menu-titre', text: g.titre }) : null,
      ...g.items.map(it => h('button', { class: 'menu-item', type: 'button', role: 'menuitem', 'aria-label': it.texte, ...(it.touche ? { 'aria-keyshortcuts': it.touche.replace(/⌘/g, 'Meta+').replace(/⇧/g, 'Shift+').replace(/Maj/g, 'Shift') } : {}), disabled: !!it.inactif, onclick: () => { fermer(); it.agir(); } },
        it.ic ? icone(it.ic, 14) : h('span', { class: 'menu-ic' }), h('span', { class: 'menu-texte', text: it.texte }), it.touche ? h('kbd', { text: it.touche }) : null)),
    ]).filter(Boolean));
    liste.hidden = false; bouton.setAttribute('aria-expanded', 'true'); bouton.classList.remove('signal');
    placer();
    document.addEventListener('pointerdown', dehors, true);
    window.addEventListener('scroll', fermerSurDefilement, true); window.addEventListener('resize', fermerSurDefilement);
    // Sans défilement : un focus qui fait défiler la page refermerait le menu aussitôt ouvert.
    liste.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
  });
  liste.addEventListener('keydown', e => {
    const items = [...liste.querySelectorAll('.menu-item:not([disabled])')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); fermer(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus({ preventScroll: true }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus({ preventScroll: true }); }
    else if (e.key === 'Tab') fermer();
  });
  return { ancre, bouton, fermer };
}

// Écrans gardés en continu, trois VM au plus : la plus ancienne est fermée.
const ECRANS_GARDES = new Map();
const ecranContinu = () => lireLocal('proxlab-ecran-continu', '0') === '1';
function garderEcran(cle, v) {
  ECRANS_GARDES.delete(cle); ECRANS_GARDES.set(cle, v);
  while (ECRANS_GARDES.size > 3) { const [k, x] = ECRANS_GARDES.entries().next().value; ECRANS_GARDES.delete(k); x.fermer(); x.el.nettoyer?.(); }
}
function lacherEcrans() { for (const x of ECRANS_GARDES.values()) { x.fermer(); x.el.nettoyer?.(); } ECRANS_GARDES.clear(); }

function ecranMachine(f, garder, relire, { auto = false, seul = false } = {}) {
  const cible = { noeud: f.node, type: f.type, vmid: String(f.vmid) }, enMarche = f.status === 'running';
  const agent = /clipboard=vnc/.test(f.config?.vga || '');
  const agentPrevu = !agent && (f.enAttente || []).includes('vga');
  // ⌘V dans l'écran : taper le texte (marche partout, même à l'écran de
  // connexion) ou passer par le presse-papiers de la VM (spice-vdagent, qui ne
  // relaie rien sous une session GNOME Wayland — Fedora par défaut).
  let modeColler = lireLocal('proxlab-coller', 'taper');
  // L'écran de la VM prend la taille de la fenêtre (ou de l'écran, en plein
  // écran) et la suit : il faut l'affichage VirtIO-GPU, que l'invité
  // redimensionne seul (GNOME, KDE, Windows avec le pilote VirtIO).
  const genreVga = String(f.config?.vga || '').split(',')[0] || 'std';
  const virtioPrevu = !/^virtio/.test(genreVga) && /^virtio/.test(f.vgaSuivant || '');
  let ajusterTaille = lireLocal('proxlab-ajuster', '1') === '1', refusSignale = false, minuteurTaille = null;
  // Taille de la VM : pixels de la VM par point de la fenêtre (×1, ×1,5,
  // ×2). ×1 est le plus léger : une VM sans carte graphique dessine tout au
  // processeur, et à ×2 sur un écran Retina (2560 × 1536 pour une fiche) elle
  // saturait ses cœurs, au point de perdre la frappe. L'image, elle, est
  // toujours sans perte (Tight sans JPEG) : nette quelle que soit la taille.
  // Ancien réglage « Qualité nette » coché : ×1,5.
  const ECHELLES = ['1', '1.5', '2'];
  let echelle = lireLocal('proxlab-echelle-vm', lireLocal('proxlab-ajuster-nette', '0') === '1' ? '1.5' : '1');
  if (!ECHELLES.includes(echelle)) echelle = '1';
  // Première ouverture avec ce réglage : la VM quitte la taille d'avant (×2
  // sur un Retina), quitte à rapetisser une fois.
  let echelleNeuve = lireLocal('proxlab-echelle-vm', '') === '';
  // Plein écran : l'image remplit tout l'écran, quitte à être un peu étirée,
  // plutôt que de laisser des bandes noires quand la VM n'a pas les mêmes
  // proportions que l'écran (console texte qui ne change pas de taille).
  let remplir = lireLocal('proxlab-remplir', '1') === '1';
  const densite = () => Number(echelle);
  const hote = h('div', { class: 'ecran-hote' + (remplir ? ' remplir' : '') });
  const cibleTaille = () => document.fullscreenElement === hote || hote.classList.contains('fenetre')
    ? [hote.clientWidth, hote.clientHeight]
    : [hote.clientWidth, Math.max(320, Math.min(innerHeight * 0.75, innerHeight - Math.max(0, hote.getBoundingClientRect().top) - 24))];
  // La VM grandit avec la fenêtre, sans jamais rapetisser d'elle-même : une
  // fenêtre plus petite (autre écran, fenêtre réduite) montre la même image,
  // réduite, au lieu d'agrandir tout ce qu'elle affiche et de rogner ce que
  // l'invité a posé pour la grande taille. Rapetisser reste un geste : « Adapter
  // la VM à sa fenêtre maintenant ». Quelques pixels de plus (barre de menus du
  // plein écran qui passe) ne valent pas un changement de taille.
  const reajuster = () => {
    clearTimeout(minuteurTaille);
    minuteurTaille = setTimeout(() => {
      if (!ajusterTaille || !ecran?.etendu || !hote.isConnected) return;
      const [l, h] = cibleTaille().map(v => Math.round(v * densite()));
      if (l - ecran.toile.width < 24 && h - ecran.toile.height < 24) return;
      ecran.ajuster(Math.max(l, ecran.toile.width), Math.max(h, ecran.toile.height));
    }, 500);
  };
  // Changement de taille voulu (échelle choisie, réglage changé ailleurs) : en plus petit aussi.
  const adapterMaintenant = () => { if (ajusterTaille && ecran?.etendu) ecran.ajuster(...cibleTaille().map(v => Math.round(v * densite()))); };
  // La plus grande taille vue pour cette VM, ici : celle à laquelle revenir
  // si son écran a été rapetissé.
  const cleTailleMax = `proxlab-taille-max:${f.node}/${f.vmid}`;
  const tailleMax = () => { const [l, h] = String(lireLocal(cleTailleMax, '')).split('x').map(Number); return l > 0 && h > 0 ? [l, h] : null; };
  const noterTaille = (l, h) => { const m = tailleMax(); if (!m || l * h > m[0] * m[1]) poserLocal(cleTailleMax, `${l}x${h}`); };
  new ResizeObserver(reajuster).observe(hote);
  // Plein écran (écran entier) : le clavier entier va à la VM, raccourcis du
  // système compris (⌘Espace, ⌘Tab, Échap…), là où le navigateur le permet
  // (Keyboard Lock : Chrome, Edge). Safari ne le permet pas : il garde ces
  // raccourcis pour macOS, et on le dit une fois.
  let clavierPris = false;
  const prendreClavier = async () => {
    if (document.fullscreenElement === hote) {
      if (navigator.keyboard?.lock) {
        try { await navigator.keyboard.lock(); clavierPris = true; toast('Toutes les touches vont à la VM, raccourcis du Mac compris (⌘Espace, ⌘Tab…). Pour sortir du plein écran : garde Échap enfoncée.'); } catch { /* refusé par le navigateur */ }
      } else if (lireLocal('proxlab-astuce-clavier', '') !== '1') {
        poserLocal('proxlab-astuce-clavier', '1');
        toast('Ce navigateur garde ⌘Espace, ⌘Tab et les raccourcis du système pour lui. Avec Chrome ou Edge, en plein écran, toutes les touches vont à la VM.', true);
      }
    } else if (clavierPris) { try { navigator.keyboard.unlock(); } catch { /* déjà rendu */ } clavierPris = false; }
  };
  hote.addEventListener('fullscreenchange', () => { ecran?.repeindre(); reajuster(); prendreClavier(); });
  const etat = h('span', { class: 'note', text: 'fermé' });
  let ecran = null, ouvertA = 0, reprise = false;
  // Le clavier de la VM : choisi à la main pour cette VM, sinon demandé à la VM
  // (agent QEMU) à l'ouverture, sinon le dernier choisi, sinon la langue d'ici.
  const cleDispo = `proxlab-disposition:${f.node}/${f.vmid}`;
  const choisie = lireLocal(cleDispo, '');
  let disposition = DISPOSITIONS[choisie] ? choisie : lireLocal('proxlab-disposition', /^fr/i.test(navigator.language || '') ? 'fr' : 'us');
  let detection = null;   // { disposition, brut, source } ou { disposition: null, raison, message }
  // Frappe au caractère (par défaut) : ce qui est tapé ici arrive tel quel ; ou
  // par touche physique (jeux, raccourcis exotiques), la disposition de la VM s'appliquant.
  let frappePhysique = lireLocal('proxlab-frappe', '') === 'physique', intapableVu = '';
  const agentPrevuClavier = (f.enAttente || []).includes('agent');
  const urlClavier = `/api/machines/${encodeURIComponent(f.node)}/qemu/${f.vmid}/clavier`;
  const poserDispo = (k, { main = false } = {}) => {
    disposition = k; choixDispo.value = k;
    if (main) { poserLocal(cleDispo, k); poserLocal('proxlab-disposition', k); }
    peindreDispo();
  };
  const detecter = async (relire = false) => {
    try { detection = await api.get(urlClavier + (relire ? '?relire=1' : '')); } catch (e) { detection = { disposition: null, raison: 'erreur', message: e.message }; }
    if (detection.disposition && detection.disposition !== disposition) { poserDispo(detection.disposition); toast(`Clavier de la VM détecté : ${DISPOSITIONS[detection.disposition].nom}.`); }
    else if (relire) toast(detection.disposition ? `Clavier de la VM : ${DISPOSITIONS[detection.disposition].nom} (détecté).` : detection.message || 'Pas de réponse de la VM.', !detection.disposition);
    else if (!detection.disposition && !dispoSure()) toast(`Clavier de la VM inconnu : ${DISPOSITIONS[disposition].nom} supposé. Une lettre sort mal (q pour a) ? Clique « ${court(disposition)} ? » en haut de l'écran.`, true);
    peindreDispo();
  };
  // Le clavier de la VM, dit en permanence en haut de l'écran : un clic passe à
  // l'autre. Choisi à la main ou détecté, il est sûr ; sinon il est supposé
  // (langue d'ici) et marqué d'un « ? ».
  const court = k => DISPOSITIONS[k].nom.split(' ')[0];
  const dispoSure = () => !!DISPOSITIONS[lireLocal(cleDispo, '')] || detection?.disposition === disposition;
  const boutonDispo = h('button', { class: 'btn sm dispo-vm', type: 'button', disabled: true, onclick: () => {
    const ks = Object.keys(DISPOSITIONS), k = ks[(ks.indexOf(disposition) + 1) % ks.length];
    poserDispo(k, { main: true });
    ecran?.toile.focus();
  } });
  function peindreDispo() {
    const sure = dispoSure();
    boutonDispo.replaceChildren(icone('clavier', 14), h('span', { text: frappePhysique ? 'Touches physiques' : `${court(disposition)}${sure ? '' : ' ?'}` }));
    boutonDispo.classList.toggle('devine', !sure && !frappePhysique);
    boutonDispo.title = frappePhysique ? 'Chaque touche part telle quelle (menu Actions pour revenir au caractère)'
      : `Clavier de la VM : ${DISPOSITIONS[disposition].nom}${sure ? (detection?.disposition === disposition ? ', détecté' : ', choisi') : ', supposé'}. Clic : ${DISPOSITIONS[Object.keys(DISPOSITIONS).find(k => k !== disposition)].nom}.`;
    boutonDispo.setAttribute('aria-label', boutonDispo.title);
  }
  peindreDispo();

  // Le panneau du presse-papiers.
  const recu = h('pre', { class: 'presse-recu vide-doux', text: 'Rien de copié dans la VM pour l\'instant.' });
  const copierIci = h('button', { class: 'btn sm', type: 'button', disabled: true, onclick: async () => {
    try { await navigator.clipboard.writeText(ecran?.dernierPresse || ''); toast('Copié ici.'); } catch { toast('Le navigateur refuse : sélectionne le texte et copie-le.', true); }
  } }, icone('copie', 13), 'Copier ici');
  const aEnvoyer = h('textarea', { class: 'presse-envoi', rows: 3, placeholder: `Colle ici ce que tu veux envoyer (${MOD}V), ou fais ${MOD}V directement dans l'écran.`, spellcheck: false });
  const choixDispo = h('select', { class: 'presse-dispo', 'aria-label': 'Disposition du clavier de la VM', onchange: e => poserDispo(e.target.value, { main: true }) },
    Object.entries(DISPOSITIONS).map(([k, d]) => h('option', { value: k, text: d.nom, selected: k === disposition })));
  const avance = h('span', { class: 'note' });
  // Taper : ProxLab tape le texte lui-même dans la VM, par sa propre connexion
  // à l'écran. On peut quitter la page ou fermer l'écran : la frappe continue,
  // et se retrouve ici (barre de l'écran) en revenant.
  const urlFrappe = `/api/machines/${encodeURIComponent(f.node)}/qemu/${f.vmid}/frappe`;
  let suiviFrappe = null, frappeVue = null;
  const frappeChip = h('span', { class: 'frappe-chip', hidden: true });
  const duree = (n, ms) => { const s = Math.ceil(n * ms / 1000); return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`; };
  let frappeEnCours = false;
  const peindreFrappe = fr => {
    const enCours = fr?.etat === 'en cours';
    frappeEnCours = enCours;
    frappeChip.hidden = !enCours;
    avance.textContent = enCours ? `frappe ${fr.tapes}/${fr.total}…` : '';
    if (enCours) frappeChip.replaceChildren(icone('clavier', 13), h('span', { text: `Frappe ${fr.tapes}/${fr.total} · reste ${duree(fr.total - fr.tapes, fr.msParCaractere)}` }),
      h('button', { class: 'btn sm flat', type: 'button', onclick: sur(() => arreterFrappe()) }, 'Arrêter'));
  };
  const arreterFrappe = async () => { frappeEnCours = false; peindreFrappe(await api.del(urlFrappe)); toast('Frappe arrêtée.'); ecran?.toile.focus({ preventScroll: true }); };
  // Suppr, ⌫ ou Échap dans l'écran pendant une frappe : elle s'arrête, la touche ne part pas.
  const toucheArret = e => { if (!frappeEnCours || !TOUCHES_ARRET_FRAPPE.has(e.key)) return false; arreterFrappe().catch(x => toast(x.message, true)); return true; };
  const suivreFrappe = async () => {
    clearTimeout(suiviFrappe);
    if (!membre) return;
    let fr;
    try { fr = await api.get(urlFrappe); } catch { return; }
    peindreFrappe(fr);
    if (fr.etat === 'en cours') { frappeVue = fr.debut; suiviFrappe = setTimeout(suivreFrappe, 700); return; }
    // La fin d'une frappe suivie ici : dite une fois.
    if (frappeVue && frappeVue === fr.debut) {
      frappeVue = null;
      if (fr.etat === 'terminée') toast(fr.sautes ? `Tapé, sauf ${fr.sautes} caractère${fr.sautes > 1 ? 's' : ''} absent${fr.sautes > 1 ? 's' : ''} de la disposition de la VM.` : `Frappe terminée : ${fr.tapes} caractère${fr.tapes > 1 ? 's' : ''}.`, !!fr.sautes);
      else if (fr.etat === 'échec') toast(`Frappe interrompue (${fr.tapes}/${fr.total}) : ${fr.message}`, true);
    }
  };
  const taper = async texte => {
    texte = String(texte ?? '');
    if (!texte) return toast('Rien à taper.');
    const n = [...texte].length;
    if (n > FRAPPE_MAX) return toast(`Au plus ${FRAPPE_MAX.toLocaleString('fr-FR')} caractères par frappe (ici ${n.toLocaleString('fr-FR')}).`, true);
    if (!await frappePermise(texte, disposition)) return;
    const manque = intapables(texte, disposition);
    let fr;
    try { fr = await api.post(urlFrappe, { texte, disposition }); } catch (e) { return toast(e.message, true); }
    frappeVue = fr.debut;
    peindreFrappe(fr);
    if (manque.length) toast(`Absent${manque.length > 1 ? 's' : ''} de la disposition ${DISPOSITIONS[disposition].nom}, sauté${manque.length > 1 ? 's' : ''} : ${manque.slice(0, 8).join(' ')}`, true);
    else if (fr.total > 150) toast(`ProxLab tape ${fr.total.toLocaleString('fr-FR')} caractères dans la VM (environ ${duree(fr.total, fr.msParCaractere)}) : tu peux quitter la page, la frappe continue ; Suppr ou Échap dans l'écran l'arrête.`);
    ecran?.toile.focus();
    suiviFrappe = setTimeout(suivreFrappe, 500);
  };
  suivreFrappe();
  const coller = texte => {
    if (!ecran?.actif) return toast('Ouvre l\'écran d\'abord.', true);
    ecran.envoyerPresse(texte);
    ecran.toile.focus();
    setTimeout(() => ecran?.combinaison('v'), 150);
  };
  const branche = admin ? h('button', { class: 'btn sm', type: 'button', onclick: sur(async () => {
    if (!await confirmer('Brancher le presse-papiers de cette VM ?', 'Proxmox ajoute « clipboard=vnc » à son affichage : pris en compte au prochain démarrage complet (Redémarrer depuis ProxLab suffit). Une VM ainsi réglée ne migre plus à chaud. Dans la VM, spice-vdagent doit tourner (déjà là sur Fedora, Ubuntu et la plupart des bureaux Linux).', { oui: 'Brancher' })) return;
    await api.post(`/api/machines/${encodeURIComponent(f.node)}/qemu/${f.vmid}/acces`, { pressePapiers: true });
    toast('Presse-papiers branché : redémarre la VM pour qu\'il prenne effet.');
    relire?.();
  }) }, 'Brancher le presse-papiers') : null;
  const passerVirtio = sur(async () => {
    if (!await confirmer('Passer l\'affichage en VirtIO-GPU ?', `Proxmox remplace l'affichage « ${genreVga} » par « virtio » (les autres options, dont le presse-papiers, restent) : pris en compte au prochain démarrage complet (Redémarrer depuis ProxLab suffit). L'écran de la VM peut alors prendre la taille de ta fenêtre. Linux le gère seul ; Windows demande le pilote VirtIO-GPU (virtio-win).`, { oui: 'Passer en VirtIO-GPU' })) return;
    await api.post(`/api/machines/${encodeURIComponent(f.node)}/qemu/${f.vmid}/acces`, { ajustement: true });
    toast('Affichage VirtIO-GPU réglé : redémarre la VM pour qu\'il prenne effet.');
    relire?.();
  });
  const activerAgent = sur(async () => {
    if (!await confirmer('Activer l\'agent QEMU de cette VM ?', 'Proxmox coche « Agent QEMU » : pris en compte au prochain démarrage complet (Redémarrer depuis ProxLab suffit). Dans la VM, qemu-guest-agent doit être installé (déjà là sur Fedora ; sinon : sudo dnf install qemu-guest-agent, ou sudo apt install qemu-guest-agent). ProxLab lui demandera alors la disposition du clavier, par un script fixe qui ne fait que la lire.', { oui: 'Activer' })) return;
    await api.post(`/api/machines/${encodeURIComponent(f.node)}/qemu/${f.vmid}/acces`, { agent: true });
    toast('Agent QEMU activé : redémarre la VM pour qu\'il prenne effet.');
    relire?.();
  });
  const panneau = h('div', { class: 'presse', hidden: true },
    h('div', { class: 'presse-col' },
      h('div', { class: 'presse-tete' }, h('b', { text: 'Copié dans la VM' }), copierIci),
      recu,
      agent ? h('p', { class: 'hint', text: `Copie dans la VM : le texte arrive ici. ${MOD}C dans l'écran le met directement dans ton presse-papiers.` })
        : agentPrevu ? h('p', { class: 'hint', text: 'Presse-papiers branché, actif au prochain redémarrage de la VM (bouton Redémarrer, en haut). D\'ici là, coller tape le texte.' })
          : h('div', { class: 'note-bloc' }, h('p', { class: 'hint', text: 'Le presse-papiers de cette VM n\'est pas branché : ce qu\'elle copie ne peut pas sortir. Le coller fonctionne quand même, en tapant le texte.' }), branche)),
    h('div', { class: 'presse-col' },
      h('div', { class: 'presse-tete' }, h('b', { text: 'Envoyer à la VM' }), avance),
      aEnvoyer,
      h('div', { class: 'presse-actions' },
        agent ? h('button', { class: 'btn sm solid', type: 'button', onclick: () => coller(aEnvoyer.value) }, icone('presse', 13), 'Coller dans la VM') : null,
        h('button', { class: 'btn sm' + (agent ? '' : ' solid'), type: 'button', onclick: () => taper(aEnvoyer.value) }, icone('clavier', 13), 'Taper dans la VM'),
        h('label', { class: 'presse-label' }, h('span', { class: 'cache-s', text: 'Clavier de la VM' }), choixDispo)),
      agent ? h('label', { class: 'presse-label presse-mode' }, h('span', { text: `${MOD}V dans l'écran` }),
        h('select', { class: 'presse-dispo', onchange: e => { modeColler = e.target.value; poserLocal('proxlab-coller', modeColler); } },
          h('option', { value: 'taper', text: 'tape le texte', selected: modeColler !== 'agent' }), h('option', { value: 'agent', text: 'colle par le presse-papiers de la VM', selected: modeColler === 'agent' }))) : null,
      h('p', { class: 'hint', text: `${MOD}V dans l'écran : ProxLab tape ton presse-papiers lui-même, au clavier de la VM — ça marche partout, même à l'écran de connexion, et ça continue si tu quittes la page.${agent ? ' Le presse-papiers de la VM demande spice-vdagent, qui ne relaie rien sous GNOME Wayland (Fedora par défaut).' : ''}` })));
  const montrerPanneau = (ouvert = panneau.hidden) => { panneau.hidden = !ouvert; if (ouvert) actions.bouton.classList.remove('signal'); };
  // Coller : le texte d'ici, tapé ou passé par le presse-papiers de la VM.
  const collerTexte = (t, maj = false) => {
    if (!t) return toast('Le presse-papiers est vide.');
    if (agent && modeColler === 'agent') { ecran.envoyerPresse(t); setTimeout(() => ecran?.combinaison('v', maj), 150); } else taper(t);
  };
  // Fiche dont l'écran est dans la fenêtre à part : le presse-papiers est lu
  // ici (le clic est ici), le texte part là-bas.
  const collerVersApart = () => {
    if (!navigator.clipboard?.readText) { montrerPanneau(true); aEnvoyer.focus(); return toast('Colle ton texte dans le panneau, puis « Taper dans la VM ».'); }
    navigator.clipboard.readText().then(t => (t ? versApart({ agir: 'coller', texte: t }) : toast('Le presse-papiers est vide.')), () => { montrerPanneau(true); aEnvoyer.focus(); });
  };
  const collerDepuisIci = (maj = false) => {
    if (!navigator.clipboard?.readText) { montrerPanneau(true); aEnvoyer.focus(); return toast('Colle ton texte dans le panneau, puis « Taper dans la VM ».'); }
    navigator.clipboard.readText().then(t => { ecran?.toile.focus(); collerTexte(t, maj); }, () => { montrerPanneau(true); aEnvoyer.focus(); toast(`Le navigateur n'a pas donné le presse-papiers : colle-le ici (${MOD}V), puis envoie-le.`, true); });
  };
  // Une combinaison envoyée à la VM, puis le clavier lui revient.
  const dansVm = fn => () => { if (!ecran?.actif) return; fn(); ecran.toile.focus(); };
  // Deux pleins écrans. Celui du navigateur (l'écran entier), et l'écran de la
  // VM étendu à toute la fenêtre : Safari floute une page en plein écran qui
  // reçoit beaucoup de frappes (protection contre les faux écrans), et Échap y
  // fait quitter au lieu de partir dans la VM. Sur Safari, le second par
  // défaut ; la fenêtre elle-même se met en plein écran (⌃⌘F).
  const safari = /^((?!chrome|chromium|android|crios|fxios|edg|opr).)*safari/i.test(navigator.userAgent || '');
  // Troisième voie : une fenêtre à part, rien que l'écran de la VM. macOS la met
  // en plein écran dans son propre bureau (bouton vert), à côté d'autres apps.
  let modePlein = lireLocal('proxlab-plein', safari ? 'apart' : 'ecran');
  // Seule dans sa fenêtre, la barre de l'écran (Actions, plein écran) flotte
  // au-dessus de l'image avec le bouton qui ferme la fenêtre.
  const sortieFenetre = seul
    ? h('div', { class: 'sortie-fenetre barre' })
    : h('button', { class: 'btn sm sortie-fenetre', type: 'button', title: 'Revenir à la fiche', onclick: () => fenetre(false) }, icone('croix', 14), 'Réduire');
  // En plein écran, cette barre est cachée : la souris gardée trois secondes
  // contre le bord gauche la fait apparaître (en haut à gauche) ; elle repart
  // quand la souris s'en éloigne, sauf si son menu est ouvert.
  let minuteurBord = null, minuteurCache = null;
  const barreVue = () => hote.classList.contains('barre-visible');
  const montrerBarre = on => { clearTimeout(minuteurBord); clearTimeout(minuteurCache); minuteurBord = minuteurCache = null; hote.classList.toggle('barre-visible', on); };
  const menuOuvert = () => sortieFenetre.matches(':focus-within') || !!document.querySelector('.menu-actions:not([hidden])');
  const auBord = () => { if (!minuteurBord && !barreVue()) minuteurBord = setTimeout(() => { minuteurBord = null; montrerBarre(true); }, 3000); };
  hote.addEventListener('pointermove', e => {
    if (!hote.classList.contains('fenetre')) return;
    if (sortieFenetre.contains(e.target)) { clearTimeout(minuteurCache); minuteurCache = null; return; }
    if (e.clientX - hote.getBoundingClientRect().left <= 4) return auBord();
    clearTimeout(minuteurBord); minuteurBord = null;
    if (barreVue() && !minuteurCache) minuteurCache = setTimeout(() => { minuteurCache = null; if (!menuOuvert()) montrerBarre(false); }, 1500);
  });
  // Une fenêtre à part : la souris peut sortir par la gauche, c'est le bord aussi.
  hote.addEventListener('pointerleave', e => { if (hote.classList.contains('fenetre') && e.clientX - hote.getBoundingClientRect().left <= 4) auBord(); });
  // Deux écrans de la même VM se disputeraient sa taille : celui de la fiche se
  // ferme quand la fenêtre à part s'ouvre, et se reprend d'un clic.
  let wsCourant = null;
  // La fenêtre à part et la fiche se parlent (même origine) : la fenêtre dit
  // son état toutes les deux secondes ; le menu Actions de la fiche agit sur
  // elle, plein écran compris, au lieu d'être grisé.
  const canal = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`proxlab-ecran:${f.node}/${f.vmid}`) : null;
  let fenetreApart = null, distant = null;
  const distantVivant = () => !seul && !ecran?.actif && !!fenetreApart && !fenetreApart.closed && !!distant?.actif && Date.now() - distant.t < 90e3;
  const versApart = message => { canal?.postMessage(message); try { fenetreApart?.focus(); } catch { /* fermée */ } };
  const annoncer = () => canal?.postMessage({ etat: { actif: !!ecran?.actif, l: ecran?.toile.width || 0, h: ecran?.toile.height || 0, caps: ecran?.verrous ? !!ecran.verrous.caps : null } });
  if (canal) canal.onmessage = ({ data: m }) => {
    if (!m || typeof m !== 'object') return;
    if (!seul) { if (m.etat && typeof m.etat === 'object') distant = { ...m.etat, t: Date.now() }; return; }
    if (m.qui) return annoncer();
    if (typeof m.agir !== 'string' || !ecran?.actif) return;
    if (m.agir === 'coller') return collerTexte(String(m.texte ?? ''), !!m.maj);
    const it = groupesActions().flatMap(g => g.items).find(x => x.id === m.agir);
    if (it && !it.inactif) { it.agir(); setTimeout(annoncer, 300); }
  };
  // Une fenêtre en arrière-plan voit ses minuteries ralenties : la fiche
  // redemande l'état quand on y revient et à chaque ouverture du menu.
  if (seul && canal) { setInterval(annoncer, 2000); addEventListener('focus', annoncer); }
  const demanderEtat = () => { if (!seul && fenetreApart && !fenetreApart.closed) canal?.postMessage({ qui: 1 }); };
  if (!seul) addEventListener('focus', demanderEtat);
  // Réglages changés dans l'autre fenêtre : appliqués ici aussi.
  window.addEventListener('storage', e => {
    if (!hote.isConnected) return;
    if (e.key === 'proxlab-echelle-vm' && ECHELLES.includes(e.newValue)) { echelle = e.newValue; adapterMaintenant(); }
    else if (e.key === 'proxlab-remplir') { remplir = e.newValue === '1'; hote.classList.toggle('remplir', remplir); if (ecran) ecran.remplir = remplir; }
    else if (e.key === 'proxlab-ajuster') { ajusterTaille = e.newValue === '1'; reajuster(); }
  });
  const reprendreIci = () => { try { fenetreApart?.close(); } catch { /* fermée */ } fenetreApart = null; reprise = false; essaisOuverture = 0; essaisAuto = 0; ouvrir(); };
  const apart = () => {
    const w = window.open(`/#ecran/${encodeURIComponent(f.node)}/qemu/${f.vmid}`, `proxlab-ecran-${f.node}-${f.vmid}`, 'popup,width=1280,height=800');
    if (!w) return toast('Le navigateur a bloqué la fenêtre : autorise les fenêtres de ProxLab, puis recommence.', true);
    fenetreApart = w; distant = null;
    setTimeout(demanderEtat, 4000);
    fenetre(false);
    const ancien = wsCourant; wsCourant = null;
    try { ancien?.close(); } catch { /* déjà fermé */ }
    ecran = null;
    etat.textContent = 'dans une fenêtre à part';
    hote.replaceChildren(h('p', { class: 'vide' }, 'L\'écran est ouvert dans une fenêtre à part (bouton vert de la fenêtre : plein écran dans son propre bureau). ',
      h('button', { class: 'btn sm', type: 'button', onclick: reprendreIci }, icone('ecran', 14), 'Reprendre ici')));
    // La fenêtre à part fermée : l'écran revient ici de lui-même.
    const guet = setInterval(() => {
      if (!w.closed) return;
      clearInterval(guet);
      if (hote.isConnected && !wsCourant && etat.textContent === 'dans une fenêtre à part') { reprise = false; essaisOuverture = 0; essaisAuto = 0; ouvrir(); }
    }, 800);
  };
  const fenetre = on => {
    if (seul && !on) return;
    hote.classList.toggle('fenetre', on);
    document.documentElement.classList.toggle('ecran-fenetre', on);
    montrerBarre(false);
    if (on) hote.append(sortieFenetre); else sortieFenetre.remove();
    if (on && lireLocal('proxlab-astuce-bord', '') !== '1') { poserLocal('proxlab-astuce-bord', '1'); toast('Barre cachée : garde la souris contre le bord gauche 3 secondes pour la faire apparaître.'); }
    ecran?.toile.focus({ preventScroll: true });
  };
  const pleinEcran = () => (document.fullscreenElement ? document.exitFullscreen() : hote.requestFullscreen?.())?.catch(() => {});
  const plein = () => {
    if (seul) return pleinEcran();
    if (hote.classList.contains('fenetre')) return fenetre(false);
    if (document.fullscreenElement) return pleinEcran();
    return modePlein === 'fenetre' ? fenetre(true) : modePlein === 'apart' ? apart() : pleinEcran();
  };
  // Les actions de l'écran ; « id » : celles que la fiche fait faire à la
  // fenêtre à part quand c'est elle qui tient l'écran.
  function groupesActions() {
    const vu = ecran?.actif ? { actif: true, l: ecran.toile.width, h: ecran.toile.height, caps: ecran.verrous ? !!ecran.verrous.caps : null }
      : distantVivant() ? distant : null;
    const off = !vu?.actif;
    const r = (l, maj = false) => dansVm(() => ecran.raccourci(l, { maj, disposition }));
    return [
      { titre: 'Presse-papiers', items: [
        { id: 'copier', texte: 'Copier', ic: 'copie', touche: `${MOD}C`, inactif: off, agir: dansVm(() => { ecran.armerCopie(); ecran.raccourci('c', { disposition }); }) },
        { id: 'couper', texte: 'Couper', ic: 'ciseaux', touche: `${MOD}X`, inactif: off, agir: dansVm(() => { ecran.armerCopie(); ecran.raccourci('x', { disposition }); }) },
        { texte: 'Coller', ic: 'presse', touche: `${MOD}V`, inactif: off, agir: () => (distantVivant() ? collerVersApart() : collerDepuisIci()) },
        { id: 'tout', texte: 'Tout sélectionner', ic: 'selection', touche: `${MOD}A`, inactif: off, agir: r('a') },
        { texte: 'Taper un texte…', ic: 'clavier', agir: () => { montrerPanneau(true); aEnvoyer.focus(); } },
      ] },
      { titre: 'Clavier de la VM', items: [
        ...Object.entries(DISPOSITIONS).map(([k, d]) => ({
          texte: d.nom + (detection?.disposition === k ? ' · détecté' : ''), ic: k === disposition ? 'verifie' : null,
          agir: () => { poserDispo(k, { main: true }); toast(`Clavier de la VM : ${d.nom}. Ce que tu tapes et colles arrive tel quel.`); ecran?.toile.focus(); },
        })),
        { texte: 'Touches physiques (sans traduction)', ic: frappePhysique ? 'verifie' : null, agir: () => {
          frappePhysique = !frappePhysique; poserLocal('proxlab-frappe', frappePhysique ? 'physique' : ''); peindreDispo();
          toast(frappePhysique ? 'Chaque touche part telle quelle : la disposition de la VM s’applique (jeux, raccourcis).' : 'Ce que tu tapes arrive tel quel dans la VM, quelle que soit la disposition de ton clavier.');
          ecran?.relacher(); ecran?.toile.focus();
        } },
        { texte: detection?.disposition ? 'Détecter à nouveau' : 'Détecter le clavier de la VM', ic: 'relance', inactif: off, agir: () => { try { localStorage.removeItem(cleDispo); } catch { /* stockage du navigateur indisponible : rien à oublier */ } detecter(true); } },
        ...(detection?.raison === 'agent' && !agentPrevuClavier && admin ? [{ texte: 'Activer l\'agent QEMU…', ic: 'clavier', agir: activerAgent }] : []),
      ] },
      { titre: 'Édition', items: [
        { id: 'annuler', texte: 'Annuler', ic: 'annuler', touche: `${MOD}Z`, inactif: off, agir: r('z') },
        { id: 'retablir', texte: 'Rétablir', ic: 'retablir', touche: `${T_MAJ}Z`, inactif: off, agir: r('z', true) },
      ] },
      { titre: 'Touches', items: [
        { id: 'cas', texte: 'Ctrl+Alt+Suppr', inactif: off, agir: dansVm(() => ecran.ctrlAltSuppr()) },
        { id: 'super', texte: 'Touche Super (Windows)', inactif: off, agir: dansVm(() => ecran.combo('MetaLeft')) },
        { id: 'alttab', texte: 'Alt+Tab', inactif: off, agir: dansVm(() => ecran.combo('AltLeft', 'Tab')) },
        { id: 'echap', texte: 'Échap', inactif: off, agir: dansVm(() => ecran.combo('Escape')) },
        { id: 'impr', texte: 'Impr. écran', inactif: off, agir: dansVm(() => ecran.combo('PrintScreen')) },
      ] },
      { items: [
        { texte: panneau.hidden ? 'Afficher le presse-papiers' : 'Masquer le presse-papiers', ic: 'presse', agir: () => montrerPanneau() },
        ...(seul ? [] : [{ texte: document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran (écran entier)', ic: 'agrandir', inactif: off, agir: () => { modePlein = 'ecran'; poserLocal('proxlab-plein', 'ecran'); if (distantVivant()) reprendreIci(); pleinEcran(); } }]),
        ...(seul ? [] : [
          { texte: 'Plein écran dans la fenêtre', ic: modePlein === 'fenetre' ? 'verifie' : 'agrandir', inactif: off, agir: () => { modePlein = 'fenetre'; poserLocal('proxlab-plein', 'fenetre'); if (distantVivant()) reprendreIci(); fenetre(true); } },
          { texte: 'Ouvrir dans une fenêtre à part', ic: modePlein === 'apart' ? 'verifie' : 'lien', agir: () => { modePlein = 'apart'; poserLocal('proxlab-plein', 'apart'); apart(); } },
        ]),
        { texte: 'Écran en continu (reste ouvert en quittant la page)', ic: ecranContinu() ? 'verifie' : null, agir: () => {
          const on = !ecranContinu(); poserLocal('proxlab-ecran-continu', on ? '1' : '0');
          if (!on) lacherEcrans();
          toast(on ? 'L’écran reste connecté quand tu quittes la page ou l’onglet, et reprend tel quel au retour (trois VM au plus).' : 'L’écran se ferme de nouveau en quittant la page.');
        } },
        { texte: 'Plein écran sans bandes noires (image étirée)', ic: remplir ? 'verifie' : null, agir: () => {
          remplir = !remplir; poserLocal('proxlab-remplir', remplir ? '1' : '0');
          hote.classList.toggle('remplir', remplir); if (ecran) ecran.remplir = remplir;
          toast(remplir ? 'En plein écran, l’image remplit tout l’écran.' : 'En plein écran, l’image garde ses proportions (bandes noires possibles).');
        } },
        { texte: 'Ajuster la VM à la fenêtre', ic: ajusterTaille ? 'verifie' : null, agir: () => {
          ajusterTaille = !ajusterTaille; poserLocal('proxlab-ajuster', ajusterTaille ? '1' : '0'); refusSignale = false; if (tailleVue) peindreEtat();
          if (!ajusterTaille) return toast('La VM garde sa résolution.');
          if (!/^virtio/.test(genreVga)) return toast(`L'affichage de cette VM (${genreVga}) ne change pas de taille : il faut VirtIO-GPU${admin ? ' (« Passer en VirtIO-GPU… »)' : ' : demande-le à un administrateur'}.`, true);
          toast('La VM prend la taille de la fenêtre et grandit avec elle ; pour la rapetisser : « Adapter la VM à sa fenêtre maintenant ».'); reajuster();
        } },
        { id: 'reveiller', texte: 'Réveiller l\'écran', ic: 'ecran', inactif: off, agir: dansVm(() => ecran.reveiller()) },
        { id: 'adapter', texte: 'Adapter la VM à sa fenêtre maintenant', inactif: off || !ajusterTaille, agir: () => {
          ecran.ajuster(...cibleTaille().map(v => Math.round(v * densite())));
          toast('La VM prend la taille de la fenêtre. Une console texte Linux peut alors être rognée : « Revenir à … » la rend entière.');
        } },
        ...(() => { const m = tailleMax(); return m && !off && (m[0] !== vu.l || m[1] !== vu.h) ? [{ id: 'rmax', texte: `Revenir à ${m[0]} × ${m[1]} (écran entier)`, agir: () => { ecran.ajuster(m[0], m[1], { libre: true }); toast(`La VM revient à ${m[0]} × ${m[1]}.`); } }] : []; })(),
        ...(typeof vu?.caps === 'boolean' ? [{ id: 'caps', texte: `Verr. Maj de la VM : ${vu.caps ? 'allumé — l’éteindre' : 'éteint — l’allumer'}`, inactif: off, agir: dansVm(() => ecran.basculerCaps()) }] : []),
        { id: 'r1280', texte: 'Revenir à 1280 × 800', inactif: off, agir: () => {
          ajusterTaille = false; poserLocal('proxlab-ajuster', '0');
          ecran.ajuster(1280, 800, { libre: true });
          toast('La VM revient à 1280 × 800 ; l\'ajustement à la fenêtre est coupé (menu Actions pour le remettre).');
        } },
        ...ECHELLES.map(k => ({ texte: `Taille de la VM ×${k.replace('.', ',')}${k === '1' ? ' (la plus légère)' : k === '2' ? ' (lourde sans carte graphique)' : ''}`, ic: echelle === k ? 'verifie' : null, inactif: !ajusterTaille, agir: () => {
          echelle = k; poserLocal('proxlab-echelle-vm', k);
          toast(`La VM prend ${k === '1' ? 'un pixel' : `${k.replace('.', ',')} pixels`} par point de la fenêtre${k === '1' ? ' : le plus léger pour elle' : ' : plus fin, plus lourd pour une VM sans carte graphique'}.`);
          adapterMaintenant();
        } })),
        ...(admin && !/^virtio/.test(genreVga) && !virtioPrevu ? [{ texte: 'Passer en VirtIO-GPU…', ic: 'ecran', agir: passerVirtio }] : []),
      ] },
    ];
  }
  const actions = menuActions(() => {
    demanderEtat();
    const groupes = groupesActions();
    if (!distantVivant()) return groupes;
    return groupes.map(g => ({ ...g, items: g.items.map(it => (it.id ? { ...it, agir: () => versApart({ agir: it.id }) } : it)) }));
  });

  // Taille fixe (affichage sans redimensionnement) : dit en permanence à côté
  // de la résolution, avec le geste qui la débloque à portée de main.
  let fixe = false, tailleVue = '', majVm = false;
  const peindreEtat = () => { etat.textContent = `ouvert · ${tailleVue}${majVm ? ' · VERR. MAJ' : ''}${fixe && ajusterTaille ? ` · taille fixe : affichage ${virtioPrevu ? 'VirtIO-GPU au prochain démarrage' : genreVga}` : ''}`; };
  const boutonVirtio = admin && !/^virtio/.test(genreVga) && !virtioPrevu
    ? h('button', { class: 'btn sm', type: 'button', hidden: true, title: 'L\'écran de la VM suivra la taille de la fenêtre', onclick: () => passerVirtio() }, icone('ecran', 14), 'Passer en VirtIO-GPU')
    : null;
  const outils = h('div', { class: 'ecran-outils' },
    boutonVirtio,
    boutonDispo,
    actions.ancre,
    // Dans la fenêtre à part, le plein écran est celui de la fenêtre (bouton vert) :
    // celui du navigateur ferait flouter Safari.
    seul ? null : h('button', { class: 'btn sm', type: 'button', disabled: true, 'aria-label': 'Plein écran', title: 'Plein écran', onclick: plein }, icone('agrandir', 14)));
  const activer = on => { for (const b of outils.querySelectorAll(':scope > button')) b.disabled = !on; copierIci.disabled = !on || !ecran?.dernierPresse; };

  // Une ouverture à la fois, comme pour la console texte.
  let ouverture = false;
  const ouvrir = sur(async () => {
    if (ouverture) return;
    ouverture = true; bouton.disabled = true;
    try { await ouvrirMaintenant(); } finally { ouverture = false; bouton.disabled = false; }
  });
  async function ouvrirMaintenant() {
    // Une première connexion qui n'aboutit pas (Proxmox encore en train de
    // préparer l'écran, coupure pendant la poignée) : ProxLab refait lui-même ce
    // que faisait « Rouvrir », deux fois au plus, jusqu'à la première image.
    let vivante = false, chien = null;
    const { passe } = await api.post('/api/console', { ...cible, mode: 'ecran' });
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/console?passe=${encodeURIComponent(passe)}`);
    wsCourant = ws;
    ws.binaryType = 'arraybuffer';
    ecran = new Ecran(hote, ws, {
      surTouche: toucheArret,
      remplir, nette: true,
      // Le caractère tapé ici, sur la bonne touche de la VM ; ou la touche physique, au choix.
      disposition: () => (frappePhysique ? null : disposition),
      surIntapable: ch => { if (intapableVu !== ch) { intapableVu = ch; toast(`« ${ch} » n'existe pas sur le clavier ${DISPOSITIONS[disposition].nom} de la VM.`, true); } },
      surEtat: (q, d) => {
        if (q === 'pret') { vivante = true; essaisOuverture = 0; clearTimeout(chien); }
        if (q === 'ajustable') {
          if (echelleNeuve) { echelleNeuve = false; poserLocal('proxlab-echelle-vm', echelle); return adapterMaintenant(); }
          return reajuster();
        }
        if (q === 'ajustement-refuse') {
          // Dit une fois par VM et par affichage, pas à chaque ouverture.
          const cle = `proxlab-ajuster-refus:${f.node}/${f.vmid}`;
          if (!refusSignale && lireLocal(cle, '') !== genreVga) toast(`L'affichage de cette VM (${genreVga}) ne change pas de taille${/^virtio/.test(genreVga) ? '' : ' : il faut VirtIO-GPU (menu Actions)'}.`, true);
          refusSignale = true; poserLocal(cle, genreVga);
          fixe = true; if (boutonVirtio) boutonVirtio.hidden = false;
          return peindreEtat();
        }
        if (q === 'taille') { tailleVue = d; const [l, h] = d.split(' × ').map(Number); noterTaille(l, h); return peindreEtat(); }
        if (q === 'verrous') { majVm = d.caps; return peindreEtat(); }
        etat.textContent = q === 'pret' ? 'ouvert' : q;
      },
      surPresse: texte => {
        recu.textContent = texte || '(vide)'; recu.classList.toggle('vide-doux', !texte); copierIci.disabled = !texte;
        if (panneau.hidden) actions.bouton.classList.add('signal');
      },
      // ⌘V / Ctrl+V dans l'écran : le texte du collage natif, sinon la lecture du presse-papiers.
      surColler: ({ maj, texte }) => (texte !== null && texte !== undefined ? collerTexte(texte, maj) : collerDepuisIci(maj)),
      // Une reconnexion garde l'image d'avant jusqu'à la première nouvelle : pas d'écran noir.
      garderImage: !!hote.querySelector('canvas.ecran'),
    });
    if (hote.classList.contains('fenetre')) hote.append(sortieFenetre);
    garder({ detruire: () => { ecran?.relacher(); fenetre(false); } }, ws);
    etat.textContent = 'connexion…';
    ws.addEventListener('message', ev => {
      if (ws !== wsCourant) return;
      dernier = Date.now();
      if (typeof ev.data !== 'string') return ecran?.recevoir(ev.data);
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.pret) { essaisAuto = 0; ecran.demarrer(); ouvertA = Date.now(); activer(true); ecran.toile.focus(); if (!DISPOSITIONS[lireLocal(cleDispo, '')] && !detection?.disposition) detecter(); }
      if (m.fin) {
        etat.textContent = 'fermé';
        if (/session fermée|refusé/.test(m.fin)) sansRetour = true;
        // Proxmox qui coupe dans les premières secondes : une reprise, automatique.
        if (/fermé par Proxmox/.test(m.fin) && !reprise && Date.now() - ouvertA < 8000) { reprise = true; etat.textContent = 'reprise…'; setTimeout(ouvrir, 600); return; }
        hote.append(h('p', { class: 'vide', text: m.fin }));
      }
    });
    const nouvelEssai = () => {
      clearTimeout(chien);
      if (ws !== wsCourant || vivante || !hote.isConnected || essaisOuverture >= 2) return false;
      essaisOuverture++; etat.textContent = 'nouvel essai…';
      try { ws.close(); } catch { /* déjà fermé */ }
      setTimeout(ouvrir, 800);
      return true;
    };
    chien = setTimeout(nouvelEssai, 10000);
    ws.addEventListener('close', () => {
      activer(false);
      if (nouvelEssai()) return;
      if (ws === wsCourant && etat.textContent !== 'reprise…') etat.textContent = 'fermé';
      setTimeout(revenir, 1500);
    });
    dernier = Date.now();
    bouton.replaceChildren(icone('relance', 14), 'Rouvrir');
  }
  // Un écran laissé de côté (autre onglet, ordinateur en veille, tunnel qui a
  // coupé) : dès qu'on le regarde de nouveau, il se rouvre de lui-même s'il est
  // tombé ou sans nouvelles depuis 70 s (ProxLab bat toutes les 25 s), sinon
  // l'image entière est redemandée. Trois essais d'affilée au plus ; jamais
  // après une session fermée, ni quand l'écran est dans une fenêtre à part.
  let dernier = 0, essaisAuto = 0, essaisOuverture = 0, sansRetour = false, monte = false;
  const morte = () => !!wsCourant && (wsCourant.readyState > 1 || Date.now() - dernier > 70e3);
  // Une connexion peut rester ouverte et ne plus rien donner (Proxmox ou le
  // tunnel l'ont lâchée sans la fermer) : on demande l'image entière ; sans
  // elle en cinq secondes, l'écran est rouvert.
  let sondeEnCours = false;
  function sonder() {
    if (!ecran?.actif || sondeEnCours || !wsCourant || wsCourant.readyState !== 1) return;
    sondeEnCours = true;
    const ws0 = wsCourant, e0 = ecran, t = Date.now();
    e0.demander(false);
    setTimeout(() => {
      sondeEnCours = false;
      if (wsCourant !== ws0 || ecran !== e0 || e0.derniereImage >= t || !hote.isConnected || ouverture || sansRetour) return;
      essaisAuto = 0; reprise = true; etat.textContent = 'reconnexion…';
      try { ws0.close(); } catch { /* déjà fermé */ }
      ouvrir();
    }, 5000);
  }
  // Retour sur l'écran après un moment sans image : la même vérification au premier geste.
  hote.addEventListener('pointerdown', () => { if (ecran?.actif && Date.now() - ecran.derniereImage > 30e3) sonder(); }, true);
  hote.addEventListener('keydown', () => { if (ecran?.actif && Date.now() - ecran.derniereImage > 30e3) sonder(); }, true);
  function revenir() {
    if (!hote.isConnected || document.visibilityState !== 'visible' || ouverture || sansRetour) return;
    if (!morte()) return sonder();
    if (essaisAuto >= 3) return;
    essaisAuto++; reprise = true; etat.textContent = 'reconnexion…';
    try { wsCourant.close(); } catch { /* déjà fermé */ }
    ouvrir();
  }
  const surRetour = () => { if (document.visibilityState === 'visible') { ecran?.repeindre(); revenir(); if (hote.isConnected) suivreFrappe(); } };
  const nettoyer = () => { clearInterval(veille); clearTimeout(suiviFrappe); document.removeEventListener('visibilitychange', surRetour); window.removeEventListener('focus', surRetour); };
  const veille = setInterval(() => {
    if (hote.isConnected) { monte = true; if (morte()) revenir(); return; }
    // Gardé en continu hors de la fiche : il reste en vie, sans rien demander.
    if (monte && ![...ECRANS_GARDES.values()].some(x => x.el === carteEcran)) nettoyer();
  }, 20e3);
  document.addEventListener('visibilitychange', surRetour);
  window.addEventListener('focus', surRetour);
  const bouton = h('button', { class: 'btn sm solid', type: 'button', onclick: () => { reprise = false; essaisOuverture = 0; ouvrir(); } }, icone('ecran', 14), 'Ouvrir');
  // Ouvert dès le premier affichage de l'onglet ; ensuite il reste ouvert.
  if (auto && enMarche) setTimeout(() => { reprise = false; ouvrir(); }, 0);
  hote.append(h('p', { class: 'vide', text: enMarche ? `L'écran de la machine, avec le clavier et la souris. Clique dans l'image pour lui donner le clavier ; ${MOD}C et ${MOD}V copient et collent. Chaque ouverture est journalisée.` : 'La machine est arrêtée : démarre-la pour voir son écran.' }));
  if (!enMarche) bouton.disabled = true;
  if (seul) sortieFenetre.append(outils, h('button', { class: 'btn sm', type: 'button', title: 'Fermer cette fenêtre', onclick: () => window.close() }, icone('croix', 14), 'Fermer'));
  const carteEcran = h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Écran' }), etat, frappeChip, seul ? null : outils, bouton), panneau, hote);
  if (seul) fenetre(true);
  carteEcran.nettoyer = nettoyer;
  carteEcran.addEventListener('montre', () => { ecran?.repeindre(); if (ecran?.actif) ecran.toile.focus({ preventScroll: true }); revenir(); });
  return carteEcran;
}

// La console d'une VM sans port série : ce qu'il faut, et le bouton pour l'ajouter.
// L'écran fluide : Sunshine encode l'écran de la VM sur sa carte graphique,
// ProxLab relaie, le navigateur décode (web/fluide.js). Réglé une fois par un
// administrateur : l'adresse de Sunshine, puis l'appairage par un PIN.
const QUALITES_FLUIDE = [
  { k: 'tres-haute', nom: 'Très haute · 1440p 60 i/s', largeur: 2560, hauteur: 1440, ips: 60, debit: 40000 },
  { k: 'haute', nom: 'Haute · 1080p 60 i/s', largeur: 1920, hauteur: 1080, ips: 60, debit: 20000 },
  { k: 'equilibree', nom: 'Équilibrée · 1080p 30 i/s', largeur: 1920, hauteur: 1080, ips: 30, debit: 10000 },
  { k: 'legere', nom: 'Légère · 720p 30 i/s', largeur: 1280, hauteur: 720, ips: 30, debit: 4000 },
];
// La taille du flux : la hauteur de la qualité choisie, aux proportions de
// l'écran (le plein écran est là où l'image doit le remplir). Avec l'écran de
// la VM réglé sur cette taille, plus aucune bande noire.
function tailleFluide(q, ecranL = screen.width, ecranH = screen.height) {
  const r = ecranL > 0 && ecranH > 0 ? ecranL / ecranH : 16 / 9;
  const paire = v => Math.round(v / 2) * 2;
  let l, h;
  if (r >= 1) { h = q.hauteur; l = paire(h * r); if (l > 3840) { l = 3840; h = paire(l / r); } }
  else { l = q.hauteur; h = paire(l / r); if (h > 2160) { h = 2160; l = paire(h * r); } }
  return { largeur: Math.max(320, l), hauteur: Math.max(200, h) };
}
function ecranFluide(f, garder, relire, { auto = false } = {}) {
  const url = `/api/machines/${encodeURIComponent(f.node)}/qemu/${f.vmid}/fluide`;
  const enMarche = f.status === 'running';
  const carte = h('div', { class: 'card' });
  let suivi = null, fermerVue = () => {}, commandeAffichee = '';
  const choix = { noeud: null, lecture: null, manuel: false, commande: false };
  // Chaque peinture a son numéro : une lecture partie avant (suivi d'une
  // commande, peinture précédente) ne repeint plus une carte déjà remplacée.
  let tour = 0;
  const peindre = async () => {
    clearTimeout(suivi);
    const ici = ++tour;
    let c;
    try { c = await api.get(url); } catch (e) { if (ici === tour) carte.replaceChildren(h('header', {}, h('h2', { text: 'Écran fluide' })), h('p', { class: 'vide', text: e.message })); return; }
    if (ici !== tour) return;
    fermerVue();
    if (c.configure && c.appaire) visionneuse(c); else reglage(c);
  };
  carte.nettoyer = () => { tour++; clearTimeout(suivi); fermerVue(); };

  function reglage(c) {
    const titre = h('header', {}, h('h2', { text: 'Écran fluide' }), h('span', { class: 'note', text: c.configure ? 'à appairer' : 'à régler' }));
    const intro = h('p', { text: 'L\'écran de la VM encodé en vidéo par sa carte graphique (Sunshine), décodé par ton navigateur : bien plus fluide que l\'écran VNC, même plein écran et animé. Le flux passe par ProxLab, chiffré, comme le reste.' });
    if (!admin) return carte.replaceChildren(titre, h('div', { class: 'pad' }, intro, h('p', { class: 'hint', text: c.configure ? 'Un administrateur doit encore appairer Sunshine à ProxLab.' : 'Un administrateur le règle ici, une fois : Sunshine dans la VM, puis son adresse et un appairage.' })));
    const cmd = 'lan_encryption_mode = 2';
    const copier = texte => async () => { try { await navigator.clipboard.writeText(texte); toast('Copié.'); } catch { toast(texte); } };
    const champ = h('input', { class: 'field', maxlength: 253, value: c.hote || '', placeholder: 'adresse de la VM', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Adresse de Sunshine dans la VM' });
    const propositions = h('div', { class: 'puces' });
    api.get(url + '/adresses').then(r => {
      if (r.adresses?.length) propositions.replaceChildren(h('small', { class: 'dim', text: 'Adresses de la VM (agent QEMU) : ' }), ...r.adresses.map(a => h('button', { class: 'btn sm flat', type: 'button', onclick: () => { champ.value = a.adresse; champ.focus(); } }, `${a.adresse} (${a.interface})`)));
      else if (r.raison) propositions.replaceChildren(h('small', { class: 'dim', text: r.raison }));
    }).catch(() => {});
    const verifier = h('button', { class: 'btn sm solid', type: 'button', onclick: sur(async () => {
      const hote = champ.value.trim();
      if (!hote) return toast('Adresse requise.', true);
      await api.post(url, { hote });
      toast('Sunshine répond.');
      peindre();
    }) }, icone('verifie', 14), c.configure ? 'Changer' : 'Vérifier');
    const a = c.appairage;
    let etapeAppairage;
    if (a?.etat === 'attente') {
      etapeAppairage = h('div', { class: 'pin-fluide' },
        h('p', {}, 'Dans la VM, ouvre ', h('code', { text: 'https://localhost:47990' }), ' (Sunshine, onglet PIN), choisis la demande « ProxLab » et saisis :'),
        h('div', { class: 'pin', text: a.pin || '····' }),
        h('small', { class: 'dim', text: 'En attente de Sunshine… (trois minutes au plus)' }));
      suivi = setTimeout(peindre, 2000);
    } else {
      etapeAppairage = h('div', {},
        a?.etat === 'echec' ? h('p', { class: 'erreur', text: `Appairage échoué : ${a.message}` }) : null,
        h('button', { class: 'btn sm solid', type: 'button', disabled: !c.configure, onclick: sur(async () => { await api.post(url + '/appairage'); peindre(); }) }, icone('lien', 14), 'Appairer'));
    }
    // Relier la VM : ProxLab lance lui-même le script dans le shell du nœud
    // (« Relier »), sinon une ligne à coller dans le terminal de l'ordinateur.
    // L'adresse de la VM côté nœud est trouvée par le script, sans choix ici.
    const k = c.commande;
    const enCours = k && ['attente', 'en cours', 'verification'].includes(k.etat);
    const cleSsh = `proxlab-fluide-ssh:${f.node}`;
    const terminal = h('input', { class: 'field', maxlength: 200, value: lireLocal(cleSsh, ''), placeholder: 'ssh root@…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Commande qui ouvre un terminal root sur le nœud' });
    const prefixe = () => terminal.value.replace(/[\r\n]/g, ' ').trim();
    terminal.addEventListener('input', () => poserLocal(cleSsh, prefixe()));
    const remplirTerminal = () => { if (!terminal.value && choix.noeud?.ip) terminal.value = `ssh root@${choix.noeud.ip}`; };
    if (!choix.noeud && !choix.lecture) {
      choix.lecture = api.get(url + '/adresses').then(r => { choix.noeud = r.noeud || { ip: '' }; }).catch(() => { choix.noeud = { ip: '' }; }).finally(() => { choix.lecture = null; remplirTerminal(); });
    }
    remplirTerminal();
    const relier = h('button', { class: 'btn sm solid', type: 'button', disabled: !!(enCours && k.mode === 'auto'), onclick: sur(async () => {
      await api.post(url + '/relier'); commandeAffichee = ''; peindre();
    }) }, icone('lien', 14), 'Relier');
    const copierCommande = h('button', { class: `btn sm ${c.auto ? 'flat' : 'solid'}`, type: 'button', onclick: sur(async () => {
      poserLocal(cleSsh, prefixe());
      const p = prefixe();
      const texte = api.post(url + '/commande').then(r => `curl -fsS '${location.origin}${r.chemin}' | ${p ? `${p} bash` : 'bash'}\n`);
      try {
        if (window.ClipboardItem && navigator.clipboard?.write) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': texte.then(t => new Blob([t], { type: 'text/plain' })) })]);
        else await navigator.clipboard.writeText(await texte);
        commandeAffichee = '';
        toast('Commande copiée : colle-la dans le terminal de ton ordinateur.');
      } catch {
        commandeAffichee = await texte;   // une erreur de l'API passe d'abord (toast)
      }
      peindre();
    }) }, icone('copie', 14), 'Copier la commande');
    // Presse-papiers refusé : la commande montrée, à copier à la main.
    const sortieManuelle = h('div', {});
    if (commandeAffichee && k?.mode === 'commande' && enCours) {
      const zone = h('textarea', { class: 'field commande-fluide', rows: 2, readonly: true, spellcheck: 'false', 'aria-label': 'Commande à copier' });
      zone.value = commandeAffichee;
      zone.addEventListener('focus', () => zone.select());
      sortieManuelle.replaceChildren(h('small', { class: 'dim', text: 'Copie automatique impossible ici : sélectionne la commande et copie-la.' }), zone);
    } else commandeAffichee = '';
    // L'avancement : les lignes du script (relié par ProxLab), puis l'issue.
    // Pendant l'attente, seul l'état est relu ; la carte n'est repeinte que quand il change.
    const lignes = k?.mode === 'auto' && k.lignes?.length ? h('ul', { class: 'lignes-fluide' }, ...k.lignes.map(l => h('li', { text: l }))) : null;
    let etatCommande = null;
    if (enCours) {
      etatCommande = h('p', { class: 'dim', text: k.mode === 'auto' ? 'ProxLab relie la VM : relais sur le nœud, Sunshine réglé dans la VM…' : 'En attente de la commande… ProxLab termine tout seul dès qu\'elle a tourné (quinze minutes au plus).' });
      const depart = tour, vues = k.lignes?.length || 0;
      const relire = async () => {
        let n;
        try { n = await api.get(url); } catch { if (depart === tour) suivi = setTimeout(relire, 4000); return; }
        if (depart !== tour) return;
        if ((n.commande?.etat || '') !== k.etat || (n.commande?.lignes?.length || 0) !== vues || (n.configure && n.appaire)) return peindre();
        suivi = setTimeout(relire, k.mode === 'auto' ? 800 : 2000);
      };
      suivi = setTimeout(relire, k.mode === 'auto' ? 800 : 2000);
    } else if (k?.etat === 'echec') etatCommande = h('p', { class: 'erreur', text: `${k.mode === 'auto' ? 'Relier' : 'La commande'} : ${k.message}` });
    else if (k?.etat === 'expiree') etatCommande = h('p', { class: 'dim', text: 'Commande expirée : recopie-la.' });

    const parCommande = [
      h('div', { class: 'ligne-fluide' }, terminal, copierCommande),
      h('small', { class: 'dim', text: 'Une ligne pour le terminal de ton ordinateur, jamais pour la VM : elle va chercher chez ProxLab un script à usage unique et le lance en root sur le nœud. Le terminal : la commande qui ouvre un shell root sur le nœud depuis ton poste (retenue par ce navigateur) ; vide, colle-la dans le Shell du nœud, dans Proxmox.' }),
      sortieManuelle,
    ];
    if (a?.etat === 'attente' || a?.etat === 'echec') choix.manuel = true;
    if (k?.mode === 'commande' && enCours) choix.commande = true;
    const manuelOuvert = !!choix.manuel;
    const etapeRelier = c.auto
      ? h('li', {}, h('span', { text: 'La relier, une fois : ProxLab ouvre le shell du nœud et s\'occupe de tout. Il relaie Sunshine par le nœud (ProxLab seul admis), le règle dans la VM (image toujours chiffrée, ports ouverts au nœud seul, VM plus annoncée sur le réseau) et lui présente ProxLab : ni PIN, ni mot de passe, rien à coller.' }),
        h('div', { class: 'ligne-fluide' }, relier), lignes, etatCommande,
        h('details', { class: 'manuel', ...(choix.commande ? { open: true } : {}), ontoggle: e => { choix.commande = e.target.open; } }, h('summary', { text: 'Ou par une commande à coller' }), ...parCommande))
      : h('li', {}, h('span', { text: 'La relier, une fois, par une commande : ProxLab ne peut pas ouvrir le shell du nœud lui-même (la liaison n\'a pas l\'utilisateur root@pam et son mot de passe). Elle relaie Sunshine par le nœud, le règle dans la VM et lui présente ProxLab : ni PIN, ni mot de passe.' }), ...parCommande, etatCommande);
    carte.replaceChildren(titre, h('div', { class: 'pad sans-serie' }, intro,
      h('ol', { class: 'etapes' },
        h('li', {}, 'Dans la VM, installer Sunshine (github.com/LizardByte/Sunshine ; Arch : paquet AUR « sunshine ») et ouvrir une session.'),
        etapeRelier),
      h('details', { class: 'manuel', ...(manuelOuvert ? { open: true } : {}), ontoggle: e => { choix.manuel = e.target.open; } }, h('summary', { text: 'Réglage à la main : adresse et PIN' }),
        h('ol', { class: 'etapes' },
          h('li', {}, 'Pour que l\'image ne circule jamais en clair, ajouter à la configuration de Sunshine : ',
            h('span', { class: 'cmd' }, h('code', { text: cmd }), h('button', { class: 'btn flat sm', type: 'button', 'aria-label': 'Copier', onclick: copier(cmd) }, icone('copie', 12)))),
          h('li', { class: c.configure ? 'fait' : '' }, h('span', {}, 'Son adresse, joignable par ProxLab sur le réseau interne : '), h('div', { class: 'ligne-fluide' }, champ, verifier), propositions,
            c.configure ? h('small', { class: 'dim', text: `${c.nom || 'Sunshine'} · version ${c.version}` }) : null),
          h('li', { class: c.appaire ? 'fait' : '' }, h('span', { text: 'L\'appairer à ProxLab, une fois : ' }), etapeAppairage))),
      c.configure ? h('p', {}, h('button', { class: 'btn sm flat', type: 'button', onclick: sur(async () => {
        if (!await confirmer('Oublier l\'écran fluide de cette VM ?', 'L\'adresse et l\'appairage sont effacés de ProxLab. Dans Sunshine, l\'appareil « ProxLab » peut être retiré aussi.', { oui: 'Oublier', danger: true })) return;
        await api.del(url); peindre();
      }) }, 'Oublier ce réglage')) : null));
  }

  function visionneuse(c) {
    const etat = h('span', { class: 'note', text: 'fermé' });
    const hote = h('div', { class: 'ecran-hote fluide' });
    let ecran = null, ws = null, choisie = lireLocal('proxlab-fluide-qualite', 'haute');
    let ajusterVm = lireLocal('proxlab-fluide-ajuster', '1') === '1', avisTaille = false;
    // Un seul curseur sur l'image : celui de la VM, dessiné dans la vidéo. Le
    // curseur du poste, toujours en avance sur elle, faisait voir le retard.
    let curseurPoste = lireLocal('proxlab-fluide-curseur', '0') === '1';
    const peindreCurseur = () => ecran?.toile.classList.toggle('sans-curseur', !curseurPoste);
    const qualite = () => QUALITES_FLUIDE.find(q => q.k === choisie) || QUALITES_FLUIDE[1];
    // Le clavier de la VM : le même réglage que l'écran VNC de cette VM.
    const cleDispo = `proxlab-disposition:${f.node}/${f.vmid}`;
    const disposition = () => (lireLocal('proxlab-frappe', '') === 'physique' ? null : (DISPOSITIONS[lireLocal(cleDispo, '')] ? lireLocal(cleDispo, '') : lireLocal('proxlab-disposition', /^fr/i.test(navigator.language || '') ? 'fr' : 'us')));
    const boutonDispo = h('button', { class: 'btn sm dispo-vm', type: 'button', onclick: () => {
      const ks = Object.keys(DISPOSITIONS), k = ks[(ks.indexOf(disposition() || 'fr') + 1) % ks.length];
      poserLocal(cleDispo, k); poserLocal('proxlab-disposition', k); peindreDispo(); ecran?.toile.focus();
    } });
    const peindreDispo = () => { const d = disposition(); boutonDispo.replaceChildren(icone('clavier', 14), h('span', { text: d ? DISPOSITIONS[d].nom.split(' ')[0] : 'Touches physiques' })); boutonDispo.title = d ? `Clavier de la VM : ${DISPOSITIONS[d].nom}. Clic : l'autre.` : 'Chaque touche part telle quelle.'; };
    peindreDispo();
    const urlFrappe = `/api/machines/${encodeURIComponent(f.node)}/qemu/${f.vmid}/frappe`;
    // La frappe en cours (collage tapé par ProxLab) : suivie, dite dans la barre, arrêtée par Suppr.
    let frappeEnCours = false, suiviFrappe = null;
    const frappeChip = h('span', { class: 'frappe-chip', hidden: true });
    const peindreFrappe = fr => {
      frappeEnCours = fr?.etat === 'en cours';
      frappeChip.hidden = !frappeEnCours;
      if (frappeEnCours) frappeChip.replaceChildren(icone('clavier', 13), h('span', { text: `Frappe ${fr.tapes}/${fr.total}` }), h('button', { class: 'btn sm flat', type: 'button', onclick: sur(() => arreterFrappe()) }, 'Arrêter'));
    };
    const suivreFrappe = async () => {
      clearTimeout(suiviFrappe);
      if (!membre) return;
      let fr;
      try { fr = await api.get(urlFrappe); } catch { return; }
      peindreFrappe(fr);
      if (frappeEnCours) suiviFrappe = setTimeout(suivreFrappe, 700);
    };
    const arreterFrappe = async () => { frappeEnCours = false; clearTimeout(suiviFrappe); peindreFrappe(await api.del(urlFrappe)); toast('Frappe arrêtée.'); ecran?.toile.focus({ preventScroll: true }); };
    const toucheArret = e => { if (!frappeEnCours || !TOUCHES_ARRET_FRAPPE.has(e.key)) return false; arreterFrappe().catch(x => toast(x.message, true)); return true; };
    suivreFrappe();
    const taper = async texte => {
      texte = String(texte ?? '');
      if (!texte) return;
      const d = disposition() || 'fr';
      if ([...texte].length > FRAPPE_MAX) return toast(`Au plus ${FRAPPE_MAX.toLocaleString('fr-FR')} caractères par frappe.`, true);
      if (!await frappePermise(texte, d)) return;
      try { const fr = await api.post(urlFrappe, { texte, disposition: d }); peindreFrappe(fr); clearTimeout(suiviFrappe); suiviFrappe = setTimeout(suivreFrappe, 500); if (fr.total > 150) toast(`ProxLab tape ${fr.total.toLocaleString('fr-FR')} caractères dans la VM : tu peux quitter la page, la frappe continue ; Suppr ou Échap dans l'écran l'arrête.`); } catch (e) { toast(e.message, true); }
    };
    const collerIci = async texte => {
      if (texte === null) { try { texte = await navigator.clipboard.readText(); } catch { return toast('Le navigateur refuse la lecture du presse-papiers.', true); } }
      taper(texte);
    };
    const choixQualite = h('select', { class: 'presse-dispo', 'aria-label': 'Qualité de l\'écran fluide', onchange: e => { choisie = e.target.value; poserLocal('proxlab-fluide-qualite', choisie); if (ecran) ouvrir(); } },
      QUALITES_FLUIDE.map(q => h('option', { value: q.k, text: q.nom, selected: q.k === choisie })));
    const plein = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else hote.requestFullscreen?.().then(() => ecran?.toile.focus()).catch(() => {}); };
    const actions = menuActions(() => [{ items: [
      { texte: 'Ctrl+Alt+Suppr', ic: 'clavier', inactif: !ecran?.actif, agir: () => ecran?.ctrlAltSuppr() },
      { texte: 'Coller (tapé par ProxLab)', ic: 'presse', touche: `${MOD}V`, agir: () => collerIci(null) },
      { texte: 'Image complète', ic: 'relance', inactif: !ecran?.actif, agir: () => ecran?.demanderCle() },
      { texte: 'Curseur du poste sur l\'image', ic: curseurPoste ? 'verifie' : null, agir: () => {
        curseurPoste = !curseurPoste; poserLocal('proxlab-fluide-curseur', curseurPoste ? '1' : '0'); peindreCurseur();
        toast(curseurPoste ? 'Deux curseurs : celui du poste, immédiat, et celui de la VM, dans la vidéo.' : 'Un seul curseur : celui de la VM, dans la vidéo.');
      } },
      { texte: 'Écran de la VM à la taille du flux', ic: ajusterVm ? 'verifie' : null, agir: () => {
        ajusterVm = !ajusterVm; poserLocal('proxlab-fluide-ajuster', ajusterVm ? '1' : '0');
        toast(ajusterVm ? 'À chaque ouverture, l\'écran de la VM prend la taille du flux : l\'image remplit l\'écran, sans bandes noires.' : 'L\'écran de la VM garde sa taille : bandes noires possibles si ses proportions diffèrent.');
        if (ecran) ouvrir();
      } },
    ] }, ...(admin ? [{ titre: 'Réglage', items: [
      { texte: 'Réappairer', ic: 'lien', agir: sur(async () => { await api.post(url + '/appairage'); fermer(); peindre(); }) },
      { texte: 'Oublier ce réglage', ic: 'corbeille', agir: sur(async () => { if (!await confirmer('Oublier l\'écran fluide de cette VM ?', 'L\'adresse et l\'appairage sont effacés de ProxLab.', { oui: 'Oublier', danger: true })) return; await api.del(url); fermer(); peindre(); }) },
    ] }] : [])]);
    const bouton = h('button', { class: 'btn sm solid', type: 'button', disabled: !enMarche, onclick: () => (ecran ? fermer() : ouvrir()) }, icone('ecran', 14), 'Ouvrir');
    function fermer() {
      try { ecran?.fermer(); } catch { /* fermé */ }
      ecran = null; ws = null;
      etat.textContent = 'fermé';
      // La dernière image reste affichée : « Rouvrir » reprend là.
      bouton.replaceChildren(icone('ecran', 14), hote.querySelector('canvas') ? 'Rouvrir' : 'Ouvrir');
    }
    fermerVue = fermer;
    async function ouvrir() {
      fermer();
      if (!window.VideoDecoder) { hote.replaceChildren(h('p', { class: 'vide', text: 'Ce navigateur ne décode pas la vidéo lui-même (WebCodecs) : Safari 16.4, Chrome ou Firefox récents le font.' })); return; }
      etat.textContent = 'connexion…';
      const { passe } = await api.post('/api/console', { noeud: f.node, type: 'qemu', vmid: String(f.vmid), mode: 'fluide' });
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws/console?passe=${encodeURIComponent(passe)}`);
      const e = new EcranFluide(hote, ws, { disposition, surTouche: toucheArret, surIntapable: ch => toast(`« ${ch} » n'existe pas sur le clavier de la VM.`, true), surColler: collerIci, mac: estMac() });
      ecran = e;
      peindreCurseur();
      garder(e, ws);
      bouton.replaceChildren(icone('croix', 14), 'Fermer');
      ws.addEventListener('open', () => { const q = qualite(); e.commencer({ ...q, ...tailleFluide(q), ajuster: ajusterVm }); etat.textContent = ajusterVm ? 'écran de la VM à la taille du flux…' : 'lancement de Sunshine…'; });
      ws.addEventListener('message', ev => {
        if (typeof ev.data !== 'string') return;
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.pret) {
          e.pret(m.pret); etat.textContent = `ouvert · ${m.pret.largeur} × ${m.pret.hauteur} · ${m.pret.ips} i/s${m.pret.chiffre ? ' · chiffré' : ' · vidéo en clair (lan_encryption_mode)'}`; e.toile.focus({ preventScroll: true });
          const v = m.pret.ecranVm;
          if (v && !v.fait && !avisTaille) { avisTaille = true; toast(`L'écran de la VM garde sa taille${v.refus ? ` : ${v.refus}` : v.erreur ? ` : ${v.erreur}` : ' (l\'invité n\'a pas suivi à temps)'}. Bandes noires possibles.`, true); }
        }
        if (m.fin) { etat.textContent = 'fermé'; hote.append(h('p', { class: 'vide', text: m.fin })); }
      });
      ws.addEventListener('close', () => { if (ecran === e) { ecran = null; bouton.replaceChildren(icone('ecran', 14), 'Rouvrir'); if (!/fermé|Sunshine|indisponible/.test(etat.textContent)) etat.textContent = 'fermé'; } });
    }
    const outils = h('div', { class: 'ecran-outils' }, choixQualite, boutonDispo, actions.ancre,
      h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Plein écran', title: 'Plein écran', onclick: plein }, icone('agrandir', 14)));
    hote.append(h('p', { class: 'vide', text: enMarche ? 'L\'écran de la VM en vidéo, fluide. Clique dans l\'image pour lui donner le clavier ; ' + MOD + 'V colle (tapé par ProxLab).' : 'La machine est arrêtée : démarre-la pour voir son écran.' }));
    carte.replaceChildren(h('header', {}, h('h2', { text: 'Écran fluide' }), etat, frappeChip, outils, bouton), hote);
    hote.addEventListener('dblclick', e => { if (e.target === hote) plein(); });
    if (auto && enMarche) setTimeout(() => ouvrir().catch(x => { etat.textContent = 'fermé'; toast(x.message, true); }), 0);
  }

  peindre();
  carte.addEventListener('montre', () => { /* rien à rafraîchir : la vidéo continue */ });
  return carte;
}

function sansPortSerie(f, relire) {
  const prevu = (f.enAttente || []).includes('serial0');
  const cmd = 'sudo systemctl enable --now serial-getty@ttyS0.service';
  return h('div', { class: 'pad sans-serie' },
    h('p', { text: prevu ? 'Le port série est ajouté mais pas encore actif : redémarre la VM depuis ProxLab (Redémarrer, en haut), puis ouvre la console.' : 'La console texte d\'une VM passe par son port série, et celle-ci n\'en a pas. L\'onglet Écran marche sans lui.' }),
    h('ol', { class: 'etapes' },
      prevu ? h('li', { class: 'fait', text: 'Port série ajouté : il sera actif au prochain démarrage.' }) : h('li', {}, admin ? h('span', {}, 'Ajouter le port série : ', h('button', { class: 'btn sm', type: 'button', onclick: sur(async () => {
        if (!await confirmer('Ajouter un port série à cette VM ?', 'Proxmox ajoute « serial0: socket ». Il est pris en compte au prochain démarrage complet : Redémarrer depuis ProxLab suffit.', { oui: 'Ajouter' })) return;
        await api.post(`/api/machines/${encodeURIComponent(f.node)}/qemu/${f.vmid}/acces`, { portSerie: true });
        toast('Port série ajouté : redémarre la VM.');
        relire?.();
      }) }, 'Ajouter')) : 'Un administrateur ajoute le port série (serial0: socket) à la VM.'),
      h('li', { text: 'Redémarrer la VM depuis ProxLab (le bouton Redémarrer, en haut).' }),
      h('li', {}, 'Dans la VM, une seule fois, activer la connexion sur le port série : ',
        h('span', { class: 'cmd' }, h('code', { text: cmd }), h('button', { class: 'btn flat sm', type: 'button', 'aria-label': 'Copier la commande', onclick: async () => { try { await navigator.clipboard.writeText(cmd); toast('Commande copiée.'); } catch { toast(cmd); } } }, icone('copie', 12))))));
}

// Le port série est là mais l'invité n'y écoute pas : la commande à taper dans
// la VM et, si l'agent QEMU tourne, le bouton qui la lance (administrateur).
function consoleMuette(f, surActivee) {
  const cmd = 'sudo systemctl enable --now serial-getty@ttyS0.service';
  const agent = /^(1|enabled=1)(,|$)/.test(String(f.config?.agent || ''));
  const activer = sur(async () => {
    if (!await confirmer('Activer la connexion sur le port série ?', 'L\'agent QEMU lance dans la VM, en administrateur, la commande ci-dessous et rien d\'autre : la console texte affiche ensuite l\'invite de connexion. Inscrit au journal.', { oui: 'Activer' })) return;
    const r = await api.post(`/api/machines/${encodeURIComponent(f.node)}/qemu/${f.vmid}/console-serie`);
    if (!r.ok) return toast(r.message, true);
    toast('Connexion activée dans la VM : Entrée affiche l\'invite.');
    surActivee();
  });
  return h('div', { class: 'pad sans-serie' },
    h('p', { text: 'Le port série ne répond pas : la VM n\'y lance aucune connexion (c\'est le cas par défaut sur Fedora et Ubuntu de bureau). Une seule fois, dans la VM :' }),
    h('span', { class: 'cmd' }, h('code', { text: cmd }), h('button', { class: 'btn flat sm', type: 'button', 'aria-label': 'Copier la commande', onclick: async () => { try { await navigator.clipboard.writeText(cmd); toast('Commande copiée.'); } catch { toast(cmd); } } }, icone('copie', 12))),
    admin && agent ? h('p', {}, h('button', { class: 'btn sm solid', type: 'button', onclick: activer }, icone('terminal', 14), 'Activer par l\'agent QEMU'), h('small', { class: 'dim', text: ' — sans ouvrir la VM.' }))
      : h('p', { class: 'hint', text: agent ? 'Un administrateur peut aussi l\'activer par l\'agent QEMU.' : 'Tape-la depuis l\'onglet Écran, dans un terminal de la VM.' }));
}

function consoleMachine(cible, garder, { f = null, relire = null, auto = false } = {}) {
  const hote = h('div', { class: 'console-hote' });
  const etat = h('span', { class: 'note', text: 'fermée' });
  let term = null;
  const tC = estMac() ? '⌘C' : 'Ctrl+Maj+C', tV = estMac() ? '⌘V' : 'Ctrl+Maj+V';
  const vivant = () => term && ws?.readyState === 1;
  const ctrl = s => () => term?.envoyer(s);
  const actions = menuActions(() => [
    { titre: 'Presse-papiers', items: [
      { texte: 'Copier la sélection', ic: 'copie', touche: tC, inactif: !term, agir: () => term.copier() },
      { texte: 'Coller', ic: 'presse', touche: tV, inactif: !vivant(), agir: () => term.collerPressePapiers() },
      { texte: 'Tout sélectionner', ic: 'selection', inactif: !term, agir: () => term.toutSelectionner() },
    ] },
    { titre: 'Envoyer', items: [
      { texte: 'Interrompre', touche: 'Ctrl+C', inactif: !vivant(), agir: ctrl('\x03') },
      { texte: 'Fin de saisie', touche: 'Ctrl+D', inactif: !vivant(), agir: ctrl('\x04') },
      { texte: 'Effacer l\'écran', touche: 'Ctrl+L', inactif: !vivant(), agir: ctrl('\x0c') },
      { texte: 'Suspendre', touche: 'Ctrl+Z', inactif: !vivant(), agir: ctrl('\x1a') },
      { texte: 'Complétion', touche: 'Tab', inactif: !vivant(), agir: ctrl('\t') },
      { texte: 'Échap', inactif: !vivant(), agir: ctrl('\x1b') },
    ] },
  ]);
  let ws = null;
  const carte = h('div', { class: 'card' });
  // Une ouverture à la fois : un second clic pendant la connexion (celle
  // lancée d'office à l'ouverture de l'onglet) remplacerait le terminal tout
  // juste ouvert, et les touches déjà tapées partiraient dans l'ancien.
  let ouverture = false;
  const ouvrir = sur(async () => {
    if (ouverture) return;
    ouverture = true; bouton.disabled = true;
    try { await ouvrirMaintenant(); } finally { ouverture = false; bouton.disabled = false; }
  });
  async function ouvrirMaintenant() {
    let passe;
    try { ({ passe } = await api.post('/api/console', cible)); } catch (e) {
      if (e.details?.sansSerie && f) { hote.replaceChildren(sansPortSerie(f, relire)); return; }
      throw e;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/console?passe=${encodeURIComponent(passe)}`);
    term = new Terminal(hote, {
      surSaisie: s => { if (ws.readyState === 1) ws.send(JSON.stringify({ i: s })); },
      surTaille: (c, l) => { if (ws.readyState === 1) ws.send(JSON.stringify({ r: [c, l] })); },
      surCopie: n => toast(n ? `${n} caractère${n > 1 ? 's' : ''} copié${n > 1 ? 's' : ''}.` : 'Rien de sélectionné.'),
      surRefus: m => toast(m, true),
    });
    garder(term, ws);
    etat.textContent = 'connexion…';
    ws.addEventListener('open', () => {
      etat.textContent = 'ouverte'; ws.send(JSON.stringify({ r: [term.cols, term.lignes] })); term.focus();
      // Port série d'une VM : l'invite de connexion a été écrite avant notre arrivée.
      // Rien n'est tapé à la place de l'opérateur (une ligne laissée à moitié par un
      // autre partirait) : on lui dit seulement quoi faire.
      if (cible.type === 'qemu') etat.textContent = 'ouverte · Entrée pour afficher l\'invite';
    });
    // Une touche, puis rien pendant quatre secondes : l'invité n'écoute pas son
    // port série (Fedora et Ubuntu de bureau n'y lancent pas de connexion).
    let silence = null;
    hote.addEventListener('keydown', () => {
      if (/Entrée/.test(etat.textContent) && ws?.readyState === 1) etat.textContent = 'ouverte';
      if (cible.type === 'qemu' && f && !silence && !aide.isConnected) silence = setTimeout(() => { if (ws?.readyState === 1) carte.insertBefore(aide, hote); }, 4000);
    }, true);
    ws.addEventListener('message', ev => { if (typeof ev.data === 'string') { clearTimeout(silence); silence = null; term.ecrire(ev.data); } });
    ws.addEventListener('close', () => { etat.textContent = 'fermée'; });
    bouton.replaceChildren(icone('relance', 14), 'Rouvrir');
  }
  const bouton = h('button', { class: 'btn sm solid', type: 'button', onclick: ouvrir }, icone('terminal', 14), 'Ouvrir');
  const aide = cible.type === 'qemu' && f ? consoleMuette(f, () => { aide.remove(); term?.focus(); ws?.readyState === 1 && ws.send(JSON.stringify({ i: '\r' })); }) : h('div');
  const serie = cible.type !== 'qemu' || !f || Object.keys(f.config || {}).some(k => /^serial\d$/.test(k));
  if (serie) hote.append(h('p', { class: 'vide', text: cible.type === 'node' ? 'Shell du nœud, en administrateur : chaque ouverture est journalisée.' : `Console texte de la machine. Sélectionne pour copier (${estMac() ? '⌘C' : 'Ctrl+Maj+C'}), ${estMac() ? '⌘V' : 'Ctrl+Maj+V'} pour coller. Chaque ouverture est journalisée.` }));
  else { hote.append(sansPortSerie(f, relire)); bouton.disabled = true; actions.ancre.hidden = true; }
  if (auto && serie && (!f || f.status === 'running')) setTimeout(ouvrir, 0);
  carte.addEventListener('montre', () => { if (term && ws?.readyState === 1) term.focus(); });
  carte.append(h('header', {}, h('h2', { text: cible.type === 'node' ? `Shell de ${cible.noeud}` : 'Console' }), etat, h('div', { class: 'ecran-outils' }, actions.ancre), bouton), hote);
  return carte;
}

async function pageNoeuds() {
  const page = h('div', { class: 'page' });
  let shell = { term: null, ws: null };
  const fermer = () => { try { shell.ws?.close(); } catch { /* fermé */ } shell.term?.detruire(); shell = { term: null, ws: null }; };
  const peindre = async () => {
    const et = E.etat;
    const tete = h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Nœuds' }), h('p', { class: 'lede', text: 'Ressources et shell de chaque nœud ; ses interfaces sont dans Réseau.' })));
    if (!et.relie) { page.replaceChildren(tete, nonRelie()); return; }
    const cartes = et.noeuds.map(n => {
      const hors = n.status !== 'online';
      const kv = (k, v) => h('div', { class: 'kv' }, h('span', { text: k }), v instanceof Node ? v : h('b', { text: v }));
      return h('div', { class: 'card' },
        h('header', {}, h('span', { class: 'itile' }, icone('noeud', 15)), h('h2', { text: n.alias || n.node }), n.alias ? h('span', { class: 'note mono', text: n.node }) : null,
          h('span', { class: 'tag ' + (hors ? 'held' : '') }, h('i', { class: 'd' }), hors ? 'hors ligne' : 'en ligne'),
          admin ? boutonEtiquette(n.node, sur(async () => { if (await etiqueter({ genre: 'noeud', noeud: n.node, objet: n.node, actuel: n.alias })) { await rafraichir(); toast('Étiquette enregistrée.'); } })) : null,
          admin && !hors ? h('button', { class: 'btn sm', type: 'button', onclick: () => { fermer(); zoneShell.replaceChildren(consoleMachine({ noeud: n.node, type: 'node' }, (t, w) => { shell = { term: t, ws: w }; })); zoneShell.scrollIntoView({ behavior: 'smooth' }); } }, icone('terminal', 14), 'Shell') : null),
        h('div', { class: 'cardbody' },
          kv('Processeur', hors ? '—' : barre(n.cpu * 100)), kv('Mémoire', hors ? '—' : barre(pct(n.mem, n.maxmem))), kv('Disque système', hors ? '—' : barre(pct(n.disk, n.maxdisk))),
          kv('Cœurs', String(n.maxcpu)), kv('Mémoire installée', octets(n.maxmem)), kv('En ligne depuis', hors ? '—' : duree(n.uptime)),
          kv('Invités', String(et.machines.filter(m => m.node === n.node && !m.template).length))));
    });
    page.replaceChildren(tete, h('div', { class: 'grille' }, cartes), zoneShell);
  };
  const zoneShell = h('div', { class: 'mt16' });
  enregistrer(() => { if (!shell.ws) peindre(); }, fermer);
  await peindre();
  return page;
}

// Réseau : les interfaces de chaque nœud (ponts, agrégats, cartes, VLAN),
// ce qu'elles relient, et une étiquette pour les reconnaître.
const GENRE_IFACE = { bridge: 'Pont', OVSBridge: 'Pont OVS', bond: 'Agrégat', OVSBond: 'Agrégat OVS', eth: 'Carte', vlan: 'VLAN', OVSIntPort: 'Port OVS', alias: 'Alias' };
async function pageReseau() {
  const page = h('div', { class: 'page' });
  const peindre = async () => {
    const et = E.etat;
    const tete = h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Réseau' }),
      h('p', { class: 'lede', text: 'Les interfaces de chaque nœud. Une VM se branche sur un pont ; une étiquette le rend reconnaissable, sans rien renommer dans Proxmox.' })));
    if (!et.relie) { page.replaceChildren(tete, nonRelie()); return; }
    const cartes = await Promise.all(et.noeuds.filter(n => n.status === 'online').map(async n => {
      let ifaces, erreurIf = '';
      try { ifaces = await api.get(`/api/noeuds/${encodeURIComponent(n.node)}/reseau`); } catch (e) { ifaces = []; erreurIf = e.message; }
      const ordre = i => ({ bridge: 0, OVSBridge: 0, bond: 1, OVSBond: 1, vlan: 2 })[i.type] ?? 3;
      ifaces.sort((a, b) => ordre(a) - ordre(b) || a.iface.localeCompare(b.iface, 'fr', { numeric: true }));
      const marquer = i => sur(async () => { if (await etiqueter({ genre: 'reseau', noeud: n.node, objet: i.iface, actuel: i.alias })) { toast('Étiquette enregistrée.'); peindre(); } });
      // Les adresses MAC viennent du rapport du nœud, plus lent : la table est
      // montrée d'abord, chaque case se remplit à l'arrivée.
      const casesMac = new Map(ifaces.map(i => [i.iface, h('td', { class: 'cache-s mono dim mac', text: '…' })]));
      const avisMac = h('p', { class: 'hint avis-carte', hidden: true });
      if (!erreurIf) api.get(`/api/noeuds/${encodeURIComponent(n.node)}/reseau/mac`).then(macs => {
        for (const [iface, td] of casesMac) {
          const m = Object.hasOwn(macs, iface) ? macs[iface] : null;
          td.textContent = m?.mac || '—';
          if (m?.autresNoms?.length) { td.title = `Aussi nommée ${m.autresNoms.join(', ')}`; td.append(h('small', { text: m.autresNoms.join(', ') })); }
        }
      }, e => {
        for (const td of casesMac.values()) td.textContent = '—';
        avisMac.textContent = `Adresses MAC illisibles : ${e.message}${/permission|Sys\.Audit/i.test(e.message) ? ' Le jeton de ProxLab doit avoir Sys.Audit sur le nœud (rôle PVEAuditor).' : ''}`;
        avisMac.hidden = false;
      });
      return h('div', { class: 'card mb16' },
        h('header', {}, h('span', { class: 'itile' }, icone('noeud', 15)), h('h2', { text: n.alias || n.node }), h('span', { class: 'note', text: `${ifaces.length} interface${ifaces.length > 1 ? 's' : ''}` })),
        erreurIf ? h('p', { class: 'vide', text: erreurIf }) : h('div', { class: 'tw' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', { text: 'Interface' }), h('th', { class: 'cache-s', text: 'Relie' }), h('th', { class: 'cache-m', text: 'Adresse' }), h('th', { class: 'cache-s', text: 'MAC' }), h('th', { text: 'État' }), admin ? h('th', { class: 'fin' }) : null)),
          h('tbody', {}, ifaces.map(i => h('tr', {},
            h('td', { class: 'principal' }, h('div', { class: 'who-cell' }, h('span', { class: 'itile' }, icone(/bridge/i.test(i.type) ? 'reseau' : 'noeud')),
              nomEtiquete(i.iface, i.alias, GENRE_IFACE[i.type] || i.type, i.commentaire && i.commentaire !== i.alias ? `« ${i.commentaire} »` : ''))),
            h('td', { class: 'cache-s mono dim', text: i.ports || '—' }),
            h('td', { class: 'cache-m mono', text: i.cidr || '—' }),
            casesMac.get(i.iface),
            h('td', {}, h('span', { class: 'tag ' + (i.active ? '' : 'idle') }, h('i', { class: 'd' }), i.active ? 'active' : 'inactive')),
            admin ? h('td', { class: 'fin' }, boutonEtiquette(i.iface, marquer(i))) : null))))),
        avisMac);
    }));
    const hors = et.noeuds.filter(n => n.status !== 'online').map(n => n.alias || n.node);
    page.replaceChildren(tete, ...cartes, hors.length ? h('p', { class: 'hint', text: `Hors ligne, interfaces illisibles : ${hors.join(', ')}.` }) : '');
  };
  enregistrer(() => {});
  await peindre();
  return page;
}

async function pageStockage() {
  const page = h('div', { class: 'page' });
  const peindre = () => {
    const et = E.etat;
    const tete = h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Stockage' }), h('p', { class: 'lede', text: 'Volumes de chaque nœud ; un stockage partagé est vu par tous.' })));
    if (!et.relie) { page.replaceChildren(tete, nonRelie()); return; }
    const liste = et.stockages.slice().sort((a, b) => a.node.localeCompare(b.node) || a.storage.localeCompare(b.storage));
    page.replaceChildren(tete, h('div', { class: 'card' }, h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Stockage' }), h('th', { class: 'cache-m', text: 'Nœud' }), h('th', { class: 'cache-l', text: 'Contenu' }), h('th', { text: 'Occupation' }), h('th', { class: 'cache-s fin', text: 'Libre' }), admin ? h('th', { class: 'fin' }) : null)),
      h('tbody', {}, liste.map(s => {
        const tr = h('tr', { class: 'cliquable' },
          h('td', { class: 'principal' }, h('div', { class: 'who-cell' }, h('span', { class: 'itile' }, icone('disque')), nomEtiquete(s.storage, s.alias, `${s.plugintype}${s.shared ? ' · partagé' : ''}`))),
          h('td', { class: 'cache-m dim', text: noeudAffiche(s.node) }),
          h('td', { class: 'cache-l dim', text: s.content.split(',').join(', ') }),
          h('td', {}, barre(pct(s.disk, s.maxdisk), { alerte: 90, attention: 80 })),
          h('td', { class: 'cache-s fin mono', text: octets(s.maxdisk - s.disk) }),
          admin ? h('td', { class: 'fin' }, boutonEtiquette(s.storage, sur(async () => { if (await etiqueter({ genre: 'stockage', noeud: s.node, objet: s.storage, actuel: s.alias })) { await rafraichir(); toast('Étiquette enregistrée.'); } }))) : null);
        return ouvrable(tr, () => contenuStockage(s));
      }))))));
  };
  enregistrer(peindre);
  peindre();
  return page;
}
async function contenuStockage(s) {
  const types = ['backup', 'iso', 'vztmpl', 'images', 'rootdir'].filter(t => s.content.includes(t));
  if (!types.length) return;
  const noms = { backup: 'Sauvegardes', iso: 'Images ISO', vztmpl: 'Modèles de conteneur', images: 'Disques', rootdir: 'Racines de conteneur' };
  const choix = h('select', { class: 'field', 'aria-label': 'Contenu' }, types.map(t => h('option', { value: t, text: noms[t] })));
  const liste = h('div', { class: 'liste-contenu' });
  const charger = async () => {
    liste.replaceChildren(h('p', { class: 'hint', text: 'Lecture…' }));
    try {
      const c = await api.get(`/api/stockages/${encodeURIComponent(s.node)}/${encodeURIComponent(s.storage)}/contenu?type=${choix.value}`);
      liste.replaceChildren(...(c.length ? c.map(x => h('div', { class: 'kv' }, h('span', { class: 'mono fs12 tronque', text: x.volid.split(':').pop() }), h('b', { class: 'mono fs12', text: `${octets(x.size)}${x.ctime ? ' · ' + dateHeure(x.ctime) : ''}` }))) : [h('p', { class: 'hint', text: 'Rien ici.' })]));
    } catch (e) { liste.replaceChildren(h('p', { class: 'erreur', text: e.message })); }
  };
  choix.addEventListener('change', charger);
  charger();
  await dialogue({ titre: `${s.alias || s.storage} sur ${noeudAffiche(s.node)}`, large: true, contenu: [choix, liste], boutons: [{ texte: 'Fermer', valeur: null }] });
}

// Images ISO : celles de chaque stockage qui en accepte, les VM qui en ont
// une dans leur lecteur, et pour l'administrateur : importer depuis une
// adresse (suivie ici jusqu'au bout), envoyer depuis l'ordinateur, insérer,
// éjecter, supprimer.
const FICHIER_ISO = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}\.(iso|img)$/i;
const TUNNEL_MAX = 100 * 1024 ** 2;
async function pageIsos() {
  const page = h('div', { class: 'page' });
  let d = { relie: true, stockages: [], isos: [] };
  let importations = [];
  const libelleStockage = x => `${x.storage} · ${x.shared ? 'partagé' : x.node} — ${octets(x.avail)} libres`;
  const choixStockage = () => h('select', { class: 'field', 'aria-label': 'Stockage' }, d.stockages.map((x, i) => h('option', { value: String(i), text: libelleStockage(x) })));
  let suivi = null;
  const recharger = async () => {
    [d, importations] = await Promise.all([api.get('/api/isos'), admin ? api.get('/api/isos/importations') : []]);
    peindre();
    // Une importation en cours : suivie toutes les deux secondes, jusqu'à sa fin.
    clearTimeout(suivi);
    if (importations.some(t => t.etat === 'en cours')) suivi = setTimeout(() => { if (courante.cle === 'isos') recharger().catch(() => {}); }, 2000);
  };
  const apres = msg => { toast(msg); setTimeout(() => recharger().catch(() => {}), 2500); };

  const telecharger = sur(async () => {
    const url = h('input', { class: 'field', type: 'url', placeholder: 'https://…/image.iso', 'aria-label': 'Adresse de l\'image', spellcheck: 'false' });
    const nom = h('input', { class: 'field mt9', placeholder: 'nom-de-l-image.iso', 'aria-label': 'Nom du fichier', spellcheck: 'false' });
    const st = choixStockage();
    st.classList.add('mt9');
    const somme = h('input', { class: 'field', placeholder: 'Somme de contrôle (recommandée)', 'aria-label': 'Somme de contrôle', spellcheck: 'false' });
    const algo = h('select', { class: 'field', 'aria-label': 'Algorithme' }, ['sha256', 'sha512', 'sha1', 'md5'].map(a => h('option', { value: a, text: a })));
    const info = h('p', { class: 'hint' });
    const err = h('p', { class: 'erreur', role: 'alert' });
    url.addEventListener('change', async () => {
      info.textContent = '';
      if (!/^https:\/\//.test(url.value.trim())) return;
      try {
        const m = await api.get(`/api/isos/apercu?url=${encodeURIComponent(url.value.trim())}`);
        if (m.nom && !nom.value) nom.value = m.nom;
        info.textContent = m.taille ? `${octets(m.taille)} à importer.` : 'Taille non annoncée par le serveur : l’importation sera refusée.';
      } catch (x) { info.textContent = x.message; }
    });
    const ok = await dialogue({ titre: 'Importer une image', texte: 'Depuis une adresse publique en https. ProxLab la télécharge, vérifie que c’est une image de disque (et sa somme de contrôle si tu la donnes), puis la remet à Proxmox. Une image du réseau local s’envoie depuis l’ordinateur.', large: true,
      contenu: [url, nom, st, h('div', { class: 'row2 mt9' }, somme, algo), info, err],
      boutons: [{ texte: 'Annuler', classe: 'flat', valeur: false }, { texte: 'Importer', classe: 'solid', agir: async () => {
        const x = d.stockages[Number(st.value)];
        try {
          await api.post(`/api/isos/${encodeURIComponent(x.node)}/${encodeURIComponent(x.storage)}/telechargement`, { url: url.value.trim(), nom: nom.value.trim(), somme: somme.value.trim(), algorithme: algo.value });
          return true;
        } catch (e) { err.textContent = e.message; return false; }
      } }] });
    if (ok) { toast('Importation lancée : elle avance en haut de la page.'); recharger().catch(() => {}); }
  });

  const envoyer = sur(async () => {
    const fichier = h('input', { class: 'field', type: 'file', accept: '.iso,.img', 'aria-label': 'Image à envoyer' });
    const st = choixStockage();
    st.classList.add('mt9');
    const note = h('p', { class: 'hint' });
    const err = h('p', { class: 'erreur', role: 'alert' });
    const rail = h('i');
    const pourcent = h('b', { text: '' });
    const progression = h('div', { class: 'jaugette mt9', hidden: true }, h('div', { class: 'rail2' }, rail), pourcent);
    fichier.addEventListener('change', () => {
      const f = fichier.files[0];
      note.textContent = !f ? '' : f.size > TUNNEL_MAX
        ? `${octets(f.size)}. Par le tunnel Cloudflare, un envoi de plus de 100 Mo est refusé : ouvre ProxLab par son adresse locale, ou télécharge l'image depuis une adresse.`
        : `${octets(f.size)}.`;
    });
    let xhr = null;
    const ok = await dialogue({ titre: 'Envoyer une image', texte: 'Depuis cet ordinateur vers un stockage de la grappe.', large: true,
      contenu: [fichier, st, note, progression, err],
      boutons: [{ texte: 'Annuler', classe: 'flat', agir: () => { xhr?.abort(); }, valeur: false }, { texte: 'Envoyer', classe: 'solid', agir: async () => {
        const f = fichier.files[0];
        if (!f) { err.textContent = 'Choisis un fichier.'; return false; }
        if (!FICHIER_ISO.test(f.name)) { err.textContent = 'Nom de fichier en .iso ou .img, lettres, chiffres, points et tirets : renomme-le avant de l\'envoyer.'; return false; }
        const x = d.stockages[Number(st.value)];
        try {
          // Le renfort d'abord : un refus après des Gio envoyés ne servirait à rien.
          const sec = await api.get('/api/compte/securite');
          if (!(sec.renfortJusqua > Date.now() + 60e3) && !await renforcer(api, sec.methodesRenfort)) return false;
          progression.hidden = false; err.textContent = '';
          await new Promise((resolve, reject) => {
            xhr = new XMLHttpRequest();
            xhr.open('PUT', `/api/isos/${encodeURIComponent(x.node)}/${encodeURIComponent(x.storage)}/envoi?nom=${encodeURIComponent(f.name)}`);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            if (api.csrf) xhr.setRequestHeader('X-CSRF', api.csrf);
            xhr.upload.onprogress = e => { if (e.lengthComputable) { const v = pct(e.loaded, e.total); rail.style.width = `${v}%`; pourcent.textContent = `${v} %`; } };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) return resolve();
              let msg = '';
              try { msg = JSON.parse(xhr.responseText).error; } catch { /* page d'un relais, pas de JSON */ }
              reject(new Error(msg || (xhr.status === 413 ? 'Refusé par un relais (taille) : par le tunnel Cloudflare, 100 Mo au plus.' : `Erreur ${xhr.status}`)));
            };
            xhr.onerror = () => reject(new Error('Envoi interrompu (réseau, ou relais qui refuse la taille).'));
            xhr.onabort = () => reject(new Error('Envoi annulé.'));
            xhr.send(f);
          });
          return true;
        } catch (e) { err.textContent = e.message; return false; } finally { xhr = null; }
      } }] });
    xhr?.abort();   // fermé par Échap pendant l'envoi
    if (ok) apres('Image envoyée : Proxmox la range dans le stockage.');
  });

  const inserer = i => sur(async () => {
    const vms = E.etat.machines.filter(m => m.type === 'qemu' && !m.template && (i.shared || m.node === i.node));
    if (!vms.length) { toast('Aucune VM ne peut lire ce stockage.', true); return; }
    const vm = h('select', { class: 'field', 'aria-label': 'Machine' }, vms.map((m, k) => h('option', { value: String(k), text: `${m.vmid} · ${m.name || 'VM'} (${m.node})` })));
    const err = h('p', { class: 'erreur', role: 'alert' });
    const ok = await dialogue({ titre: `Insérer ${i.alias || i.nom}`, texte: 'Dans le lecteur CD de la machine (le premier, ou ide2 s\'il est libre). Une VM en marche voit le disque tout de suite.', contenu: [vm, err],
      boutons: [{ texte: 'Annuler', classe: 'flat', valeur: false }, { texte: 'Insérer', classe: 'solid', agir: async () => {
        const m = vms[Number(vm.value)];
        try { await api.post(`/api/machines/${encodeURIComponent(m.node)}/qemu/${m.vmid}/lecteur`, { volid: i.volid }); return true; } catch (e) { err.textContent = e.message; return false; }
      } }] });
    if (ok) apres(`${i.nom} insérée.`);
  });
  const marquer = i => sur(async () => {
    if (await etiqueter({ genre: 'iso', noeud: i.node, objet: i.volid, reel: i.nom, actuel: i.alias })) apres('Étiquette enregistrée.');
  });
  const ejecter = u => sur(async () => {
    if (!await confirmer(`Éjecter le disque de ${u.vmid} ?`, `${u.name || 'VM'} sur ${u.node}, lecteur ${u.lecteur}.`, { oui: 'Éjecter' })) return;
    await api.post(`/api/machines/${encodeURIComponent(u.node)}/qemu/${u.vmid}/lecteur`, { volid: '' });
    apres('Lecteur vidé.');
  });
  const supprimer = i => sur(async () => {
    if (!await confirmer(`Supprimer ${i.alias || i.nom} ?`, `Du stockage ${i.storage}${i.shared ? '' : ` de ${i.node}`}, ${octets(i.size)}.`, { danger: true, oui: 'Supprimer' })) return;
    await api.del(`/api/isos/${encodeURIComponent(i.node)}/${encodeURIComponent(i.storage)}?volid=${encodeURIComponent(i.volid)}`);
    apres(`${i.nom} : suppression demandée.`);
  });

  const peindre = () => {
    const tete = h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Images ISO' }), h('p', { class: 'lede', text: 'Les images d\'installation de chaque stockage, et les VM qui en ont une dans leur lecteur.' })),
      admin && d.relie && d.stockages.length ? h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: envoyer }, icone('envoi', 14), h('span', { class: 'cache-s', text: 'Envoyer' })),
        h('button', { class: 'btn solid', type: 'button', onclick: telecharger }, icone('telecharge', 14), h('span', { class: 'cache-s', text: 'Importer' }))) : null);
    if (!d.relie) { page.replaceChildren(tete, nonRelie()); return; }
    const colonnes = admin ? 5 : 4;
    const etatImport = t => t.etat === 'en cours' ? barreImport(t) : h('span', { class: 'tag ' + (t.etat === 'terminée' ? '' : t.etat === 'annulée' ? 'idle' : 'held') }, h('i', { class: 'd' }), t.etat);
    const carteImports = importations.length ? h('div', { class: 'card mb16' }, h('header', {}, h('h2', { text: 'Importations' }), h('span', { class: 'note', text: String(importations.length) })),
      h('div', { class: 'tw' }, h('table', {}, h('tbody', {}, importations.slice().reverse().map(t => h('tr', {},
        h('td', { class: 'principal' }, h('div', { class: 'nom-iso' }, h('b', { text: t.nom }), h('small', { class: 'mono', text: `${t.hote} → ${t.stockage} · ${t.par}` }), t.erreur ? h('small', { class: 'erreur bloc', text: t.erreur }) : null)),
        h('td', {}, etatImport(t)),
        h('td', { class: 'fin' }, t.etat === 'en cours' ? h('button', { class: 'btn sm flat', type: 'button', onclick: sur(async () => { await api.del(`/api/isos/importations/${t.id}`); recharger().catch(() => {}); }) }, 'Annuler') : null)))))))
      : null;
    page.replaceChildren(tete, ...[carteImports].filter(Boolean), h('div', { class: 'card' },
      h('header', {}, h('h2', { text: 'Images' }), h('span', { class: 'note', text: `${d.isos.length} · ${octets(d.isos.reduce((n, i) => n + i.size, 0))}` })),
      h('div', { class: 'tw' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Image' }), h('th', { class: 'cache-m', text: 'Stockage' }), h('th', { class: 'cache-s', text: 'Taille' }), h('th', { class: 'cache-s', text: 'Dans le lecteur de' }), admin ? h('th', { class: 'fin' }) : null)),
        h('tbody', {}, d.isos.length ? d.isos.map(i => h('tr', {},
          h('td', { class: 'principal' }, h('div', { class: 'who-cell' }, h('span', { class: 'itile' }, icone('iso')), h('div', { class: 'nom-iso' }, h('b', { text: i.alias || i.nom }),
            h('small', { class: 'mono', text: [i.alias ? i.nom : '', i.ctime ? dateHeure(i.ctime) : '', i.utilisePar.length ? `dans ${i.utilisePar.map(u => u.vmid).join(', ')}` : ''].filter(Boolean).join(' · ') })))),
          h('td', { class: 'cache-m dim', text: `${d.stockages.find(x => x.storage === i.storage && (x.shared || x.node === i.node))?.alias || i.storage} · ${i.shared ? 'partagé' : noeudAffiche(i.node)}` }),
          h('td', { class: 'cache-s mono', text: octets(i.size) }),
          h('td', { class: 'cache-s' }, i.utilisePar.length ? i.utilisePar.map(u => h('span', { class: 'tag idle' }, `${u.vmid} ${u.name || ''}`.trim(),
            admin ? h('button', { class: 'ghost', type: 'button', 'aria-label': `Éjecter de ${u.vmid}`, title: 'Éjecter', onclick: ejecter(u) }, icone('ejecter', 12)) : null)) : h('span', { class: 'dim', text: '—' })),
          admin ? h('td', { class: 'fin' }, h('div', { class: 'actions' },
            h('button', { class: 'btn sm', type: 'button', onclick: sur(() => creerMachine({ iso: i.volid, noeud: i.node })) }, icone('plus', 13), h('span', { class: 'cache-s', text: 'Créer une VM' })),
            h('button', { class: 'btn sm flat', type: 'button', 'aria-label': `Actions pour ${i.alias || i.nom}`, onclick: () => feuille(i.alias || i.nom, [
              { texte: 'Insérer dans une VM', agir: inserer(i) },
              { texte: 'Étiquette', agir: marquer(i) },
              { texte: i.utilisePar.length ? 'Supprimer (éjecte-la d’abord)' : 'Supprimer', danger: true, agir: i.utilisePar.length ? () => toast(`Dans le lecteur de ${i.utilisePar.map(u => u.vmid).join(', ')} : éjecte-la d’abord.`, true) : supprimer(i) },
            ]) }, icone('actions', 15)))) : null))
          : h('tr', {}, h('td', { colspan: colonnes, class: 'vide', text: d.stockages.length ? 'Aucune image : télécharge-en une, ou envoie-la depuis ton ordinateur.' : 'Aucun stockage n\'accepte d\'images ISO.' })))))));
  };
  enregistrer(() => recharger().catch(() => {}));
  await recharger();
  return page;
}

function barreImport(t) {
  const v = t.taille ? pct(t.octets, t.taille) : 0;
  const i = h('i');
  i.style.width = `${v}%`;
  return h('div', { class: 'jaugette' }, h('div', { class: 'rail2' }, i), h('b', { text: t.taille ? `${v} %` : octets(t.octets) }));
}

async function pageTaches() {
  const page = h('div', { class: 'page' });
  const peindre = async () => {
    const tete = h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Tâches' }), h('p', { class: 'lede', text: 'Ce que Proxmox exécute ou a exécuté récemment, sur toute la grappe.' })));
    if (!E.etat.relie) { page.replaceChildren(tete, nonRelie()); return; }
    const liste = await api.get('/api/taches').catch(e => { toast(e.message, true); return []; });
    page.replaceChildren(tete, h('div', { class: 'card' }, h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Tâche' }), h('th', { class: 'cache-m', text: 'Nœud' }), h('th', { class: 'cache-l', text: 'Par' }), h('th', { class: 'cache-s', text: 'Début' }), h('th', { text: 'Statut' }))),
      h('tbody', {}, liste.length ? liste.map(t => {
        const enCours = !t.endtime, ok = t.status === 'OK';
        const tr = h('tr', { class: 'cliquable' },
          h('td', { class: 'principal' }, h('b', { class: 'fw5', text: t.type }), h('small', { class: 'dim bloc mono', text: t.id || '—' })),
          h('td', { class: 'cache-m dim', text: t.node }),
          h('td', { class: 'cache-l dim mono fs12', text: t.user }),
          h('td', { class: 'cache-s mono', text: dateHeure(t.starttime) }),
          h('td', {}, h('span', { class: 'tag ' + (enCours ? 'warn' : ok ? '' : 'held') }, h('i', { class: 'd' }), enCours ? 'en cours' : ok ? 'réussie' : String(t.status).slice(0, 40))));
        return ouvrable(tr, () => journalTache(t));
      }) : h('tr', {}, h('td', { colspan: 5, class: 'vide', text: 'Aucune tâche récente.' })))))));
  };
  enregistrer(peindre);
  await peindre();
  return page;
}
async function journalTache(t) {
  const pre = h('pre', { class: 'journal-tache' });
  const statut = h('p', { class: 'hint' });
  let fini = false, minuterie = null;
  const lire = async () => {
    try {
      const j = await api.get(`/api/taches/${encodeURIComponent(t.node)}/${encodeURIComponent(t.upid)}`);
      pre.textContent = j.lignes.map(l => l.t).join('\n');
      fini = j.status === 'stopped';
      statut.textContent = fini ? `Terminée : ${j.exitstatus || '—'}` : 'En cours…';
      if (!fini) minuterie = setTimeout(lire, 2000);
    } catch (e) { statut.textContent = e.message; }
  };
  lire();
  await dialogue({ titre: `${t.type} ${t.id || ''} sur ${t.node}`, large: true, contenu: [statut, pre],
    boutons: [...(admin && !t.endtime ? [{ texte: 'Arrêter la tâche', classe: 'flat danger', agir: async () => {
      if (!await confirmer('Arrêter cette tâche ?', 'Proxmox l\'interrompt ; ce qu\'elle a déjà fait reste fait.', { danger: true, oui: 'Arrêter' })) return false;
      try { await api.del(`/api/taches/${encodeURIComponent(t.node)}/${encodeURIComponent(t.upid)}`); toast('Arrêt demandé.'); return true; } catch (e) { toast(e.message, true); return false; }
    } }] : []), { texte: 'Fermer', valeur: null }] });
  clearTimeout(minuterie);
}

async function pageEvenements() {
  const corps = h('div', { class: 'ev-liste' });
  const plus = h('button', { class: 'btn sm', type: 'button', text: 'Plus anciens' });
  const pied = h('div', { class: 'ev-pied', hidden: true }, plus);
  let dernier = null, jour = null, n = 0;
  const ajouter = liste => {
    for (const e of liste) {
      const j = jourEvenement(e.at);
      if (j !== jour) { jour = j; corps.append(h('h3', { class: 'ev-jour', text: j })); }
      corps.append(ligneEvenement(e, { heure: true }));
    }
  };
  const charger = async (suite = false) => {
    const liste = await api.get('/api/evenements?limite=50' + (suite && dernier ? `&avant=${encodeURIComponent(dernier)}` : ''));
    if (!suite) { corps.replaceChildren(); jour = null; n = 0; }
    ajouter(liste);
    n += liste.length;
    if (!suite && !liste.length) corps.append(h('p', { class: 'vide', text: 'Aucun événement pour l\'instant.' }));
    dernier = liste.at(-1)?.id || dernier;
    pied.hidden = liste.length < 50;
  };
  plus.addEventListener('click', sur(() => charger(true)));
  await charger();
  enregistrer(() => { if (n <= 50) charger().catch(() => {}); });
  return h('div', { class: 'page' },
    h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Événements' }), h('p', { class: 'lede', text: 'Ce qui est arrivé à la grappe : pannes, retours, gestes faits depuis ProxLab et tâches lues dans Proxmox.' }))),
    h('div', { class: 'card' }, corps, pied));
}
async function pageReglages() {
  const [{ liaison }, { alertes }] = await Promise.all([api.get('/api/liaison'), api.get('/api/alertes')]);
  return h('div', { class: 'page' },
    h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Réglages' }), h('p', { class: 'lede', text: 'Liaison à la grappe et envoi des alertes. Chaque enregistrement demande un renfort récent.' }))),
    carteLiaison(liaison), carteAlertes(alertes));
}
let champs = 0;
function champ(lbl, el, aide = null) {
  if (aide) { el.id ||= `champ-${++champs}`; el.setAttribute('aria-describedby', el.id + '-aide'); }
  return h('div', { class: 'lbl-champ' }, h('label', {}, h('span', { text: lbl }), el), aide ? h('small', { class: 'hint', id: el.id + '-aide', text: aide }) : null);
}

function carteLiaison(l) {
  const hote = h('input', { class: 'field', value: l?.hote || '', placeholder: 'proxmox.exemple.org ou 192.0.2.10', autocomplete: 'off' });
  const port = h('input', { class: 'field', type: 'number', min: 1, max: 65535, value: l?.port || 8006 });
  const confiance = h('select', { class: 'field' }, [['epingle', 'Empreinte épinglée'], ['autorite', 'Autorité reconnue par le système']].map(([v, t]) => h('option', { value: v, text: t, selected: (l?.confiance || 'epingle') === v })));
  const fp = h('input', { class: 'field mono fs12', value: l?.fp || '', placeholder: 'sha256:…', autocomplete: 'off', spellcheck: false });
  const jetonId = h('input', { class: 'field mono', value: l?.jetonId || '', placeholder: 'proxlab@pve!panneau', autocomplete: 'off' });
  const secret = h('input', { class: 'field mono', type: 'password', placeholder: l?.aSecret ? 'inchangé' : 'secret du jeton', autocomplete: 'new-password' });
  const utilisateur = h('input', { class: 'field mono', value: l?.utilisateur || '', placeholder: 'proxlab@pve (pour la console)', autocomplete: 'off' });
  const mdp = h('input', { class: 'field', type: 'password', placeholder: l?.aMotDePasse ? 'inchangé' : 'mot de passe (pour la console)', autocomplete: 'new-password' });
  const certificat = h('div', { class: 'certificat' });
  const err = h('p', { class: 'erreur', role: 'alert' });
  const etat = h('div', { class: 'cardbody' });
  const peindreEtat = x => etat.replaceChildren(...(x ? [
    h('div', { class: 'kv' }, h('span', { text: 'Grappe' }), h('b', { class: 'mono', text: `${x.hote}:${x.port}` })),
    h('div', { class: 'kv' }, h('span', { text: 'Confiance' }), h('b', { text: x.confiance === 'epingle' ? 'empreinte épinglée' : 'autorité du système' })),
    x.fp ? h('div', { class: 'kv' }, h('span', { text: 'Empreinte' }), h('b', { class: 'mono fs11', text: x.fp })) : null,
    h('div', { class: 'kv' }, h('span', { text: 'Jeton d\'API' }), h('b', { class: 'mono', text: x.jetonId ? `${x.jetonId}${x.aSecret ? '' : ' (sans secret)'}` : '—' })),
    h('div', { class: 'kv' }, h('span', { text: 'Console' }), h('b', { text: x.utilisateur ? `${x.utilisateur}${x.aMotDePasse ? '' : ' (sans mot de passe)'}` : 'non réglée' })),
    h('div', { class: 'kv' }, h('span', { text: 'Vérifiée' }), h('b', { text: x.verifie ? age(x.verifie) : '—' })),
  ] : [h('p', { class: 'hint', text: 'Pas encore reliée.' })]));
  peindreEtat(l);
  const sonder = sur(async () => {
    err.textContent = '';
    const c = await api.post('/api/liaison/sonde', { hote: hote.value.trim(), port: Number(port.value) });
    fp.value = c.fp;
    confiance.value = c.autorite ? 'autorite' : 'epingle';
    certificat.replaceChildren(h('p', { class: 'hint', text: c.autorite ? 'Ce certificat est reconnu par les autorités du système.' : 'Ce certificat n\'est pas reconnu par le système (autosigné ou autorité de la grappe) : compare l\'empreinte avec celle affichée par Proxmox (Système › Certificats) avant d\'enregistrer.' }),
      h('div', { class: 'kv' }, h('span', { text: 'Sujet' }), h('b', { class: 'fs12', text: c.sujet || '—' })), h('div', { class: 'kv' }, h('span', { text: 'Émetteur' }), h('b', { class: 'fs12', text: c.emetteur || '—' })),
      h('div', { class: 'kv' }, h('span', { text: 'Expire' }), h('b', { class: 'fs12', text: c.expire || '—' })), h('div', { class: 'kv' }, h('span', { text: 'Empreinte' }), h('b', { class: 'mono fs11', text: c.fp })));
  });
  const enregistrerL = sur(async () => {
    err.textContent = '';
    try {
      const r = await api.put('/api/liaison', { hote: hote.value.trim(), port: Number(port.value), confiance: confiance.value, fp: fp.value.trim(), jetonId: jetonId.value.trim(), secret: secret.value, utilisateur: utilisateur.value.trim(), motDePasse: mdp.value });
      secret.value = ''; mdp.value = '';
      peindreEtat(r.liaison);
      toast(`Relié à Proxmox VE ${r.version} : ${r.noeuds} nœud${r.noeuds > 1 ? 's' : ''}, ${r.machines} machines.`);
      rafraichir({ synthese: true });
    } catch (e) { err.textContent = e.message; }
  });
  const retirer = sur(async () => {
    if (!await confirmer('Retirer la liaison ?', 'ProxLab oublie l\'adresse, le jeton et le mot de passe. La surveillance s\'arrête.', { danger: true, oui: 'Retirer' })) return;
    await api.del('/api/liaison'); peindreEtat(null); toast('Liaison retirée.'); rafraichir();
  });
  return h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Liaison à Proxmox' }), l ? h('button', { class: 'btn sm flat danger', type: 'button', onclick: retirer }, 'Retirer') : null),
    etat,
    h('div', { class: 'pad formulaire' },
      h('div', { class: 'row2' }, champ('Adresse', hote), champ('Port', port)),
      h('div', { class: 'rowline mt10' }, h('button', { class: 'btn sm', type: 'button', onclick: sonder }, icone('cadenas', 14), 'Lire le certificat')),
      certificat,
      h('div', { class: 'row2 mt10' }, champ('Confiance', confiance), champ('Empreinte SHA-256', fp)),
      h('div', { class: 'row2 mt10' }, champ('Jeton d\'API', jetonId, 'Utilisateur@royaume!nom, avec les droits PVEAuditor et PVEVMUser.'), champ('Secret du jeton', secret)),
      h('div', { class: 'row2 mt10' }, champ('Utilisateur', utilisateur, 'Pour la console : le WebSocket de Proxmox refuse les jetons.'), champ('Mot de passe', mdp)),
      err,
      h('div', { class: 'rowline mt14' }, h('button', { class: 'btn solid', type: 'button', onclick: enregistrerL }, 'Essayer et enregistrer'))));
}

function carteAlertes(a) {
  const actif = h('input', { type: 'checkbox', checked: !!a?.actif });
  const url = h('input', { class: 'field mono fs12', value: a?.url || '', placeholder: 'https://tickets.exemple.org/api/alertes', autocomplete: 'off' });
  const format = h('select', { class: 'field' }, [['ticket', 'Ticket (schéma commun)'], ['brut', 'Événement brut']].map(([v, t]) => h('option', { value: v, text: t, selected: (a?.format || 'ticket') === v })));
  const entete = h('input', { class: 'field mono', value: a?.entete || 'X-API-Key' });
  const cle = h('input', { class: 'field mono', type: 'password', placeholder: a?.aCle ? 'inchangée' : 'clé du récepteur', autocomplete: 'new-password' });
  const secret = h('input', { class: 'field mono', type: 'password', placeholder: a?.aSecret ? 'inchangé' : 'secret HMAC (facultatif)', autocomplete: 'new-password' });
  const lienP = h('input', { class: 'field mono fs12', value: a?.lien || '', placeholder: 'https://proxlab.exemple.org', autocomplete: 'off' });
  const seuil = (v, d) => h('input', { class: 'field', type: 'number', min: 50, max: 100, value: v ?? d });
  const cpu = seuil(a?.cpu, 92), mem = seuil(a?.memoire, 92), sto = seuil(a?.stockage, 90);
  const effCle = h('input', { type: 'checkbox' }), effSecret = h('input', { type: 'checkbox' });
  const err = h('p', { class: 'erreur', role: 'alert' });
  const enregistrerA = sur(async () => {
    err.textContent = '';
    try {
      await api.put('/api/alertes', { actif: actif.checked, url: url.value.trim(), format: format.value, entete: entete.value.trim(), cle: cle.value, secret: secret.value, lien: lienP.value.trim(), cpu: Number(cpu.value), memoire: Number(mem.value), stockage: Number(sto.value), effacerCle: effCle.checked, effacerSecret: effSecret.checked });
      cle.value = ''; secret.value = ''; toast('Alertes enregistrées.');
    } catch (e) { err.textContent = e.message; }
  });
  const essai = sur(async () => { const r = await api.post('/api/alertes/essai', {}); toast(`Essai accepté par le récepteur${r.ref ? ` (réf. ${r.ref})` : ''}.`); });
  return h('div', { class: 'card mt16' }, h('header', {}, h('h2', { text: 'Alertes vers un récepteur de tickets' })),
    h('div', { class: 'pad formulaire' },
      h('p', { class: 'hint', text: 'Les événements sont toujours visibles ici et lus par le Hub. Un récepteur HTTP reçoit en plus chaque panne, signée en HMAC si un secret est réglé.' }),
      h('label', { class: 'chk mt10' }, actif, 'Envoyer les alertes'),
      h('div', { class: 'row2 mt10' }, champ('Adresse du récepteur', url), champ('Format', format)),
      h('div', { class: 'row2 mt10' }, champ('En-tête de la clé', entete), champ('Clé', cle)),
      h('div', { class: 'row2 mt10' }, champ('Secret de signature', secret), champ('Lien vers ProxLab', lienP, 'Ajouté aux tickets.')),
      h('div', { class: 'rowline9 mt10' }, h('label', { class: 'chk' }, effCle, 'Effacer la clé'), h('label', { class: 'chk' }, effSecret, 'Effacer le secret')),
      h('div', { class: 'seuils mt10' }, champ('Seuil processeur (%)', cpu), champ('Seuil mémoire (%)', mem), champ('Seuil stockage (%)', sto)),
      err,
      h('div', { class: 'rowline mt14' }, h('button', { class: 'btn solid', type: 'button', onclick: enregistrerA }, 'Enregistrer'), h('button', { class: 'btn', type: 'button', onclick: essai }, 'Envoyer un essai'))));
}

await rafraichir({ synthese: true });
let tours = 0;
setInterval(() => { tours++; rafraichir({ synthese: tours % 3 === 0 }); }, 20000);
const [p0, ...ref] = location.hash.slice(1).split('/');
// L'écran d'une VM seul dans sa fenêtre (« Ouvrir dans une fenêtre à part »).
if (p0 === 'ecran' && ref.length === 3 && /^[A-Za-z0-9.-]{1,63}$/.test(ref[0]) && ref[1] === 'qemu' && /^\d{2,9}$/.test(ref[2]) && membre) {
  app.hidden = true;
  try {
    const f = await api.get(`/api/machines/${encodeURIComponent(ref[0])}/qemu/${ref[2]}`);
    document.title = `${f.name || 'VM ' + f.vmid} — écran`;
    const fermer = [];
    document.body.append(ecranMachine(f, (o, ws) => fermer.push(() => { o?.detruire?.(); try { ws?.close(); } catch { /* fermé */ } }), null, { auto: true, seul: true }));
    addEventListener('pagehide', () => fermer.forEach(fn => fn()));
  } catch (e) { document.body.append(erreur(e)); }
} else if (p0 === 'fiche' && ref.length === 3 && /^[A-Za-z0-9.-]{1,63}$/.test(ref[0]) && ['qemu', 'lxc'].includes(ref[1]) && /^\d{2,9}$/.test(ref[2])) aller('fiche', ref);
else aller(PAGES[p0] ? p0 : 'over');
