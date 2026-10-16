#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
readonly TRIVY_IMAGE='aquasec/trivy:0.58.1@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7'
readonly SYFT_IMAGE='anchore/syft:v1.18.1@sha256:b8c170b8e51bfc4779ec3ef4399942c57290f5ce76a9c3af564c9d00d4946a6b'
mkdir -p dist/sbom

# A named volume keeps the vulnerability DB between runs; Trivy downloads updates inside the container.
status=0
for name in control-plane ui agent; do
  image="gromesh-${name}:local"
  docker build --tag "$image" --file "apps/${name}/Dockerfile" .
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v "$PWD/dist/sbom:/out" \
    "$SYFT_IMAGE" "docker:${image}" -o "spdx-json=/out/gromesh-${name}.spdx.json"
  # Still scan the remaining images and produce their SBOMs if one image has CRITICAL findings.
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v gromesh-trivy-cache:/root/.cache/trivy \
    "$TRIVY_IMAGE" image --image-src docker --scanners vuln \
    --severity CRITICAL --exit-code 1 --ignorefile /dev/null \
    --no-progress --timeout 15m "$image" || status=1
done
exit "$status"
