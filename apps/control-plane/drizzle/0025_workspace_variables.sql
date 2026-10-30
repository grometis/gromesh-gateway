CREATE TABLE "workspace_variable_values" (
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"value" text NOT NULL,
	"sealed" boolean NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_variable_values_workspace_id_name_version_pk" PRIMARY KEY("workspace_id","name","version"),
	CONSTRAINT "workspace_variable_values_version_ck" CHECK ("workspace_variable_values"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workspace_variables" (
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"secret" boolean NOT NULL,
	"required" boolean NOT NULL,
	"validation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_variables_workspace_id_name_pk" PRIMARY KEY("workspace_id","name"),
	CONSTRAINT "workspace_variables_name_ck" CHECK ("workspace_variables"."name" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "workspace_variables_type_ck" CHECK ("workspace_variables"."type" in ('string', 'host', 'port', 'url', 'certificate', 'privateKey', 'credential'))
);
--> statement-breakpoint
ALTER TABLE "workspace_variable_values" ADD CONSTRAINT "workspace_variable_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_variable_values" ADD CONSTRAINT "workspace_variable_values_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_variables" ADD CONSTRAINT "workspace_variables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;