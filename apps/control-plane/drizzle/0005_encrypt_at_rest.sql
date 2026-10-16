-- The fingerprint is an HMAC the database cannot compute: the application fills key_hash on its next start
-- (crypto/at-rest.ts), then sets it NOT NULL, creates keyauth_env_key_hash_uq and drops keyauth_env_key_uq.
ALTER TABLE "keyauth_credentials" ADD COLUMN "key_hash" text;
