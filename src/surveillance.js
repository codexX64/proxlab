// Surveillance de la grappe : à chaque passe, l'état de Proxmox est comparé à
// la passe précédente, et seule une transition devient un événement — une
// machine qui tombe, un nœud qui disparaît, un seuil franchi. Un stockage plein
// reste plein à chaque passe : il ne sonne qu'au franchissement, et se réarme
// quand la condition se résout. Le journal des tâches de Proxmox donne ce que
// le panneau ne fait pas lui-même : créations, destructions, restaurations,
// démarrages échoués.
//
// Un événement est toujours noté (l'interface et le Hub le lisent) ; il part en
// plus au récepteur de tickets si un administrateur en a réglé un.
const ARRET_VOULU_MS = 10 * 60e3;
const TACHES = {
  qmcreate: ['vm.created', 'info', 'créée'], vzcreate: ['vm.created', 'info', 'créé'], qmclone: ['vm.created', 'info', 'clonée'],
  qmdestroy: ['vm.destroyed', 'avertissement', 'détruite'], vzdestroy: ['vm.destroyed', 'avertissement', 'détruit'],
  qmrestore: ['vm.restored', 'info', 'restaurée'], vzrestore: ['vm.restored', 'info', 'restauré'],
};
const gio = v => `${(v / 1024 ** 3).toFixed(1)} Gio`;

export class Surveillance {
  constructor({ proxmox, reglages, evenements, emetteur, log = console, maintenant = () => Date.now() }) {
    Object.assign(this, { proxmox, reglages, evenements, emetteur, log, maintenant });
    this.enMarche = null; this.enLigne = null;
    this.sonnees = new Map();        // clé de dédoublonnage → alerte en cours (ce qui reste « à traiter »)
    this.aRenvoyer = new Map();      // alertes non transmises au récepteur, retentées à la passe suivante
    this.arretsVoulus = new Map();   // 'qemu/101' → instant d'un arrêt demandé depuis ProxLab
  }

  // Ce qui est en cours, le plus grave et le plus ancien d'abord.
  actives() {
    const rang = { critique: 0, avertissement: 1, info: 2 };
    return [...this.sonnees.values()].map(a => ({ kind: a.genre, severity: a.niveau, title: a.titre, target: a.cible, node: a.noeud, since: new Date(a.depuis).toISOString() }))
      .sort((a, b) => rang[a.severity] - rang[b.severity] || a.since.localeCompare(b.since));
  }

  // Un arrêt fait depuis le panneau n'est pas une panne.
  arretVoulu(cible) { this.arretsVoulus.set(cible, this.maintenant()); }

  async passe() {
    if (!this.reglages.lire('liaison')) return;
    const seuils = { cpu: 92, memoire: 92, stockage: 90, ...(this.reglages.lire('alertes') || {}) };
    const ressources = await this.proxmox.get('/cluster/resources');
    const alertes = [], enMarche = new Set(), enLigne = new Set();
    const t = this.maintenant();
    for (const [c, quand] of this.arretsVoulus) if (t - quand > ARRET_VOULU_MS) this.arretsVoulus.delete(c);

    for (const x of ressources || []) {
      if (x.type === 'qemu' || x.type === 'lxc') {
        const cible = `${x.type}/${x.vmid}`;
        const nom = x.name || cible;
        if (x.status === 'running') {
          enMarche.add(cible);
          if (this.enMarche && !this.enMarche.has(cible) && this.sonnees.has(`down:${cible}`)) {
            this.evenements.noter({ genre: 'guest.recovered', niveau: 'info', titre: `${nom} est de nouveau en marche`, cible, noeud: x.node });
          }
        } else if (this.enMarche?.has(cible) && !this.arretsVoulus.has(cible)) {
          alertes.push({
            cle: `down:${cible}`, genre: 'guest.down', niveau: 'critique', titre: `${nom} est arrêtée`, cible, noeud: x.node,
            corps: `${x.type === 'qemu' ? 'La machine virtuelle' : 'Le conteneur'} ${x.vmid} tournait à la passe précédente et ne tourne plus (état : ${x.status}).`,
            ticket: { impact: 'bloquant', portee: 'groupe', composant: x.type === 'qemu' ? 'machine virtuelle' : 'conteneur', symptomes: [`état ${cible} : ${x.status}`] },
          });
        }
      } else if (x.type === 'storage' && x.maxdisk) {
        const pct = Math.round(x.disk / x.maxdisk * 100);
        if (pct >= seuils.stockage) alertes.push({
          cle: `stockage:${x.node}:${x.storage}`, genre: 'storage.threshold', niveau: pct >= 95 ? 'critique' : 'avertissement',
          titre: `Stockage ${x.storage} à ${pct} %`, cible: `storage/${x.storage}`, noeud: x.node,
          corps: `Le volume ${x.storage} de ${x.node} dépasse le seuil de ${seuils.stockage} % (${gio(x.maxdisk - x.disk)} libres).`,
          ticket: { impact: pct >= 95 ? 'bloquant' : 'degrade', portee: 'service', composant: 'stockage', metriques: [{ label: 'Occupation', valeur: `${pct} %`, seuil: `${seuils.stockage} %`, etat: pct >= 95 ? 'ko' : 'warn' }] },
        });
      } else if (x.type === 'node') {
        if (x.status === 'online') {
          enLigne.add(x.node);
          const mem = x.maxmem ? Math.round(x.mem / x.maxmem * 100) : 0, cpu = Math.round((x.cpu || 0) * 100);
          if (mem >= seuils.memoire) alertes.push({
            cle: `memoire:${x.node}`, genre: 'node.memory', niveau: 'avertissement', titre: `Mémoire du nœud ${x.node} à ${mem} %`, cible: `node/${x.node}`, noeud: x.node,
            corps: `La mémoire du nœud dépasse le seuil de ${seuils.memoire} %.`,
            ticket: { impact: 'degrade', portee: 'service', composant: 'nœud', metriques: [{ label: 'Mémoire', valeur: `${mem} %`, seuil: `${seuils.memoire} %`, etat: 'warn' }] },
          });
          if (cpu >= seuils.cpu) alertes.push({
            cle: `cpu:${x.node}`, genre: 'node.cpu', niveau: 'avertissement', titre: `Charge du nœud ${x.node} à ${cpu} %`, cible: `node/${x.node}`, noeud: x.node,
            corps: `La charge processeur dépasse le seuil de ${seuils.cpu} %.`,
            ticket: { impact: 'degrade', portee: 'service', composant: 'nœud', metriques: [{ label: 'Processeur', valeur: `${cpu} %`, seuil: `${seuils.cpu} %`, etat: 'warn' }] },
          });
        } else if (this.enLigne?.has(x.node)) {
          alertes.push({
            cle: `noeud:${x.node}`, genre: 'node.offline', niveau: 'critique', titre: `Nœud ${x.node} hors ligne`, cible: `node/${x.node}`, noeud: x.node,
            corps: 'Le nœud ne répond plus à la grappe.', ticket: { impact: 'bloquant', portee: 'site', composant: 'nœud' },
          });
        }
      }
    }
    this.enMarche = enMarche; this.enLigne = enLigne;

    // Une alerte dont la condition a disparu se réarme ; une machine revenue
    // garde sa clé jusqu'à l'événement « de nouveau en marche » ci-dessus.
    const actives = new Set(alertes.map(a => a.cle));
    for (const k of this.sonnees.keys()) if (!actives.has(k) && !(k.startsWith('down:') && !enMarche.has(k.slice(5)))) this.sonnees.delete(k);
    for (const k of this.aRenvoyer.keys()) if (!actives.has(k)) this.aRenvoyer.delete(k);

    for (const a of alertes) {
      if (this.sonnees.has(a.cle)) { Object.assign(this.sonnees.get(a.cle), { titre: a.titre, niveau: a.niveau }); continue; }
      this.sonnees.set(a.cle, { genre: a.genre, niveau: a.niveau, titre: a.titre, cible: a.cible, noeud: a.noeud, depuis: t });
      this.evenements.noter(a);
      this.aRenvoyer.set(a.cle, a);
    }
    await this.transmettre();
    await this.lireTaches();
  }

  async transmettre() {
    const reglage = this.reglages.alertes();
    if (!reglage?.actif || !reglage.url) { this.aRenvoyer.clear(); return; }
    for (const [cle, a] of this.aRenvoyer) {
      const r = await this.emetteur.envoyer({ titre: a.titre, description: a.corps, dedup_key: `proxlab-${cle.replace(/[^A-Za-z0-9._-]/g, '-')}`, ref: a.cible || '', zone: { host: a.noeud }, ...a.ticket }, reglage);
      if (r.ok) this.aRenvoyer.delete(cle);
      else { this.log.warn?.(`[alertes] non transmise (${cle}) : ${r.erreur}`); break; }
    }
  }

  // Le journal des tâches : ce que Proxmox a fait sans passer par le panneau.
  // Une ligne d'eau gardée en base empêche un redémarrage de rejouer le passé.
  async lireTaches() {
    const taches = await this.proxmox.get('/cluster/tasks');
    const vues = this.reglages.lire('taches_vues');
    const finies = (taches || []).filter(x => x.endtime && x.upid).sort((a, b) => a.endtime - b.endtime);
    if (!vues) { this.reglages.ecrire('taches_vues', { fin: finies.at(-1)?.endtime || Math.floor(this.maintenant() / 1000), upids: [] }); return; }
    let fin = vues.fin, upids = new Set(vues.upids);
    for (const x of finies) {
      if (x.endtime < vues.fin || (x.endtime === vues.fin && vues.upids.includes(x.upid))) continue;
      const echec = x.status && x.status !== 'OK';
      const cible = x.id && /^\d+$/.test(x.id) ? `${/^vz/.test(x.type) ? 'lxc' : 'qemu'}/${x.id}` : null;
      if (TACHES[x.type] && !echec) {
        const [genre, niveau, verbe] = TACHES[x.type];
        this.evenements.noter({ genre, niveau, titre: `${cible || 'machine'} ${verbe} sur ${x.node}`, corps: `Tâche Proxmox ${x.type} par ${x.user || '?'}.`, cible, noeud: x.node });
      } else if ((x.type === 'qmstart' || x.type === 'vzstart') && echec) {
        this.evenements.noter({ genre: 'vm.start_failed', niveau: 'avertissement', titre: `${cible || 'machine'} n'a pas démarré sur ${x.node}`, corps: String(x.status).slice(0, 300), cible, noeud: x.node });
      }
      if (x.endtime > fin) { fin = x.endtime; upids = new Set(); }
      if (x.endtime === fin) upids.add(x.upid);
    }
    this.reglages.ecrire('taches_vues', { fin, upids: [...upids].slice(-200) });
  }
}
