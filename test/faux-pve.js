// Un faux Proxmox VE pour les essais et la vitrine : HTTPS avec une feuille
// signée par l'autorité de la grappe (comme pveproxy), jeton d'API ou ticket,
// grappe de deux nœuds, machines, instantanés, sauvegardes, tâches, et un
// termproxy WebSocket qui répond comme un shell minimal. Données fabriquées,
// adresses de documentation.
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { accepter } from '../src/websocket.js';
import { reponseVnc } from '../src/des.js';

export const JETON = { id: 'proxlab@pve!panneau', secret: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
export const UTILISATEUR = { nom: 'proxlab@pve', motDePasse: 'mot-de-passe-de-la-grappe-essai' };

// Une autorité de grappe et une feuille qu'elle signe, tirées par openssl.
export function certificatsGrappe(nom = 'pve-essai') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'grappe-essai-'));
  const f = n => path.join(d, n);
  const openssl = (...args) => execFileSync('openssl', args, { stdio: 'ignore' });
  const courbe = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  try {
    openssl('req', '-x509', ...courbe, '-days', '2', '-subj', '/CN=Proxmox Virtual Environment/OU=essai/O=PVE Cluster Manager CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,digitalSignature', '-keyout', f('ca.key'), '-out', f('ca.pem'));
    openssl('req', '-new', ...courbe, '-subj', `/CN=${nom}`, '-keyout', f('feuille.key'), '-out', f('feuille.csr'));
    fs.writeFileSync(f('ext.cnf'), `subjectAltName=DNS:${nom},DNS:localhost,IP:127.0.0.1\n`);
    openssl('x509', '-req', '-in', f('feuille.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-set_serial', '7', '-days', '2', '-extfile', f('ext.cnf'), '-out', f('feuille.pem'));
    const lire = n => fs.readFileSync(f(n), 'utf8');
    return { autorite: lire('ca.pem'), cle: lire('feuille.key'), cert: lire('feuille.pem') };
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

function grappeInitiale() {
  const g = (node, type, vmid, name, status, mem, maxmem, extra = {}) => ({ node, type, vmid, name, status, cpu: status === 'running' ? 0.07 : 0, maxcpu: 2, mem: status === 'running' ? mem : 0, maxmem, disk: 0, maxdisk: 34359738368, uptime: status === 'running' ? 86400 * 3 : 0, ...extra });
  return {
    noeuds: [
      { node: 'pve-a', status: 'online', cpu: 0.18, maxcpu: 16, mem: 25769803776, maxmem: 68719476736, disk: 21474836480, maxdisk: 107374182400, uptime: 864000 },
      { node: 'pve-b', status: 'online', cpu: 0.06, maxcpu: 8, mem: 8589934592, maxmem: 34359738368, disk: 10737418240, maxdisk: 107374182400, uptime: 432000 },
    ],
    machines: [
      g('pve-a', 'qemu', 101, 'passerelle', 'running', 1073741824, 2147483648, { tags: 'reseau', conf: { serial0: 'socket', vga: 'std,clipboard=vnc' } }),
      g('pve-a', 'qemu', 102, 'base-de-donnees-du-service-de-facturation-interne', 'running', 6442450944, 8589934592),
      g('pve-a', 'lxc', 110, 'mandataire', 'running', 268435456, 1073741824),
      g('pve-b', 'lxc', 120, 'supervision', 'stopped', 0, 2147483648),
      g('pve-b', 'qemu', 130, 'bureau-essai', 'stopped', 0, 4294967296),
      g('pve-b', 'qemu', 9000, 'modele-debian', 'stopped', 0, 2147483648, { template: 1 }),
    ],
    stockages: [
      { node: 'pve-a', storage: 'local', plugintype: 'dir', status: 'available', content: 'iso,vztmpl,backup', disk: 32212254720, maxdisk: 107374182400 },
      { node: 'pve-a', storage: 'local-lvm', plugintype: 'lvmthin', status: 'available', content: 'images,rootdir', disk: 289910292480, maxdisk: 322122547200 },
      { node: 'pve-b', storage: 'local', plugintype: 'dir', status: 'available', content: 'iso,vztmpl,backup', disk: 10737418240, maxdisk: 107374182400 },
      { node: 'pve-b', storage: 'sauvegardes', plugintype: 'nfs', status: 'available', content: 'backup', disk: 429496729600, maxdisk: 1099511627776, shared: 1 },
    ],
    instantanes: { 'qemu/101': [{ name: 'avant-maj', description: 'Avant la mise à jour du noyau', snaptime: 1791700000, vmstate: 0 }] },
    sauvegardes: [{ storage: 'sauvegardes', volid: 'sauvegardes:backup/vzdump-qemu-101-2026_10_10-02_00_00.vma.zst', ctime: 1791600000, size: 1610612736, vmid: 101, format: 'vma.zst', content: 'backup' }],
    taches: historiqueSauvegardes(),
  };
}

// Vingt-huit nuits de sauvegardes à 02:00 sur chaque nœud, dont une en échec.
function historiqueSauvegardes() {
  const t = [], jour = 864e5, minuit = Math.floor(Date.now() / jour) * jour;
  for (let j = 1; j <= 28; j++) for (const [k, node] of ['pve-a', 'pve-b'].entries()) {
    const debut = Math.floor((minuit - j * jour + 2 * 3600e3) / 1000);
    const echec = j === 5 && node === 'pve-b';
    t.push({ upid: `UPID:${node}:0000${String(j).padStart(2, '0')}0${k}:0000AB12:${debut.toString(16).toUpperCase()}:vzdump::root@pam:`, node, type: 'vzdump', id: '', user: 'root@pam', starttime: debut, endtime: debut + 900, status: echec ? 'job errors' : 'OK' });
  }
  return t;
}

const rrd = n => Array.from({ length: 70 }, (_, i) => ({ time: 1791780000 + i * 60, cpu: 0.05 + 0.04 * Math.sin(i / 6 + n), mem: 1e9 + 2e8 * Math.sin(i / 9), maxmem: 2147483648, netin: 2e4 + 1e4 * Math.sin(i / 4), netout: 1e4 + 5e3 * Math.cos(i / 5), diskread: 3e4 * (1 + Math.sin(i / 7)), diskwrite: 2e4 * (1 + Math.cos(i / 8)) }));

export async function fauxProxmox({ certificats = certificatsGrappe(), ecran = [4, 2] } = {}) {
  const etat = grappeInitiale();
  const appels = [];
  const tickets = new Map(), vnctickets = new Map();
  let compteur = 0;
  const upid = (node, type, id, user = JETON.id) => `UPID:${node}:${(1000 + ++compteur).toString(16).toUpperCase().padStart(8, '0')}:0000AB12:${(1791780000 + compteur).toString(16).toUpperCase()}:${type}:${id}:${user}:`;
  const tache = (node, type, id, status = 'OK') => {
    const u = upid(node, type, id);
    etat.taches.unshift({ upid: u, node, type, id: String(id), user: JETON.id, starttime: Math.floor(Date.now() / 1000), endtime: Math.floor(Date.now() / 1000), status });
    return u;
  };
  const trouver = (node, type, vmid) => etat.machines.find(m => m.node === node && m.type === type && String(m.vmid) === String(vmid));

  const serveur = https.createServer({ key: certificats.cle, cert: certificats.cert }, (req, res) => {
    const url = new URL(req.url, 'https://pve');
    let corps = '';
    req.on('data', d => { corps += d; });
    req.on('end', () => {
      const p = url.pathname.replace(/^\/api2\/json/, '');
      const params = req.method === 'GET' || req.method === 'DELETE' ? Object.fromEntries(url.searchParams) : Object.fromEntries(new URLSearchParams(corps));
      appels.push({ methode: req.method, chemin: p, params, auth: req.headers.authorization || (req.headers.cookie ? 'ticket' : '') });
      const repondre = (code, data, message) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(code < 400 ? { data } : { data: null, message })); };
      if (p === '/access/ticket' && req.method === 'POST') {
        if (params.username !== UTILISATEUR.nom || params.password !== UTILISATEUR.motDePasse) return repondre(401, null, 'authentication failure');
        const t = 'PVE:' + crypto.randomBytes(12).toString('hex'), csrf = crypto.randomBytes(8).toString('hex');
        tickets.set(t, csrf);
        return repondre(200, { ticket: t, CSRFPreventionToken: csrf, username: UTILISATEUR.nom });
      }
      const jeton = req.headers.authorization === `PVEAPIToken=${JETON.id}=${JETON.secret}`;
      const cookie = /PVEAuthCookie=([^;]+)/.exec(req.headers.cookie || '');
      const ticket = cookie && tickets.has(decodeURIComponent(cookie[1])) ? decodeURIComponent(cookie[1]) : null;
      if (!jeton && !ticket) return repondre(401, null, 'authentication failure');
      if (!jeton && req.method !== 'GET' && req.headers.csrfpreventiontoken !== tickets.get(ticket)) return repondre(401, null, 'invalid csrf token');
      const s = p.split('/').filter(Boolean);
      try {
        if (p === '/version') return repondre(200, { version: '8.4.1', release: '8.4', repoid: 'essai' });
        if (p === '/cluster/resources') return repondre(200, [...etat.noeuds.map(n => ({ type: 'node', id: 'node/' + n.node, ...n })), ...etat.machines.map(m => ({ id: `${m.type}/${m.vmid}`, ...m })), ...etat.stockages.map(x => ({ type: 'storage', id: `storage/${x.node}/${x.storage}`, ...x }))]);
        if (p === '/cluster/tasks') return repondre(200, etat.taches.slice(0, 50));
        if (s[0] !== 'nodes' || !etat.noeuds.some(n => n.node === s[1])) return repondre(404, null, 'no such node');
        const node = s[1];
        if (s[2] === 'network') return repondre(200, [{ iface: 'vmbr0', type: 'bridge', cidr: node === 'pve-a' ? '192.0.2.10/24' : '192.0.2.11/24', gateway: '192.0.2.1', bridge_ports: 'eno1', active: 1 }, { iface: 'eno1', type: 'eth', active: 1 }]);
        if (s[2] === 'rrddata') return repondre(200, rrd(1));
        if (s[2] === 'vzdump' && req.method === 'POST') {
          const m = etat.machines.find(x => String(x.vmid) === params.vmid);
          etat.sauvegardes.unshift({ storage: params.storage, volid: `${params.storage}:backup/vzdump-${m.type}-${m.vmid}-essai-${compteur}.vma.zst`, ctime: Math.floor(Date.now() / 1000), size: 1e9, vmid: m.vmid, format: 'vma.zst', content: 'backup' });
          return repondre(200, tache(node, 'vzdump', params.vmid));
        }
        if (s[2] === 'tasks') {
          if (s.length === 3) return repondre(200, etat.taches.filter(t => t.node === node && (!params.typefilter || t.type === params.typefilter) && (!params.since || t.starttime >= Number(params.since))).slice(0, Number(params.limit) || 50));
          const t = etat.taches.find(x => x.upid === decodeURIComponent(s[3]));
          if (!t) return repondre(404, null, 'no such task');
          if (req.method === 'DELETE') { t.status = 'interrupted'; return repondre(200, null); }
          if (s[4] === 'status') return repondre(200, { status: 'stopped', exitstatus: t.status, upid: t.upid });
          if (s[4] === 'log') return repondre(200, [{ n: 1, t: `tâche ${t.type} ${t.id}` }, { n: 2, t: 'TASK OK' }]);
        }
        if (s[2] === 'storage') {
          const local = etat.stockages.filter(x => x.node === node || x.shared);
          if (s.length === 3) return repondre(200, local.filter(x => !params.content || x.content.includes(params.content)).map(x => ({ storage: x.storage, type: x.plugintype, enabled: 1, content: x.content })));
          const st = s[3];
          if (s[4] === 'content' && s.length === 5) return repondre(200, etat.sauvegardes.filter(b => b.storage === st && (!params.vmid || String(b.vmid) === params.vmid)));
          if (s[4] === 'content' && req.method === 'DELETE') {
            const volid = decodeURIComponent(s[5]);
            const i = etat.sauvegardes.findIndex(b => b.volid === volid);
            if (i < 0) return repondre(500, null, `volume '${volid}' does not exist in /mnt/pve/${st}/dump`); // Proxmox répond 500 ici
            etat.sauvegardes.splice(i, 1);
            return repondre(200, tache(node, 'imgdel', st));
          }
        }
        if (['qemu', 'lxc'].includes(s[2])) {
          const m = trouver(node, s[2], s[3]);
          if (!m) return repondre(500, null, `Configuration file 'nodes/${node}/${s[2]}/${s[3]}.conf' does not exist`);
          const cle = `${m.type}/${m.vmid}`;
          const reste = s.slice(4).join('/');
          if (reste === 'status/current') return repondre(200, { ...m, qmpstatus: m.status });
          if (reste === 'config' && req.method === 'GET') return repondre(200, { name: m.name, cores: 2, sockets: 1, memory: Math.round(m.maxmem / 1048576), ostype: 'l26', onboot: 1, net0: 'virtio=02:00:00:00:01:01,bridge=vmbr0', scsi0: 'local-lvm:vm-' + m.vmid + '-disk-0,size=32G', cipassword: '**********', sshkeys: 'ssh-ed25519%20AAAA', ciuser: 'essai', digest: 'abc', description: 'Machine fabriquée pour les essais.', ...m.conf, ...(params.current ? {} : m.attente) });
          if (reste === 'config' && req.method === 'PUT') { if (params.name) m.name = params.name; if (params.hostname) m.name = params.hostname; if (params.memory) m.maxmem = Number(params.memory) * 1048576; for (const k of ['serial0', 'vga']) if (params[k]) (m.status === 'running' ? (m.attente ||= {}) : (m.conf ||= {}))[k] = params[k]; return repondre(200, null); }
          if (reste === 'rrddata') return repondre(200, rrd(m.vmid));
          if (s[4] === 'status' && req.method === 'POST') {
            const action = s[5];
            if (action === 'start' && m.status === 'running') return repondre(500, null, `VM ${m.vmid} already running`);
            m.status = ['start', 'resume', 'reboot', 'reset'].includes(action) ? 'running' : action === 'suspend' ? 'paused' : 'stopped';
            // Comme Proxmox : le matériel en attente prend effet au démarrage (ou au redémarrage demandé à Proxmox).
            if (['start', 'reboot'].includes(action) && m.attente) { m.conf = { ...m.conf, ...m.attente }; delete m.attente; }
            m.mem = m.status === 'running' ? Math.round(m.maxmem / 3) : 0;
            return repondre(200, tache(node, `qm${action}`, m.vmid));
          }
          if (reste === 'migrate' && req.method === 'POST') { m.node = params.target; return repondre(200, tache(node, 'qmigrate', m.vmid)); }
          if (s[4] === 'snapshot') {
            const liste = etat.instantanes[cle] ||= [];
            if (s.length === 5 && req.method === 'GET') return repondre(200, [...liste, { name: 'current', description: 'You are here!' }]);
            if (s.length === 5 && req.method === 'POST') { liste.push({ name: params.snapname, description: params.description || '', snaptime: Math.floor(Date.now() / 1000), vmstate: params.vmstate ? 1 : 0 }); return repondre(200, tache(node, 'qmsnapshot', m.vmid)); }
            const i = liste.findIndex(x => x.name === s[5]);
            if (i < 0) return repondre(500, null, `snapshot '${s[5]}' does not exist`);
            if (s[6] === 'rollback') return repondre(200, tache(node, 'qmrollback', m.vmid));
            if (req.method === 'DELETE') { liste.splice(i, 1); return repondre(200, tache(node, 'qmdelsnapshot', m.vmid)); }
          }
        }
        repondre(501, null, `Method '${req.method} ${p}' not implemented`);
      } catch (e) { repondre(500, null, e.message); }
    });
  });

  // termproxy rend { port, ticket, user } : intercepté avant l'aiguillage général.
  const origine = serveur.listeners('request')[0];
  serveur.removeAllListeners('request');
  // Comme Proxmox, le ticket de vncproxy et de termproxy est lié à qui le
  // demande : un jeton d'API (« utilisateur!jeton ») n'est pas l'utilisateur
  // du ticket de session qui ouvre ensuite le WebSocket.
  const demandeur = req => (req.headers.authorization ? String(req.headers.authorization).replace(/^PVEAPIToken=/, '').split('=')[0] : UTILISATEUR.nom);
  serveur.on('request', (req, res) => {
    if (req.method === 'POST' && /\/qemu\/\d+\/vncproxy$/.test(req.url)) {
      const ticket = 'PVEVNC:' + crypto.randomBytes(12).toString('hex');
      const s = req.url.replace(/^\/api2\/json/, '').split('/').filter(Boolean);
      vnctickets.set(ticket, { node: s[1], cle: `${s[2]}/${s[3]}`, vnc: true, user: demandeur(req) });
      appels.push({ methode: 'POST', chemin: req.url.replace(/^\/api2\/json/, ''), auth: req.headers.authorization || 'ticket' });
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { port: '5900', ticket, cert: '', user: UTILISATEUR.nom, upid: 'UPID:essai' } }));
      return;
    }
    if (req.method === 'POST' && /\/termproxy$/.test(req.url)) {
      const ticket = 'PVEVNC:' + crypto.randomBytes(10).toString('hex');
      const s = req.url.replace(/^\/api2\/json/, '').split('/').filter(Boolean);
      if (s[2] === 'qemu' && !trouver(s[1], 'qemu', s[3])?.conf?.serial0) {
        req.resume(); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: null, message: 'unable to find a serial interface\n' })); return;
      }
      vnctickets.set(ticket, { node: s[1], cle: s.length > 3 ? `${s[2]}/${s[3]}` : null, user: demandeur(req) });
      appels.push({ methode: 'POST', chemin: req.url.replace(/^\/api2\/json/, ''), auth: req.headers.authorization || 'ticket' });
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { port: '5901', ticket, user: UTILISATEUR.nom, upid: 'UPID:essai' } }));
      return;
    }
    origine(req, res);
  });

  // vncwebsocket : ticket de session dans le cookie, vncticket en paramètre,
  // puis « utilisateur:ticket\n » attendu avant tout. Un shell minimal ensuite.
  const consoles = [], coupures = { ecran: 0 };
  serveur.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'https://pve');
    const cookie = /PVEAuthCookie=([^;]+)/.exec(req.headers.cookie || '');
    const vt = vnctickets.get(url.searchParams.get('vncticket') || '');
    if (!cookie || !tickets.has(decodeURIComponent(cookie[1])) || !vt || vt.user !== UTILISATEUR.nom) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const ws = accepter(req, socket, { sousProtocole: 'binary' });
    // Un écran que Proxmox coupe pendant la poignée (vncproxy pas encore prêt).
    if (vt.vnc && coupures.ecran > 0) { coupures.ecran--; setTimeout(() => ws.close(), 5); return; }
    if (vt.vnc) return ecranVnc(ws, vt, url.searchParams.get('vncticket'));
    const c = { cible: vt.cle || `node/${vt.node}`, saisies: [], tailles: [] };
    consoles.push(c);
    let authentifie = false, ligne = '';
    const invite = `root@${vt.cle ? 'invite-' + vt.cle.split('/')[1] : vt.node}:~# `;
    ws.on('message', d => {
      const t = d.toString('utf8');
      if (!authentifie) { if (t === `${UTILISATEUR.nom}:${url.searchParams.get('vncticket')}\n`) { authentifie = true; ws.envoyerBinaire(Buffer.from('OK')); ws.envoyerBinaire(Buffer.from(`Console d'essai (${c.cible})\r\n${invite}`)); } else ws.close(); return; }
      if (t === '2') return;
      const r = /^1:(\d+):(\d+):$/.exec(t);
      if (r) { c.tailles.push([+r[1], +r[2]]); return; }
      const m = /^0:(\d+):([\s\S]*)$/.exec(t);
      if (!m) return;
      c.saisies.push(m[2]);
      for (const ch of m[2]) {
        if (ch === '\r') {
          const sortie = ligne === 'hostname' ? (vt.cle ? 'invite-' + vt.cle.split('/')[1] : vt.node) : ligne === 'uname' ? 'Linux' : ligne ? `${ligne.split(' ')[0]}: commande inconnue` : '';
          ws.envoyerBinaire(Buffer.from(`\r\n${sortie ? '\x1b[32m' + sortie + '\x1b[0m\r\n' : ''}${invite}`));
          ligne = '';
        } else if (ch === '\x7f') { if (ligne) { ligne = ligne.slice(0, -1); ws.envoyerBinaire(Buffer.from('\b \b')); } } else { ligne += ch; ws.envoyerBinaire(Buffer.from(ch)); }
      }
    });
  });

  // L'écran d'une VM : un serveur RFB 3.8 minimal, authentification VNC avec
  // le ticket de vncproxy, l'image entière à chaque demande non incrémentale
  // (4 × 2 pixels pour les essais ; une fausse invite de connexion, inventée,
  // pour la vitrine). Une demande incrémentale attend : rien ne change.
  const [EL, EH] = ecran;
  const pixels = Buffer.alloc(EL * EH * 4);
  for (let y = 0; y < EH; y++) for (let x = 0; x < EL; x++) {
    const i = (y * EL + x) * 4, cadre = EL > 8 && x > EL * 0.3 && x < EL * 0.7 && y > EH * 0.35 && y < EH * 0.65;
    const champ = cadre && y > EH * 0.48 && y < EH * 0.54 && x > EL * 0.34 && x < EL * 0.66;
    const [r, g, b] = EL <= 8 ? [200, 100, 50] : champ ? [235, 238, 242] : cadre ? [44, 52, 64] : [18 + Math.round(y / EH * 20), 24 + Math.round(y / EH * 26), 38 + Math.round(x / EL * 30)];
    pixels.set([r, g, b, 0], i);
  }
  const ecrans = [];
  function ecranVnc(ws, vt, ticket) {
    // Presse-papiers étendu (comme QEMU avec clipboard=vnc) : capacités, avis,
    // demande, fourniture compressée en zlib ; l'ancien ClientCutText aussi.
    const ext = { CAPS: 1 << 24, REQUEST: 1 << 25, NOTIFY: 1 << 27, PROVIDE: 1 << 28, TEXTE: 1 };
    const couper = (flags, donnees = Buffer.alloc(0)) => { const t = Buffer.alloc(12); t[0] = 3; t.writeInt32BE(-(4 + donnees.length), 4); t.writeUInt32BE(flags >>> 0, 8); ws.envoyerBinaire(Buffer.concat([t, donnees])); };
    const e = { cible: vt.cle, authentifie: false, messages: [], presse: null, invite: '', ext: false,
      copierInvite(texte) { e.invite = texte; if (e.ext) couper(ext.NOTIFY | ext.TEXTE); } };
    ecrans.push(e);
    let tampon = Buffer.alloc(0), etape = 'version', defi = crypto.randomBytes(16);
    ws.envoyerBinaire(Buffer.from('RFB 003.008\n', 'latin1'));
    const longueur = b => ({ 0: 20, 3: 10, 4: 8, 5: 6, 255: 12 }[b[0]] ?? (b[0] === 2 && b.length >= 4 ? 4 + 4 * b.readUInt16BE(2) : b[0] === 6 && b.length >= 8 ? 8 + Math.abs(b.readInt32BE(4)) : 0));
    ws.on('message', d => {
      tampon = Buffer.concat([tampon, d]);
      for (;;) {
        if (etape === 'version') { if (tampon.length < 12) return; tampon = tampon.subarray(12); etape = 'type'; ws.envoyerBinaire(Buffer.from([1, 2])); continue; }
        if (etape === 'type') { if (tampon.length < 1) return; if (tampon[0] !== 2) return ws.close(); tampon = tampon.subarray(1); etape = 'reponse'; ws.envoyerBinaire(defi); continue; }
        if (etape === 'reponse') {
          if (tampon.length < 16) return;
          e.authentifie = tampon.subarray(0, 16).equals(reponseVnc(ticket, defi));
          tampon = tampon.subarray(16);
          if (!e.authentifie) { const r = Buffer.from('mauvais mot de passe'); const l = Buffer.alloc(4); l.writeUInt32BE(r.length); ws.envoyerBinaire(Buffer.concat([Buffer.from([0, 0, 0, 1]), l, r])); return ws.close(); }
          ws.envoyerBinaire(Buffer.from([0, 0, 0, 0])); etape = 'clientinit'; continue;
        }
        if (etape === 'clientinit') {
          if (tampon.length < 1) return;
          tampon = tampon.subarray(1); etape = 'messages';
          const nom = Buffer.from(`invite-${vt.cle.split('/')[1]}`);
          const init = Buffer.alloc(24); init.writeUInt16BE(EL, 0); init.writeUInt16BE(EH, 2); init.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4); init.writeUInt32BE(nom.length, 20);
          ws.envoyerBinaire(Buffer.concat([init, nom]));
          continue;
        }
        if (!tampon.length) return;
        const n = longueur(tampon);
        if (!n || tampon.length < n) return;
        const m = tampon.subarray(0, n); tampon = tampon.subarray(n);
        e.messages.push([...m]);
        if (m[0] === 2) {
          const encs = Array.from({ length: m.readUInt16BE(2) }, (_, i) => m.readInt32BE(4 + 4 * i));
          // QEMU accuse la touche étendue par un rectangle -258 vide.
          if (encs.includes(-258)) { const t = Buffer.alloc(16); t.writeUInt16BE(1, 2); t.writeInt32BE(-258, 12); ws.envoyerBinaire(t); }
          if (encs.includes(0xC0A1E5CE | 0)) { e.ext = true; const max = Buffer.alloc(4); max.writeUInt32BE(64 * 1024); couper(ext.CAPS | ext.REQUEST | ext.NOTIFY | ext.PROVIDE | ext.TEXTE, max); }
        }
        if (m[0] === 6) {
          const lg = m.readInt32BE(4);
          if (lg >= 0) e.presse = m.subarray(8).toString('latin1');
          else {
            const flags = m.readUInt32BE(8);
            if (flags & ext.CAPS) e.capsClient = flags;
            else if (flags & ext.REQUEST && flags & ext.TEXTE) { const t = Buffer.from(e.invite.replace(/\n/g, '\r\n') + '\0'); const l = Buffer.alloc(4); l.writeUInt32BE(t.length); couper(ext.PROVIDE | ext.TEXTE, zlib.deflateSync(Buffer.concat([l, t]))); }
            else if (flags & ext.NOTIFY && flags & ext.TEXTE) couper(ext.REQUEST | ext.TEXTE);
            else if (flags & ext.PROVIDE && flags & ext.TEXTE) { const z = zlib.inflateSync(m.subarray(12)); e.presse = z.subarray(4, 4 + z.readUInt32BE(0)).toString('utf8').replace(/\0$/, '').replace(/\r\n/g, '\n'); }
          }
        }
        if (m[0] === 3 && m[1] === 0) {
          const t = Buffer.alloc(16); t.writeUInt16BE(1, 2); t.writeUInt16BE(EL, 8); t.writeUInt16BE(EH, 10); t.writeInt32BE(0, 12);
          ws.envoyerBinaire(Buffer.concat([t, pixels]));
        }
      }
    });
  }

  await new Promise(r => serveur.listen(0, '127.0.0.1', r));
  const port = serveur.address().port;
  return {
    hote: '127.0.0.1', port, etat, appels, consoles, ecrans, coupures, autorite: certificats.autorite,
    empreinte: new crypto.X509Certificate(certificats.cert).fingerprint256,
    fermer: () => new Promise(f => { serveur.closeAllConnections?.(); serveur.close(f); }),
  };
}
