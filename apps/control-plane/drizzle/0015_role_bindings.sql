CREATE TABLE "role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text DEFAULT 'user' NOT NULL,
	"subject_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"workspace_id" uuid,
	"role" text,
	"permissions" text[],
	"granted_by_platform" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"justification" text,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "role_bindings_scope_ck" CHECK (("role_bindings"."scope_type" = 'workspace') = ("role_bindings"."workspace_id" is not null)),
	CONSTRAINT "role_bindings_grant_ck" CHECK (("role_bindings"."role" is null) <> ("role_bindings"."permissions" is null)),
	CONSTRAINT "role_bindings_subject_type_ck" CHECK ("role_bindings"."subject_type" = 'user')
);
--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_bindings_subject_idx" ON "role_bindings" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "role_bindings_workspace_idx" ON "role_bindings" USING btree ("workspace_id");