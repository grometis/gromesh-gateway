CREATE TABLE "certificate_snis" (
	"environment_id" uuid NOT NULL,
	"certificate_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "certificate_snis_environment_id_name_pk" PRIMARY KEY("environment_id","name")
);
--> statement-breakpoint
CREATE TABLE "certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"cert" text NOT NULL,
	"key" text NOT NULL,
	"subject" text NOT NULL,
	"issuer" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"fingerprint_sha256" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"upstream_id" uuid NOT NULL,
	"target" text NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstreams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"algorithm" text DEFAULT 'round-robin' NOT NULL,
	"hash_on" text DEFAULT 'none' NOT NULL,
	"hash_fallback" text DEFAULT 'none' NOT NULL,
	"hash_on_header" text,
	"hash_fallback_header" text,
	"hash_on_cookie" text,
	"hash_on_cookie_path" text,
	"healthchecks" jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificate_snis" ADD CONSTRAINT "certificate_snis_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_snis" ADD CONSTRAINT "certificate_snis_certificate_id_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_upstream_id_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."upstreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "certificate_snis_cert_idx" ON "certificate_snis" USING btree ("certificate_id");--> statement-breakpoint
CREATE INDEX "certificates_env_idx" ON "certificates" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "targets_upstream_target_uq" ON "targets" USING btree ("upstream_id","target");--> statement-breakpoint
CREATE INDEX "targets_env_idx" ON "targets" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upstreams_env_name_uq" ON "upstreams" USING btree ("environment_id","name");