CREATE TABLE IF NOT EXISTS gromesh.requests_v2_copies
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
    response_size UInt64,
    retention_days UInt8,
    CONSTRAINT valid_retention CHECK retention_days BETWEEN 1 AND 7
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (id, ts, environment_id)
TTL ts + toIntervalDay(retention_days);
