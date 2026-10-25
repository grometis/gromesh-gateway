CREATE TABLE "role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text DEFAULT 'user' NOT NULL,
	"subject_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"workspace_id" uuid,
	"role" text,
	"permissions" text[],
	"effect" text DEFAULT 'allow' NOT NULL,
	"origin" text DEFAULT 'v2' NOT NULL,
	"granted_by_platform" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"justification" text,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "role_bindings_scope_ck" CHECK (("role_bindings"."scope_type" = 'workspace') = ("role_bindings"."workspace_id" is not null)),
	CONSTRAINT "role_bindings_grant_ck" CHECK (("role_bindings"."role" is null) <> ("role_bindings"."permissions" is null)),
	CONSTRAINT "role_bindings_subject_type_ck" CHECK ("role_bindings"."subject_type" = 'user'),
	CONSTRAINT "role_bindings_origin_ck" CHECK ("role_bindings"."origin" in ('v2', 'v1-environment-role') and ("role_bindings"."origin" = 'v2' or "role_bindings"."scope_type" = 'workspace')),
	CONSTRAINT "role_bindings_effect_ck" CHECK ("role_bindings"."effect" = 'allow' or ("role_bindings"."effect" = 'deny' and "role_bindings"."origin" = 'v1-environment-role'))
);
--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_bindings_subject_idx" ON "role_bindings" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "role_bindings_workspace_idx" ON "role_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_bindings_v1_uq" ON "role_bindings" USING btree ("subject_id","workspace_id") WHERE "role_bindings"."origin" = 'v1-environment-role' and "role_bindings"."revoked_at" is null;--> statement-breakpoint
-- N1: every environment role becomes the v1 binding of its workspace (the same id): the role replaces the global one
-- there (viewer, editor → publisher: a v1 editor publishes and rolls back; admin → workspace-admin), and none is a deny
-- that prevails over every grant there. v1 keeps writing environment_roles and these rows together.
INSERT INTO "role_bindings" ("subject_id", "scope_type", "workspace_id", "role", "permissions", "effect", "origin")
SELECT "user_id", 'workspace', "environment_id",
  CASE "role" WHEN 'viewer' THEN 'viewer' WHEN 'editor' THEN 'publisher' WHEN 'admin' THEN 'workspace-admin' END,
  CASE WHEN "role" = 'none' THEN '{}'::text[] END,
  CASE WHEN "role" = 'none' THEN 'deny' ELSE 'allow' END,
  'v1-environment-role'
FROM "environment_roles";
--> statement-breakpoint
-- The v1 bindings follow environment_roles in the same transaction whatever writes it (a replica of the previous
-- version during a rolling upgrade included): the authorization never reads a stale environment role.
CREATE FUNCTION "gromesh_environment_role_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    DELETE FROM "role_bindings" WHERE "origin" = 'v1-environment-role' AND "subject_id" = OLD."user_id" AND "workspace_id" = OLD."environment_id";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO "role_bindings" ("subject_id", "scope_type", "workspace_id", "role", "permissions", "effect", "origin")
    VALUES (NEW."user_id", 'workspace', NEW."environment_id",
      CASE NEW."role" WHEN 'viewer' THEN 'viewer' WHEN 'editor' THEN 'publisher' WHEN 'admin' THEN 'workspace-admin' END,
      CASE WHEN NEW."role" = 'none' THEN '{}'::text[] END,
      CASE WHEN NEW."role" = 'none' THEN 'deny' ELSE 'allow' END,
      'v1-environment-role');
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "environment_roles_binding" AFTER INSERT OR UPDATE OR DELETE ON "environment_roles" FOR EACH ROW EXECUTE FUNCTION "gromesh_environment_role_binding"();
