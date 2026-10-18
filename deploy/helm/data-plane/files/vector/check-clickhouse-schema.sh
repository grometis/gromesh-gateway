#!/bin/sh
set -eu

# Metadata is visible for tables the INSERT-only user can access; no admin secret belongs in this chart.
# The database is base64-encoded by Helm to keep its configured name out of SQL string interpolation.
query="SELECT count() = 1 FROM system.tables
WHERE database = base64Decode('$CLICKHOUSE_DATABASE_BASE64') AND name = 'requests'
AND position(create_table_query, 'TTL ts + toIntervalDay(retention_days)') > 0
AND (SELECT count() FROM system.columns
  WHERE database = base64Decode('$CLICKHOUSE_DATABASE_BASE64') AND table = 'requests'
  AND name = 'retention_days' AND type = 'UInt8'
  AND default_kind = 'DEFAULT' AND default_expression = '7') = 1
FORMAT TabSeparated"

if ! ready=$(wget -q -O - -T 10 \
  --header='X-ClickHouse-User: gromesh_writer' \
  --header="X-ClickHouse-Key: $CLICKHOUSE_PASSWORD" \
  --post-data="$query" "$CLICKHOUSE_ENDPOINT" 2>/dev/null) || [ "$ready" != 1 ]; then
  echo 'External ClickHouse schema is not ready. Apply deploy/observability/clickhouse/001-requests.sql then 002-retention.sql before installing/upgrading the collector; retention_days UInt8 DEFAULT 7 and its per-row TTL are required.' >&2
  exit 1
fi
echo 'ClickHouse retention schema ready'
