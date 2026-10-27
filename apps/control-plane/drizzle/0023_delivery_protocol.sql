ALTER TABLE "cluster_nodes" ADD COLUMN "deployment_hash" text;--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "kong_config_hash" text;--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "failed_deployment_hash" text;--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "cluster_nodes" ADD COLUMN "verified_revision" integer;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "delivery_protocol" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "delivery_protocol_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_delivery_protocol_ck" CHECK ("clusters"."delivery_protocol" in ('v1', 'v2-pending', 'v2'));