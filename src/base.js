// Base de ProxLab (SQLite, node:sqlite) : la liaison à Proxmox et le réglage
// des alertes, secrets scellés par le coffre du socle ; les événements de la
// grappe, que l'interface montre et que le Hub relève.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function ouvrirBase(dossier) {
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  // La base naît en 0600 : SQLite la créerait selon le masque du processus.
  const fichier = path.join(dossier, 'proxlab.db');
  fs.closeSync(fs.openSync(fichier, 'a', 0o600));
  const db = new DatabaseSync(fichier);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evenements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      genre TEXT NOT NULL,
      niveau TEXT NOT NULL,
      titre TEXT NOT NULL,
      corps TEXT NOT NULL DEFAULT '',
      cible TEXT,
      noeud TEXT,
      acteur TEXT,
      acteur_compte TEXT,
      cree INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evenements_cree ON evenements(cree);`);
  for (const f of [fichier, fichier + '-wal', fichier + '-shm']) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  return db;
}

// Usages du coffre : chacun sa sous-clé ; l'AAD lie un secret à son réglage.
const SCEAUX = { jeton: ['pve-jeton', 'liaison'], motDePasse: ['pve-motdepasse', 'liaison'], cle: ['alerte-cle', 'alertes'], secret: ['alerte-secret', 'alertes'] };
const NIVEAUX = ['info', 'avertissement', 'critique'];
const MAX_EVENEMENTS = 20000;

export class Reglages {
  constructor(db, { coffre }) { this.db = db; this.coffre = coffre; }

  lire(cle) {
    const l = this.db.prepare('SELECT valeur FROM reglages WHERE cle = ?').get(cle);
    return l ? JSON.parse(l.valeur) : null;
  }
  ecrire(cle, valeur) {
    if (valeur === null) this.db.prepare('DELETE FROM reglages WHERE cle = ?').run(cle);
    else this.db.prepare('INSERT INTO reglages(cle, valeur) VALUES(?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur').run(cle, JSON.stringify(valeur));
  }

  sceller(quoi, clair) {
    if (!clair) return null;
    const [usage, aad] = SCEAUX[quoi];
    return this.coffre.scelle(usage, clair, aad);
  }
  ouvrir(quoi, scelle) {
    if (!scelle) return '';
    const [usage, aad] = SCEAUX[quoi];
    return this.coffre.ouvre(usage, scelle, aad);
  }

  // La liaison telle que le client Proxmox l'utilise : secrets ouverts.
  liaison() {
    const l = this.lire('liaison');
    if (!l) return null;
    return { ...l, secret: this.ouvrir('jeton', l.jeton_scelle), motDePasse: this.ouvrir('motDePasse', l.mdp_scelle) };
  }
  alertes() {
    const a = this.lire('alertes');
    if (!a) return null;
    return { ...a, cle: this.ouvrir('cle', a.cle_scellee), secret: this.ouvrir('secret', a.secret_scelle) };
  }

  // Après une rotation de SOCLE_CLE (le socle a rescellé ses propres secrets) :
  // ceux de ProxLab, scellés sous l'ancienne clé, sont rescellés sous la neuve.
  //   - sans SOCLE_CLE_ANCIENNE posée, le démarrage s'arrête (la reposer le
  //     temps d'un démarrage suffit, rien n'est perdu) ;
  //   - avec elle, un secret illisible sous les deux clés est retiré et le
  //     bilan le dit : il se ressaisit dans les réglages.
  resceller() {
    const avant = this.coffre.precedente;
    const bilan = { rescelles: 0, retires: 0 };
    const reprendre = (quoi, scelle) => {
      if (!scelle) return scelle;
      const [usage, aad] = SCEAUX[quoi];
      try { this.coffre.ouvre(usage, scelle, aad); return scelle; } catch { /* scellé sous une autre clé */ }
      if (!avant) throw new Error('Un secret de ProxLab (liaison Proxmox ou alertes) est illisible sous SOCLE_CLE : repose la clé remplacée dans SOCLE_CLE_ANCIENNE le temps d\'un démarrage.');
      try { const clair = avant.ouvre(usage, scelle, aad); bilan.rescelles++; return this.coffre.scelle(usage, clair, aad); } catch { bilan.retires++; return null; }
    };
    transaction(this.db, () => {
      const l = this.lire('liaison');
      if (l) this.ecrire('liaison', { ...l, jeton_scelle: reprendre('jeton', l.jeton_scelle), mdp_scelle: reprendre('motDePasse', l.mdp_scelle) });
      const a = this.lire('alertes');
      if (a) this.ecrire('alertes', { ...a, cle_scellee: reprendre('cle', a.cle_scellee), secret_scelle: reprendre('secret', a.secret_scelle) });
    });
    return bilan;
  }
}

export class Evenements {
  constructor(db, { retentionJours = 30, maintenant = () => Date.now() } = {}) {
    this.db = db; this.retention = retentionJours * 864e5; this.maintenant = maintenant;
  }

  noter({ genre, niveau = 'info', titre, corps = '', cible = null, noeud = null, acteur = null, acteurCompte = null }) {
    const e = {
      ref: crypto.randomBytes(9).toString('base64url'), genre: String(genre).slice(0, 60),
      niveau: NIVEAUX.includes(niveau) ? niveau : 'info', titre: String(titre).slice(0, 300), corps: String(corps).slice(0, 4000),
      cible: cible ? String(cible).slice(0, 80) : null, noeud: noeud ? String(noeud).slice(0, 64) : null,
      acteur: acteur ? String(acteur).slice(0, 64) : null, cree: this.maintenant(),
    };
    this.db.prepare(`INSERT INTO evenements(ref, genre, niveau, titre, corps, cible, noeud, acteur, acteur_compte, cree)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.ref, e.genre, e.niveau, e.titre, e.corps, e.cible, e.noeud, e.acteur, acteurCompte, e.cree);
    return publicDe(e);
  }

  // Les plus récents d'abord, par pages bornées ; « avant » pagine vers le passé.
  // « alertes » ne garde que le critique et l'avertissement.
  liste({ limite = 50, avant = null, alertes = false } = {}) {
    const niveau = alertes ? " AND niveau IN ('critique', 'avertissement')" : '';
    const lignes = avant
      ? this.db.prepare(`SELECT * FROM evenements WHERE id < (SELECT id FROM evenements WHERE ref = ?)${niveau} ORDER BY id DESC LIMIT ?`).all(avant, limite)
      : this.db.prepare(`SELECT * FROM evenements WHERE 1 = 1${niveau} ORDER BY id DESC LIMIT ?`).all(limite);
    return lignes.map(publicDe);
  }

  // Les incidents d'une période, pour la carte de disponibilité.
  incidents(depuis) {
    return this.db.prepare("SELECT genre, niveau, cible, noeud, cree FROM evenements WHERE cree >= ? AND niveau IN ('critique', 'avertissement') ORDER BY cree").all(depuis);
  }

  purger() {
    this.db.prepare('DELETE FROM evenements WHERE cree < ?').run(this.maintenant() - this.retention);
    this.db.prepare('DELETE FROM evenements WHERE id <= (SELECT id FROM evenements ORDER BY id DESC LIMIT 1 OFFSET ?)').run(MAX_EVENEMENTS);
  }

  // Ce que ProxLab garde d'un compte : les gestes qu'il a faits sur la grappe.
  donneesDe(compteId) {
    return { evenements: this.db.prepare('SELECT * FROM evenements WHERE acteur_compte = ? ORDER BY id').all(compteId).map(publicDe) };
  }
  oublier(compteId) {
    this.db.prepare("UPDATE evenements SET acteur = 'compte supprimé', acteur_compte = NULL WHERE acteur_compte = ?").run(compteId);
  }
}

function publicDe(e) {
  return { id: e.ref, kind: e.genre, severity: e.niveau, title: e.titre, message: e.corps, target: e.cible, node: e.noeud, by: e.acteur, at: new Date(e.cree).toISOString() };
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
