CREATE TABLE "workspace_creation_policy" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"mode" text NOT NULL,
	"creator_becomes_admin" boolean NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_creation_policy_singleton_ck" CHECK ("workspace_creation_policy"."singleton"),
	CONSTRAINT "workspace_creation_policy_mode_ck" CHECK ("workspace_creation_policy"."mode" in ('restricted-request', 'autonomous', 'admin-only'))
);
--> statement-breakpoint
ALTER TABLE "workspace_creation_policy" ADD CONSTRAINT "workspace_creation_policy_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;