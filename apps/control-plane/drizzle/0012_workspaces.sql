CREATE TABLE "data_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"slug" text,
	"slug_status" text,
	"slug_reason" text,
	"slug_locked_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"migrated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_ck" CHECK ("workspaces"."slug" ~ '^[a-z][a-z0-9-]{1,39}$'),
	CONSTRAINT "workspaces_slug_status_ck" CHECK (("workspaces"."slug" is null) = ("workspaces"."slug_status" is null) and ("workspaces"."slug_reason" is not null) = ("workspaces"."slug_status" is not distinct from 'adjusted')),
	CONSTRAINT "workspaces_status_ck" CHECK ("workspaces"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "path_compatibility" text DEFAULT 'legacy-preserved' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_id_environments_id_fk" FOREIGN KEY ("id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_key_uq" ON "workspaces" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_uq" ON "workspaces" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_path_compatibility_ck" CHECK ("routes"."path_compatibility" in ('legacy-preserved', 'workspace-default'));--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_workspace_default_paths_ck" CHECK ("routes"."path_compatibility" = 'legacy-preserved' or coalesce(cardinality("routes"."paths"), 0) > 0);--> statement-breakpoint
-- N1: every existing environment is the workspace with the same id. The slug is filled in by the application
-- (backfillWorkspaces, right after the migrations), which normalizes the name the way SQL cannot.
INSERT INTO "workspaces" ("id", "migrated_at") SELECT "id", now() FROM "environments";--> statement-breakpoint
INSERT INTO "data_migrations" ("name") VALUES ('n1-workspaces');--> statement-breakpoint
CREATE FUNCTION "gromesh_environment_workspace"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "workspaces" ("id") VALUES (NEW."id");
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "environments_workspace" AFTER INSERT ON "environments" FOR EACH ROW EXECUTE FUNCTION "gromesh_environment_workspace"();
