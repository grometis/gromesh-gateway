CREATE TABLE "cluster_nodes" (
	"cluster_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"hostname" text NOT NULL,
	"kong_version" text NOT NULL,
	"agent_version" text NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"applied_version" integer,
	"applied_hash" text,
	"failed_version" integer,
	"error" text,
	"kong_healthy" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cluster_nodes_cluster_id_node_id_pk" PRIMARY KEY("cluster_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"registration_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD CONSTRAINT "cluster_nodes_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_nodes_token_uq" ON "cluster_nodes" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "clusters_env_name_uq" ON "clusters" USING btree ("environment_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "clusters_token_uq" ON "clusters" USING btree ("registration_token_hash");