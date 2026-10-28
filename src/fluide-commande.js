// La connexion en une commande : un script bash, à coller dans un terminal root
// du nœud (ou du poste, précédé de « ssh … 'bash -s' »). Il relaie Sunshine par
// le nœud, ne laissant entrer que ProxLab, règle Sunshine dans la VM par l'agent
// QEMU, lui fait reconnaître le certificat de ProxLab, puis écrit l'empreinte du
// certificat de Sunshine dans les notes de la VM, où ProxLab la lit par l'API de
// Proxmox (canal déjà authentifié) et l'efface.
//
// Chaque valeur insérée est vérifiée ici, au format strict : le script ne
// contient rien que l'appelant ait pu choisir librement.
import net from 'node:net';

export const PORT_BASE = 47989;
export const MARQUE = 'proxlab-fluide';
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const NOEUD = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/;
const QUI = /^[A-Za-z0-9._@!-]{1,128}$/;
const PEM = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?$/;

// La ligne que le script ajoute aux notes de la VM.
export const LIGNE = /^proxlab-fluide ([0-9a-f]{32}) (\S+) (\d{1,5}) (sha256:[0-9a-f]{64})$/;
export function lireMarque(description, nonce) {
  for (const l of String(description || '').split('\n')) {
    const m = LIGNE.exec(l.trim());
    if (m && m[1] === nonce && IPV4.test(m[2]) && Number(m[3]) > 5 && Number(m[3]) < 65000) return { hote: m[2], port: Number(m[3]), empreinte: m[4] };
  }
  return null;
}
export const sansMarque = description => String(description || '').split('\n').filter(l => !l.trim().startsWith(`${MARQUE} `)).join('\n').replace(/\n+$/, '');

export function scriptConnexion({ vmid, noeud, adresseVm, nonce, qui, certClient }) {
  if (!/^\d{3,9}$/.test(String(vmid))) throw new Error('vmid');
  if (!NOEUD.test(noeud)) throw new Error('noeud');
  if (!IPV4.test(adresseVm) || net.isIP(adresseVm) !== 4) throw new Error('adresse');
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('nonce');
  if (!QUI.test(qui)) throw new Error('identité');
  const cert = String(certClient).replace(/\r/g, '');
  if (!PEM.test(cert)) throw new Error('certificat');
  return `# ProxLab · écran fluide de la VM ${vmid} : relais sur ce nœud, Sunshine réglé, ProxLab reconnu.
set -uo pipefail
VMID=${vmid}; NOEUD=${noeud}; VMIP=${adresseVm}; NONCE=${nonce}; QUI='${qui}'; BASE0=${PORT_BASE}
read -r -d '' CERT <<'PEM' || true
${cert.trim()}
PEM
dit(){ printf 'ProxLab · %s\\n' "$*"; }
stop(){ printf 'ProxLab · arrêt : %s\\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || stop "à lancer en root sur le nœud \${NOEUD}"
command -v qm >/dev/null || stop "ce n'est pas un nœud Proxmox"
[ "$(hostname)" = "\${NOEUD}" ] || stop "à lancer sur le nœud \${NOEUD} (ici : $(hostname))"
qm status \${VMID} 2>/dev/null | grep -q running || stop "la VM \${VMID} n'est pas démarrée"
command -v python3 >/dev/null || stop "python3 manque sur le nœud"
# Dans la VM, par l'agent QEMU : sortie standard rendue, code de sortie gardé.
g(){ qm guest exec \${VMID} --timeout 90 "$@" | python3 -c 'import json,sys
d=json.load(sys.stdin); sys.stdout.write(d.get("out-data","")); sys.stderr.write(d.get("err-data","")); sys.exit(d.get("exitcode",0))'; }

# 1. ProxLab vu d'ici : la dernière adresse qui a parlé à l'API sous son identité.
SRC=$(grep -hF " \${QUI} " /var/log/pveproxy/access.log 2>/dev/null | tail -1 | awk '{print $1}' | sed 's/^::ffff://')
[[ "\${SRC}" =~ ^[0-9]{1,3}(\\.[0-9]{1,3}){3}$ ]] || stop "ProxLab n'apparaît pas dans le journal de l'API de ce nœud : garde ProxLab ouvert et relance"
ICI=$(ip -4 route get "\${SRC}" | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p' | head -1)
ip -4 route get "\${VMIP}" | grep -q ' via ' && stop "\${VMIP} n'est pas sur un pont de ce nœud"
LIEN=$(ip -4 route get "\${VMIP}" | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p' | head -1)
[ -n "\${ICI}" ] && [ -n "\${LIEN}" ] || stop "routes introuvables vers ProxLab ou vers la VM"
dit "ProxLab : \${SRC} · nœud : \${ICI} · VM : \${VMIP} (lien \${LIEN})"

# 2. Les relais déjà posés vers cette VM sont remplacés ; base de ports libre.
for u in /etc/systemd/system/*.service; do
  [ -f "\${u}" ] || continue
  case "$(basename "\${u}")" in "proxlab-fluide-\${VMID}-"*) ;; *) grep -q "^ExecStart=.*socat.*:\${VMIP}:[0-9]" "\${u}" || continue ;; esac
  systemctl disable --now "$(basename "\${u}")" >/dev/null 2>&1; rm -f "\${u}"
done
systemctl daemon-reload
occupe(){ ss -Hlntu "( sport = :$1 )" 2>/dev/null | grep -q .; }
BASE=""
for i in $(seq 0 40); do
  b=$((BASE0 + 100 * i)); libre=1
  for p in $((b-5)) $b $((b+21)) $((b+9)) $((b+10)) $((b+11)); do occupe $p && libre=0; done
  [ $libre = 1 ] && { BASE=$b; break; }
done
[ -n "\${BASE}" ] || stop "aucune base de ports libre sur ce nœud"
TCP="$((BASE-5)) \${BASE} $((BASE+21))"; UDP="$((BASE+9)) $((BASE+10)) $((BASE+11))"

# 3. Dans la VM : l'utilisateur de la session graphique, Sunshine.
read -r -d '' QUI_VM <<'S' || true
U=""
for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
  i=$(loginctl show-session "$s" -p Name -p Type -p State 2>/dev/null)
  case "$i" in *Type=wayland*State=active*|*Type=x11*State=active*|*State=active*Type=wayland*|*State=active*Type=x11*) U=$(printf '%s\\n' "$i" | sed -n 's/^Name=//p'); break ;; esac
done
[ -n "$U" ] || U=$(getent passwd 1000 | cut -d: -f1)
command -v sunshine >/dev/null || { echo "SANS_SUNSHINE"; exit 0; }
echo "$U"
S
U=$(g -- bash -c "\${QUI_VM}") || stop "l'agent QEMU ne répond pas dans la VM \${VMID}"
[ "\${U}" = SANS_SUNSHINE ] && stop "Sunshine n'est pas installé dans la VM (Arch : paquet AUR « sunshine » ; Debian, Ubuntu, Fedora : paquet de github.com/LizardByte/Sunshine), puis relance"
[[ "\${U}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || stop "utilisateur de la session introuvable dans la VM"

# 4. Sunshine arrêté, réglé ; pare-feu de la VM ; mDNS coupé.
read -r -d '' REGLER <<'S' || true
H=$(getent passwd "$U" | cut -d: -f6); R=/run/user/$(id -u "$U"); C="$H/.config/sunshine"; F="$C/sunshine.conf"
us(){ runuser -u "$U" -- env XDG_RUNTIME_DIR="$R" DBUS_SESSION_BUS_ADDRESS="unix:path=$R/bus" systemctl --user "$@"; }
UNITE=app-dev.lizardbyte.app.Sunshine; us cat "$UNITE" >/dev/null 2>&1 || UNITE=sunshine
us stop "$UNITE" >/dev/null 2>&1; pkill -u "$U" -x sunshine 2>/dev/null; sleep 1
mkdir -p "$C"; touch "$F"
kv(){ sed -i "/^[[:space:]]*$1[[:space:]]*=/d" "$F"; echo "$1 = $2" >> "$F"; }
kv lan_encryption_mode 2; kv wan_encryption_mode 2; kv upnp disabled; kv address_family ipv4
kv port "$BASE"; kv bind_address "$VMIP"; kv origin_web_ui_allowed lan
chown -R "$U": "$C"; chmod 600 "$F"
systemctl mask --now avahi-daemon.service avahi-daemon.socket >/dev/null 2>&1
IF=$(ip -o -4 addr show | awk -v a="$VMIP" '{split($4, p, "/"); if (p[1] == a) print $2}' | head -1)
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw status numbered | sed -n 's/^\\[ *\\([0-9]*\\)\\].*# proxlab-fluide$/\\1/p' | sort -rn | while read -r n; do yes | ufw delete "$n" >/dev/null; done
  ufw allow in on "$IF" from "$LIEN" to any port "$((BASE-5)),$BASE,$((BASE+21))" proto tcp comment proxlab-fluide >/dev/null
  ufw allow in on "$IF" from "$LIEN" to any port "$((BASE+9)):$((BASE+11))" proto udp comment proxlab-fluide >/dev/null
  echo "pare-feu de la VM : ufw, ports ouverts sur $IF depuis $LIEN seulement" >&2
elif systemctl is-active -q firewalld 2>/dev/null || systemctl is-active -q nftables 2>/dev/null; then
  echo "pare-feu de la VM non modifié : ouvrir TCP $((BASE-5)), $BASE, $((BASE+21)) et UDP $((BASE+9))-$((BASE+11)) depuis $LIEN sur $IF" >&2
fi
cat "$C/sunshine_state.json" 2>/dev/null || echo '{}'
S
ETAT=$(g -- bash -c "U=\${U}; BASE=\${BASE}; VMIP=\${VMIP}; LIEN=\${LIEN}; \${REGLER}") || stop "réglage de Sunshine dans la VM impossible"

# 5. ProxLab reconnu par Sunshine : son certificat parmi les appareils appairés.
NOUVEL=$(printf '%s' "\${ETAT}" | CERT="\${CERT}" python3 -c 'import json,os,sys,uuid
try: d=json.loads(sys.stdin.read() or "{}")
except Exception: d={}
if not isinstance(d,dict): d={}
r=d.setdefault("root",{}); r.setdefault("uniqueid",str(uuid.uuid4()).upper()); l=r.get("named_devices") or []
c=os.environ["CERT"].strip()+"\\n"
l=[x for x in l if isinstance(x,dict) and x.get("cert","").strip()!=c.strip()]
l.append({"name":"ProxLab","cert":c,"uuid":str(uuid.uuid4()).upper(),"enabled":"true"})
r["named_devices"]=l; print(json.dumps(d,indent=4))') || stop "état de Sunshine illisible"
read -r -d '' ECRIRE <<'S' || true
C=$(getent passwd "$U" | cut -d: -f6)/.config/sunshine
cat > "$C/sunshine_state.json.proxlab" && chown "$U": "$C/sunshine_state.json.proxlab" && chmod 600 "$C/sunshine_state.json.proxlab" && mv "$C/sunshine_state.json.proxlab" "$C/sunshine_state.json"
S
printf '%s' "\${NOUVEL}" | g --pass-stdin 1 -- bash -c "U=\${U}; \${ECRIRE}" || stop "écriture de l'état de Sunshine impossible"

# 6. Sunshine relancé avec la session ; son certificat lu.
read -r -d '' LANCER <<'S' || true
H=$(getent passwd "$U" | cut -d: -f6); R=/run/user/$(id -u "$U"); C="$H/.config/sunshine"
us(){ runuser -u "$U" -- env XDG_RUNTIME_DIR="$R" DBUS_SESSION_BUS_ADDRESS="unix:path=$R/bus" systemctl --user "$@"; }
UNITE=app-dev.lizardbyte.app.Sunshine; us cat "$UNITE" >/dev/null 2>&1 || UNITE=sunshine
us enable "$UNITE" >/dev/null 2>&1; us restart "$UNITE" >/dev/null 2>&1
for _ in $(seq 1 20); do [ -s "$C/credentials/cacert.pem" ] && ss -Hlnt "( sport = :$BASE )" | grep -q . && break; sleep 1; done
cat "$C/credentials/cacert.pem"
S
PEMS=$(g -- bash -c "U=\${U}; BASE=\${BASE}; \${LANCER}") || stop "Sunshine ne démarre pas dans la VM (journal : ~/.config/sunshine/sunshine.log)"
FP=$(printf '%s\\n' "\${PEMS}" | openssl x509 -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
[[ "\${FP}" =~ ^[0-9a-f]{64}$ ]] || stop "certificat de Sunshine illisible"

# 7. Le relais : ce nœud, ports de la VM, ProxLab seul admis.
for p in \${TCP} \${UDP}; do
  case " \${TCP} " in *" \${p} "*) t=TCP4; d=600; n=tcp ;; *) t=UDP4; d=60; n=udp ;; esac
  cat > /etc/systemd/system/proxlab-fluide-\${VMID}-\${n}-\${p}.service <<UNIT
[Unit]
Description=ProxLab, ecran fluide de la VM \${VMID} (\${n}/\${p})
After=network-online.target
[Service]
ExecStart=/usr/bin/socat -T \${d} \${t}-LISTEN:\${p},bind=\${ICI},fork,reuseaddr,range=\${SRC}/32 \${t}:\${VMIP}:\${p}
Restart=always
DynamicUser=yes
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
UNIT
done
command -v socat >/dev/null || { apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq socat >/dev/null 2>&1; } || true
command -v socat >/dev/null || stop "socat manque et n'a pas pu être installé"
systemctl daemon-reload
for p in \${TCP} \${UDP}; do case " \${TCP} " in *" \${p} "*) n=tcp ;; *) n=udp ;; esac; systemctl enable --now proxlab-fluide-\${VMID}-\${n}-\${p}.service >/dev/null 2>&1; done
pve-firewall status 2>/dev/null | grep -q 'enabled' && dit "le pare-feu de Proxmox est actif sur ce nœud : ouvrir TCP \${TCP} et UDP \${UDP} depuis \${SRC}"
curl -s -m 5 -o /dev/null "http://\${VMIP}:\${BASE}/serverinfo" || stop "Sunshine ne répond pas sur \${VMIP}:\${BASE}"

# 8. L'empreinte, transmise à ProxLab par les notes de la VM.
DESC=$(pvesh get /nodes/\${NOEUD}/qemu/\${VMID}/config --output-format json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("description",""), end="")')
NOTE=$(printf '%s' "\${DESC}" | python3 -c 'import sys
l=[x for x in sys.stdin.read().split("\\n") if not x.strip().startswith("proxlab-fluide ")]
while l and not l[-1].strip(): l.pop()
print("\\n".join(l + ["proxlab-fluide '"\${NONCE} \${ICI} \${BASE} sha256:\${FP}"'"]), end="")')
qm set \${VMID} --description "\${NOTE}" >/dev/null || stop "notes de la VM non modifiables"
dit "terminé : la VM \${VMID} est reliée par \${ICI}:\${BASE}. ProxLab finit tout seul."
`;
}
