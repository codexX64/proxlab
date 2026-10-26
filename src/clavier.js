// La disposition du clavier d'une VM, demandée à la VM elle-même par l'agent
// QEMU (qemu-guest-agent) : l'écran tape alors chaque caractère sur la bonne
// touche, sans que personne ait à choisir AZERTY ou QWERTY.
//
// Un seul script, fixe, lu sur l'entrée standard de `sh` : rien de ce que
// demande le navigateur n'entre dans la commande. Il lit les sources de saisie
// de la session ouverte (la disposition réellement utilisée : GNOME, puis
// KDE Plasma, Hyprland, Sway ou Xfce par leur réglage et la session qui
// tourne), sinon la disposition du système (localectl), sinon ses fichiers
// (xorg.conf.d, vconsole.conf, /etc/default/keyboard).

export const SCRIPT_CLAVIER = `actif() { command -v pgrep >/dev/null 2>&1 || return 0; pgrep -u "$1" -x "$2" >/dev/null 2>&1; }
dire() { [ -n "$1" ] || return 0; echo "session $1"; [ -n "$2" ] && echo "variante $2"; exit 0; }
for d in /run/user/*; do
  [ -S "$d/bus" ] || continue
  u=$(stat -c %U "$d" 2>/dev/null) || continue
  [ "$u" = root ] && continue
  for k in mru-sources sources; do
    v=$(runuser -u "$u" -- env DBUS_SESSION_BUS_ADDRESS="unix:path=$d/bus" gsettings get org.gnome.desktop.input-sources "$k" 2>/dev/null)
    case "$v" in *xkb*) echo "gnome $v"; exit 0;; esac
  done
  h=$(getent passwd "$u" | cut -d: -f6)
  [ -n "$h" ] || continue
  f="$h/.config/kxkbrc"
  if grep -qs '^Use=true' "$f" && actif "$u" 'plasmashell|kwin_wayland|kwin_x11'; then
    i=$(runuser -u "$u" -- env DBUS_SESSION_BUS_ADDRESS="unix:path=$d/bus" gdbus call --session --dest org.kde.keyboard --object-path /Layouts --method org.kde.KeyboardLayouts.getLayout 2>/dev/null | sed -n 's/.*uint32 \\([0-9]\\{1,2\\}\\).*/\\1/p')
    n=$(( \${i:-0} + 1 ))
    l=$(sed -n 's/^LayoutList=//p' "$f" | head -n 1)
    v=$(sed -n 's/^VariantList=//p' "$f" | head -n 1)
    k=$(echo "$l" | cut -d, -f$n); [ -n "$k" ] || { n=1; k=$(echo "$l" | cut -d, -f1); }
    dire "$k" "$(echo "$v" | cut -d, -f$n)"
  fi
  f="$h/.config/hypr/hyprland.conf"
  if [ -r "$f" ] && actif "$u" 'Hyprland'; then
    dire "$(sed -n 's/^[[:space:]]*kb_layout[[:space:]]*=[[:space:]]*\\([A-Za-z0-9_-]*\\).*/\\1/p' "$f" | head -n 1)" "$(sed -n 's/^[[:space:]]*kb_variant[[:space:]]*=[[:space:]]*\\([A-Za-z0-9_-]*\\).*/\\1/p' "$f" | head -n 1)"
  fi
  f="$h/.config/sway/config"
  if [ -r "$f" ] && actif "$u" 'sway'; then
    dire "$(sed -n 's/.*xkb_layout[[:space:]]\\{1,\\}"\\{0,1\\}\\([A-Za-z0-9_-]*\\).*/\\1/p' "$f" | head -n 1)" "$(sed -n 's/.*xkb_variant[[:space:]]\\{1,\\}"\\{0,1\\}\\([A-Za-z0-9_-]*\\).*/\\1/p' "$f" | head -n 1)"
  fi
  f="$h/.config/xfce4/xfconf/xfce-perchannel-xml/keyboard-layout.xml"
  if grep -qs 'name="XkbDisable" type="bool" value="false"' "$f" && actif "$u" 'xfsettingsd|xfce4-session'; then
    dire "$(sed -n 's/.*name="XkbLayout"[^>]*value="\\([A-Za-z0-9_-]*\\).*/\\1/p' "$f" | head -n 1)" "$(sed -n 's/.*name="XkbVariant"[^>]*value="\\([A-Za-z0-9_-]*\\).*/\\1/p' "$f" | head -n 1)"
  fi
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
  if (/^fr(-latin[019]|-pc|-oss|-azerty)?$/.test(s)) return 'fr';
  return null;
}

// Sortie du script → { brut, source } ; brut est la première disposition trouvée.
export function lireSortie(sortie) {
  const t = String(sortie || '');
  const g = /^gnome .*?\('xkb', '([^']{1,64})'\)/m.exec(t);
  if (g) return { brut: g[1], source: 'gnome' };
  const s = /^session ([^\s,]{1,64})/m.exec(t);
  if (s) {
    const v = /^variante ([^\s,]{1,64})/m.exec(t);
    return { brut: v ? `${s[1]}+${v[1]}` : s[1], source: 'session' };
  }
  const x = /^x11 ([^\s,]{1,64})/m.exec(t);
  if (x) {
    const v = /^variante ([^\s,]{1,64})/m.exec(t);
    return { brut: v ? `${x[1]}+${v[1]}` : x[1], source: 'système' };
  }
  const c = /^vc (\S{1,64})/m.exec(t);
  if (c) return { brut: c[1], source: 'console' };
  return { brut: '', source: '' };
}

// L'agent est-il coché dans la VM ? « 1 », « enabled=1,fstrim_cloned_disks=1 »…
export const agentActif = v => /^(1|enabled=1)(,|$)/.test(String(v || ''));

const pause = ms => new Promise(r => setTimeout(r, ms));

// Un script fixe passé à `sh` par l'agent QEMU, puis son état attendu.
// Rend { st } (exited, exitcode, out-data, err-data) ou { raison, message }.
async function executer(proxmox, base, script, { essais, attente, quoi }) {
  const config = await proxmox.get(base + '/config', { current: 1 });
  if (!agentActif(config?.agent)) return { raison: 'agent', message: 'L\'agent QEMU n\'est pas activé dans cette VM.' };
  let pid;
  try {
    ({ pid } = await proxmox.post(base + '/agent/exec', { command: 'sh', 'input-data': script }) || {});
  } catch (e) {
    if (/permission check failed/i.test(e.message)) return { raison: 'droit', message: `Le compte de ProxLab dans Proxmox n'a pas le droit d'utiliser l'agent (VM.GuestAgent.Unrestricted sur Proxmox VE 9, VM.Monitor sur la 8) : ${quoi}.` };
    return { raison: 'injoignable', message: `L'agent QEMU ne répond pas dans la VM (qemu-guest-agent installé et démarré ?) : ${String(e.message).slice(0, 160)}` };
  }
  if (!Number.isInteger(Number(pid))) return { raison: 'injoignable', message: 'L\'agent QEMU n\'a pas lancé la commande.' };
  for (let i = 0; i < essais; i++) {
    await pause(attente);
    const st = await proxmox.get(base + '/agent/exec-status', { pid }).catch(() => null);
    if (st?.exited) return { st };
  }
  return { raison: 'delai', message: 'La VM a mis trop de temps à répondre.' };
}

// Interroge la VM ; rend { disposition, brut, source } ou { disposition: null, raison }.
export async function detecterClavier(proxmox, base, { essais = 12, attente = 250 } = {}) {
  const r = await executer(proxmox, base, SCRIPT_CLAVIER, { essais, attente, quoi: 'choisis la disposition à la main' });
  if (!r.st) return { disposition: null, raison: r.raison, message: r.message };
  {
    const st = r.st;
    const { brut, source } = lireSortie(st['out-data']);
    const disposition = dispositionDe(brut);
    if (disposition) return { disposition, brut, source };
    if (brut) return { disposition: null, brut, source, raison: 'inconnue', message: `Disposition « ${brut} » : pas encore prise en charge, choisis-en une à la main.` };
    const err = String(st['err-data'] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { disposition: null, raison: 'vide', message: `La VM n'a pas dit sa disposition (code ${st.exitcode ?? '?'}${err ? ` : ${err}` : ''}). Choisis-la à la main.` };
  }
}

// La connexion sur le port série, dans l'invité : un service systemd, activé
// et démarré par une commande fixe. Rien de ce que demande le navigateur
// n'entre dans la commande.
export const SCRIPT_CONSOLE_SERIE = 'systemctl enable --now serial-getty@ttyS0.service\n';
export async function activerConsoleSerie(proxmox, base, { essais = 40, attente = 250 } = {}) {
  const r = await executer(proxmox, base, SCRIPT_CONSOLE_SERIE, { essais, attente, quoi: 'tape la commande dans la VM, depuis l\'onglet Écran' });
  if (!r.st) return { ok: false, raison: r.raison, message: r.message };
  if (Number(r.st.exitcode) !== 0) {
    const err = String(r.st['err-data'] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { ok: false, raison: 'echec', message: `systemctl a échoué dans la VM (code ${r.st.exitcode ?? '?'}${err ? ` : ${err}` : ''}).` };
  }
  return { ok: true };
}
