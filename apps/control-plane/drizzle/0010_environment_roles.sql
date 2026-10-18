CREATE TABLE "environment_roles" (
	"user_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_roles_user_id_environment_id_pk" PRIMARY KEY("user_id","environment_id"),
	CONSTRAINT "environment_roles_role_ck" CHECK ("environment_roles"."role" in ('viewer', 'editor', 'admin', 'none'))
);
--> statement-breakpoint
ALTER TABLE "environment_roles" ADD CONSTRAINT "environment_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_roles" ADD CONSTRAINT "environment_roles_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_roles_env_idx" ON "environment_roles" USING btree ("environment_id");