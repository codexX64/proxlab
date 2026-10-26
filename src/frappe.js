// Frappe d'un texte par ProxLab lui-même dans une VM (socle/src/frappe.js) :
// le transport est une connexion VNC à elle, propre à la frappe (partagée avec
// un écran ouvert, s'il y en a un), et la touche étendue de QEMU — le code
// physique part avec chaque touche, la VM applique sa disposition.

// Message QEMU « touche étendue » : code physique et keysym.
export function messageTouche({ bas, keysym, xt }) {
  const b = Buffer.alloc(12);
  b[0] = 255; b[1] = 0; b.writeUInt16BE(bas ? 1 : 0, 2); b.writeUInt32BE(keysym >>> 0, 4); b.writeUInt32BE(xt >>> 0, 8);
  return b;
}
// ClientInit partagé (l'écran ouvert reste ouvert), puis la touche étendue demandée.
export function ouvertureRfb() {
  const se = Buffer.alloc(8);
  se[0] = 2; se.writeUInt16BE(1, 2); se.writeInt32BE(-258, 4);
  return [Buffer.from([1]), se];
}

// ouvrirVnc → le lien que la frappe du socle attend.
export async function lienVnc(ouvrirVnc) {
  const { amont } = await ouvrirVnc();
  // Les touches partent une à une, sans être regroupées par TCP.
  amont.socket?.setNoDelay?.(true);
  amont.on('message', () => { /* ni image ni presse-papiers demandés : rien à lire */ });
  for (const m of ouvertureRfb()) amont.envoyerBinaire(m);
  return {
    envoyer: ev => amont.envoyerBinaire(messageTouche(ev)),
    fermer: () => amont.close(),
    surFin: f => amont.on('fermeture', f),
  };
}
