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
// tâche, shell d'un nœud, liaison à Proxmox, alertes).
import crypto from 'node:crypto';
import { ErreurHttp, Routeur, lireCorps, valider, repondreJson, egal } from '../socle/src/index.js';
import { ErreurProxmox, Proxmox, chemin } from './pve.js';
import { observer, empreinte, empreinteValide } from './tls.js';
import { ENTETE } from './alerte.js';
import { classer } from './reseau.js';

const NOEUD = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$/;
const STOCKAGE = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
const INSTANTANE = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;
const VMID = /^[1-9]\d{1,8}$/;
const UPID = /^UPID:[A-Za-z0-9.!@_:-]{10,250}$/;
const VOLID = /^[A-Za-z][A-Za-z0-9._-]{0,99}:[A-Za-z0-9._\/-]{1,250}$/;
const TYPES = ['qemu', 'lxc'];
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
  acces: { portSerie: { type: 'booleen', defaut: false }, pressePapiers: { type: 'booleen', defaut: false } },
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
};

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
  const { portail, journal, limiteur } = socle;
  const pve = (fn) => fn().catch(e => versClient(e, log));

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

  r.get('/api/health', () => ({ ok: true }), { public: true });

  r.get('/api/etat', async ctx => {
    session(ctx);
    const relie = !!reglages.lire('liaison');
    if (!relie) return { relie, intervalle: cfg.intervalle, noeuds: [], machines: [], stockages: [], at: Date.now() };
    return { relie, intervalle: cfg.intervalle, ...(await pve(etatGrappe)), at: Date.now() };
  }, { role: 'lecture' });

  r.get('/api/noeuds/:noeud/reseau', async ctx => {
    session(ctx);
    const n = noeud(ctx.params.noeud);
    const ifaces = await pve(() => proxmox.get(chemin('nodes', n, 'network')));
    return (ifaces || []).map(i => ({ iface: i.iface, type: i.type, cidr: i.cidr || i.address || '', gateway: i.gateway || '', ports: i.bridge_ports || i.slaves || '', active: !!i.active }))
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
    const [statut, config, instantanes] = await pve(() => Promise.all([
      proxmox.get(m.base + '/status/current'), proxmox.get(m.base + '/config'), proxmox.get(m.base + '/snapshot').catch(() => []),
    ]));
    return {
      ...machinePublique({ ...statut, node: m.noeud, type: m.type, vmid: m.vmid }),
      config: Object.fromEntries(Object.entries(config || {}).filter(([k]) => CONFIG_VISIBLE.test(k)).map(([k, v]) => [k, String(v).slice(0, 2000)])),
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
    if (!b.portSerie && !b.pressePapiers) throw new ErreurHttp(400, 'Rien à ajouter.');
    const config = await pve(() => proxmox.get(m.base + '/config'));
    const params = {};
    if (b.portSerie && !Object.keys(config || {}).some(k => /^serial\d$/.test(k))) params.serial0 = 'socket';
    if (b.pressePapiers) {
      const vga = String(config?.vga || '');
      const [genre = '', ...options] = vga.split(',').filter(Boolean);
      if (/^(qxl|serial|none)/.test(genre)) throw new ErreurHttp(409, `L'affichage de cette VM (${genre}) ne prend pas le presse-papiers VNC : passe-le en « std » ou « virtio » dans Proxmox.`);
      if (!options.includes('clipboard=vnc')) params.vga = [genre || 'std', ...options.filter(o => !o.startsWith('clipboard=')), 'clipboard=vnc'].join(',');
    }
    if (!Object.keys(params).length) return { ok: true, deja: true };
    await pve(() => proxmox.put(m.base + '/config', params));
    const qui = acteur(ctx);
    const quoi = [params.serial0 && 'port série', params.vga && 'presse-papiers'].filter(Boolean).join(' et ');
    journal.ecrire({ acteur: qui.acteurCompte, action: 'machine.configuration', objet: m.cible, ip: ctx.ip, details: { champs: Object.keys(params).join(',') } });
    evenements.noter({ genre: 'vm.configured', niveau: 'info', titre: `VM ${m.vmid} : ${quoi} ajouté${params.serial0 && params.vga ? 's' : ''}`, corps: `Pris en compte au prochain démarrage complet — par ${qui.acteur}.`, cible: m.cible, noeud: m.noeud, ...qui });
    return { ok: true, champs: Object.keys(params) };
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
      const config = await pve(() => proxmox.get(machine({ noeud: b.noeud, type: 'qemu', vmid: b.vmid }).base + '/config'));
      if (!Object.keys(config || {}).some(k => /^serial\d$/.test(k))) throw new ErreurHttp(409, 'Cette VM n\'a pas de port série : sa console texte passe par lui. Utilise l\'Écran, ou ajoute un port série.', { sansSerie: true });
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
      if (reponse !== undefined) repondreJson(ctx.res, 200, reponse);
      return true;
    },
  };
}
