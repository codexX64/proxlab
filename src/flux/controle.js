// Le flux de contrôle d'une session Sunshine, sur ENet : chaque message est
// chiffré en AES-GCM (clé de la session, IV tiré d'un compteur et d'un
// marqueur d'origine). Démarrage, ping périodique, demande d'image complète,
// entrées clavier et souris ; fin de session annoncée par Sunshine.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ClientEnet } from './enet.js';

export const CANAL = { GENERAL: 0x00, URGENT: 0x01, CLAVIER: 0x02, SOURIS: 0x03, NOMBRE: 0x30 };
const T = { IDR: 0x0302, START_B: 0x0307, PING: 0x0200, ENTREE: 0x0206, FIN: 0x0109, HDR: 0x010e };
const PING_MS = 100;

export function scellerControle(type, charge, cle, seq) {
  const clair = Buffer.alloc(4 + charge.length);
  clair.writeUInt16LE(type, 0); clair.writeUInt16LE(charge.length, 2); charge.copy(clair, 4);
  const iv = Buffer.alloc(12);
  iv.writeUInt32LE(seq >>> 0, 0); iv[10] = 0x43; iv[11] = 0x43;      // « CC » : client, contrôle
  const c = crypto.createCipheriv('aes-128-gcm', cle, iv);
  const chiffre = Buffer.concat([c.update(clair), c.final()]);
  const h = Buffer.alloc(8);
  h.writeUInt16LE(0x0001, 0); h.writeUInt16LE(4 + 16 + chiffre.length, 2); h.writeUInt32LE(seq >>> 0, 4);
  return Buffer.concat([h, c.getAuthTag(), chiffre]);
}

export function ouvrirControle(brut, cle) {
  if (brut.length < 8 + 16 + 4 || brut.readUInt16LE(0) !== 0x0001) return null;
  const lg = brut.readUInt16LE(2);
  if (lg + 4 !== brut.length || lg < 4 + 16 + 4) return null;
  const iv = Buffer.alloc(12);
  iv.writeUInt32LE(brut.readUInt32LE(4), 0); iv[10] = 0x48; iv[11] = 0x43;   // « HC » : hôte, contrôle
  const d = crypto.createDecipheriv('aes-128-gcm', cle, iv);
  d.setAuthTag(brut.subarray(8, 24));
  let clair;
  try { clair = Buffer.concat([d.update(brut.subarray(24)), d.final()]); } catch { return null; }
  if (clair.length < 4) return null;
  const n = clair.readUInt16LE(2);
  if (4 + n > clair.length) return null;
  return { type: clair.readUInt16LE(0), charge: clair.subarray(4, 4 + n) };
}

export class Controle extends EventEmitter {
  constructor({ cle }) {
    super();
    this.cle = cle; this.seq = 0;
    this.enet = new ClientEnet({ canaux: CANAL.NOMBRE });
    this.enet.on('message', (_c, m) => this.recu(m));
    this.enet.on('ferme', (e, { distant } = {}) => { clearInterval(this.minuteur); if (!this.fini) { this.fini = true; this.emit('fin', e ? e.message : distant ? 'session fermée par Sunshine' : 'contrôle fermé'); } });
  }

  async demarrer({ hote, port, donnees }) {
    await this.enet.connecter(hote, port, { donnees });
    this.envoyer(T.IDR, Buffer.from([0, 0]), CANAL.GENERAL);
    this.envoyer(T.START_B, Buffer.from([0]), CANAL.GENERAL);
    const ping = Buffer.alloc(8); ping.writeUInt32LE(4, 0);
    this.minuteur = setInterval(() => this.envoyer(T.PING, ping, CANAL.GENERAL), PING_MS);
  }

  envoyer(type, charge, canal, { fiable = true } = {}) {
    if (this.fini) return false;
    return this.enet.envoyer(canal, scellerControle(type, charge, this.cle, this.seq++), { fiable });
  }

  demanderImageComplete() { return this.envoyer(T.IDR, Buffer.from([0, 0]), CANAL.URGENT); }
  entree(paquet, canal) { return this.envoyer(T.ENTREE, paquet, canal); }

  recu(brut) {
    const m = ouvrirControle(brut, this.cle);
    if (!m) return;
    if (m.type === T.FIN) {
      const code = m.charge.length >= 4 ? m.charge.readUInt32BE(0) : m.charge.length >= 2 ? m.charge.readUInt16LE(0) : 0;
      this.fini = true;
      clearInterval(this.minuteur);
      this.emit('fin', code === 0x80030023 || code === 0x0100 ? 'session fermée par Sunshine' : `session interrompue par Sunshine (0x${code.toString(16)})`);
      this.enet.fermer(null, { distant: true });
    }
  }

  fermer() {
    this.fini = true;
    clearInterval(this.minuteur);
    this.enet.fermer();
  }
}
