CREATE TABLE "instance_signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_signing_keys_sealed_ck" CHECK ("instance_signing_keys"."private_key" like 'enc:v2:%'),
	CONSTRAINT "instance_signing_keys_validity_ck" CHECK ("instance_signing_keys"."valid_until" > "instance_signing_keys"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "instance_signing_keys_public_key_uq" ON "instance_signing_keys" USING btree ("public_key");