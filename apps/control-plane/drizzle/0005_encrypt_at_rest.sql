DROP INDEX "keyauth_env_key_uq";--> statement-breakpoint
ALTER TABLE "keyauth_credentials" ADD COLUMN "key_hash" text;--> statement-breakpoint
-- Keys written before encryption are still in clear here: their fingerprint is computable in SQL. The application
-- seals the keys themselves on its next start (crypto/at-rest.ts).
UPDATE "keyauth_credentials" SET "key_hash" = encode(sha256(convert_to("key", 'UTF8')), 'hex') WHERE "key_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "keyauth_credentials" ALTER COLUMN "key_hash" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "keyauth_env_key_hash_uq" ON "keyauth_credentials" USING btree ("environment_id","key_hash");
