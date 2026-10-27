#!/usr/bin/env bash
# Refuses a host that cannot run the full N2/N3 lab without saturating (measured: 3 kind nodes + Cilium idle already
# load an 8-vCPU VM shared with other stacks to 22-29). Checks only; installs nothing.
#   bash e2e/kind/n2/external/host-check.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../versions.env
source "$here/../versions.env"
MIN_CPUS="${MIN_CPUS:-8}" MIN_MEM_GIB="${MIN_MEM_GIB:-16}" MIN_DISK_GIB="${MIN_DISK_GIB:-80}"
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }
ok() { echo "ok: $*"; }

[[ "$(uname -s)" == Linux ]] || { bad "a Linux host is required (the kind nodes must not share a desktop VM): $(uname -s)"; exit 1; }
cpus="$(nproc)"; (( cpus >= MIN_CPUS )) && ok "$cpus vCPU" || bad "$cpus vCPU < $MIN_CPUS"
mem="$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)"; (( mem >= MIN_MEM_GIB - 1 )) && ok "${mem} GiB RAM" || bad "${mem} GiB RAM < $MIN_MEM_GIB"
docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
disk="$(df -BG --output=avail "$docker_root" 2>/dev/null | tail -1 | tr -dc 0-9)"; (( ${disk:-0} >= MIN_DISK_GIB )) && ok "${disk} GiB free under $docker_root" || bad "${disk:-?} GiB free under $docker_root < $MIN_DISK_GIB"
kernel="$(uname -r)"; IFS=.- read -r kmaj kmin _ <<<"$kernel"
(( kmaj > 5 || (kmaj == 5 && kmin >= 10) )) && ok "kernel $kernel (Cilium $CILIUM_VERSION needs >= 5.10)" || bad "kernel $kernel < 5.10"
[[ "$(stat -fc %T /sys/fs/cgroup)" == cgroup2fs ]] && ok "cgroup v2" || bad "cgroup v2 is required"
for f in fs.inotify.max_user_instances:512 fs.inotify.max_user_watches:524288; do
  key="${f%%:*}" want="${f##*:}" have="$(sysctl -n "$key")"
  (( have >= want )) && ok "$key=$have" || bad "$key=$have < $want (kind with 3 nodes needs it)"
done
docker info >/dev/null 2>&1 && ok "docker $(docker version -f '{{.Server.Version}}')" || bad "docker daemon unreachable"
running="$(docker ps -q | wc -l)"; (( running == 0 )) && ok "no other container running" || echo "warn: $running containers already running; the lab budgets assume a dedicated host" >&2
have_kind="$(kind version 2>/dev/null | awk '{print $2}')"; [[ "$have_kind" == "$KIND_VERSION" ]] && ok "kind $have_kind" || bad "kind ${have_kind:-missing}, pinned $KIND_VERSION (checksums in versions.env)"
kc="$(kubectl version --client -o json 2>/dev/null | awk -F'"' '/gitVersion/ {print $4; exit}')"
[[ "$kc" =~ ^v1\.(35|36|37)\. ]] && ok "kubectl $kc (skew vs $KUBERNETES_VERSION)" || bad "kubectl ${kc:-missing}: needs v1.35-v1.37 against $KUBERNETES_VERSION"
hv="$(helm version --template '{{.Version}}' 2>/dev/null || true)"; [[ "$hv" =~ ^v3\. || "$hv" =~ ^v4\. ]] && ok "helm $hv" || bad "helm ${hv:-missing}"
nv="$(node --version 2>/dev/null || true)"; [[ "$nv" =~ ^v2[4-9]\. ]] && ok "node $nv" || bad "node ${nv:-missing} (>= 24 required)"
exit "$fail"
