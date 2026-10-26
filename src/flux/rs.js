// Reed-Solomon sur GF(2^8) (polynôme 0x11D), matrice de Cauchy de nanors :
// celle avec laquelle Sunshine calcule les paquets de parité de la vidéo.
// Ligne j de parité, colonne i de données : 1 / ((p + i) xor j), p le nombre
// de paquets de parité. Le décodage retrouve les paquets de données perdus à
// partir d'autant de paquets de parité reçus.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const inv = a => { if (!a) throw new Error('GF(256) : inverse de zéro'); return EXP[255 - LOG[a]]; };
// Table de multiplication par ligne, pour les boucles sur les octets.
const TABLES = new Map();
function tableDe(u) {
  let t = TABLES.get(u);
  if (!t) { t = new Uint8Array(256); for (let x = 0; x < 256; x++) t[x] = mul(u, x); TABLES.set(u, t); }
  return t;
}
// a ^= u * b, octet par octet.
function axpy(a, b, u, n) {
  if (!u) return;
  if (u === 1) { for (let k = 0; k < n; k++) a[k] ^= b[k]; return; }
  const t = tableDe(u);
  for (let k = 0; k < n; k++) a[k] ^= t[b[k]];
}

export const DONNEES_MAX = 255;
export const coefficient = (p, j, i) => inv(((p + i) ^ j) & 0xff);

// Parité (pour les essais) : parite[j] = somme des donnees[i] * P[j][i].
export function encoder(donnees, nbParite, taille) {
  const d = donnees.length;
  return Array.from({ length: nbParite }, (_, j) => {
    const sortie = new Uint8Array(taille);
    for (let i = 0; i < d; i++) axpy(sortie, donnees[i], coefficient(nbParite, j, i), taille);
    return sortie;
  });
}

// paquets : tableau de d + p entrées (Uint8Array de « taille » octets, ou null
// si perdu). Remplit les données manquantes en place ; faux si la parité reçue
// ne suffit pas.
export function decoder(paquets, d, p, taille) {
  if (d <= 0 || p < 0 || d + p > DONNEES_MAX || paquets.length < d + p) return false;
  const manquants = [];
  for (let i = 0; i < d; i++) if (!paquets[i]) manquants.push(i);
  if (!manquants.length) return true;
  const lignes = [];
  for (let j = 0; j < p && lignes.length < manquants.length; j++) if (paquets[d + j]) lignes.push(j);
  if (lignes.length < manquants.length) return false;
  const k = manquants.length;
  // Seconds membres : parité reçue moins la contribution des données reçues.
  const second = lignes.map(j => {
    const s = Uint8Array.from(paquets[d + j].subarray(0, taille));
    for (let i = 0; i < d; i++) if (paquets[i]) axpy(s, paquets[i], coefficient(p, j, i), taille);
    return s;
  });
  // Matrice k × k des coefficients des inconnues, inversée par Gauss-Jordan.
  const m = lignes.map(j => manquants.map(i => coefficient(p, j, i)));
  const id = Array.from({ length: k }, (_, r) => Array.from({ length: k }, (_, c) => (r === c ? 1 : 0)));
  for (let c = 0; c < k; c++) {
    let pivot = c;
    while (pivot < k && !m[pivot][c]) pivot++;
    if (pivot === k) return false;
    [m[c], m[pivot]] = [m[pivot], m[c]]; [id[c], id[pivot]] = [id[pivot], id[c]];
    const f = inv(m[c][c]);
    for (let x = 0; x < k; x++) { m[c][x] = mul(m[c][x], f); id[c][x] = mul(id[c][x], f); }
    for (let r = 0; r < k; r++) {
      if (r === c || !m[r][c]) continue;
      const g = m[r][c];
      for (let x = 0; x < k; x++) { m[r][x] ^= mul(g, m[c][x]); id[r][x] ^= mul(g, id[c][x]); }
    }
  }
  for (let c = 0; c < k; c++) {
    const sortie = new Uint8Array(taille);
    for (let r = 0; r < k; r++) axpy(sortie, second[r], id[c][r], taille);
    paquets[manquants[c]] = sortie;
  }
  return true;
}
