#!/bin/sh
# The collector tags every request row with its own cluster id, so it must not start without a valid one.
set -eu
: "${GROMESH_COLLECTOR_TOKEN:=}"
case "${GROMESH_CLUSTER_ID:-}" in
  [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
  *) echo "GROMESH_CLUSTER_ID must be the UUID of this cluster" >&2; exit 64 ;;
esac
uuid='[0-9a-fA-F]\{8\}-[0-9a-fA-F]\{4\}-[0-9a-fA-F]\{4\}-[0-9a-fA-F]\{4\}-[0-9a-fA-F]\{12\}'
# The environment is pinned unless explicitly opted out with "any" (development stacks that create environments
# on the fly); an empty value is an error, never a silent opt-out.
if [ "${GROMESH_ENVIRONMENT_ID:-}" != any ] && ! printf '%s' "${GROMESH_ENVIRONMENT_ID:-}" | grep -qx "$uuid"; then
  echo "GROMESH_ENVIRONMENT_ID must be the UUID of this cluster's environment" >&2; exit 64
fi
# Without a token every event would be refused (401): fail at start instead of silently losing analytics.
if [ "${#GROMESH_COLLECTOR_TOKEN}" -lt 32 ]; then
  echo "GROMESH_COLLECTOR_TOKEN must hold this cluster's collector token (at least 32 characters)" >&2; exit 64
fi
# This repository-owned config uses env defaults and the writer password in the sink.
# Vector 0.57 requires explicit opt-in to preserve that interpolation.
exec vector --dangerously-allow-env-var-interpolation --config /etc/vector/vector.yaml --log-format json "$@"
