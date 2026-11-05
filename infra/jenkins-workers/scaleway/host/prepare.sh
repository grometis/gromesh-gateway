#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || exit 78
python3 - <<'PY'
import json,socket
p=json.load(open('/etc/gromesh-j8/context.json'))
assert p['schema']=='gromesh-cloud-context/v1' and socket.gethostname()==p['hostname'] and p['hostname'].startswith('gromesh-j8-')
assert p['role'] in ['pr-amd64','pr-arm64','coordinator'] and 'n2' not in p['hostname'].lower()
PY
install -d -m0700 /etc/wireguard
if [[ ! -f /etc/wireguard/gromesh.key ]]; then
  (umask 077; wg genkey > /etc/wireguard/gromesh.key)
fi
systemctl mask docker.service docker.socket
# Persist routing/IPv6 policy across economic stop/start. No N2/private route is created.
role="$(python3 -c 'import json;print(json.load(open("/etc/gromesh-j8/context.json"))["role"])')"
forward=0
[[ "$role" != coordinator ]] || forward=1
printf 'net.ipv4.ip_forward=%s\nnet.ipv6.conf.all.disable_ipv6=1\nnet.ipv6.conf.default.disable_ipv6=1\n' "$forward" > /etc/sysctl.d/90-gromesh-j8.conf
sysctl -p /etc/sysctl.d/90-gromesh-j8.conf
systemctl daemon-reload
systemctl restart systemd-resolved systemd-journald
python3 /usr/local/lib/gromesh-j8/enroll.py --install-firewall
systemctl enable --now gromesh-enroll.service
