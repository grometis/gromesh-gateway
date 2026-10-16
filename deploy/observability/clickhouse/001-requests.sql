CREATE DATABASE IF NOT EXISTS gromesh;

CREATE TABLE IF NOT EXISTS gromesh.requests
(
    id UUID,
    ts DateTime64(3, 'UTC'),
    environment_id UUID,
    cluster_id UUID,
    service_id Nullable(UUID),
    route_id Nullable(UUID),
    consumer_id Nullable(UUID),
    method LowCardinality(String),
    path String,
    status UInt16,
    latency_kong_ms Float64,
    latency_upstream_ms Nullable(Float64),
    latency_total_ms Float64,
    client_ip IPv6,
    request_size UInt64,
    response_size UInt64
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (environment_id, ts)
TTL ts + INTERVAL 7 DAY;
