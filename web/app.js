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
  toast, confirmer, dialogue, feuille, ajouterPictos,
} from '/socle/compte.js';
import { courbe, anneau, jauge, calendrier, capacite, tuiles } from '/socle/graphes.js';
import { Terminal } from '/terminal.js';

appliquerTheme();
const SERVICE = 'ProxLab';
const api = new Api({ surDeconnexion: () => location.reload() });
const session = await porte({ api, service: SERVICE, sousTitre: 'grappe Proxmox VE' });
const moi = session.session.compte;
const admin = moi.role === 'admin';
const membre = moi.role !== 'lecture';

ajouterPictos({
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
  photo: '<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.4"/>',
  archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5 8.5V20h14V8.5M10 12h4"/>',
  deplacer: '<path d="M4 12h15M14 7l5 5-5 5"/><path d="M4 6v12"/>',
  actions: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  reseau: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M12 11 6 17M12 11l6 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
});

// ---------- mise en forme ----------
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
const erreur = e => h('div', { class: 'page' }, h('div', { class: 'card' }, h('p', { class: 'vide', text: e.message || String(e) })));
const sur = fn => async e => { e?.stopPropagation?.(); try { await fn(); } catch (x) { toast(x.message, true); } };

// ---------- coque ----------
const stage = h('div', { class: 'stage' });
const navs = {};
const PAGES = {
  over: { titre: 'Vue d\'ensemble', ic: 'vue', rendre: pageVue },
  machines: { titre: 'Machines', ic: 'vm', rendre: pageMachines },
  noeuds: { titre: 'Nœuds', ic: 'noeud', rendre: pageNoeuds },
  stockage: { titre: 'Stockage', ic: 'disque', rendre: pageStockage },
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
    groupe('Grappe', ['over', 'machines', 'noeuds', 'stockage']),
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

// ---------- non relié ----------
function nonRelie() {
  return h('div', { class: 'card vide-grand' },
    h('div', { class: 'itile' }, icone('lien', 18)),
    h('h2', { text: 'Proxmox n\'est pas encore relié' }),
    h('p', { class: 'lede', text: admin
      ? 'Indique l\'adresse de la grappe et un jeton d\'API dans Réglages. Le certificat de Proxmox est vérifié, ou son empreinte épinglée, avant le premier échange.'
      : 'Un administrateur doit relier ProxLab à la grappe dans Réglages.' }),
    admin ? h('button', { class: 'btn solid mt14', type: 'button', onclick: () => aller('reglages') }, icone('reglages', 15), 'Relier Proxmox') : null);
}

// ---------- vue d'ensemble ----------
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
      h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'État de la grappe' }), h('span', { class: 'note', text: '7 jours' })),
        h('div', { class: 'pad etat-grappe' },
          jauge({ valeur: dispo, centre: `${nf(dispo, 1)} %`, sous: 'sans incident', libelle: 'Heures sans incident sur sept jours', etat: dispo >= 99 ? 'g-ok' : dispo >= 95 ? 'g-degrade' : 'g-incident' }),
          h('div', { class: 'resume' },
            ligne('Nœuds en ligne', `${enLigne.length} / ${et.noeuds.length}`, enLigne.length < et.noeuds.length ? 'warn' : ''),
            ligne('Processeur', `${nf(cpu)} %`, cpu >= 85 ? 'warn' : ''),
            ligne('Mémoire', `${mem} %`, mem >= 85 ? 'warn' : ''),
            ligne('Nuits en échec', echecs.length ? String(echecs.length) : 'aucune', echecs.length ? 'warn' : ''))))),
    h('div', { class: 'split mt16' }, carteATraiter(sy.actives), carteJournal()),
    h('div', { class: 'split mt16' }, carteNoeuds(et, sy), h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Invités' }), h('span', { class: 'note', text: `${et.machines.length} au total` })),
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
      h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Sauvegardes' }), h('span', { class: 'note', text: '28 nuits' })),
        h('div', { class: 'pad' }, calendrierSauvegardes(sy.sauvegardes.jours), legendeEtats('Réussies', 'Partielles', 'En échec', 'Aucune'))),
      h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Disponibilité' }), h('span', { class: 'note', text: '7 jours, heure par heure' })),
        h('div', { class: 'pad' }, calendrierDispo(sy.disponibilite), legendeEtats('Sans incident', 'Dégradé', 'Incident')))),
    h('div', { class: 'card mt16' }, h('header', {}, h('h2', { text: 'Stockage' }), h('span', { class: 'note', text: `${octets(utilise)} sur ${octets(total)}` })),
      h('div', { class: 'pad' }, tuiles({ libelle: 'Occupation des stockages', format: octets, parts: st.map(s => ({ nom: `${s.storage}${s.shared ? '' : ' · ' + s.node}`, valeur: s.disk, detail: `${pct(s.disk, s.maxdisk)} % de ${octets(s.maxdisk)}` })) })))];
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
  return h('div', { class: 'card' }, h('header', {}, h('h2', {}, 'À traiter', h('span', { class: 'compte', text: String(actives.length) })), h('button', { class: 'btn sm flat', type: 'button', onclick: () => aller('evenements') }, 'Événements', icone('fleche', 14))),
    h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Élément' }), h('th', { class: 'cache-m', text: 'Nœud' }), h('th', { text: 'Observation' }), h('th', { class: 'cache-s fin', text: 'Depuis' }))),
      h('tbody', {}, actives.length ? actives.slice(0, 8).map(a => {
        const tr = h('tr', { class: vers(a) ? 'cliquable' : '' },
          h('td', {}, h('b', { class: 'mono fw5 sans-retour', text: a.target || '—' })),
          h('td', { class: 'cache-m dim', text: a.node || '—' }),
          h('td', { class: 'principal' }, h('span', { class: 'obs ' + (a.severity === 'critique' ? 'held' : 'warn') }, h('i', { class: 'd' }), h('span', { class: 'tronque', text: a.title }))),
          h('td', { class: 'cache-s fin mono', text: age(a.since) }));
        const f = vers(a); if (f) tr.addEventListener('click', f);
        return tr;
      }) : h('tr', {}, h('td', { colspan: 4, class: 'vide', text: 'Rien à traiter.' }))))));
}

const journal = h('div', { class: 'journal' });
function carteJournal() {
  api.get('/api/evenements?limite=6').then(liste => {
    journal.replaceChildren(...(liste.length ? liste.map(ligneEvenement) : [h('p', { class: 'vide', text: 'Rien pour l\'instant.' })]));
  }).catch(() => {});
  return h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Journal d\'activité' }), h('span', { class: 'note', text: 'en direct' })), journal);
}
function ligneEvenement(e) {
  const ic = e.severity === 'critique' ? 'alerte' : /^backup/.test(e.kind) ? 'archive' : /^snapshot/.test(e.kind) ? 'photo' : /^node|^storage/.test(e.kind) ? 'noeud' : 'vm';
  return h('div', { class: 'evenement ' + e.severity }, h('span', { class: 'ev-ic' }, icone(ic, 15)),
    h('div', { class: 'ev-txt' }, h('b', { text: e.title }), h('span', { text: [GENRES[e.kind] || e.kind, e.node, e.by].filter(Boolean).join(' · ') })),
    h('time', { datetime: e.at, text: age(e.at) }));
}

function carteNoeuds(et, sy) {
  const lignes = et.noeuds.map(n => {
    const ici = et.machines.filter(m => m.node === n.node && !m.template);
    const enPanne = new Set(sy.actives.filter(a => a.kind === 'guest.down' && a.node === n.node).map(a => a.target));
    const ok = ici.filter(m => m.status === 'running').length, incident = ici.filter(m => enPanne.has(cibleDe(m))).length;
    const hors = n.status !== 'online';
    const b = h('div', { class: 'noeud-ligne' },
      h('button', { class: 'noeud-nom', type: 'button', onclick: () => aller('noeuds') }, h('i', { class: 'd ' + (hors ? 'held' : '') }), h('b', { text: n.node }), h('small', { text: `${ici.length} invité${ici.length > 1 ? 's' : ''}` })),
      capacite({ ok: hors ? 0 : ok, incident: hors ? ici.length : incident, repos: hors ? 0 : ici.length - ok - incident, libelle: n.node }),
      h('div', { class: 'noeud-ratio' }, h('b', { text: hors ? 'hors ligne' : `${nf(n.cpu * 100)} %` }), h('small', { text: hors ? '' : `CPU · RAM ${pct(n.mem, n.maxmem)} %` })));
    return b;
  });
  return h('div', { class: 'card' }, h('header', {}, h('h2', { text: 'Nœuds' }), h('span', { class: 'note', text: 'invités par état' })),
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

// ---------- machines ----------
async function pageMachines() {
  const filtres = [['toutes', 'Toutes'], ['marche', 'En marche'], ['arretees', 'Arrêtées'], ['modeles', 'Modèles']];
  const choix = h('div', { class: 'views' });
  const corps = h('tbody', {});
  const compte = h('span', { class: 'grow1 dim' });
  const q = h('input', { class: 'field fld-sm', type: 'search', placeholder: 'Nom, VMID, nœud, étiquette', 'aria-label': 'Chercher une machine', value: E.q });
  const peindre = () => {
    if (!E.etat.relie) { corps.replaceChildren(h('tr', {}, h('td', { colspan: 6, class: 'vide', text: 'Proxmox n\'est pas encore relié.' }))); compte.textContent = ''; return; }
    let l = E.etat.machines.slice();
    if (E.filtre === 'marche') l = l.filter(m => m.status === 'running');
    else if (E.filtre === 'arretees') l = l.filter(m => m.status !== 'running' && !m.template);
    else if (E.filtre === 'modeles') l = l.filter(m => m.template);
    const t = E.q.toLowerCase().trim();
    if (t) l = l.filter(m => `${m.name} ${m.vmid} ${m.node} ${m.tags}`.toLowerCase().includes(t));
    corps.replaceChildren(...(l.length ? l.map(ligneMachine) : [h('tr', {}, h('td', { colspan: 6, class: 'vide', text: 'Aucune machine.' }))]));
    compte.textContent = `${l.length} machine${l.length > 1 ? 's' : ''}`;
  };
  choix.replaceChildren(...filtres.map(([k, l]) => h('button', { class: 'view' + (E.filtre === k ? ' on' : ''), type: 'button', text: l, onclick: () => { E.filtre = k; [...choix.children].forEach(c => c.classList.toggle('on', c.textContent === l)); peindre(); } })));
  q.addEventListener('input', () => { E.q = q.value; peindre(); });
  enregistrer(peindre);
  peindre();
  return h('div', { class: 'page' },
    h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Machines' }), h('p', { class: 'lede', text: 'Machines virtuelles et conteneurs de la grappe, sur tous les nœuds.' }))),
    h('div', { class: 'card' }, h('div', { class: 'pad rowline pt12' }, choix, q, compte),
      h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Machine' }), h('th', { class: 'cache-m', text: 'Nœud' }), h('th', { class: 'cache-l', text: 'Processeur' }), h('th', { class: 'cache-l', text: 'Mémoire' }), h('th', { class: 'cache-s', text: 'En marche depuis' }), h('th', { text: 'État' }))), corps))));
}
function ligneMachine(m) {
  const marche = m.status === 'running';
  const tr = h('tr', { class: 'cliquable' },
    h('td', { class: 'principal' }, h('div', { class: 'who-cell' }, h('span', { class: 'itile' }, icone(m.type === 'qemu' ? 'vm' : 'ct')), h('div', {}, h('b', { text: m.name || `${genreMachine(m)} ${m.vmid}` }), h('small', { class: 'mono', text: `${m.vmid} · ${genreMachine(m)}${m.tags ? ' · ' + m.tags.split(/[;,]/).join(', ') : ''}` })))),
    h('td', { class: 'cache-m dim', text: m.node }),
    h('td', { class: 'cache-l' }, marche ? barre(m.cpu * 100) : h('span', { class: 'dim', text: '—' })),
    h('td', { class: 'cache-l' }, marche ? barre(pct(m.mem, m.maxmem)) : h('span', { class: 'dim', text: octets(m.maxmem) })),
    h('td', { class: 'cache-s mono', text: marche ? duree(m.uptime) : '—' }),
    h('td', {}, tagMachine(m)));
  const ouvrir = () => aller('fiche', [m.node, m.type, String(m.vmid)]);
  tr.addEventListener('click', ouvrir);
  tr.tabIndex = 0;
  tr.addEventListener('keydown', e => { if (e.key === 'Enter') ouvrir(); });
  return tr;
}

// ---------- fiche d'une machine ----------
async function pageFiche(noeud, type, vmid) {
  const base = `/api/machines/${encodeURIComponent(noeud)}/${type}/${vmid}`;
  let f = await api.get(base);
  const onglets = [['resume', 'Résumé'], ['instantanes', 'Instantanés'], ['sauvegardes', 'Sauvegardes'], ['configuration', 'Configuration'], ...(membre ? [['console', 'Console']] : [])];
  let onglet = 'resume', term = null, ws = null;
  const fermerConsole = () => { try { ws?.close(); } catch { /* fermé */ } ws = null; term?.detruire(); term = null; };
  const corps = h('div', { class: 'dtpane' });
  const tabs = h('div', { class: 'views mb16', role: 'tablist' });
  const tete = h('div', { class: 'detailhead' });
  const relire = async () => { f = await api.get(base); peindreTete(); if (onglet !== 'console') montrer(onglet); };
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
      ...(admin && (E.etat.noeuds.length > 1) ? [{ texte: 'Migrer vers un autre nœud', agir: () => migrer(f, base) }] : []),
    ];
    tete.replaceChildren(
      h('button', { class: 'btn sm flat', type: 'button', 'aria-label': 'Retour aux machines', onclick: () => aller('machines') }, icone('retour', 15)),
      h('div', { class: 'big' }, icone(f.type === 'qemu' ? 'vm' : 'ct', 22)),
      h('div', { class: 'grow1' }, h('h1', { text: f.name || `${genreMachine(f)} ${f.vmid}` }), h('div', { class: 'sub dim' }, `${genreMachine(f)} ${f.vmid} · ${f.node} · `, tagMachine(f))),
      h('div', { class: 'actions' },
        membre && !f.template && !marche ? h('button', { class: 'btn solid', type: 'button', onclick: action('start', 'Démarrer') }, icone('marche', 14), h('span', { class: 'cache-s', text: 'Démarrer' })) : null,
        membre && marche ? h('button', { class: 'btn', type: 'button', onclick: action('shutdown', 'Arrêter', { question: 'Arrêter proprement la machine ?' }) }, icone('arret', 14), h('span', { class: 'cache-s', text: 'Arrêter' })) : null,
        membre && marche ? h('button', { class: 'btn', type: 'button', onclick: action('reboot', 'Redémarrer', { question: 'Redémarrer la machine ?' }) }, icone('relance', 14), h('span', { class: 'cache-s', text: 'Redémarrer' })) : null,
        plus.length ? h('button', { class: 'btn', type: 'button', 'aria-label': 'Autres actions', onclick: () => feuille('Autres actions', plus) }, icone('actions', 16)) : null));
  }
  async function montrer(k) {
    onglet = k;
    for (const b of tabs.children) { const on = b.dataset.k === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    if (k !== 'console') fermerConsole();
    history.replaceState(null, '', `#fiche/${noeud}/${type}/${vmid}`);
    try {
      if (k === 'resume') corps.replaceChildren(resumeMachine(f, base));
      else if (k === 'instantanes') corps.replaceChildren(instantanes(f, base, relire));
      else if (k === 'sauvegardes') corps.replaceChildren(await sauvegardes(f, base));
      else if (k === 'configuration') corps.replaceChildren(configuration(f, base, relire));
      else if (k === 'console') corps.replaceChildren(consoleMachine({ noeud: f.node, type: f.type, vmid: String(f.vmid) }, (t, w) => { fermerConsole(); term = t; ws = w; }));
    } catch (e) { corps.replaceChildren(h('p', { class: 'vide', text: e.message })); }
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
    h('div', { class: 'rowline mb12' }, h('h2', { class: 'grow1 fs13', text: 'Relevés' }), choix),
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

// ---------- console ----------
function consoleMachine(cible, garder) {
  const hote = h('div', { class: 'console-hote' });
  const etat = h('span', { class: 'note', text: 'fermée' });
  const ouvrir = sur(async () => {
    const { passe } = await api.post('/api/console', cible);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/console?passe=${encodeURIComponent(passe)}`);
    const term = new Terminal(hote, {
      surSaisie: s => { if (ws.readyState === 1) ws.send(JSON.stringify({ i: s })); },
      surTaille: (c, l) => { if (ws.readyState === 1) ws.send(JSON.stringify({ r: [c, l] })); },
    });
    garder(term, ws);
    etat.textContent = 'connexion…';
    ws.addEventListener('open', () => { etat.textContent = 'ouverte'; ws.send(JSON.stringify({ r: [term.cols, term.lignes] })); term.focus(); });
    ws.addEventListener('message', ev => { if (typeof ev.data === 'string') term.ecrire(ev.data); });
    ws.addEventListener('close', () => { etat.textContent = 'fermée'; });
    bouton.replaceChildren(icone('relance', 14), 'Rouvrir');
  });
  const bouton = h('button', { class: 'btn sm solid', type: 'button', onclick: ouvrir }, icone('terminal', 14), 'Ouvrir');
  hote.append(h('p', { class: 'vide', text: cible.type === 'node' ? 'Shell du nœud, en administrateur : chaque ouverture est journalisée.' : 'Console texte de la machine (termproxy). Chaque ouverture est journalisée.' }));
  return h('div', { class: 'card' }, h('header', {}, h('h2', { text: cible.type === 'node' ? `Shell de ${cible.noeud}` : 'Console' }), etat, bouton), hote);
}

// ---------- nœuds ----------
async function pageNoeuds() {
  const page = h('div', { class: 'page' });
  let shell = { term: null, ws: null };
  const fermer = () => { try { shell.ws?.close(); } catch { /* fermé */ } shell.term?.detruire(); shell = { term: null, ws: null }; };
  const peindre = async () => {
    const et = E.etat;
    const tete = h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Nœuds' }), h('p', { class: 'lede', text: 'Ressources, interfaces réseau et shell de chaque nœud.' })));
    if (!et.relie) { page.replaceChildren(tete, nonRelie()); return; }
    const cartes = await Promise.all(et.noeuds.map(async n => {
      const hors = n.status !== 'online';
      const ifaces = hors ? [] : await api.get(`/api/noeuds/${encodeURIComponent(n.node)}/reseau`).catch(() => []);
      const kv = (k, v) => h('div', { class: 'kv' }, h('span', { text: k }), v instanceof Node ? v : h('b', { text: v }));
      return h('div', { class: 'card' },
        h('header', {}, h('span', { class: 'itile' }, icone('noeud', 15)), h('h2', { text: n.node }), h('span', { class: 'tag ' + (hors ? 'held' : '') }, h('i', { class: 'd' }), hors ? 'hors ligne' : 'en ligne'),
          admin && !hors ? h('button', { class: 'btn sm', type: 'button', onclick: () => { fermer(); zoneShell.replaceChildren(consoleMachine({ noeud: n.node, type: 'node' }, (t, w) => { shell = { term: t, ws: w }; })); zoneShell.scrollIntoView({ behavior: 'smooth' }); } }, icone('terminal', 14), 'Shell') : null),
        h('div', { class: 'cardbody' },
          kv('Processeur', hors ? '—' : barre(n.cpu * 100)), kv('Mémoire', hors ? '—' : barre(pct(n.mem, n.maxmem))), kv('Disque système', hors ? '—' : barre(pct(n.disk, n.maxdisk))),
          kv('Cœurs', String(n.maxcpu)), kv('Mémoire installée', octets(n.maxmem)), kv('En ligne depuis', hors ? '—' : duree(n.uptime)),
          kv('Invités', String(et.machines.filter(m => m.node === n.node && !m.template).length))),
        ifaces.length ? h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Interface' }), h('th', { text: 'Adresse' }), h('th', { class: 'cache-s', text: 'Ports' }))),
          h('tbody', {}, ifaces.map(i => h('tr', {}, h('td', {}, h('b', { class: 'mono fw5', text: i.iface }), h('small', { class: 'dim bloc', text: i.type })), h('td', { class: 'mono', text: i.cidr || '—' }), h('td', { class: 'cache-s mono dim', text: i.ports || '—' })))))) : null);
    }));
    page.replaceChildren(tete, h('div', { class: 'grille' }, cartes), zoneShell);
  };
  const zoneShell = h('div', { class: 'mt16' });
  enregistrer(() => { if (!shell.ws) peindre(); }, fermer);
  await peindre();
  return page;
}

// ---------- stockage ----------
async function pageStockage() {
  const page = h('div', { class: 'page' });
  const peindre = () => {
    const et = E.etat;
    const tete = h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Stockage' }), h('p', { class: 'lede', text: 'Volumes de chaque nœud ; un stockage partagé est vu par tous.' })));
    if (!et.relie) { page.replaceChildren(tete, nonRelie()); return; }
    const liste = et.stockages.slice().sort((a, b) => a.node.localeCompare(b.node) || a.storage.localeCompare(b.storage));
    page.replaceChildren(tete, h('div', { class: 'card' }, h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Stockage' }), h('th', { class: 'cache-m', text: 'Nœud' }), h('th', { class: 'cache-l', text: 'Contenu' }), h('th', { text: 'Occupation' }), h('th', { class: 'cache-s fin', text: 'Libre' }))),
      h('tbody', {}, liste.map(s => {
        const tr = h('tr', { class: 'cliquable', tabIndex: 0 },
          h('td', { class: 'principal' }, h('div', { class: 'who-cell' }, h('span', { class: 'itile' }, icone('disque')), h('div', {}, h('b', { text: s.storage }), h('small', { class: 'mono', text: `${s.plugintype}${s.shared ? ' · partagé' : ''}` })))),
          h('td', { class: 'cache-m dim', text: s.node }),
          h('td', { class: 'cache-l dim', text: s.content.split(',').join(', ') }),
          h('td', {}, barre(pct(s.disk, s.maxdisk), { alerte: 90, attention: 80 })),
          h('td', { class: 'cache-s fin mono', text: octets(s.maxdisk - s.disk) }));
        const ouvrir = () => contenuStockage(s);
        tr.addEventListener('click', ouvrir);
        tr.addEventListener('keydown', e => { if (e.key === 'Enter') ouvrir(); });
        return tr;
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
  await dialogue({ titre: `${s.storage} sur ${s.node}`, large: true, contenu: [choix, liste], boutons: [{ texte: 'Fermer', valeur: null }] });
}

// ---------- tâches ----------
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
        const tr = h('tr', { class: 'cliquable', tabIndex: 0 },
          h('td', { class: 'principal' }, h('b', { class: 'fw5', text: t.type }), h('small', { class: 'dim bloc mono', text: t.id || '—' })),
          h('td', { class: 'cache-m dim', text: t.node }),
          h('td', { class: 'cache-l dim mono fs12', text: t.user }),
          h('td', { class: 'cache-s mono', text: dateHeure(t.starttime) }),
          h('td', {}, h('span', { class: 'tag ' + (enCours ? 'warn' : ok ? '' : 'held') }, h('i', { class: 'd' }), enCours ? 'en cours' : ok ? 'réussie' : String(t.status).slice(0, 40))));
        const ouvrir = () => journalTache(t);
        tr.addEventListener('click', ouvrir);
        tr.addEventListener('keydown', e => { if (e.key === 'Enter') ouvrir(); });
        return tr;
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

// ---------- événements ----------
async function pageEvenements() {
  const corps = h('div', {});
  const plus = h('button', { class: 'btn sm flat', type: 'button', text: 'Plus anciens' });
  let dernier = null;
  const charger = async (suite = false) => {
    const liste = await api.get('/api/evenements?limite=50' + (suite && dernier ? `&avant=${encodeURIComponent(dernier)}` : ''));
    if (!suite) corps.replaceChildren();
    corps.append(...liste.map(ligneEvenement));
    if (!suite && !liste.length) corps.append(h('p', { class: 'vide', text: 'Aucun événement pour l\'instant.' }));
    dernier = liste.at(-1)?.id || dernier;
    plus.hidden = liste.length < 50;
  };
  plus.addEventListener('click', sur(() => charger(true)));
  await charger();
  enregistrer(() => { if (!corps.querySelector('.evenement:nth-child(51)')) charger().catch(() => {}); });
  return h('div', { class: 'page' },
    h('div', { class: 'headrow' }, h('div', {}, h('h1', { class: 'title', text: 'Événements' }), h('p', { class: 'lede', text: 'Ce qui est arrivé à la grappe : pannes, retours, gestes faits depuis ProxLab et tâches lues dans Proxmox.' }))),
    h('div', { class: 'card' }, corps, h('div', { class: 'pad centre' }, plus)));
}

// ---------- réglages ----------
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

// ---------- démarrage ----------
await rafraichir({ synthese: true });
let tours = 0;
setInterval(() => { tours++; rafraichir({ synthese: tours % 3 === 0 }); }, 20000);
const [p0, ...ref] = location.hash.slice(1).split('/');
if (p0 === 'fiche' && ref.length === 3 && /^[A-Za-z0-9.-]{1,63}$/.test(ref[0]) && ['qemu', 'lxc'].includes(ref[1]) && /^\d{2,9}$/.test(ref[2])) aller('fiche', ref);
else aller(PAGES[p0] ? p0 : 'over');
