ALTER TABLE "cluster_nodes" ADD COLUMN "analytics_health" jsonb;--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "analytics_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "collector_token_fingerprints" jsonb;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "analytics_degraded" boolean DEFAULT false NOT NULL;