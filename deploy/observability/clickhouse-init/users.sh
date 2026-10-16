#!/bin/sh
# One-shot `clickhouse-init` compose service, run with the admin user after the server is healthy and before Vector
# starts. Idempotent. Neither the control plane nor Vector ever use the admin (or `default`): one reader, one writer.
set -eu
clickhouse-client --host "${CLICKHOUSE_HOST:-clickhouse}" -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -n <<SQL
CREATE USER IF NOT EXISTS gromesh_writer IDENTIFIED WITH sha256_password BY '${CLICKHOUSE_WRITER_PASSWORD}';
GRANT INSERT ON gromesh.requests TO gromesh_writer;
CREATE USER IF NOT EXISTS gromesh_reader IDENTIFIED WITH sha256_password BY '${CLICKHOUSE_READER_PASSWORD}';
GRANT SELECT ON gromesh.requests TO gromesh_reader;
SQL
echo "clickhouse users ready"
