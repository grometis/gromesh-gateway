#!/bin/sh
# Environment values for vector.yaml without --dangerously-allow-env-var-interpolation: only the names below are read,
# and each is checked against a strict format first, so no environment variable can add or change configuration
# (a quote or a newline would).
#   config.sh render <vector.yaml>   prints the config with each @@name@@ replaced (typed fields: Vector parses them
#                                    before it resolves secrets, so SECRET[...] cannot fill a socket address or a URI)
#   config.sh secret                 Vector "exec" secret backend (protocol 1.0) for SECRET[env.*]; the password stays
#                                    in memory instead of being written into the rendered file
set -eu

address='(\[[0-9A-Fa-f:.]+\]|[0-9A-Za-z.-]+):[0-9]{1,5}'
endpoint='https?://(\[[0-9A-Fa-f:.]+\]|[0-9A-Za-z.-]+)(:[0-9]{1,5})?(/[0-9A-Za-z._~/-]*)?'
database='[A-Za-z_][A-Za-z0-9_]{0,63}'

# value <name>: prints the checked value of a known name; exits 2 for an unknown name, 1 for a missing/invalid value.
value() {
  case "$1" in
    collector_address) variable=GROMESH_COLLECTOR_ADDRESS v=${GROMESH_COLLECTOR_ADDRESS:-0.0.0.0:8080} format=$address ;;
    metrics_address) variable=GROMESH_COLLECTOR_METRICS_ADDRESS v=${GROMESH_COLLECTOR_METRICS_ADDRESS:-0.0.0.0:9598} format=$address ;;
    clickhouse_endpoint) variable=CLICKHOUSE_ENDPOINT v=${CLICKHOUSE_ENDPOINT:-http://clickhouse:8123} format=$endpoint ;;
    clickhouse_database) variable=CLICKHOUSE_DATABASE v=${CLICKHOUSE_DATABASE:-gromesh} format=$database ;;
    clickhouse_password) variable=CLICKHOUSE_PASSWORD v=${CLICKHOUSE_PASSWORD:-} format='' ;;
    *) return 2 ;;
  esac
  if [ -z "$format" ]; then
    # The password lands inside a double-quoted YAML string: any character but the double quote, the backslash
    # (both already broke or silently changed it under Vector's interpolation) and control characters.
    [ -n "$v" ] && [ "$(printf '%s' "$v" | LC_ALL=C tr -d '"\\[:cntrl:]')" = "$v" ] || {
      echo "$variable is missing or not in the accepted format" >&2
      return 1
    }
  # grep -x matches line by line: a value with a newline must be refused before it.
  elif [ "$(printf '%s' "$v" | wc -l)" -ne 0 ] || ! printf '%s' "$v" | grep -Eqx "$format"; then
    echo "$variable is missing or not in the accepted format" >&2
    return 1
  fi
  printf '%s' "$v"
}

case "${1:-}" in
  render)
    text=$(cat "$2")
    for name in $(printf '%s\n' "$text" | grep -o '@@[a-z_]*@@' | sort -u | tr -d @); do
      [ "$name" != clickhouse_password ] || { echo "the password is a secret: use SECRET[env.clickhouse_password]" >&2; exit 64; }
      v=$(value "$name") || { [ $? -eq 2 ] && echo "unknown placeholder @@$name@@" >&2; exit 64; }
      # The formats above exclude the sed delimiter and "&", so the value is replaced literally.
      text=$(printf '%s\n' "$text" | sed "s|@@$name@@|$v|g")
    done
    printf '%s\n' "$text"
    ;;
  secret)
    names=$(tr -d '\n' | sed -n 's/.*"secrets"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr -d '" \t' | tr ',' ' ')
    out='{' sep=''
    for name in $names; do
      if [ "$name" = clickhouse_password ] && v=$(value "$name" 2>/dev/null); then
        out="$out$sep\"$name\":{\"value\":\"$v\",\"error\":null}"
      elif [ "$name" = clickhouse_password ]; then
        out="$out$sep\"$name\":{\"value\":null,\"error\":\"CLICKHOUSE_PASSWORD is missing or not in the accepted format\"}"
      else
        out="$out$sep\"$name\":{\"value\":null,\"error\":\"unknown secret\"}"
      fi
      sep=','
    done
    printf '%s}\n' "$out"
    ;;
  *) echo "usage: config.sh render <vector.yaml> | config.sh secret" >&2; exit 64 ;;
esac
