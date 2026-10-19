// Console : un terminal du navigateur relié au termproxy de Proxmox (shell d'un
// nœud, console série d'une VM, console d'un conteneur).
//
// Le WebSocket de Proxmox n'accepte pas les jetons d'API : il lui faut un
// ticket, d'où l'utilisateur et le mot de passe de la liaison. Côté navigateur,
// deux messages seulement sont compris — une saisie { i } et une taille { r } ;
// le reste est ignoré. La session ProxLab est revérifiée chaque minute : une
// session fermée ailleurs ferme aussi la console.
import { chemin } from './pve.js';
import { connecter } from './websocket.js';

const SAISIE_MAX = 64 * 1024;

export async function ouvrirTermproxy(proxmox, { noeud, type, vmid }) {
  const base = type === 'node' ? chemin('nodes', noeud) : chemin('nodes', noeud, type, vmid);
  const tp = await proxmox.postSession(base + '/termproxy', {});
  const ticket = await proxmox.obtenirTicket();
  const l = proxmox.liaison();
  const amont = await connecter(l, `/api2/json${base}/vncwebsocket?port=${encodeURIComponent(tp.port)}&vncticket=${encodeURIComponent(tp.ticket)}`, {
    entetes: { Cookie: `PVEAuthCookie=${encodeURIComponent(ticket.ticket)}`, 'Sec-WebSocket-Protocol': 'binary', Origin: `https://${l.hote}:${l.port}` },
  });
  amont.envoyerTexte(`${tp.user}:${tp.ticket}\n`);
  return amont;
}

// navigateur : Connexion serveur ; ouvrir() rend la Connexion vers Proxmox.
export function relayer(navigateur, ouvrir, { vivante = () => true, surFin = () => {} } = {}) {
  let amont = null, fini = false;
  const finir = message => {
    if (fini) return;
    fini = true;
    clearInterval(garde); clearInterval(battement);
    if (message) { try { navigateur.envoyerTexte(`\r\n\x1b[33m${message}\x1b[0m\r\n`); } catch { /* fermé */ } }
    try { navigateur.close(); } catch { /* fermé */ }
    try { amont?.close(); } catch { /* fermé */ }
    surFin();
  };
  const garde = setInterval(() => { if (!vivante()) finir('— session fermée —'); }, 60e3);
  const battement = setInterval(() => { try { amont?.envoyerTexte('2'); } catch { /* fermé */ } }, 30e3);
  garde.unref?.(); battement.unref?.();

  navigateur.on('message', (donnees, texte) => {
    if (!amont || !texte || donnees.length > SAISIE_MAX) return;
    let m;
    try { m = JSON.parse(donnees.toString('utf8')); } catch { return; }
    if (typeof m?.i === 'string') amont.envoyerTexte(`0:${Buffer.byteLength(m.i)}:${m.i}`);
    else if (Array.isArray(m?.r) && m.r.length === 2) {
      const [c, l] = m.r.map(Number);
      if (Number.isInteger(c) && Number.isInteger(l) && c >= 10 && c <= 500 && l >= 4 && l <= 200) amont.envoyerTexte(`1:${c}:${l}:`);
    }
  });
  navigateur.on('fermeture', () => finir(null));

  ouvrir().then(conn => {
    if (fini) { conn.close(); return; }
    amont = conn;
    let premier = true;
    conn.on('message', donnees => {
      const s = donnees.toString('utf8');
      // Proxmox accuse réception du ticket par « OK » : ce n'est pas une sortie du terminal.
      if (premier) { premier = false; if (s === 'OK') return; }
      navigateur.envoyerTexte(s);
    });
    conn.on('fermeture', () => finir('— session terminée —'));
    navigateur.envoyerTexte('\x1b[2J\x1b[H');
  }, e => finir(`console indisponible : ${String(e.message || e).slice(0, 160)}`));
}
