ALTER TABLE "cluster_nodes" ADD COLUMN "collector_token_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "collector_token_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "collector_token_shared" boolean DEFAULT false NOT NULL;