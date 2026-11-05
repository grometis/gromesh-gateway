#!/usr/bin/env bash
# Future authorized-host step only. It keeps J7 runtime/transport/publication gates inactive.
set -euo pipefail
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || exit 78
python3 /usr/local/lib/gromesh-j8/bootstrap.py --validate-only
role="$(python3 -c 'import json;print(json.load(open("/etc/gromesh-j8/context.json"))["role"])')"
install -d -m0755 /opt/gromesh/tools/bin /usr/local/lib/docker/cli-plugins
link_exact() {
  local target="$1" source="$2"
  [[ -f "$source" ]] || exit 78
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -L "$target" && "$(readlink "$target")" == "$source" ]] || exit 78
  else
    ln -s "$source" "$target"
  fi
}
link_exact /opt/gromesh/tools/bin/node /opt/gromesh/tools/node/bin/node
link_exact /usr/local/bin/node /opt/gromesh/tools/node/bin/node
if ! id gromesh-executor >/dev/null 2>&1; then
  [[ -d /opt/executor ]] || exit 78
  useradd --uid 1100 --user-group --home-dir /opt/executor/home --create-home --shell /bin/bash gromesh-executor
else
  [[ "$(id -u gromesh-executor)" == 1100 && "$(getent passwd gromesh-executor | cut -d: -f6)" == /opt/executor/home ]] || exit 78
fi
[[ "$(id -nG gromesh-executor)" == gromesh-executor ]] || exit 78
# Bind every writable temporary directory into the XFS project before enabling executor work.
python3 - <<'PYHOST'
import importlib.util,json
spec=importlib.util.spec_from_file_location('bootstrap','/usr/local/lib/gromesh-j8/bootstrap.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.prepare_executor_mounts(json.load(open('/etc/gromesh-j8/context.json')))
PYHOST
install -d -o 1100 -g 1100 -m0700 /opt/executor/home/.cache /opt/executor/home/workspaces /opt/executor/home/.local/share
# Public executor key is root-controlled and separate from the admin key. No private key is installed.
python3 - <<'PY'
import json,re,os
from pathlib import Path
p=Path('/etc/gromesh-j8/authorization.json');a=json.loads(p.read_text());key=a.get('agentSshPublicKey','')
assert re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [A-Za-z0-9._@-]+)?',key)
root=Path('/etc/ssh/authorized_keys');root.mkdir(mode=0o755,exist_ok=True);target=root/'gromesh-executor'
if target.exists():assert target.read_text()==key+'\n' and not target.is_symlink()
else:target.write_text(key+'\n');target.chmod(0o644)
conf=Path('/etc/ssh/sshd_config.d/00-gromesh.conf')
expected='PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers gromesh-admin gromesh-executor\nDisableForwarding yes\nPermitTunnel no\nMatch User gromesh-executor\n AuthorizedKeysFile /etc/ssh/authorized_keys/%u\n AuthenticationMethods publickey\n'
conf.write_text(expected);conf.chmod(0o644)
PY
/usr/sbin/sshd -t
systemctl reload ssh.service
if [[ "$role" != coordinator ]]; then
  link_exact /opt/gromesh/tools/bin/go /opt/gromesh/tools/go/bin/go
  link_exact /opt/gromesh/tools/bin/helm /opt/gromesh/tools/helm/helm
  link_exact /opt/gromesh/tools/bin/kind /opt/gromesh/tools/kind/binary
  link_exact /opt/gromesh/tools/bin/kubectl /opt/gromesh/tools/kubectl/binary
  link_exact /opt/gromesh/tools/bin/syft /opt/gromesh/tools/syft/syft
  link_exact /opt/gromesh/tools/bin/trivy /opt/gromesh/tools/trivy/trivy
  link_exact /usr/local/lib/docker/cli-plugins/docker-buildx /opt/gromesh/tools/buildx/binary
  link_exact /usr/local/lib/docker/cli-plugins/docker-compose /opt/gromesh/tools/compose/binary
  pnpm_shim='#!/bin/sh
exec /opt/gromesh/tools/node/bin/node /opt/gromesh/tools/pnpm/bin/pnpm.cjs "$@"
'
  if [[ -e /opt/gromesh/tools/bin/pnpm ]]; then
    [[ "$(cat /opt/gromesh/tools/bin/pnpm)" == "${pnpm_shim%$'\n'}" ]] || exit 78
  else
    printf '%s' "$pnpm_shim" > /opt/gromesh/tools/bin/pnpm
    chmod 0555 /opt/gromesh/tools/bin/pnpm
  fi
  [[ "$(/opt/gromesh/tools/bin/pnpm --version)" == 10.28.0 ]] || exit 78
  [[ "$(/opt/gromesh/tools/node/bin/node --version)" == v26.13.0 ]] || exit 78
  loginctl enable-linger gromesh-executor
  systemctl start user@1100.service
  userenv=(runuser -u gromesh-executor -- env XDG_RUNTIME_DIR=/run/user/1100 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1100/bus PATH=/opt/gromesh/tools/node/bin:/opt/gromesh/tools/bin:/usr/local/bin:/usr/bin:/bin)
  if ! "${userenv[@]}" systemctl --user is-enabled docker.service >/dev/null 2>&1; then
    "${userenv[@]}" dockerd-rootless-setuptool.sh install
  fi
  "${userenv[@]}" systemctl --user start docker.service
  python3 - <<'PY'
from pathlib import Path
p=Path('/opt/executor/home/.config/systemd/user');p.mkdir(parents=True,exist_ok=True)
unit=p/'gromesh-buildkit.service'
text='[Unit]\nAfter=docker.service\n[Service]\nEnvironment=PATH=/opt/gromesh/tools/buildkit/bin:/usr/bin:/bin\nExecStart=/usr/bin/rootlesskit --net=slirp4netns --copy-up=/etc --disable-host-loopback /opt/gromesh/tools/buildkit/bin/buildkitd --addr unix:///run/user/1100/buildkit/buildkitd.sock --root /opt/executor/home/.local/share/buildkit --oci-worker-snapshotter=fuse-overlayfs\nRestart=no\nDelegate=yes\n[Install]\nWantedBy=default.target\n'
if unit.exists():assert unit.read_text()==text
else:unit.write_text(text);unit.chmod(0o644)
# The unit runs only as the executor; trust changes require a new host/disk generation.
PY
  "${userenv[@]}" systemctl --user daemon-reload
  "${userenv[@]}" systemctl --user enable --now gromesh-buildkit.service
fi
# Runtime bundle/profile/authorization/isolation-proof must be independently prepared and root-owned.
# The existing installer validates them and writes only inactive descriptors. No self-certification.
[[ -f /etc/gromesh-jenkins/bundle.json && -f /etc/gromesh-jenkins/profile.json && -f /etc/gromesh-jenkins/authorization.json && -f /etc/gromesh-jenkins/isolation-proof.json ]] || exit 78
/opt/gromesh/tools/node/bin/node /usr/local/lib/gromesh-j8/worker-bootstrap.mjs install /etc/gromesh-jenkins/authorization.json /etc/gromesh-jenkins/profile.json /etc/gromesh-jenkins/bundle.json
printf '%s\n' 'RUNTIME_INSTALLED_INACTIVE: qualify SSH, cgroups, quotas, reset, N2 denial and service identity before registration/CI.'
