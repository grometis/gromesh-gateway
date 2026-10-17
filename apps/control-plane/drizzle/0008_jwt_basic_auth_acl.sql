CREATE TABLE "basicauth_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"consumer_id" uuid NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwt_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"consumer_id" uuid NOT NULL,
	"key" text NOT NULL,
	"algorithm" text NOT NULL,
	"secret" text,
	"rsa_public_key" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consumers" ADD COLUMN "acl_groups" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "basicauth_credentials" ADD CONSTRAINT "basicauth_credentials_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basicauth_credentials" ADD CONSTRAINT "basicauth_credentials_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jwt_credentials" ADD CONSTRAINT "jwt_credentials_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jwt_credentials" ADD CONSTRAINT "jwt_credentials_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "basicauth_env_username_uq" ON "basicauth_credentials" USING btree ("environment_id","username");--> statement-breakpoint
CREATE INDEX "basicauth_consumer_idx" ON "basicauth_credentials" USING btree ("consumer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jwt_env_key_uq" ON "jwt_credentials" USING btree ("environment_id","key");--> statement-breakpoint
CREATE INDEX "jwt_consumer_idx" ON "jwt_credentials" USING btree ("consumer_id");