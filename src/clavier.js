// La disposition du clavier d'une VM, demandée à la VM elle-même par l'agent
// QEMU (qemu-guest-agent) : l'écran tape alors chaque caractère sur la bonne
// touche, sans que personne ait à choisir AZERTY ou QWERTY.
//
// Un seul script, fixe, lu sur l'entrée standard de `sh` : rien de ce que
// demande le navigateur n'entre dans la commande. Il lit les sources de saisie
// de la session GNOME ouverte (la disposition réellement utilisée), sinon la
// disposition du système (localectl), sinon ses fichiers (xorg.conf.d,
// vconsole.conf, /etc/default/keyboard) quand l'agent n'a pas accès à D-Bus.

export const SCRIPT_CLAVIER = `for d in /run/user/*; do
  [ -S "$d/bus" ] || continue
  u=$(stat -c %U "$d" 2>/dev/null) || continue
  [ "$u" = root ] && continue
  for k in mru-sources sources; do
    v=$(runuser -u "$u" -- env DBUS_SESSION_BUS_ADDRESS="unix:path=$d/bus" gsettings get org.gnome.desktop.input-sources "$k" 2>/dev/null)
    case "$v" in *xkb*) echo "gnome $v"; exit 0;; esac
  done
done
l=$(localectl status 2>/dev/null | sed -n 's/.*X11 Layout: *\\(.*\\)/x11 \\1/p;s/.*X11 Variant: *\\(.*\\)/variante \\1/p;s/.*VC Keymap: *\\(.*\\)/vc \\1/p')
[ -n "$l" ] && { echo "$l"; exit 0; }
f=/etc/X11/xorg.conf.d/00-keyboard.conf
k=$(sed -n 's/.*"XkbLayout" *"\\([^"]*\\)".*/\\1/p' $f 2>/dev/null | head -n 1)
v=$(sed -n 's/.*"XkbVariant" *"\\([^"]*\\)".*/\\1/p' $f 2>/dev/null | head -n 1)
[ -n "$k" ] && { echo "x11 $k"; [ -n "$v" ] && echo "variante $v"; exit 0; }
k=$(sed -n 's/^KEYMAP="*\\([^"]*\\)"*.*/\\1/p' /etc/vconsole.conf /etc/default/keyboard 2>/dev/null | head -n 1)
[ -n "$k" ] && { echo "vc $k"; exit 0; }
k=$(sed -n 's/^XKBLAYOUT="*\\([^"]*\\)"*.*/\\1/p' /etc/default/keyboard 2>/dev/null | head -n 1)
[ -n "$k" ] && echo "x11 $k"
`;

const SANS_TOUCHE_MORTE_FR = new Set(['', 'oss', 'latin9', 'azerty', 'nodeadkeys', 'oss_latin9', 'oss_nodeadkeys', 'latin9_nodeadkeys', 'oss_sundeadkeys', 'sundeadkeys', 'latin9_sundeadkeys']);

// « fr », « fr+oss », « us », « fr-latin9 »… → la disposition que l'écran sait
// taper, ou null (bépo, dvorak, us international à touches mortes…).
export function dispositionDe(brut) {
  const s = String(brut || '').trim().toLowerCase();
  if (!s) return null;
  const [base, variante = ''] = s.split(/[+(]/).map(x => x.replace(/\)$/, ''));
  if (base === 'fr' && SANS_TOUCHE_MORTE_FR.has(variante)) return 'fr';
  if (base === 'us' && (variante === '' || variante === 'altgr-intl')) return 'us';
  // Table de la console (VC Keymap) : fr, fr-latin1, fr-latin9, fr-pc ; us.
  if (/^fr(-latin[019]|-pc|-oss)?$/.test(s)) return 'fr';
  return null;
}

// Sortie du script → { brut, source } ; brut est la première disposition trouvée.
export function lireSortie(sortie) {
  const t = String(sortie || '');
  const g = /^gnome .*?\('xkb', '([^']+)'\)/m.exec(t);
  if (g) return { brut: g[1], source: 'gnome' };
  const x = /^x11 ([^\s,]+)/m.exec(t);
  if (x) {
    const v = /^variante ([^\s,]+)/m.exec(t);
    return { brut: v ? `${x[1]}+${v[1]}` : x[1], source: 'système' };
  }
  const c = /^vc (\S+)/m.exec(t);
  if (c) return { brut: c[1], source: 'console' };
  return { brut: '', source: '' };
}

// L'agent est-il coché dans la VM ? « 1 », « enabled=1,fstrim_cloned_disks=1 »…
export const agentActif = v => /^(1|enabled=1)(,|$)/.test(String(v || ''));

const pause = ms => new Promise(r => setTimeout(r, ms));

// Interroge la VM ; rend { disposition, brut, source } ou { disposition: null, raison }.
export async function detecterClavier(proxmox, base, { essais = 12, attente = 250 } = {}) {
  const config = await proxmox.get(base + '/config', { current: 1 });
  if (!agentActif(config?.agent)) return { disposition: null, raison: 'agent', message: 'L\'agent QEMU n\'est pas activé dans cette VM.' };
  let pid;
  try {
    ({ pid } = await proxmox.post(base + '/agent/exec', { command: 'sh', 'input-data': SCRIPT_CLAVIER }) || {});
  } catch (e) {
    return { disposition: null, raison: 'injoignable', message: `L'agent QEMU ne répond pas dans la VM (qemu-guest-agent installé et démarré ?) : ${String(e.message).slice(0, 160)}` };
  }
  if (!Number.isInteger(Number(pid))) return { disposition: null, raison: 'injoignable', message: 'L\'agent QEMU n\'a pas lancé la lecture.' };
  for (let i = 0; i < essais; i++) {
    await pause(attente);
    const st = await proxmox.get(base + '/agent/exec-status', { pid }).catch(() => null);
    if (!st?.exited) continue;
    const { brut, source } = lireSortie(st['out-data']);
    const disposition = dispositionDe(brut);
    if (disposition) return { disposition, brut, source };
    if (brut) return { disposition: null, brut, source, raison: 'inconnue', message: `Disposition « ${brut} » : pas encore prise en charge, choisis-en une à la main.` };
    const err = String(st['err-data'] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { disposition: null, raison: 'vide', message: `La VM n'a pas dit sa disposition (code ${st.exitcode ?? '?'}${err ? ` : ${err}` : ''}). Choisis-la à la main.` };
  }
  return { disposition: null, raison: 'delai', message: 'La VM a mis trop de temps à répondre.' };
}
