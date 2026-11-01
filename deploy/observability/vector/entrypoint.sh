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
# During a rotation the previous token is accepted too: it must be as strong as the current one.
if [ -n "${GROMESH_COLLECTOR_TOKEN_PREVIOUS:-}" ] && [ "${#GROMESH_COLLECTOR_TOKEN_PREVIOUS}" -lt 32 ]; then
  echo "GROMESH_COLLECTOR_TOKEN_PREVIOUS must be empty or hold the previous token (at least 32 characters)" >&2; exit 64
fi
# Environment values reach the config only through config.sh (checked formats), never through Vector's interpolation.
# The rendered file holds no secret (the password is resolved in memory); it is still readable by this user only.
umask 077
sh /etc/vector/config.sh render /etc/vector/vector.yaml > /var/lib/vector/vector.yaml
exec vector --config /var/lib/vector/vector.yaml --log-format json "$@"
