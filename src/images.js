// Images ISO remises à Proxmox : qu'elles viennent du navigateur ou d'une
// adresse, elles passent par le même chemin (SEC-FILE-001, -002, -008) —
// taille annoncée et bornée, place vérifiée sur le stockage, signature d'une
// image de disque lue dans les premiers octets avant d'en relayer un seul,
// somme de contrôle calculée au passage quand elle est donnée.
import crypto from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import { chemin } from './pve.js';
import { telecharger, DestinationRefusee } from './sortie.js';

export const ISO_MAX = 64 * 1024 ** 3;
export const FICHIER_ISO = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}\.(iso|img)$/i;
const ENTETE = 34816;   // le descripteur de volume ISO 9660 / UDF est au secteur 16 (32 768 octets)
const RELAIS_MAX = 3;   // envois et importations en même temps

export class ImageRefusee extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ImageRefusee'; this.status = status; }
}

/**
 * Une image de disque : ISO 9660 ou UDF (« CD001 », « BEA01 », « NSR02/03 »
 * au secteur 16), ou disque brut amorçable (signature MBR ou en-tête GPT).
 */
export function imageReconnue(tete) {
  const a = tete.length >= 32774 ? tete.toString('latin1', 32769, 32774) : '';
  if (['CD001', 'BEA01', 'NSR02', 'NSR03'].includes(a)) return true;
  if (tete.length >= 520 && tete.toString('latin1', 512, 520) === 'EFI PART') return true;
  return tete.length >= 512 && tete[510] === 0x55 && tete[511] === 0xAA;
}

// Les premiers octets d'un flux, sans le consommer : rend { tete, suite },
// suite redonnant tout depuis le premier octet.
function lireEntete(flux, n = ENTETE) {
  return new Promise((ok, ko) => {
    const morceaux = [];
    let t = 0, fini = false;
    const arreter = fin => {
      flux.off('data', donnees); flux.off('end', surFin); flux.off('error', ko);
      flux.pause();
      const tete = Buffer.concat(morceaux);
      const suite = new PassThrough();
      suite.write(tete);
      if (fin) suite.end();
      else {
        flux.pipe(suite);
        // Un navigateur qui coupe : la suite s'arrête en erreur au lieu d'attendre.
        flux.once('close', () => { if (!flux.readableEnded) suite.destroy(new ImageRefusee('Envoi interrompu.')); });
      }
      ok({ tete, suite });
    };
    const donnees = c => { morceaux.push(c); t += c.length; if (t >= n && !fini) { fini = true; arreter(false); } };
    const surFin = () => { if (!fini) { fini = true; arreter(true); } };
    flux.on('data', donnees);
    flux.once('end', surFin);
    flux.once('error', ko);
    flux.once('close', () => { if (!fini) { fini = true; ko(new ImageRefusee('Envoi interrompu.')); } });
  });
}

export class Images {
  constructor({ proxmox, journal, evenements, log = console, maintenant = () => Date.now() }) {
    Object.assign(this, { proxmox, journal, evenements, log, maintenant });
    this.travaux = new Map();
    this.relais = 0;
  }

  /** Les octets libres d'un stockage vus du nœud, ou null si Proxmox ne le dit pas. */
  async placeLibre(noeud, stockage) {
    const liste = await this.proxmox.get(chemin('nodes', noeud, 'storage'), { content: 'iso' });
    const s = (liste || []).find(x => x.storage === stockage);
    if (!s) throw new ImageRefusee('Ce stockage n’accepte pas d’images ISO sur ce nœud.', 404);
    return Number.isFinite(+s.avail) ? +s.avail : null;
  }

  // Une image du même nom n'est jamais écrasée : le nom, contraint par
  // FICHIER_ISO (ni séparateur, ni point en tête), ne peut ni sortir du
  // stockage ni prendre la place d'une autre.
  async exigerNomLibre(noeud, stockage, nom) {
    const contenu = await this.proxmox.get(chemin('nodes', noeud, 'storage', stockage, 'content'), { content: 'iso' });
    if ((contenu || []).some(c => c.volid === `${stockage}:iso/${nom}`)) throw new ImageRefusee(`${nom} existe déjà sur ${stockage} : choisis un autre nom, ou supprime l’ancienne.`, 409);
  }

  /**
   * Relaie une image vers Proxmox. `flux` : le corps (navigateur ou adresse),
   * `taille` : sa longueur annoncée. `progres(octets)` suit l'envoi, `somme`
   * { algorithme, valeur } est comparée à la fin : une image différente est
   * retirée du stockage.
   */
  async relayer(options) {
    if (this.relais >= RELAIS_MAX) throw new ImageRefusee(`Déjà ${RELAIS_MAX} images en route : attends la fin de l’une d’elles.`, 429);
    this.relais++;
    try { return await this.relayerMaintenant(options); } finally { this.relais--; }
  }
  async relayerMaintenant({ noeud, stockage, nom, flux, taille, somme = null, progres = () => {} }) {
    if (!FICHIER_ISO.test(nom)) throw new ImageRefusee('Nom d’image en .iso ou .img : lettres, chiffres, points, tirets.');
    if (!Number.isSafeInteger(taille) || taille <= 0) throw new ImageRefusee('Taille de l’image inconnue : elle est exigée.', 411);
    if (taille > ISO_MAX) throw new ImageRefusee('Image de plus de 64 Gio : refusée.', 413);
    await this.exigerNomLibre(noeud, stockage, nom);
    const libre = await this.placeLibre(noeud, stockage);
    if (libre !== null && taille > libre) throw new ImageRefusee(`Pas assez de place sur ${stockage} : ${Math.ceil(taille / 1048576)} Mio demandés.`, 409);
    const { tete, suite } = await lireEntete(flux);
    if (!imageReconnue(tete)) { suite.destroy(); flux.destroy?.(); throw new ImageRefusee('Ce fichier n’est pas une image de disque (ni ISO 9660, ni UDF, ni disque amorçable) : refusé.', 415); }
    const empreinte = somme ? crypto.createHash(somme.algorithme) : null;
    let vus = 0;
    const compte = new Transform({ transform(c, _e, cb) { vus += c.length; empreinte?.update(c); progres(vus); cb(null, c); } });
    suite.on('error', e => compte.destroy(e));
    const upid = await this.proxmox.envoyerFichier(chemin('nodes', noeud, 'storage', stockage, 'upload'), { champs: { content: 'iso' }, champFichier: 'filename', nom, flux: suite.pipe(compte), taille });
    if (empreinte) {
      const obtenue = empreinte.digest('hex');
      if (obtenue !== somme.valeur.toLowerCase()) {
        await this.retirerApresTache(noeud, stockage, nom, upid);
        throw new ImageRefusee(`Somme de contrôle différente (${somme.algorithme} ${obtenue.slice(0, 16)}…) : l’image a été retirée du stockage.`, 422);
      }
    }
    return String(upid || '');
  }

  // Une image refusée après coup : Proxmox la range en tâche ; on attend sa
  // fin (une minute au plus) puis on la retire.
  async retirerApresTache(noeud, stockage, nom, upid) {
    for (let i = 0; upid && i < 60; i++) {
      const st = await this.proxmox.get(chemin('nodes', noeud, 'tasks', upid, 'status')).catch(() => null);
      if (!st || st.status === 'stopped') break;
      await new Promise(r => setTimeout(r, 1000));
    }
    await this.proxmox.del(chemin('nodes', noeud, 'storage', stockage, 'content', encodeURIComponent(`${stockage}:iso/${nom}`))).catch(e => this.log.warn?.(`[images] ${nom} non retirée : ${e.message}`));
  }

  // Importations depuis une adresse, en tâche de fond.

  /** Ce qu'annonce l'adresse (nom, taille), lu sans télécharger l'image. */
  async apercu(url) {
    const r = await telecharger(url, { delai: 15000 });
    r.flux.destroy();
    if (r.statut !== 200) throw new ImageRefusee(`Le serveur répond ${r.statut}.`, 502);
    return { nom: nomDepuis(r), taille: Number(r.entetes['content-length']) || 0 };
  }

  importer({ url, nom, noeud, stockage, somme, acteur }) {
    if ([...this.travaux.values()].filter(x => x.etat === 'en cours').length >= RELAIS_MAX) throw new ImageRefusee(`Déjà ${RELAIS_MAX} importations en cours : attends la fin de l’une d’elles.`, 429);
    const id = crypto.randomBytes(9).toString('base64url');
    const controleur = new AbortController();
    const t = { id, nom, noeud, stockage, hote: new URL(url).host, etat: 'en cours', octets: 0, taille: 0, debut: this.maintenant(), fin: null, erreur: '', acteur, controleur };
    this.travaux.set(id, t);
    this.elaguer();
    (async () => {
      try {
        const r = await telecharger(url, { signal: controleur.signal, delai: 60000 });
        if (r.statut !== 200) { r.flux.destroy(); throw new ImageRefusee(`Le serveur répond ${r.statut}.`, 502); }
        t.taille = Number(r.entetes['content-length']) || 0;
        await this.relayer({ noeud, stockage, nom, flux: r.flux, taille: t.taille, somme, progres: n => { t.octets = n; } });
        t.etat = 'terminée';
        this.evenements.noter({ genre: 'iso.added', niveau: 'info', titre: `${nom} importée dans ${stockage}`, corps: `Depuis ${t.hote}${somme ? `, somme ${somme.algorithme} vérifiée` : ''}, par ${acteur.acteur}.`, noeud, ...acteur });
      } catch (e) {
        t.etat = controleur.signal.aborted ? 'annulée' : 'échec';
        t.erreur = controleur.signal.aborted ? '' : e instanceof ImageRefusee || e instanceof DestinationRefusee ? e.message : `${e.message}`.slice(0, 300);
        this.log.warn?.(`[images] ${nom} depuis ${t.hote} : ${t.etat}${t.erreur ? ` — ${t.erreur}` : ''}`);
      } finally {
        t.fin = this.maintenant();
        delete t.controleur;
        this.journal.ecrire({ acteur: acteur.acteurCompte, action: 'iso.import', objet: `${stockage}:iso/${nom}`, resultat: t.etat === 'terminée' ? 'ok' : 'refus', details: { noeud, hote: t.hote, etat: t.etat, octets: t.octets, somme: !!somme } });
      }
    })();
    return id;
  }

  annuler(id) {
    const t = this.travaux.get(id);
    if (!t) throw new ImageRefusee('Importation introuvable.', 404);
    t.controleur?.abort();
  }

  liste() {
    return [...this.travaux.values()].map(({ controleur, acteur, ...t }) => ({ ...t, par: acteur.acteur }));
  }

  // Vingt importations gardées au plus, et pas plus d'un jour une fois finies.
  elaguer() {
    const t = this.maintenant();
    for (const [id, x] of this.travaux) if (x.fin && t - x.fin > 864e5) this.travaux.delete(id);
    const finies = [...this.travaux.values()].filter(x => x.fin).sort((a, b) => a.fin - b.fin);
    while (this.travaux.size > 20 && finies.length) this.travaux.delete(finies.shift().id);
  }
}

// Le nom d'une image d'après la réponse : Content-Disposition, sinon le
// dernier segment de l'adresse finale, ramené aux caractères permis.
function nomDepuis(r) {
  const cd = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(r.entetes['content-disposition'] || ''))?.[1];
  let brut = cd || new URL(r.url).pathname.split('/').pop() || '';
  try { brut = decodeURIComponent(brut); } catch { /* nom déjà en clair */ }
  const nom = brut.replace(/[^A-Za-z0-9._+-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 200);
  return FICHIER_ISO.test(nom) ? nom : '';
}
