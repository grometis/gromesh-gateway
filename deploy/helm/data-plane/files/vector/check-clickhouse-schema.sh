#!/bin/sh
set -eu

# Metadata is visible for tables the INSERT-only user can access; no admin secret belongs in this chart.
# The database is base64-encoded by Helm to keep its configured name out of SQL string interpolation.
db="base64Decode('$CLICKHOUSE_DATABASE_BASE64')"
query() {
  wget -q -O - -T 10 \
    --header='X-ClickHouse-User: gromesh_writer' \
    --header="X-ClickHouse-Key: $CLICKHOUSE_PASSWORD" \
    --post-data="$1 FORMAT TabSeparated" "$CLICKHOUSE_ENDPOINT" 2>/dev/null
}
missing() {
  echo "External ClickHouse schema is not ready: migration $1 is missing. Apply it with an admin user, from the repository root:" >&2
  echo "  clickhouse-client --host <clickhouse-host> --user <admin-user> --password -n < deploy/observability/clickhouse/$1" >&2
  echo "Then install/upgrade again. Migrations run in order (001-requests.sql, then 002-retention.sql) and are idempotent." >&2
  exit 1
}

table=$(query "SELECT count() FROM system.tables WHERE database = $db AND name = 'requests'") || {
  echo "External ClickHouse is unreachable at $CLICKHOUSE_ENDPOINT with the writer user; check the endpoint and its secret." >&2
  exit 1
}
[ "$table" = 1 ] || missing 001-requests.sql
retention=$(query "SELECT count() = 1 FROM system.tables
WHERE database = $db AND name = 'requests'
AND position(create_table_query, 'TTL ts + toIntervalDay(retention_days)') > 0
AND (SELECT count() FROM system.columns
  WHERE database = $db AND table = 'requests'
  AND name = 'retention_days' AND type = 'UInt8'
  AND default_kind = 'DEFAULT' AND default_expression = '7') = 1") || missing 002-retention.sql
[ "$retention" = 1 ] || missing 002-retention.sql
echo 'ClickHouse retention schema ready'
