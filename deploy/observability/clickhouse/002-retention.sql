ALTER TABLE gromesh.requests
    ADD COLUMN IF NOT EXISTS retention_days UInt8 DEFAULT 7;

ALTER TABLE gromesh.requests
    MODIFY TTL ts + toIntervalDay(retention_days)
    SETTINGS materialize_ttl_after_modify = 0;
