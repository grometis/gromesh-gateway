CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" jsonb NOT NULL,
	"action" text NOT NULL,
	"environment_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"publish_mode" text DEFAULT 'manual' NOT NULL,
	"current_version" integer,
	"has_unpublished_changes" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"name" text NOT NULL,
	"protocols" text[] DEFAULT '{http,https}'::text[] NOT NULL,
	"methods" text[],
	"hosts" text[],
	"paths" text[],
	"headers" jsonb,
	"strip_path" boolean DEFAULT true NOT NULL,
	"preserve_host" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"path" text,
	"retries" integer,
	"connect_timeout_ms" integer,
	"read_timeout_ms" integer,
	"write_timeout_ms" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"environment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"message" text,
	"created_by" jsonb NOT NULL,
	"rollback_of" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshots_environment_id_version_pk" PRIMARY KEY("environment_id","version")
);
--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_env_idx" ON "audit_events" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_name_uq" ON "environments" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "routes_env_name_uq" ON "routes" USING btree ("environment_id","name");--> statement-breakpoint
CREATE INDEX "routes_service_idx" ON "routes" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_env_name_uq" ON "services" USING btree ("environment_id","name");