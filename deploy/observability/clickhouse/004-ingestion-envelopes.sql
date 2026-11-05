ALTER TABLE gromesh.requests_v2_copies
 ADD COLUMN IF NOT EXISTS ingress_stream_id Nullable(UUID),
 ADD COLUMN IF NOT EXISTS ingress_batch_id Nullable(UUID),
 ADD COLUMN IF NOT EXISTS ingress_copy_id Nullable(UUID),
 ADD COLUMN IF NOT EXISTS ingress_generation Nullable(UInt64),
 ADD COLUMN IF NOT EXISTS ingress_wire Nullable(String);
