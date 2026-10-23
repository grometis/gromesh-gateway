#!/usr/bin/env bash
set -euo pipefail
chart=deploy/helm/control-plane
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
required=(--set-string database.existingSecret=ci-database --set-string bootstrapAdmin.existingSecret=ci-admin --set-string encryption.existingSecret=ci-encryption)
helm lint "$chart" --strict "${required[@]}"
helm template cp "$chart" "${required[@]}" > "$work/default.yaml"
helm lint "$chart" --strict -f "$chart/ci/values-full.yaml"
helm template cp "$chart" -f "$chart/ci/values-full.yaml" > "$work/full.yaml"
helm lint "$chart" --strict -f "$chart/ci/values-kind.yaml"
helm template cp "$chart" -f "$chart/ci/values-kind.yaml" > "$work/kind.yaml"
helm lint "$chart" --strict -f "$chart/ci/values-homelab.yaml"
helm template cp "$chart" -f "$chart/ci/values-homelab.yaml" > "$work/homelab.yaml"
# Homelab: the node's cgroup is smaller than its reported capacity, so every container books its whole memory limit.
unbooked="$(docker run --rm -i mikefarah/yq:4.44.3 ea '[.. | select(tag == "!!map" and has("image")) | select(.resources.limits.memory == null or .resources.requests.memory != .resources.limits.memory) | .name] | join(",")' < "$work/homelab.yaml")"
[[ -z "$unbooked" ]] || { echo "Homelab containers whose memory request differs from the limit: $unbooked" >&2; exit 1; }
# The inline alternative must render a Secret, including on first installation.
helm template cp "$chart" --set-string database.existingSecret=ci-database --set-string encryption.existingSecret=ci-encryption \
  --set-string bootstrapAdmin.email=admin@example.test --set-string bootstrapAdmin.password=synthetic-ci-password > "$work/inline.yaml"
expect_failure() {
  local expected="$1"
  shift
  if helm template cp "$chart" "$@" > /dev/null 2> "$work/error"; then
    echo "Unexpected render success: $expected" >&2
    exit 1
  fi
  grep -Fq "$expected" "$work/error"
}
expect_failure 'database.existingSecret' --set-string bootstrapAdmin.existingSecret=ci-admin --set-string encryption.existingSecret=ci-encryption
expect_failure 'bootstrapAdmin' --set-string database.existingSecret=ci-database --set-string encryption.existingSecret=ci-encryption
expect_failure 'bootstrapAdmin' --set-string database.existingSecret=ci-database --set-string encryption.existingSecret=ci-encryption --set-string bootstrapAdmin.email=admin@example.test
expect_failure 'encryption.existingSecret' --set-string database.existingSecret=ci-database --set-string bootstrapAdmin.existingSecret=ci-admin
expect_failure 'trustProxy' "${required[@]}" --set ingress.enabled=true
for trust in uniquelocal true false loopback linklocal 0.0.0.0/0; do
  expect_failure 'trustProxy' "${required[@]}" --set ingress.enabled=true --set-string "trustProxy=$trust"
done
# clientIpHeader (contract P6-C0): a header name, only with trustProxy, refused until P6-C1 implements it.
expect_failure 'single HTTP header name' "${required[@]}" --set-string 'clientIpHeader=CF Connecting IP'
expect_failure 'clientIpHeader needs trustProxy' "${required[@]}" --set-string clientIpHeader=CF-Connecting-IP
expect_failure 'clientIpHeader is planned' "${required[@]}" --set-string clientIpHeader=CF-Connecting-IP --set-string trustProxy=10.244.0.0/16
# Secure cookies need HTTPS somewhere: an ingress without TLS must declare the terminator in front of it.
expect_failure 'ingress.tls is required' -f "$chart/ci/values-homelab.yaml" --set ingress.tlsTerminatedUpstream=false
expect_failure 'proxy-read-timeout' -f "$chart/ci/values-full.yaml" \
  --set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-read-timeout=15'
expect_failure 'proxy-buffering' -f "$chart/ci/values-full.yaml" \
  --set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-buffering=on'
# Upgrades of an already bootstrapped database can omit bootstrap credentials.
helm template cp "$chart" --is-upgrade --set-string database.existingSecret=ci-database --set-string encryption.existingSecret=ci-encryption > /dev/null
echo 'Chart lint/render and rejection checks passed'
if [[ "${KUBECONFORM:-false}" == true ]]; then
  for variant in default full kind inline homelab; do
    docker run --rm -i ghcr.io/yannh/kubeconform:v0.6.7 \
      -strict -summary -kubernetes-version 1.32.2 < "$work/$variant.yaml"
  done
fi
