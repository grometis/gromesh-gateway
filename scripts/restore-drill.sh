#!/usr/bin/env bash
# From repo root: POSTGRES_PORT=55433 scripts/restore-drill.sh [custom-format.dump]
# Requires only bash and Docker (psql/pg_dump/pg_restore run in compose postgres).
# Without a file, exports a consistent source snapshot and dumps it. With a file,
# compares it to the CURRENT source; historical dumps fail if source has changed.
# A new, random database is always created and always dropped; source is read-only.
# Override COMPOSE_FILE, SOURCE_DATABASE and PGUSER for another compose database.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
node scripts/assert-test-stack.mjs || exit 1
export POSTGRES_PORT="${POSTGRES_PORT:-55433}"
compose=(node scripts/compose.mjs exec -T postgres)
source_db="${SOURCE_DATABASE:-gromesh}"
pguser="${PGUSER:-gromesh}"
work="$(mktemp -d)"
restore_db="gromesh_drill_$(date -u +%Y%m%d%H%M%S)_$$_${RANDOM}"
created=false
holder_pid=''
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$holder_pid" ]]; then
    printf 'ROLLBACK;\n\\q\n' >&3 2>/dev/null || true
    wait "$holder_pid" || true
  fi
  if [[ "$created" == true ]]; then
    if ! "${compose[@]}" dropdb -U "$pguser" --force "$restore_db"; then
      echo "ERROR: could not remove drill database $restore_db" >&2
      code=1
    fi
  fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if (( $# > 1 )); then echo 'Usage: scripts/restore-drill.sh [custom-format.dump]' >&2; exit 2; fi
# Hold an exported MVCC snapshot while pg_dump reads it. Counts and latest hash
# are measured in that same transaction, even when publications happen concurrently.
query="SELECT json_build_object('snapshots', (SELECT count(*) FROM public.snapshots), 'users', (SELECT count(*) FROM public.users), 'latestSnapshotHash', (SELECT hash FROM public.snapshots ORDER BY created_at DESC, environment_id DESC, version DESC LIMIT 1))::text;"
mkfifo "$work/source-in" "$work/source-out"
"${compose[@]}" psql -XAtq -v ON_ERROR_STOP=1 -U "$pguser" -d "$source_db" < "$work/source-in" > "$work/source-out" &
holder_pid=$!
exec 3> "$work/source-in"
exec 4< "$work/source-out"
printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n%s\n' "$query" >&3
IFS= read -r snapshot <&4
IFS= read -r expected <&4
if [[ ! "$snapshot" =~ ^[0-9A-Fa-f-]+$ || -z "$expected" ]]; then echo 'Source snapshot/manifest could not be read' >&2; exit 1; fi
if (( $# == 1 )); then
  dump="$1"
  [[ -r "$dump" ]] || { echo 'Dump file is not readable' >&2; exit 2; }
else
  dump="$work/source.dump"
  "${compose[@]}" pg_dump -U "$pguser" -d "$source_db" --snapshot="$snapshot" --format=custom --no-owner --no-acl > "$dump"
fi
printf 'ROLLBACK;\n\\q\n' >&3
wait "$holder_pid"
holder_pid=''
"${compose[@]}" createdb -U "$pguser" --template=template0 "$restore_db"
created=true
"${compose[@]}" pg_restore -U "$pguser" --dbname="$restore_db" --no-owner --no-acl --exit-on-error < "$dump"
actual="$("${compose[@]}" psql -XAtq -v ON_ERROR_STOP=1 -U "$pguser" -d "$restore_db" -c "$query")"
printf 'Source:   %s\nRestored: %s\n' "$expected" "$actual"
if [[ "$actual" != "$expected" ]]; then echo 'FAIL: snapshot/user counts or latest snapshot hash differ' >&2; exit 1; fi
echo 'PASS: snapshots, users and latest snapshot hash match; temporary database will be dropped'
