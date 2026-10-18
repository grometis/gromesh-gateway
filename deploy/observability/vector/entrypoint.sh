#!/bin/sh
# The collector tags every request row with its own cluster id, so it must not start without a valid one.
set -eu
case "${GROMESH_CLUSTER_ID:-}" in
  [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
  *) echo "GROMESH_CLUSTER_ID must be the UUID of this cluster" >&2; exit 64 ;;
esac
# This repository-owned config uses env defaults and the writer password in the sink.
# Vector 0.57 requires explicit opt-in to preserve that interpolation.
exec vector --dangerously-allow-env-var-interpolation --config /etc/vector/vector.yaml --log-format json "$@"
