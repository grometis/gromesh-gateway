CREATE TABLE "analytics_ingestion_workers" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	"token" uuid NOT NULL,
	"state" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_ingestion_worker_ck" CHECK ("analytics_ingestion_workers"."epoch">0 and "analytics_ingestion_workers"."state" in ('persisting','verified','failed'))
);
--> statement-breakpoint
ALTER TABLE "analytics_ingestion_workers" ADD CONSTRAINT "analytics_ingestion_workers_batch_id_analytics_ingestion_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."analytics_ingestion_batches"("id") ON DELETE no action ON UPDATE no action;