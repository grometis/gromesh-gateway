CREATE TABLE "content_activations" (
	"workspace_id" uuid NOT NULL,
	"content_digest" text NOT NULL,
	"first_activated_at" timestamp with time zone NOT NULL,
	"deployment_revision" integer NOT NULL,
	"origin_promotion_id" uuid,
	CONSTRAINT "content_activations_workspace_id_content_digest_pk" PRIMARY KEY("workspace_id","content_digest"),
	CONSTRAINT "content_activations_digest_ck" CHECK ("content_activations"."content_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "content_revocations" (
	"workspace_id" uuid NOT NULL,
	"content_digest" text NOT NULL,
	"reason" text NOT NULL,
	"revoked_by" jsonb NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "content_revocations_workspace_id_content_digest_pk" PRIMARY KEY("workspace_id","content_digest"),
	CONSTRAINT "content_revocations_digest_ck" CHECK ("content_revocations"."content_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "deployment_lease" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"revision" integer,
	"operation" text,
	"owner" jsonb,
	"started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	CONSTRAINT "deployment_lease_single_ck" CHECK ("deployment_lease"."id")
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"epoch" integer NOT NULL,
	"revision" integer NOT NULL,
	"members" jsonb NOT NULL,
	"expected_nodes" jsonb NOT NULL,
	"mandatory_plugins_version" integer,
	"values_digest" text,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"reason" text NOT NULL,
	"promotion_id" uuid,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_epoch_revision_pk" PRIMARY KEY("epoch","revision"),
	CONSTRAINT "deployments_revision_ck" CHECK ("deployments"."epoch" >= 1 and "deployments"."revision" >= 1),
	CONSTRAINT "deployments_config_hash_ck" CHECK ("deployments"."config_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "deployments_reason_ck" CHECK ("deployments"."reason" in ('publish', 'promotion', 'rollback', 'reconcile', 'mandatory-plugins', 'values'))
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"origin" text NOT NULL,
	"promotion_id" uuid,
	"rollback_of" integer,
	"message" text,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_origin_version" integer NOT NULL,
	"origin_promotion_id" uuid,
	"attestation_id" uuid,
	CONSTRAINT "releases_workspace_id_version_pk" PRIMARY KEY("workspace_id","version"),
	CONSTRAINT "releases_version_ck" CHECK ("releases"."version" >= 1 and "releases"."content_origin_version" between 1 and "releases"."version"),
	CONSTRAINT "releases_content_digest_ck" CHECK ("releases"."content_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "releases_origin_ck" CHECK ("releases"."origin" in ('local', 'promotion', 'rollback', 'tombstone', 'migration')),
	CONSTRAINT "releases_promotion_origin_ck" CHECK ("releases"."origin" <> 'promotion' or "releases"."origin_promotion_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "workspace_active_release" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"deployment_revision" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "epoch" integer;--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "applied_revision" integer;--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "failed_revision" integer;--> statement-breakpoint
ALTER TABLE "content_activations" ADD CONSTRAINT "content_activations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revocations" ADD CONSTRAINT "content_revocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_active_release" ADD CONSTRAINT "workspace_active_release_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_active_release" ADD CONSTRAINT "workspace_active_release_release_fk" FOREIGN KEY ("workspace_id","version") REFERENCES "public"."releases"("workspace_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "releases_content_idx" ON "releases" USING btree ("workspace_id","content_digest");--> statement-breakpoint
-- The single lease row (C-16): free while revision is null, so taking it is a row lock and never an insert race.
INSERT INTO "deployment_lease" ("id") VALUES (true);--> statement-breakpoint
-- Releases and deployments are immutable, content activations and revocations insert only (C §4): rows are never
-- changed nor removed, by any path (TRUNCATE included).
CREATE FUNCTION "gromesh_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "releases_append_only" BEFORE UPDATE OR DELETE ON "releases" FOR EACH ROW EXECUTE FUNCTION "gromesh_append_only"();--> statement-breakpoint
CREATE TRIGGER "releases_no_truncate" BEFORE TRUNCATE ON "releases" FOR EACH STATEMENT EXECUTE FUNCTION "gromesh_append_only"();--> statement-breakpoint
CREATE TRIGGER "deployments_append_only" BEFORE UPDATE OR DELETE ON "deployments" FOR EACH ROW EXECUTE FUNCTION "gromesh_append_only"();--> statement-breakpoint
CREATE TRIGGER "deployments_no_truncate" BEFORE TRUNCATE ON "deployments" FOR EACH STATEMENT EXECUTE FUNCTION "gromesh_append_only"();--> statement-breakpoint
CREATE TRIGGER "content_activations_append_only" BEFORE UPDATE OR DELETE ON "content_activations" FOR EACH ROW EXECUTE FUNCTION "gromesh_append_only"();--> statement-breakpoint
CREATE TRIGGER "content_activations_no_truncate" BEFORE TRUNCATE ON "content_activations" FOR EACH STATEMENT EXECUTE FUNCTION "gromesh_append_only"();--> statement-breakpoint
CREATE TRIGGER "content_revocations_append_only" BEFORE UPDATE OR DELETE ON "content_revocations" FOR EACH ROW EXECUTE FUNCTION "gromesh_append_only"();--> statement-breakpoint
CREATE TRIGGER "content_revocations_no_truncate" BEFORE TRUNCATE ON "content_revocations" FOR EACH STATEMENT EXECUTE FUNCTION "gromesh_append_only"();
