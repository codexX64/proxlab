// Routes de ProxLab. Chaque route dit qui peut l'appeler — session du socle avec
// son rôle, ou jeton de service du Hub — et rien d'autre. Chaque segment de
// chemin (nœud, type, VMID, instantané, stockage, tâche) est validé contre le
// format de Proxmox avant d'atteindre son API, et chaque réponse ne porte que
// les champs que l'interface montre.
//
// Rôles : lecture (voit la grappe), membre (démarre, arrête proprement,
// redémarre, prend un instantané, lance une sauvegarde, ouvre la console d'une
// machine), admin sous renfort récent (arrêt forcé, migration, configuration,
// retour et suppression d'instantané, suppression de sauvegarde, arrêt d'une
// tâche, shell d'un nœud, liaison à Proxmox, alertes, images ISO et lecteur
// CD, création d'une VM, étiquettes). Supprimer une machine demande en plus son nom
// recopié et une confirmation d'identité faite pour elle seule.
import { detecterClavier, activerConsoleSerie, agentActif } from './clavier.js';
import crypto from 'node:crypto';
import { ErreurHttp, Routeur, lireCorps, valider, repondreJson, egal } from '../socle/src/index.js';
import { ErreurProxmox, Proxmox, chemin } from './pve.js';
import { observer, empreinte, empreinteValide } from './tls.js';
import { ENTETE } from './alerte.js';
import { classer } from './reseau.js';
import { Images, ImageRefusee, FICHIER_ISO } from './images.js';
import { DestinationRefusee, lireUrl } from './sortie.js';

const NOEUD = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$/;
const STOCKAGE = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
const INSTANTANE = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;
const VMID = /^[1-9]\d{1,8}$/;
const UPID = /^UPID:[A-Za-z0-9.!@_:-]{10,250}$/;
const VOLID = /^[A-Za-z][A-Za-z0-9._-]{0,99}:[A-Za-z0-9._\/-]{1,250}$/;
const TYPES = ['qemu', 'lxc'];
const VOLID_ISO = /^[A-Za-z][A-Za-z0-9._-]{0,99}:iso\/[A-Za-z0-9][A-Za-z0-9._+-]{0,200}\.(iso|img)$/i;
const LECTEUR = /^(ide|sata|scsi)\d{1,2}$/;
const PONT = /^[A-Za-z][A-Za-z0-9._-]{0,15}$/;
const IFACE = /^[A-Za-z][A-Za-z0-9._-]{0,19}$/;
const NOM_AFFICHE = /^[\p{L}\p{N}][\p{L}\p{N} ._()+'’-]{0,79}$/u;
const NOMS_ISO_MAX = 1000;
// Étiquettes : un nom lisible posé par ProxLab sur une image, une interface
// réseau, un stockage ou un nœud. Proxmox n'en sait rien : rien n'y est renommé.
const GENRES_ETIQUETTE = ['iso', 'reseau', 'stockage', 'noeud'];
const FORMAT_OBJET = { iso: VOLID_ISO, reseau: IFACE, stockage: STOCKAGE, noeud: NOEUD };
const ETIQUETTES_MAX = 1000;
// La confirmation d'identité d'une suppression : faite dans les deux minutes,
// et pour cette suppression seulement.
const RENFORT_SUPPRESSION_MS = 2 * 60e3;
const PERIODES = ['hour', 'day', 'week', 'month', 'year'];

// Ce que la fiche d'une machine montre de sa configuration. Le reste (mots de
// passe cloud-init, clés SSH, scripts d'accroche, arguments bruts) ne sort pas.
const CONFIG_VISIBLE = /^(name|hostname|description|tags|ostype|arch|cores|sockets|cpu|vcpus|memory|swap|balloon|onboot|startup|boot|bootdisk|machine|bios|agent|scsihw|unprivileged|features|template|protection|lock|vga|(serial|net|scsi|virtio|ide|sata|efidisk|tpmstate|rootfs|mp|unused)\d*)$/;

const S = {
  alimentation: { action: { type: 'chaine', requis: true, parmi: ['start', 'shutdown', 'reboot', 'suspend', 'resume', 'stop', 'reset'] } },
  alimentationHub: { action: { type: 'chaine', requis: true, parmi: ['start', 'shutdown', 'reboot'] } },
  migration: { cible: { type: 'chaine', requis: true, max: 63, motif: NOEUD }, enLigne: { type: 'booleen', defaut: false } },
  configuration: {
    nom: { type: 'chaine', max: 63, motif: NOEUD }, description: { type: 'chaine', max: 2000 },
    coeurs: { type: 'entier', min: 1, max: 512 }, sockets: { type: 'entier', min: 1, max: 8 }, memoire: { type: 'entier', min: 16, max: 4194304 },
    demarrageAuto: { type: 'booleen' }, etiquettes: { type: 'chaine', max: 200, motif: /^[A-Za-z0-9_.;+-]*$/ },
  },
  acces: { portSerie: { type: 'booleen', defaut: false }, pressePapiers: { type: 'booleen', defaut: false }, agent: { type: 'booleen', defaut: false }, ajustement: { type: 'booleen', defaut: false } },
  instantane: { nom: { type: 'chaine', requis: true, motif: INSTANTANE, max: 40 }, description: { type: 'chaine', max: 500, defaut: '' }, avecMemoire: { type: 'booleen', defaut: false } },
  sauvegarde: {
    stockage: { type: 'chaine', requis: true, max: 100, motif: STOCKAGE }, mode: { type: 'chaine', parmi: ['snapshot', 'suspend', 'stop'], defaut: 'snapshot' },
    compression: { type: 'chaine', parmi: ['zstd', 'lzo', 'gzip', '0'], defaut: 'zstd' }, notes: { type: 'chaine', max: 200, defaut: '' },
  },
  console: { noeud: { type: 'chaine', requis: true, max: 63, motif: NOEUD }, type: { type: 'chaine', requis: true, parmi: ['node', ...TYPES] }, vmid: { type: 'chaine', max: 9, motif: VMID }, mode: { type: 'chaine', parmi: ['texte', 'ecran'] } },
  sonde: { hote: { type: 'chaine', requis: true, max: 253 }, port: { type: 'entier', min: 1, max: 65535, defaut: 8006 } },
  liaison: {
    hote: { type: 'chaine', requis: true, max: 253 }, port: { type: 'entier', min: 1, max: 65535, defaut: 8006 },
    confiance: { type: 'chaine', requis: true, parmi: ['autorite', 'epingle'] }, fp: { type: 'chaine', max: 120, defaut: '' },
    jetonId: { type: 'chaine', max: 128, motif: /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]*$/, defaut: '' }, secret: { type: 'chaine', max: 200, defaut: '' },
    utilisateur: { type: 'chaine', max: 128, motif: /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/, defaut: '' }, motDePasse: { type: 'chaine', max: 200, defaut: '' },
  },
  alertes: {
    actif: { type: 'booleen', defaut: false }, url: { type: 'chaine', max: 500, defaut: '' }, format: { type: 'chaine', parmi: ['ticket', 'brut'], defaut: 'ticket' },
    entete: { type: 'chaine', max: 64, motif: ENTETE, defaut: 'X-API-Key' }, cle: { type: 'chaine', max: 500, defaut: '' }, secret: { type: 'chaine', max: 500, defaut: '' },
    service: { type: 'chaine', max: 64, defaut: 'proxmox' }, lien: { type: 'chaine', max: 500, defaut: '' },
    cpu: { type: 'entier', min: 50, max: 100, defaut: 92 }, memoire: { type: 'entier', min: 50, max: 100, defaut: 92 }, stockage: { type: 'entier', min: 50, max: 100, defaut: 90 },
    effacerCle: { type: 'booleen', defaut: false }, effacerSecret: { type: 'booleen', defaut: false },
  },
  // Paramètres de requête : un paramètre qu'une route ne déclare pas est refusé.
  periode: { tf: { type: 'chaine', parmi: PERIODES, defaut: 'hour' } },
  contenu: { type: { type: 'chaine', parmi: ['backup', 'iso', 'vztmpl', 'images', 'rootdir', 'snippets'], defaut: 'backup' } },
  taches: { noeud: { type: 'chaine', max: 63, motif: NOEUD }, limite: { type: 'entier', min: 1, max: 200, defaut: 60 } },
  journal: { debut: { type: 'entier', min: 0, max: 1e6, defaut: 0 } },
  evenements: { limite: { type: 'entier', min: 1, max: 200, defaut: 50 }, avant: { type: 'chaine', max: 20, motif: /^[A-Za-z0-9_-]{12}$/ } },
  volume: { volid: { type: 'chaine', requis: true, max: 360, motif: VOLID } },
  suppression: { nom: { type: 'chaine', requis: true, max: 100 } },
  lecteur: { volid: { type: 'chaine', max: 320, motif: VOLID_ISO, defaut: '' } },
  telechargement: {
    url: { type: 'chaine', requis: true, max: 2000 }, nom: { type: 'chaine', requis: true, max: 205, motif: FICHIER_ISO },
    somme: { type: 'chaine', max: 128, motif: /^([A-Fa-f0-9]{32,128})?$/, defaut: '' },
    algorithme: { type: 'chaine', parmi: ['sha256', 'sha512', 'sha1', 'md5'], defaut: 'sha256' },
  },
  envoi: { nom: { type: 'chaine', requis: true, max: 205, motif: FICHIER_ISO } },
  apercu: { url: { type: 'chaine', requis: true, max: 2000 } },
  iso: { volid: { type: 'chaine', requis: true, max: 320, motif: VOLID_ISO } },
  nomIso: { noeud: { type: 'chaine', requis: true, max: 63, motif: NOEUD }, volid: { type: 'chaine', requis: true, max: 320, motif: VOLID_ISO }, nom: { type: 'chaine', max: 80, defaut: '' } },
  etiquette: {
    genre: { type: 'chaine', requis: true, parmi: GENRES_ETIQUETTE }, noeud: { type: 'chaine', requis: true, max: 63, motif: NOEUD },
    objet: { type: 'chaine', requis: true, max: 320 }, etiquette: { type: 'chaine', max: 80, defaut: '' },
  },
  options: { noeud: { type: 'chaine', requis: true, max: 63, motif: NOEUD } },
  creation: {
    noeud: { type: 'chaine', requis: true, max: 63, motif: NOEUD }, nom: { type: 'chaine', requis: true, max: 63, motif: NOEUD },
    systeme: { type: 'chaine', parmi: ['linux', 'windows', 'autre'], defaut: 'linux' },
    coeurs: { type: 'entier', min: 1, max: 128, defaut: 2 }, memoire: { type: 'entier', min: 256, max: 1048576, defaut: 2048 },
    disque: { type: 'entier', min: 1, max: 65536, defaut: 32 }, stockage: { type: 'chaine', requis: true, max: 100, motif: STOCKAGE },
    iso: { type: 'chaine', max: 320, motif: /^$|^[A-Za-z][A-Za-z0-9._-]{0,99}:iso\/[A-Za-z0-9][A-Za-z0-9._+-]{0,200}\.(iso|img)$/i, defaut: '' },
    pont: { type: 'chaine', requis: true, max: 16, motif: PONT }, demarrer: { type: 'booleen', defaut: true },
  },
};

// Le refus d'une image ou d'une adresse, dit tel quel à l'opérateur.
function versClientImage(e) {
  if (e instanceof ImageRefusee || e instanceof DestinationRefusee) throw new ErreurHttp(e.status, e.message);
  throw e;
}
const LONGUEUR_SOMME = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };

// La configuration d'une VM neuve, par famille de système. Linux : VirtIO
// partout, agent QEMU, port série (la console de ProxLab) et VirtIO-GPU
// (l'écran s'ajuste à la fenêtre). Windows 11 : UEFI, TPM, disque SATA et
// carte e1000, que l'installeur reconnaît sans pilote. Le reste : matériel
// le plus courant.
export function configurationNeuve({ vmid, nom, systeme, coeurs, memoire, disque, stockage, iso, pont }) {
  const commun = { vmid, name: nom, cores: coeurs, sockets: 1, memory: memoire, ide2: `${iso || 'none'},media=cdrom`, onboot: 0 };
  if (systeme === 'linux') return { ...commun, ostype: 'l26', scsihw: 'virtio-scsi-single', scsi0: `${stockage}:${disque},iothread=1,discard=on`, net0: `virtio,bridge=${pont}`, agent: '1', vga: 'virtio', serial0: 'socket', boot: 'order=scsi0;ide2;net0' };
  if (systeme === 'windows') return { ...commun, ostype: 'win11', machine: 'q35', bios: 'ovmf', efidisk0: `${stockage}:1,efitype=4m,pre-enrolled-keys=1`, tpmstate0: `${stockage}:1,version=v2.0`, sata0: `${stockage}:${disque}`, net0: `e1000,bridge=${pont}`, agent: '1', boot: 'order=sata0;ide2;net0' };
  return { ...commun, ostype: 'other', sata0: `${stockage}:${disque}`, net0: `e1000,bridge=${pont}`, boot: 'order=sata0;ide2;net0' };
}

const ACTIONS = {
  start: ['guest.started', 'démarrée'], shutdown: ['guest.stopped', 'arrêtée proprement'], reboot: ['guest.rebooted', 'redémarrée'],
  suspend: ['guest.suspended', 'suspendue'], resume: ['guest.resumed', 'reprise'], stop: ['guest.stopped', 'arrêtée de force'], reset: ['guest.rebooted', 'réinitialisée'],
};
const FORCEES = new Set(['stop', 'reset']);

// Une erreur de Proxmox : l'opérateur lit la cause, sans chemin de fichier de
// l'hyperviseur ; le détail complet va au journal du serveur, sous une référence.
function versClient(e, log) {
  if (!(e instanceof ErreurProxmox)) throw e;
  const ref = crypto.randomBytes(4).toString('hex');
  log.warn?.(`[proxmox] (réf. ${ref}) ${String(e.message).slice(0, 500)}`);
  const court = String(e.message).replace(/\/[\w./-]+/g, '…').replace(/\s+/g, ' ').trim().slice(0, 160);
  throw new ErreurHttp(e.status === 409 ? 409 : e.status >= 400 && e.status < 500 ? e.status : 502, `${/^Proxmox\b/.test(court) ? '' : 'Proxmox : '}${court} (réf. ${ref}).`);
}

const nombre = v => (Number.isFinite(+v) ? +v : 0);
const noeudPublic = n => ({ node: n.node, status: n.status, cpu: nombre(n.cpu), maxcpu: nombre(n.maxcpu), mem: nombre(n.mem), maxmem: nombre(n.maxmem), disk: nombre(n.disk), maxdisk: nombre(n.maxdisk), uptime: nombre(n.uptime) });
const machinePublique = g => ({
  node: g.node, type: g.type, vmid: nombre(g.vmid), name: String(g.name || ''), status: g.status, template: !!g.template, tags: String(g.tags || ''),
  cpu: nombre(g.cpu), maxcpu: nombre(g.maxcpu), mem: nombre(g.mem), maxmem: nombre(g.maxmem), disk: nombre(g.disk), maxdisk: nombre(g.maxdisk), uptime: nombre(g.uptime),
});
const stockagePublic = s => ({ node: s.node, storage: s.storage, plugintype: s.plugintype || '', status: s.status, shared: !!s.shared, content: s.content || '', disk: nombre(s.disk), maxdisk: nombre(s.maxdisk) });
const tachePublique = t => ({ upid: t.upid, node: t.node, type: t.type, id: t.id || '', user: t.user || '', starttime: nombre(t.starttime), endtime: nombre(t.endtime), status: t.status || '' });

export function creerApi({ socle, cfg, reglages, evenements, surveillance, emetteur, proxmox, log = console }) {
  const r = new Routeur();
  const { portail, journal, limiteur, comptes } = socle;
  const pve = (fn) => fn().catch(e => versClient(e, log));
  const images = new Images({ proxmox, journal, evenements, log });
  const image = fn => pve(() => fn().catch(versClientImage));

  // Le jeton du Hub : vérifié en temps constant, un faux compte comme un échec
  // pour l'adresse (limiteur persistant du socle), jamais un repli sur la session.
  const cleMachine = ctx => [`ip:machine:${ctx.ip}`];
  const hub = ctx => {
    const h = String(ctx.req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) throw new ErreurHttp(401, 'Jeton de service attendu.');
    limiteur.controler(cleMachine(ctx));
    if (cfg.jetonHub && egal(h.slice(7), cfg.jetonHub)) return true;
    limiteur.echec(cleMachine(ctx));
    journal.rare(`hub:${ctx.ip}`, { action: 'connexion.jeton', objet: ctx.url.pathname, ip: ctx.ip, resultat: 'refus' });
    throw new ErreurHttp(401, 'Jeton de service invalide.');
  };
  const session = (ctx, opts = {}) => portail.exiger(ctx, { role: 'lecture', ...opts });
  const acteur = ctx => ({ acteur: ctx.session?.compteLigne?.identifiant || 'Hub', acteurCompte: ctx.session?.compte || null });
  const corps = async (ctx, schema) => valider(await lireCorps(ctx.req), schema);

  // Segments du chemin d'une machine, validés une fois.
  const machine = ({ noeud, type, vmid }) => {
    if (!NOEUD.test(noeud) || !TYPES.includes(type) || !VMID.test(vmid)) throw new ErreurHttp(404, 'Machine introuvable.');
    return { noeud, type, vmid, base: chemin('nodes', noeud, type, vmid), cible: `${type}/${vmid}` };
  };
  const noeud = n => { if (!NOEUD.test(n)) throw new ErreurHttp(404, 'Nœud introuvable.'); return n; };
  const stockageDe = ({ noeud: n, stockage }) => { if (!NOEUD.test(n) || !STOCKAGE.test(stockage)) throw new ErreurHttp(404, 'Stockage introuvable.'); return { n, stockage }; };
  const tacheDe = ({ noeud: n, upid }) => { if (!NOEUD.test(n) || !UPID.test(upid)) throw new ErreurHttp(404, 'Tâche introuvable.'); return { n, upid }; };
  const instantane = nom => { if (!INSTANTANE.test(nom)) throw new ErreurHttp(404, 'Instantané introuvable.'); return nom; };

  async function etatGrappe() {
    const ressources = await proxmox.get('/cluster/resources');
    const noeuds = ressources.filter(x => x.type === 'node').map(noeudPublic).sort((a, b) => a.node.localeCompare(b.node));
    const machines = ressources.filter(x => TYPES.includes(x.type)).map(machinePublique).sort((a, b) => a.vmid - b.vmid);
    const stockages = ressources.filter(x => x.type === 'storage').map(stockagePublic);
    return { noeuds, machines, stockages };
  }

  // Étiquettes des images : sous « noms_iso » (leur clé d'avant), les autres sous « etiquettes ».
  // Clé : l'objet, précédé du nœud quand il n'existe que sur lui.
  const cleStockage = (n, st, partage) => (partage ? st : `${n}/${st}`);
  const etiquettes = genre => (genre === 'iso' ? reglages.lire('noms_iso') : reglages.lire('etiquettes')?.[genre]) || {};
  const etiquetteDe = (genre, cle) => etiquettes(genre)[cle] || '';
  async function etiqueter(ctx, genre, n, objet, texte) {
    const propre = texte.trim().replace(/\s+/g, ' ');
    if (propre && !NOM_AFFICHE.test(propre)) throw new ErreurHttp(400, 'Étiquette : lettres, chiffres, espaces, points, tirets, parenthèses (80 au plus).');
    if (!FORMAT_OBJET[genre].test(objet)) throw new ErreurHttp(400, 'Objet hors format.');
    let cle;
    if (genre === 'iso') {
      const i = (await inventaireIso()).isos.find(x => x.volid === objet && (x.shared || x.node === n));
      if (!i) throw new ErreurHttp(404, 'Image introuvable.');
      cle = i.shared ? i.volid : `${i.node}/${i.volid}`;
    } else if (genre === 'reseau') {
      const ifaces = await pve(() => proxmox.get(chemin('nodes', n, 'network')));
      if (!(ifaces || []).some(i => i.iface === objet)) throw new ErreurHttp(404, `Pas d’interface ${objet} sur ${n}.`);
      cle = `${n}/${objet}`;
    } else if (genre === 'stockage') {
      const st = ((await pve(() => proxmox.get(chemin('nodes', n, 'storage')))) || []).find(x => x.storage === objet);
      if (!st) throw new ErreurHttp(404, `Pas de stockage ${objet} sur ${n}.`);
      cle = cleStockage(n, objet, !!st.shared);
    } else {
      if (objet !== n || !(await pve(etatGrappe)).noeuds.some(x => x.node === n)) throw new ErreurHttp(404, 'Nœud introuvable.');
      cle = n;
    }
    const liste = { ...etiquettes(genre) };
    if (propre) liste[cle] = propre; else delete liste[cle];
    if (Object.keys(liste).length > (genre === 'iso' ? NOMS_ISO_MAX : ETIQUETTES_MAX)) throw new ErreurHttp(409, 'Trop d’étiquettes gardées : retire celles des objets disparus.');
    if (genre === 'iso') reglages.ecrire('noms_iso', liste);
    else reglages.ecrire('etiquettes', { ...(reglages.lire('etiquettes') || {}), [genre]: liste });
    journal.ecrire({ acteur: acteur(ctx).acteurCompte, action: genre === 'iso' ? 'iso.nom' : `etiquette.${genre}`, objet: genre === 'iso' ? objet : cle, ip: ctx.ip, details: { nom: propre || null } });
    return propre;
  }

  r.put('/api/etiquettes', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const { genre, noeud: n, objet, etiquette } = await corps(ctx, S.etiquette);
    return { genre, objet, etiquette: await etiqueter(ctx, genre, n, objet, etiquette) };
  }, { role: 'admin' });

  r.get('/api/health', () => ({ ok: true }), { public: true });

  r.get('/api/etat', async ctx => {
    session(ctx);
    const relie = !!reglages.lire('liaison');
    if (!relie) return { relie, intervalle: cfg.intervalle, noeuds: [], machines: [], stockages: [], at: Date.now() };
    const { noeuds, machines, stockages } = await pve(etatGrappe);
    return {
      relie, intervalle: cfg.intervalle, machines, at: Date.now(),
      noeuds: noeuds.map(n => ({ ...n, alias: etiquetteDe('noeud', n.node) })),
      stockages: stockages.map(x => ({ ...x, alias: etiquetteDe('stockage', cleStockage(x.node, x.storage, x.shared)) })),
    };
  }, { role: 'lecture' });

  r.get('/api/noeuds/:noeud/reseau', async ctx => {
    session(ctx);
    const n = noeud(ctx.params.noeud);
    const ifaces = await pve(() => proxmox.get(chemin('nodes', n, 'network')));
    return (ifaces || []).filter(i => IFACE.test(i.iface || '')).map(i => ({
      iface: i.iface, type: i.type, cidr: i.cidr || i.address || '', gateway: i.gateway || '', ports: i.bridge_ports || i.slaves || '', active: !!i.active,
      alias: etiquetteDe('reseau', `${n}/${i.iface}`), commentaire: String(i.comments || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }))
      .sort((a, b) => String(a.iface).localeCompare(String(b.iface)));
  }, { role: 'lecture' });

  r.get('/api/noeuds/:noeud/rrd', async ctx => {
    session(ctx);
    const { tf } = ctx.q;
    return pve(() => proxmox.get(chemin('nodes', noeud(ctx.params.noeud), 'rrddata'), { timeframe: tf, cf: 'AVERAGE' }));
  }, { role: 'lecture', requete: S.periode });

  r.get('/api/machines/:noeud/:type/:vmid', async ctx => {
    session(ctx);
    const m = machine(ctx.params);
    // La configuration en vigueur (current=1) ; sans lui, Proxmox rend les
    // valeurs en attente du prochain démarrage, et un port série ou un
    // presse-papiers tout juste ajoutés passeraient pour actifs.
    const [statut, config, attente, instantanes] = await pve(() => Promise.all([
      proxmox.get(m.base + '/status/current'), proxmox.get(m.base + '/config', { current: 1 }), proxmox.get(m.base + '/config'), proxmox.get(m.base + '/snapshot').catch(() => []),
    ]));
    return {
      ...machinePublique({ ...statut, node: m.noeud, type: m.type, vmid: m.vmid }),
      config: Object.fromEntries(Object.entries(config || {}).filter(([k]) => CONFIG_VISIBLE.test(k)).map(([k, v]) => [k, String(v).slice(0, 2000)])),
      enAttente: ['serial0', 'vga', 'agent'].filter(k => String(attente?.[k] ?? '') !== String(config?.[k] ?? '')),
      // Le genre d'affichage du prochain démarrage (std, virtio, qxl…), sans ses options.
      vgaSuivant: String(attente?.vga || 'std').split(',')[0].slice(0, 20),
      instantanes: (instantanes || []).filter(s => s.name !== 'current').map(s => ({ name: s.name, description: String(s.description || '').slice(0, 500), snaptime: nombre(s.snaptime), parent: s.parent || '', vmstate: !!s.vmstate })),
    };
  }, { role: 'lecture' });

  r.get('/api/machines/:noeud/:type/:vmid/rrd', async ctx => {
    session(ctx);
    const m = machine(ctx.params);
    const { tf } = ctx.q;
    return pve(() => proxmox.get(m.base + '/rrddata', { timeframe: tf, cf: 'AVERAGE' }));
  }, { role: 'lecture', requete: S.periode });

  r.get('/api/machines/:noeud/:type/:vmid/sauvegardes', async ctx => {
    session(ctx);
    const m = machine(ctx.params);
    const stockages = (await pve(() => proxmox.get(chemin('nodes', m.noeud, 'storage'), { content: 'backup' }))) || [];
    const sauvegardes = [];
    for (const s of stockages.filter(x => x.enabled !== 0 && STOCKAGE.test(x.storage))) {
      const liste = await proxmox.get(chemin('nodes', m.noeud, 'storage', s.storage, 'content'), { content: 'backup', vmid: m.vmid }).catch(() => []);
      for (const b of liste || []) sauvegardes.push({ storage: s.storage, volid: b.volid, ctime: nombre(b.ctime), size: nombre(b.size), notes: String(b.notes || '').slice(0, 200) });
    }
    sauvegardes.sort((a, b) => b.ctime - a.ctime);
    return { stockages: stockages.filter(s => STOCKAGE.test(s.storage)).map(s => s.storage), sauvegardes: sauvegardes.slice(0, 200) };
  }, { role: 'lecture' });

  r.get('/api/stockages/:noeud/:stockage/contenu', async ctx => {
    session(ctx);
    const { n, stockage } = stockageDe(ctx.params);
    const { type } = ctx.q;
    const liste = await pve(() => proxmox.get(chemin('nodes', n, 'storage', stockage, 'content'), { content: type }));
    return (liste || []).slice(0, 500).map(c => ({ volid: c.volid, format: c.format || '', size: nombre(c.size), ctime: nombre(c.ctime), vmid: c.vmid ? nombre(c.vmid) : null, content: c.content || '' }));
  }, { role: 'lecture', requete: S.contenu });

  r.get('/api/taches', async ctx => {
    session(ctx);
    const { noeud: n, limite } = ctx.q;
    const liste = n ? await pve(() => proxmox.get(chemin('nodes', n, 'tasks'), { limit: limite, start: 0 })) : await pve(() => proxmox.get('/cluster/tasks'));
    return (liste || []).filter(t => UPID.test(t.upid || '')).slice(0, limite).map(tachePublique);
  }, { role: 'lecture', requete: S.taches });

  r.get('/api/taches/:noeud/:upid', async ctx => {
    session(ctx);
    const { n, upid } = tacheDe(ctx.params);
    const { debut } = ctx.q;
    const [statut, lignes] = await pve(() => Promise.all([
      proxmox.get(chemin('nodes', n, 'tasks', upid, 'status')),
      proxmox.get(chemin('nodes', n, 'tasks', upid, 'log'), { start: debut, limit: 500 }),
    ]));
    return { status: statut?.status || '', exitstatus: statut?.exitstatus || '', lignes: (lignes || []).map(l => ({ n: nombre(l.n), t: String(l.t ?? '').slice(0, 2000) })) };
  }, { role: 'lecture', requete: S.journal });

  r.get('/api/evenements', ctx => {
    session(ctx);
    const { limite, avant } = ctx.q;
    return evenements.liste({ limite, avant });
  }, { role: 'lecture', requete: S.evenements });

  // Synthèse de la vue d'ensemble : ce qui est à traiter, vingt-huit nuits de
  // sauvegardes (tâches vzdump de chaque nœud en ligne) et sept jours de
  // disponibilité heure par heure (incidents notés par la surveillance).
  r.get('/api/synthese', async ctx => {
    session(ctx);
    const t = Date.now(), jour = 864e5, heure = 3600e3;
    const premierJour = Math.floor(t / jour) * jour - 27 * jour;
    const jours = Array.from({ length: 28 }, (_, i) => ({ jour: new Date(premierJour + i * jour).toISOString().slice(0, 10), ok: 0, echec: 0 }));
    const recentes = { ok: 0, echec: 0 };
    const relie = !!reglages.lire('liaison');
    if (relie) {
      const { noeuds } = await pve(etatGrappe);
      for (const n of noeuds.filter(x => x.status === 'online' && NOEUD.test(x.node))) {
        const taches = await proxmox.get(chemin('nodes', n.node, 'tasks'), { typefilter: 'vzdump', since: Math.floor(premierJour / 1000), limit: 500, start: 0 }).catch(() => []);
        for (const x of taches || []) {
          if (!x.endtime) continue;
          const i = Math.floor((x.starttime * 1000 - premierJour) / jour);
          const ok = x.status === 'OK';
          if (jours[i]) jours[i][ok ? 'ok' : 'echec']++;
          if (x.endtime * 1000 > t - jour) recentes[ok ? 'ok' : 'echec']++;
        }
      }
    }
    const debut = Math.floor(t / heure) * heure - 167 * heure;
    const heures = Array.from({ length: 168 }, () => 'ok');
    for (const e of evenements.incidents(debut)) {
      const i = Math.floor((e.cree - debut) / heure);
      if (heures[i] === undefined) continue;
      const grave = ['guest.down', 'node.offline'].includes(e.genre) || e.niveau === 'critique';
      if (grave) heures[i] = 'incident'; else if (heures[i] === 'ok') heures[i] = 'degrade';
    }
    return { relie, actives: surveillance.actives(), sauvegardes: { jours, recentes }, disponibilite: { debut: new Date(debut).toISOString(), heures } };
  }, { role: 'lecture' });

  r.post('/api/machines/:noeud/:type/:vmid/alimentation', async ctx => {
    session(ctx, { role: 'membre' });
    const m = machine(ctx.params);
    const { action } = await corps(ctx, S.alimentation);
    if (FORCEES.has(action)) session(ctx, { role: 'admin', renfort: true });
    return alimenter(ctx, m, action);
  }, { role: 'membre' });

  async function alimenter(ctx, m, action) {
    if (m.type === 'lxc' && ['reset'].includes(action)) throw new ErreurHttp(400, 'Action indisponible sur un conteneur.');
    if (['shutdown', 'stop'].includes(action)) surveillance.arretVoulu(m.cible);
    const upid = await pve(() => proxmox.post(`${m.base}/status/${action}`, {}));
    clavierConnu.delete(m.cible);   // le système qui redémarre peut changer de clavier, ou d'agent
    const [genre, verbe] = ACTIONS[action];
    const qui = acteur(ctx);
    evenements.noter({ genre, niveau: FORCEES.has(action) ? 'avertissement' : 'info', titre: `${m.type === 'qemu' ? 'VM' : 'CT'} ${m.vmid} ${verbe}`, corps: `Depuis ProxLab, par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    if (FORCEES.has(action)) journal.ecrire({ acteur: qui.acteurCompte, action: 'machine.alimentation', objet: m.cible, ip: ctx.ip, details: { action, noeud: m.noeud } });
    return { upid: String(upid || '') };
  }

  r.post('/api/machines/:noeud/:type/:vmid/migration', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const m = machine(ctx.params);
    const { cible, enLigne } = await corps(ctx, S.migration);
    if (cible === m.noeud) throw new ErreurHttp(400, 'La machine est déjà sur ce nœud.');
    const params = { target: cible, ...(m.type === 'qemu' ? { online: enLigne ? 1 : 0 } : { restart: enLigne ? 1 : 0 }) };
    const upid = await pve(() => proxmox.post(m.base + '/migrate', params));
    const qui = acteur(ctx);
    evenements.noter({ genre: 'vm.migrated', niveau: 'info', titre: `${m.type === 'qemu' ? 'VM' : 'CT'} ${m.vmid} migrée vers ${cible}`, corps: `Migration ${enLigne ? 'à chaud' : 'à froid'} depuis ${m.noeud}, par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    journal.ecrire({ acteur: qui.acteurCompte, action: 'machine.migration', objet: m.cible, ip: ctx.ip, details: { de: m.noeud, vers: cible } });
    return { upid: String(upid || '') };
  }, { role: 'admin' });

  r.put('/api/machines/:noeud/:type/:vmid/configuration', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const m = machine(ctx.params);
    const b = await corps(ctx, S.configuration);
    const params = {};
    if (b.nom !== undefined) params[m.type === 'qemu' ? 'name' : 'hostname'] = b.nom;
    if (b.description !== undefined) params.description = b.description;
    if (b.coeurs !== undefined) params.cores = b.coeurs;
    if (b.sockets !== undefined && m.type === 'qemu') params.sockets = b.sockets;
    if (b.memoire !== undefined) params.memory = b.memoire;
    if (b.demarrageAuto !== undefined) params.onboot = b.demarrageAuto ? 1 : 0;
    if (b.etiquettes !== undefined) params.tags = b.etiquettes;
    if (!Object.keys(params).length) throw new ErreurHttp(400, 'Aucun champ modifiable fourni.');
    await pve(() => proxmox.put(m.base + '/config', params));
    const qui = acteur(ctx);
    journal.ecrire({ acteur: qui.acteurCompte, action: 'machine.configuration', objet: m.cible, ip: ctx.ip, details: { champs: Object.keys(params).join(',') } });
    evenements.noter({ genre: 'vm.configured', niveau: 'info', titre: `Configuration de ${m.type === 'qemu' ? 'VM' : 'CT'} ${m.vmid} modifiée`, corps: `Champs : ${Object.keys(params).join(', ')} — par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    return { ok: true };
  }, { role: 'admin' });

  // Ce que la console et l'écran demandent à la VM : un port série (console
  // texte) et le presse-papiers de l'écran (agent VNC de QEMU, relayé par
  // spice-vdagent dans l'invité). Pris en compte au prochain démarrage complet.
  r.post('/api/machines/:noeud/:type/:vmid/acces', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const m = machine(ctx.params);
    if (m.type !== 'qemu') throw new ErreurHttp(400, 'Réservé aux machines virtuelles.');
    const b = await corps(ctx, S.acces);
    if (!b.portSerie && !b.pressePapiers && !b.agent && !b.ajustement) throw new ErreurHttp(400, 'Rien à ajouter.');
    const config = await pve(() => proxmox.get(m.base + '/config'));
    const params = {};
    if (b.portSerie && !Object.keys(config || {}).some(k => /^serial\d$/.test(k))) params.serial0 = 'socket';
    if (b.pressePapiers || b.ajustement) {
      const vga = String(config?.vga || '');
      let [genre = '', ...options] = vga.split(',').filter(Boolean);
      // Taille de l'écran suivant la fenêtre : VirtIO-GPU, seul affichage dont
      // QEMU transmet la taille demandée à l'invité. Les options restent.
      if (b.ajustement && !/^virtio/.test(genre)) {
        if (/^(serial|none)/.test(genre)) throw new ErreurHttp(409, `Cette VM n'a pas d'écran graphique (${genre}) : rien à ajuster.`);
        genre = 'virtio';
      }
      if (b.pressePapiers) {
        if (/^(qxl|serial|none)/.test(genre)) throw new ErreurHttp(409, `L'affichage de cette VM (${genre}) ne prend pas le presse-papiers VNC : passe-le en « std » ou « virtio » dans Proxmox.`);
        if (!options.includes('clipboard=vnc')) options = [...options.filter(o => !o.startsWith('clipboard=')), 'clipboard=vnc'];
      }
      const nouveau = [genre || 'std', ...options].join(',');
      if (nouveau !== vga) params.vga = nouveau;
    }
    if (b.agent && !agentActif(config?.agent)) params.agent = ['enabled=1', ...String(config?.agent || '').split(',').filter(o => o && !/^(enabled=|[01]$)/.test(o))].join(',');
    if (!Object.keys(params).length) return { ok: true, deja: true };
    // Lue puis réécrite : l'empreinte de la configuration lue fait refuser
    // l'écriture par Proxmox si quelqu'un l'a changée entre-temps.
    await pve(() => proxmox.put(m.base + '/config', { ...params, ...(config?.digest ? { digest: String(config.digest) } : {}) }));
    clavierConnu.delete(m.cible);
    const qui = acteur(ctx);
    const quoi = [params.serial0 && 'port série', params.vga && b.pressePapiers && 'presse-papiers', params.vga && b.ajustement && 'affichage VirtIO-GPU', params.agent && 'agent QEMU'].filter(Boolean).join(', ');
    journal.ecrire({ acteur: qui.acteurCompte, action: 'machine.configuration', objet: m.cible, ip: ctx.ip, details: { champs: Object.keys(params).join(',') } });
    evenements.noter({ genre: 'vm.configured', niveau: 'info', titre: `VM ${m.vmid} : ${quoi} ajouté${Object.keys(params).length > 1 ? 's' : ''}`, corps: `Pris en compte au prochain démarrage complet — par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    return { ok: true, champs: Object.keys(params) };
  }, { role: 'admin' });

  // La disposition du clavier de la VM, demandée à son agent QEMU (script fixe,
  // voir src/clavier.js), gardée deux minutes.
  // Une lecture fait tourner un script dans la VM : une seule à la fois par VM,
  // pas plus d'une toutes les cinq secondes même relancée, et chacune au journal
  // (une ligne par VM et par minute).
  const clavierConnu = new Map();
  r.get('/api/machines/:noeud/:type/:vmid/clavier', async ctx => {
    session(ctx, { role: 'membre' });
    const m = machine(ctx.params);
    const { relire } = ctx.q;
    if (m.type !== 'qemu') throw new ErreurHttp(400, 'Réservé aux machines virtuelles.');
    const t = Date.now(), deja = clavierConnu.get(m.cible);
    if (deja?.encours) return deja.encours;
    if (deja && (t < deja.expire && !relire || t - deja.lu < 5000)) return deja.r;
    journal.rare(`clavier:${m.cible}`, { acteur: acteur(ctx).acteurCompte, action: 'machine.clavier', objet: m.cible, ip: ctx.ip });
    const encours = pve(() => detecterClavier(proxmox, m.base));
    if (clavierConnu.size > 500) clavierConnu.clear();
    clavierConnu.set(m.cible, { ...deja, encours });
    try {
      const r = await encours;
      clavierConnu.set(m.cible, { r, lu: Date.now(), expire: Date.now() + (r.disposition ? 120e3 : 15e3) });
      return r;
    } catch (e) { clavierConnu.delete(m.cible); throw e; }
  }, { role: 'membre', requete: { relire: { type: 'chaine', parmi: ['1'] } } });

  // La connexion sur le port série dans l'invité (serial-getty), activée par
  // l'agent QEMU avec une commande fixe : la console texte répond ensuite.
  // Administrateur et renfort : c'est une commande lancée dans la VM, en root.
  const serieEnCours = new Set();
  r.post('/api/machines/:noeud/:type/:vmid/console-serie', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const m = machine(ctx.params);
    if (m.type !== 'qemu') throw new ErreurHttp(400, 'Réservé aux machines virtuelles.');
    await corps(ctx, {});
    if (serieEnCours.has(m.cible)) throw new ErreurHttp(409, 'Activation déjà en cours pour cette VM.');
    serieEnCours.add(m.cible);
    try {
      const r = await pve(() => activerConsoleSerie(proxmox, m.base));
      const qui = acteur(ctx);
      journal.ecrire({ acteur: qui.acteurCompte, action: 'machine.console_serie', objet: m.cible, ip: ctx.ip, resultat: r.ok ? 'ok' : 'erreur', details: { raison: r.raison || null } });
      if (r.ok) evenements.noter({ genre: 'vm.configured', niveau: 'info', titre: `VM ${m.vmid} : connexion sur le port série activée`, corps: `serial-getty@ttyS0 activé par l'agent QEMU — par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
      return r;
    } finally { serieEnCours.delete(m.cible); }
  }, { role: 'admin' });

  r.post('/api/machines/:noeud/:type/:vmid/instantanes', async ctx => {
    session(ctx, { role: 'membre' });
    const m = machine(ctx.params);
    const { nom, description, avecMemoire } = await corps(ctx, S.instantane);
    const upid = await pve(() => proxmox.post(m.base + '/snapshot', { snapname: nom, description, ...(m.type === 'qemu' && avecMemoire ? { vmstate: 1 } : {}) }));
    const qui = acteur(ctx);
    evenements.noter({ genre: 'snapshot.created', niveau: 'info', titre: `Instantané « ${nom} » de ${m.cible}`, corps: description, cible: m.cible, noeud: m.noeud, ...qui });
    return { upid: String(upid || '') };
  }, { role: 'membre' });

  r.post('/api/machines/:noeud/:type/:vmid/instantanes/:nom/retour', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const m = machine(ctx.params);
    const nom = instantane(ctx.params.nom);
    const upid = await pve(() => proxmox.post(`${m.base}/snapshot/${nom}/rollback`, {}));
    const qui = acteur(ctx);
    evenements.noter({ genre: 'snapshot.rolled_back', niveau: 'avertissement', titre: `Retour à l'instantané « ${nom} » de ${m.cible}`, corps: `Tout ce qui suivait cet instantané est perdu. Par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    journal.ecrire({ acteur: qui.acteurCompte, action: 'instantane.retour', objet: m.cible, ip: ctx.ip, details: { instantane: nom } });
    return { upid: String(upid || '') };
  }, { role: 'admin' });

  r.del('/api/machines/:noeud/:type/:vmid/instantanes/:nom', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const m = machine(ctx.params);
    const nom = instantane(ctx.params.nom);
    const upid = await pve(() => proxmox.del(`${m.base}/snapshot/${nom}`));
    const qui = acteur(ctx);
    journal.ecrire({ acteur: qui.acteurCompte, action: 'instantane.suppression', objet: m.cible, ip: ctx.ip, details: { instantane: nom } });
    evenements.noter({ genre: 'snapshot.deleted', niveau: 'info', titre: `Instantané « ${nom} » de ${m.cible} supprimé`, corps: `Par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    return { upid: String(upid || '') };
  }, { role: 'admin' });

  r.post('/api/machines/:noeud/:type/:vmid/sauvegardes', async ctx => {
    session(ctx, { role: 'membre' });
    const m = machine(ctx.params);
    const b = await corps(ctx, S.sauvegarde);
    const upid = await pve(() => proxmox.post(chemin('nodes', m.noeud, 'vzdump'), {
      vmid: m.vmid, storage: b.stockage, mode: b.mode, compress: b.compression, remove: 0, ...(b.notes ? { 'notes-template': b.notes } : {}),
    }));
    const qui = acteur(ctx);
    evenements.noter({ genre: 'backup.started', niveau: 'info', titre: `Sauvegarde de ${m.cible} lancée`, corps: `Vers ${b.stockage}, mode ${b.mode}, par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    return { upid: String(upid || '') };
  }, { role: 'membre' });

  // Supprimer une machine : arrêtée, pas protégée, son nom recopié, et une
  // confirmation d'identité faite pour cette suppression (deux minutes au
  // plus, jamais réemployée). Ses disques partent avec elle ; ses sauvegardes
  // restent.
  const renfortsEmployes = new Map();
  r.post('/api/machines/:noeud/:type/:vmid/suppression', async ctx => {
    const s = session(ctx, { role: 'admin', renfort: true });
    const m = machine(ctx.params);
    const { nom } = await corps(ctx, S.suppression);
    const [statut, config] = await pve(() => Promise.all([proxmox.get(m.base + '/status/current'), proxmox.get(m.base + '/config')]));
    const attendu = String((m.type === 'qemu' ? config?.name : config?.hostname) || statut?.name || m.vmid);
    if (nom.trim() !== attendu) throw new ErreurHttp(400, `Recopie exactement « ${attendu} » pour confirmer.`);
    if (statut?.status !== 'stopped') throw new ErreurHttp(409, 'Arrête d’abord la machine : une machine en marche ne se supprime pas.');
    if (String(config?.protection) === '1') throw new ErreurHttp(409, 'Machine protégée dans Proxmox : retire d’abord sa protection.');
    if (!s.renfort || Date.now() - s.renfort > RENFORT_SUPPRESSION_MS || renfortsEmployes.get(s.compte) === s.renfort) {
      throw new ErreurHttp(403, 'Confirme ton identité pour supprimer cette machine.', { renfort: true, methodes: comptes.methodesRenfort(s.compteLigne, s.rp) });
    }
    renfortsEmployes.set(s.compte, s.renfort);
    const upid = await pve(() => proxmox.del(m.base, { purge: 1, 'destroy-unreferenced-disks': 1 }));
    clavierConnu.delete(m.cible);
    const qui = acteur(ctx);
    journal.ecrire({ acteur: qui.acteurCompte, action: 'machine.suppression', objet: m.cible, ip: ctx.ip, details: { noeud: m.noeud, nom: attendu } });
    evenements.noter({ genre: 'vm.delete_requested', niveau: 'avertissement', titre: `${m.type === 'qemu' ? 'VM' : 'CT'} ${m.vmid} « ${attendu} » : suppression demandée`, corps: `Disques compris, sauvegardes gardées. Par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    return { upid: String(upid || '') };
  }, { role: 'admin' });

  // Le lecteur CD d'une VM : une image ISO insérée, ou éjectée (volid vide).
  // Le premier lecteur CD de la machine ; sans lecteur, ide2 s'il est libre.
  r.post('/api/machines/:noeud/:type/:vmid/lecteur', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const m = machine(ctx.params);
    if (m.type !== 'qemu') throw new ErreurHttp(400, 'Un conteneur n’a pas de lecteur CD.');
    const { volid } = await corps(ctx, S.lecteur);
    const config = await pve(() => proxmox.get(m.base + '/config'));
    const cle = Object.keys(config || {}).filter(k => LECTEUR.test(k) && /media=cdrom/.test(String(config[k]))).sort()[0] || (config?.ide2 ? null : 'ide2');
    if (!cle) throw new ErreurHttp(409, 'Pas de lecteur CD sur cette machine, et ide2 est déjà pris : ajoute un lecteur dans Proxmox.');
    await pve(() => proxmox.put(m.base + '/config', { [cle]: `${volid || 'none'},media=cdrom` }));
    const qui = acteur(ctx);
    journal.ecrire({ acteur: qui.acteurCompte, action: volid ? 'lecteur.insertion' : 'lecteur.ejection', objet: m.cible, ip: ctx.ip, details: { lecteur: cle, ...(volid ? { volid } : {}) } });
    evenements.noter({ genre: 'vm.configured', niveau: 'info', titre: volid ? `${volid.split('/').pop()} insérée dans ${m.cible}` : `Lecteur CD de ${m.cible} vidé`, corps: `Lecteur ${cle}, par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    return { lecteur: cle };
  }, { role: 'admin' });

  // Ce qu'il faut pour créer une VM sur un nœud : ses ressources, les
  // stockages qui prennent un disque, ses ponts réseau, les images qu'il voit.
  async function optionsCreation(n) {
    const { noeuds } = await pve(etatGrappe);
    const nd = noeuds.find(x => x.node === n && x.status === 'online');
    if (!nd) throw new ErreurHttp(404, 'Nœud introuvable ou hors ligne.');
    const [stockages, reseau, inv, suivant] = await pve(() => Promise.all([
      proxmox.get(chemin('nodes', n, 'storage'), { content: 'images', enabled: 1 }),
      proxmox.get(chemin('nodes', n, 'network')),
      inventaireIso(),
      proxmox.get('/cluster/nextid'),
    ]));
    return {
      noeud: { node: nd.node, maxcpu: nd.maxcpu, maxmem: nd.maxmem },
      stockages: (stockages || []).filter(x => STOCKAGE.test(x.storage || '') && x.active !== 0 && String(x.content || '').includes('images')).map(x => ({ storage: x.storage, avail: nombre(x.avail), total: nombre(x.total), alias: etiquetteDe('stockage', cleStockage(n, x.storage, !!x.shared)) })),
      ponts: (reseau || []).filter(x => /bridge/.test(x.type || '') && PONT.test(x.iface || '')).map(x => x.iface).sort(),
      // Le nom que l'opérateur reconnaît : son étiquette, sinon le commentaire posé dans Proxmox.
      pontsDetail: (reseau || []).filter(x => /bridge/.test(x.type || '') && PONT.test(x.iface || '')).map(x => ({ iface: x.iface, alias: etiquetteDe('reseau', `${n}/${x.iface}`), commentaire: String(x.comments || '').replace(/\s+/g, ' ').trim().slice(0, 200) })).sort((a, b) => a.iface.localeCompare(b.iface)),
      isos: inv.isos.filter(i => i.shared || i.node === n).map(i => ({ volid: i.volid, nom: i.nom, alias: i.alias, size: i.size })),
      vmid: nombre(suivant),
    };
  }
  r.get('/api/machines/options', async ctx => {
    session(ctx, { role: 'admin' });
    return optionsCreation(ctx.q.noeud);
  }, { role: 'admin', requete: S.options });

  // Une tâche Proxmox suivie jusqu'à sa fin : rend son statut de sortie.
  async function attendreTache(n, upid, ms = 90000) {
    for (const fin = Date.now() + ms; Date.now() < fin;) {
      const st = await pve(() => proxmox.get(chemin('nodes', n, 'tasks', upid, 'status')));
      if (st?.status === 'stopped') return String(st.exitstatus || '');
      await new Promise(ok => setTimeout(ok, 1000));
    }
    throw new ErreurHttp(504, 'Proxmox n’a pas fini à temps : la tâche continue, suis-la dans Tâches.');
  }

  // Créer une VM : chaque choix revérifié contre le nœud (ressources, stockage
  // qui prend un disque, pont existant, image visible), numéro libre tiré
  // par Proxmox, puis démarrée si on le demande.
  r.post('/api/machines', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const b = await corps(ctx, S.creation);
    const o = await optionsCreation(b.noeud);
    if (b.coeurs > o.noeud.maxcpu) throw new ErreurHttp(400, `${b.noeud} n’a que ${o.noeud.maxcpu} cœurs.`);
    if (b.memoire * 1048576 > o.noeud.maxmem) throw new ErreurHttp(400, `${b.noeud} n’a que ${Math.floor(o.noeud.maxmem / 1048576)} Mio de mémoire.`);
    const st = o.stockages.find(x => x.storage === b.stockage);
    if (!st) throw new ErreurHttp(400, `${b.stockage} ne prend pas de disque de VM sur ${b.noeud}.`);
    if (st.avail && b.disque * 1024 ** 3 > st.avail) throw new ErreurHttp(409, `Pas assez de place sur ${b.stockage} pour ${b.disque} Gio.`);
    if (!o.ponts.includes(b.pont)) throw new ErreurHttp(400, `Pas de pont ${b.pont} sur ${b.noeud}.`);
    if (b.iso && !o.isos.some(i => i.volid === b.iso)) throw new ErreurHttp(400, 'Cette image n’est pas visible de ce nœud.');
    if (!VMID.test(String(o.vmid))) throw new ErreurHttp(502, 'Proxmox n’a pas donné de numéro libre.');
    const upid = await pve(() => proxmox.post(chemin('nodes', b.noeud, 'qemu'), configurationNeuve({ ...b, vmid: o.vmid })));
    const sortie = await attendreTache(b.noeud, String(upid || ''));
    if (sortie !== 'OK') throw new ErreurHttp(502, `Proxmox n’a pas créé la VM : ${sortie.replace(/\/[\w./-]+/g, '…').slice(0, 200)}`);
    const qui = acteur(ctx);
    journal.ecrire({ acteur: qui.acteurCompte, action: 'machine.creation', objet: `qemu/${o.vmid}`, ip: ctx.ip, details: { noeud: b.noeud, nom: b.nom, systeme: b.systeme, coeurs: b.coeurs, memoire: b.memoire, disque: b.disque, stockage: b.stockage, iso: b.iso || null } });
    evenements.noter({ genre: 'vm.create_requested', niveau: 'info', titre: `VM ${o.vmid} « ${b.nom} » créée`, corps: `${b.coeurs} cœurs, ${b.memoire} Mio, ${b.disque} Gio sur ${b.stockage}${b.iso ? `, ${b.iso.split('/').pop()} dans le lecteur` : ''}. Par ${qui.acteur}.`, cible: `qemu/${o.vmid}`, noeud: b.noeud, ...qui });
    let demarree = false;
    if (b.demarrer) { await pve(() => proxmox.post(chemin('nodes', b.noeud, 'qemu', o.vmid, 'status', 'start'), {})); demarree = true; }
    return { vmid: o.vmid, noeud: b.noeud, demarree };
  }, { role: 'admin' });

  // Le nom affiché d'une image : gardé par ProxLab, le fichier garde le sien
  // dans Proxmox (qui ne sait pas renommer une image). Vide : le nom du fichier revient.
  // Clé d'un nom : le volume, précédé du nœud quand le stockage n'est pas
  // partagé (« local:iso/x.iso » existe sur chaque nœud, chacun le sien).
  // Gardée pour les clients d'avant : c'est l'étiquette d'une image.
  r.put('/api/isos/nom', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const { noeud: n, volid, nom } = await corps(ctx, S.nomIso);
    return { volid, alias: await etiqueter(ctx, 'iso', n, volid, nom) };
  }, { role: 'admin' });

  // Images ISO : chaque stockage qui en accepte (un stockage partagé, une
  // fois), ses images, et les VM qui en ont une dans leur lecteur CD.
  async function inventaireIso() {
    const { noeuds, machines } = await pve(etatGrappe);
    const stockages = [], isos = [], vus = new Set();
    for (const n of noeuds.filter(x => x.status === 'online' && NOEUD.test(x.node))) {
      const liste = await proxmox.get(chemin('nodes', n.node, 'storage'), { content: 'iso', enabled: 1 }).catch(() => []);
      for (const st of (liste || []).filter(x => STOCKAGE.test(x.storage || '') && x.active !== 0)) {
        const cle = st.shared ? st.storage : `${n.node}/${st.storage}`;
        if (vus.has(cle)) continue;
        vus.add(cle);
        stockages.push({ node: n.node, storage: st.storage, shared: !!st.shared, avail: nombre(st.avail), total: nombre(st.total), alias: etiquetteDe('stockage', cleStockage(n.node, st.storage, !!st.shared)) });
        const contenu = await proxmox.get(chemin('nodes', n.node, 'storage', st.storage, 'content'), { content: 'iso' }).catch(() => []);
        for (const c of contenu || []) if (VOLID_ISO.test(c.volid || '')) isos.push({ node: n.node, storage: st.storage, shared: !!st.shared, volid: c.volid, nom: c.volid.split('/').pop(), size: nombre(c.size), ctime: nombre(c.ctime), utilisePar: [] });
      }
    }
    const vms = machines.filter(x => x.type === 'qemu' && NOEUD.test(x.node)).slice(0, 300);
    const configs = await Promise.all(vms.map(x => proxmox.get(chemin('nodes', x.node, 'qemu', x.vmid, 'config')).then(c => [x, c], () => [x, null])));
    for (const [x, c] of configs) {
      for (const [k, v] of Object.entries(c || {})) {
        if (!LECTEUR.test(k) || !/media=cdrom/.test(String(v))) continue;
        const volid = String(v).split(',')[0];
        for (const i of isos) if (i.volid === volid && (i.shared || i.node === x.node)) i.utilisePar.push({ vmid: x.vmid, name: x.name, node: x.node, lecteur: k });
      }
    }
    for (const i of isos) i.alias = etiquetteDe('iso', i.shared ? i.volid : `${i.node}/${i.volid}`);
    isos.sort((a, b) => (a.alias || a.nom).localeCompare(b.alias || b.nom) || a.node.localeCompare(b.node));
    return { stockages, isos };
  }
  r.get('/api/isos', async ctx => {
    session(ctx);
    if (!reglages.lire('liaison')) return { relie: false, stockages: [], isos: [] };
    return { relie: true, ...(await inventaireIso()) };
  }, { role: 'lecture' });

  // Le nom et la taille qu'annonce une adresse, avant de rien télécharger.
  r.get('/api/isos/apercu', async ctx => {
    session(ctx, { role: 'admin' });
    return image(() => images.apercu(ctx.q.url));
  }, { role: 'admin', requete: S.apercu });

  // Importer une image depuis une adresse publique en https : ProxLab la
  // télécharge, en vérifie la signature et, si elle est donnée, la somme de
  // contrôle, et la remet à Proxmox à mesure — en tâche de fond.
  r.post('/api/isos/:noeud/:stockage/telechargement', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const { n, stockage } = stockageDe(ctx.params);
    const b = await corps(ctx, S.telechargement);
    if (b.somme && b.somme.length !== LONGUEUR_SOMME[b.algorithme]) throw new ErreurHttp(400, `Une somme ${b.algorithme} fait ${LONGUEUR_SOMME[b.algorithme]} caractères hexadécimaux.`);
    try { lireUrl(b.url); } catch (e) { versClientImage(e); }
    let id;
    try { id = images.importer({ url: b.url, nom: b.nom, noeud: n, stockage, somme: b.somme ? { algorithme: b.algorithme, valeur: b.somme } : null, acteur: acteur(ctx) }); } catch (e) { versClientImage(e); }
    return { importation: id };
  }, { role: 'admin' });
  r.get('/api/isos/importations', ctx => { session(ctx, { role: 'admin' }); return images.liste(); }, { role: 'admin' });
  r.del('/api/isos/importations/:id', ctx => {
    session(ctx, { role: 'admin' });
    if (!/^[A-Za-z0-9_-]{12}$/.test(ctx.params.id)) throw new ErreurHttp(404, 'Importation introuvable.');
    try { images.annuler(ctx.params.id); } catch (e) { versClientImage(e); }
    return { ok: true };
  }, { role: 'admin' });

  // Envoyer une image depuis le navigateur : le corps est le fichier, relayé
  // vers Proxmox à mesure qu'il arrive.
  r.put('/api/isos/:noeud/:stockage/envoi', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const { n, stockage } = stockageDe(ctx.params);
    const { nom } = ctx.q;
    const taille = Number(ctx.req.headers['content-length']);
    const upid = await image(() => images.relayer({ noeud: n, stockage, nom, flux: ctx.req, taille }));
    const qui = acteur(ctx);
    journal.ecrire({ acteur: qui.acteurCompte, action: 'iso.envoi', objet: `${stockage}:iso/${nom}`, ip: ctx.ip, details: { noeud: n, taille } });
    evenements.noter({ genre: 'iso.added', niveau: 'info', titre: `${nom} envoyée vers ${stockage}`, corps: `Par ${qui.acteur}.`, noeud: n, ...qui });
    return { upid: String(upid || '') };
  }, { role: 'admin', requete: S.envoi });

  // Supprimer une image : refusé tant qu'une VM l'a dans son lecteur.
  r.del('/api/isos/:noeud/:stockage', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const { n, stockage } = stockageDe(ctx.params);
    const { volid } = ctx.q;
    if (!volid.startsWith(stockage + ':iso/')) throw new ErreurHttp(400, 'Image hors de ce stockage.');
    const i = (await inventaireIso()).isos.find(x => x.volid === volid && (x.shared || x.node === n));
    if (!i) throw new ErreurHttp(404, 'Image introuvable.');
    if (i.utilisePar.length) throw new ErreurHttp(409, `Image dans le lecteur de ${i.utilisePar.map(x => `${x.vmid}${x.name ? ` (${x.name})` : ''}`).join(', ')} : éjecte-la d’abord.`);
    const upid = await pve(() => proxmox.del(chemin('nodes', n, 'storage', stockage, 'content', encodeURIComponent(volid))));
    const qui = acteur(ctx);
    const noms = reglages.lire('noms_iso') || {};
    const cle = i.shared ? volid : `${n}/${volid}`;
    if (noms[cle]) { delete noms[cle]; reglages.ecrire('noms_iso', noms); }
    journal.ecrire({ acteur: qui.acteurCompte, action: 'iso.suppression', objet: volid, ip: ctx.ip, details: { noeud: n } });
    evenements.noter({ genre: 'iso.deleted', niveau: 'info', titre: `${i.nom} supprimée de ${stockage}`, corps: `Par ${qui.acteur}.`, noeud: n, ...qui });
    return { upid: String(upid || '') };
  }, { role: 'admin', requete: S.iso });

  r.del('/api/sauvegardes/:noeud/:stockage', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const { n, stockage } = stockageDe(ctx.params);
    const { volid } = ctx.q;
    if (volid.includes('..') || !volid.startsWith(stockage + ':')) throw new ErreurHttp(400, 'Volume hors de ce stockage.');
    const upid = await pve(() => proxmox.del(chemin('nodes', n, 'storage', stockage, 'content', encodeURIComponent(volid))));
    const qui = acteur(ctx);
    journal.ecrire({ acteur: qui.acteurCompte, action: 'sauvegarde.suppression', objet: volid, ip: ctx.ip, details: { noeud: n } });
    evenements.noter({ genre: 'backup.deleted', niveau: 'avertissement', titre: `Sauvegarde supprimée sur ${stockage}`, corps: `${volid.split('/').pop()} — par ${qui.acteur}.`, noeud: n, ...qui });
    return { upid: String(upid || '') };
  }, { role: 'admin', requete: S.volume });

  r.del('/api/taches/:noeud/:upid', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const { n, upid } = tacheDe(ctx.params);
    await pve(() => proxmox.del(chemin('nodes', n, 'tasks', upid)));
    journal.ecrire({ acteur: acteur(ctx).acteurCompte, action: 'tache.arret', objet: upid.slice(0, 120), ip: ctx.ip });
    return { ok: true };
  }, { role: 'admin' });

  // La console : une passe d'une minute, à usage unique, liée à la session et à
  // la cible, tirée ici (où le renfort peut être demandé) et présentée à la
  // mise à niveau WebSocket, qui revérifie la session.
  const passes = new Map();
  r.post('/api/console', async ctx => {
    session(ctx, { role: 'membre' });
    const b = await corps(ctx, S.console);
    if (b.type === 'node') session(ctx, { role: 'admin', renfort: true });
    else if (!b.vmid) throw new ErreurHttp(400, 'VMID requis.');
    // L'écran (VNC) : celui d'une machine virtuelle ; un conteneur n'a que sa console texte.
    const mode = b.mode === 'ecran' ? 'ecran' : 'texte';
    if (mode === 'ecran' && b.type !== 'qemu') throw new ErreurHttp(400, 'L\'écran est celui d\'une machine virtuelle ; un conteneur a sa console texte.');
    if (!reglages.lire('liaison')?.utilisateur) throw new ErreurHttp(409, 'La console demande l\'utilisateur et le mot de passe Proxmox dans la liaison (Réglages).');
    // La console texte d'une VM passe par son port série : sans lui, Proxmox
    // ne répond que « unable to find a serial interface ». On le dit avant.
    if (mode === 'texte' && b.type === 'qemu') {
      const base = machine({ noeud: b.noeud, type: 'qemu', vmid: b.vmid }).base;
      const config = await pve(() => proxmox.get(base + '/config', { current: 1 }));
      if (!Object.keys(config || {}).some(k => /^serial\d$/.test(k))) {
        const attente = await pve(() => proxmox.get(base + '/config'));
        const prevu = Object.keys(attente || {}).some(k => /^serial\d$/.test(k));
        throw new ErreurHttp(409, prevu ? 'Le port série est ajouté mais pas encore actif : redémarre la VM depuis ProxLab.' : 'Cette VM n\'a pas de port série : sa console texte passe par lui. Utilise l\'Écran, ou ajoute un port série.', { sansSerie: true, prevu });
      }
    }
    const passe = crypto.randomBytes(24).toString('base64url');
    const t = Date.now();
    for (const [k, v] of passes) if (v.expire < t) passes.delete(k);
    if (passes.size > 1000) throw new ErreurHttp(429, 'Trop de consoles en attente.');
    // Gardée par son empreinte : la passe en clair n'existe que dans la réponse.
    passes.set(empreintePasse(passe), { session: ctx.session.id, cible: { noeud: b.noeud, type: b.type, vmid: b.type === 'node' ? null : b.vmid, mode }, expire: t + 60e3 });
    return { passe };
  }, { role: 'membre' });

  const empreintePasse = p => crypto.createHash('sha256').update('console:' + String(p || '')).digest('hex');
  function prendrePasse(passe, sessionId) {
    const k = empreintePasse(passe);
    const p = passes.get(k);
    passes.delete(k);
    if (!p || p.expire < Date.now() || p.session !== sessionId) return null;
    return p.cible;
  }

  // Liaison à Proxmox : administrateur sous renfort, secrets scellés.
  const liaisonPublique = () => {
    const l = reglages.lire('liaison');
    return l ? { hote: l.hote, port: l.port, confiance: l.confiance, fp: l.fp || '', jetonId: l.jeton_id || '', aSecret: !!l.jeton_scelle, utilisateur: l.utilisateur || '', aMotDePasse: !!l.mdp_scelle, verifie: l.verifie || 0 } : null;
  };
  const hoteValide = hote => {
    const h = String(hote).trim().replace(/^\[|\]$/g, '');
    const ip = /^[0-9.]+$/.test(h) || h.includes(':');
    if (ip ? classer(h) === 'interdite' : !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(h)) throw new ErreurHttp(400, 'Adresse de Proxmox refusée.');
    return h;
  };

  r.get('/api/liaison', ctx => { session(ctx, { role: 'admin' }); return { liaison: liaisonPublique() }; }, { role: 'admin' });

  r.post('/api/liaison/sonde', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const b = await corps(ctx, S.sonde);
    try { return await observer(hoteValide(b.hote), b.port); } catch (e) {
      if (e instanceof ErreurHttp) throw e;
      throw new ErreurHttp(502, `Proxmox injoignable : ${String(e.code || e.message).slice(0, 80)}.`);
    }
  }, { role: 'admin' });

  r.put('/api/liaison', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const b = await corps(ctx, S.liaison);
    const avant = reglages.lire('liaison');
    const hote = hoteValide(b.hote);
    if (b.confiance === 'epingle' && !empreinteValide(b.fp)) throw new ErreurHttp(400, 'Empreinte SHA-256 attendue (64 caractères hexadécimaux).');
    // Un champ secret laissé vide garde la valeur en place (même hôte seulement :
    // un secret ne suit jamais un changement de destination sans être ressaisi).
    const memeHote = avant && avant.hote === hote && avant.port === b.port;
    const neuve = {
      hote, port: b.port, confiance: b.confiance, fp: b.confiance === 'epingle' ? empreinte(b.fp) : '',
      jeton_id: b.jetonId, jeton_scelle: b.jetonId ? (b.secret ? reglages.sceller('jeton', b.secret) : memeHote && avant.jeton_id === b.jetonId ? avant.jeton_scelle : null) : null,
      utilisateur: b.utilisateur, mdp_scelle: b.utilisateur ? (b.motDePasse ? reglages.sceller('motDePasse', b.motDePasse) : memeHote && avant.utilisateur === b.utilisateur ? avant.mdp_scelle : null) : null,
    };
    if (!(neuve.jeton_id && neuve.jeton_scelle) && !(neuve.utilisateur && neuve.mdp_scelle)) throw new ErreurHttp(400, 'Un jeton d\'API (identifiant et secret) ou un utilisateur et son mot de passe sont nécessaires.');
    // Essai en direct avant d'enregistrer : version et ressources lues avec la liaison proposée.
    const essai = new Proxmox({ reglages: { liaison: () => ({ ...neuve, secret: b.secret || reglages.ouvrir('jeton', neuve.jeton_scelle), motDePasse: b.motDePasse || reglages.ouvrir('motDePasse', neuve.mdp_scelle) }) } });
    let version, ressources;
    try {
      version = await essai.get('/version');
      ressources = await essai.get('/cluster/resources');
    } catch (e) { versClient(e, log); } finally { essai.oublier(); }
    reglages.ecrire('liaison', { ...neuve, verifie: Date.now() });
    proxmox.oublier();
    const qui = acteur(ctx);
    journal.ecrire({ acteur: qui.acteurCompte, action: 'liaison.modifiee', objet: `${hote}:${b.port}`, ip: ctx.ip, details: { confiance: b.confiance, api: !!neuve.jeton_id, console: !!neuve.utilisateur } });
    evenements.noter({ genre: 'panel.configured', niveau: 'info', titre: 'Liaison à Proxmox enregistrée', corps: `Proxmox VE ${String(version?.version || '?')}, par ${qui.acteur}.`, ...qui });
    return {
      liaison: liaisonPublique(), version: String(version?.version || ''), release: String(version?.release || ''),
      noeuds: (ressources || []).filter(x => x.type === 'node').length, machines: (ressources || []).filter(x => TYPES.includes(x.type)).length,
    };
  }, { role: 'admin' });

  r.del('/api/liaison', ctx => {
    session(ctx, { role: 'admin', renfort: true });
    reglages.ecrire('liaison', null);
    reglages.ecrire('taches_vues', null);
    proxmox.oublier();
    journal.ecrire({ acteur: acteur(ctx).acteurCompte, action: 'liaison.retiree', ip: ctx.ip });
    return { ok: true };
  }, { role: 'admin' });

  const alertesPubliques = () => {
    const a = reglages.lire('alertes');
    return a ? { actif: !!a.actif, url: a.url, format: a.format, entete: a.entete, aCle: !!a.cle_scellee, aSecret: !!a.secret_scelle, service: a.service, lien: a.lien, cpu: a.cpu, memoire: a.memoire, stockage: a.stockage } : null;
  };
  const urlAlerte = (u, quoi) => {
    if (!u) return '';
    let x;
    try { x = new URL(u); } catch { throw new ErreurHttp(400, `${quoi} : adresse invalide.`); }
    if (!['http:', 'https:'].includes(x.protocol) || x.username || x.password) throw new ErreurHttp(400, `${quoi} : http(s) sans identifiants attendu.`);
    if (/^[0-9.]+$/.test(x.hostname) && classer(x.hostname) === 'interdite') throw new ErreurHttp(400, `${quoi} : adresse interdite.`);
    return x.href;
  };

  r.get('/api/alertes', ctx => { session(ctx, { role: 'admin' }); return { alertes: alertesPubliques() }; }, { role: 'admin' });

  r.put('/api/alertes', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const b = await corps(ctx, S.alertes);
    const avant = reglages.lire('alertes') || {};
    const url = urlAlerte(b.url, 'Récepteur');
    const memeUrl = avant.url === url;
    const garder = (champ, efface, neuf, quoi) => efface ? null : neuf ? reglages.sceller(quoi, neuf) : memeUrl ? avant[champ] || null : null;
    const a = {
      actif: b.actif && !!url, url, format: b.format, entete: b.entete, service: b.service, lien: urlAlerte(b.lien, 'Lien vers ProxLab'),
      cpu: b.cpu, memoire: b.memoire, stockage: b.stockage,
      cle_scellee: garder('cle_scellee', b.effacerCle, b.cle, 'cle'), secret_scelle: garder('secret_scelle', b.effacerSecret, b.secret, 'secret'),
    };
    reglages.ecrire('alertes', a);
    journal.ecrire({ acteur: acteur(ctx).acteurCompte, action: 'alertes.reglees', objet: url ? new URL(url).host : null, ip: ctx.ip, details: { actif: a.actif, format: a.format } });
    return { alertes: alertesPubliques() };
  }, { role: 'admin' });

  r.post('/api/alertes/essai', async ctx => {
    session(ctx, { role: 'admin', renfort: true });
    const reglage = reglages.alertes();
    if (!reglage?.url) throw new ErreurHttp(409, 'Enregistre d\'abord un récepteur.');
    const out = await emetteur.envoyer({
      type: 'info', titre: 'Essai de liaison ProxLab', urgence: 'p4', impact: 'mineur', portee: 'utilisateur', composant: 'panneau',
      description: 'Ticket d\'essai émis depuis les réglages de ProxLab. Aucune action requise.', dedup_key: 'proxlab-essai', ref: 'essai',
    }, reglage, { essai: true });
    if (!out.ok) throw new ErreurHttp(502, `Le récepteur n'a pas accepté l'essai : ${out.erreur}.`);
    return { ref: out.ref };
  }, { role: 'admin' });

  // Routes du Hub : son jeton de service, jamais une session.
  r.get('/api/hub/etat', async ctx => {
    hub(ctx);
    const aTraiter = surveillance.actives().length;
    if (!reglages.lire('liaison')) return { relie: false, noeuds: 0, noeuds_en_ligne: 0, noeuds_hors_ligne: 0, machines: 0, machines_en_marche: 0, stockage_pct: 0, a_traiter: aTraiter };
    const { noeuds, machines, stockages } = await pve(etatGrappe);
    // Un stockage partagé est listé sous chaque nœud : compté une fois.
    const uniques = new Map(stockages.map(s => [s.shared ? s.storage : `${s.node}/${s.storage}`, s]));
    const utilise = [...uniques.values()].reduce((a, s) => a + s.disk, 0), total = [...uniques.values()].reduce((a, s) => a + s.maxdisk, 0);
    const enLigne = noeuds.filter(n => n.status === 'online').length;
    return {
      relie: true, noeuds: noeuds.length, noeuds_en_ligne: enLigne, noeuds_hors_ligne: noeuds.length - enLigne,
      machines: machines.filter(m => !m.template).length, machines_en_marche: machines.filter(m => m.status === 'running').length,
      stockage_pct: total ? Math.round(utilise / total * 100) : 0, a_traiter: aTraiter,
    };
  }, { hub: true });

  r.get('/api/hub/machines', async ctx => {
    hub(ctx);
    if (!reglages.lire('liaison')) return [];
    const { machines } = await pve(etatGrappe);
    return machines.filter(m => !m.template).map(m => ({ node: m.node, type: m.type, vmid: m.vmid, name: m.name, status: m.status }));
  }, { hub: true });

  r.get('/api/hub/evenements', ctx => {
    hub(ctx);
    const { limite } = ctx.q;
    return evenements.liste({ limite });
  }, { hub: true, requete: { limite: S.evenements.limite } });

  // Les alertes seules (critique et avertissement) : le déclencheur « alerte »
  // du Hub, que SYNAPSE garde en mémoire.
  r.get('/api/hub/alertes', ctx => {
    hub(ctx);
    const { limite } = ctx.q;
    return evenements.liste({ limite, alertes: true });
  }, { hub: true, requete: { limite: S.evenements.limite } });

  r.post('/api/hub/machines/:noeud/:type/:vmid/alimentation', async ctx => {
    hub(ctx);
    const { action } = await corps(ctx, S.alimentationHub);
    return alimenter(ctx, machine(ctx.params), action);
  }, { hub: true });

  // Aiguillage : renvoie vrai si la requête était pour l'API.
  return {
    routeur: r,
    prendrePasse,
    images,
    async traiter(ctx) {
      const p = ctx.url.pathname;
      if (!p.startsWith('/api/')) return false;
      const t = r.trouver(ctx.req.method, p);
      if (!t) throw new ErreurHttp(404, 'Route inconnue.');
      if (t.methodes) { ctx.res.setHeader('Allow', t.methodes.join(', ')); throw new ErreurHttp(405, 'Méthode non admise.'); }
      ctx.params = t.params;
      // Validée à la lecture, après l'authentification du gestionnaire : une
      // requête anonyme reçoit 401, pas le détail de ce qu'elle aurait dû porter.
      const schema = t.route.options?.requete;
      if (!schema && ctx.url.search) throw new ErreurHttp(400, 'Paramètres de requête inattendus.');
      Object.defineProperty(ctx, 'q', { configurable: true, get: () => valider(Object.fromEntries(ctx.url.searchParams), schema) });
      const reponse = await t.route.gestionnaire(ctx);
      // Une route qui n'a pas lu ses paramètres (une branche qui rend tôt) les fait valider ici, avant de répondre.
      if (schema && ctx.url.search && !ctx.res.headersSent) void ctx.q;
      if (reponse !== undefined) repondreJson(ctx.res, 200, reponse);
      return true;
    },
  };
}
