CREATE TABLE "analytics_ingestion_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"write_transaction" text DEFAULT pg_current_xact_id()::text NOT NULL,
	"descriptor" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "analytics_ingestion_generation_ck" CHECK ("analytics_ingestion_batches"."generation">0),
	CONSTRAINT "analytics_ingestion_descriptor_ck" CHECK (jsonb_typeof("analytics_ingestion_batches"."descriptor")='array' and jsonb_array_length("analytics_ingestion_batches"."descriptor") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "analytics_ingestion_counter" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_ingestion_singleton_ck" CHECK ("analytics_ingestion_counter"."singleton"=true),
	CONSTRAINT "analytics_ingestion_position_ck" CHECK ("analytics_ingestion_counter"."position">=0)
);
--> statement-breakpoint
CREATE TABLE "analytics_ingestion_receipts" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"stored_copies" integer NOT NULL,
	"expired_copies" integer NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "analytics_ingestion_receipt_counts_ck" CHECK ("analytics_ingestion_receipts"."stored_copies">=0 and "analytics_ingestion_receipts"."expired_copies">=0 and "analytics_ingestion_receipts"."stored_copies"+"analytics_ingestion_receipts"."expired_copies" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "analytics_ingestion_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"pod_uid" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_ingestion_batches" ADD CONSTRAINT "analytics_ingestion_batches_stream_id_analytics_ingestion_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."analytics_ingestion_streams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_ingestion_receipts" ADD CONSTRAINT "analytics_ingestion_receipts_batch_id_analytics_ingestion_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."analytics_ingestion_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_ingestion_streams" ADD CONSTRAINT "analytics_ingestion_streams_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_ingestion_streams" ADD CONSTRAINT "analytics_ingestion_streams_authorization_id_analytics_cluster_events_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."analytics_cluster_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_ingestion_generation_uq" ON "analytics_ingestion_batches" USING btree ("generation");
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_streams_append_only BEFORE UPDATE OR DELETE ON analytics_ingestion_streams FOR EACH ROW EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_streams_no_truncate BEFORE TRUNCATE ON analytics_ingestion_streams FOR EACH STATEMENT EXECUTE FUNCTION gromesh_append_only();

--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_batches_append_only BEFORE UPDATE OR DELETE ON analytics_ingestion_batches FOR EACH ROW EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_batches_no_truncate BEFORE TRUNCATE ON analytics_ingestion_batches FOR EACH STATEMENT EXECUTE FUNCTION gromesh_append_only();

--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_receipts_append_only BEFORE UPDATE OR DELETE ON analytics_ingestion_receipts FOR EACH ROW EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_receipts_no_truncate BEFORE TRUNCATE ON analytics_ingestion_receipts FOR EACH STATEMENT EXECUTE FUNCTION gromesh_append_only();

--> statement-breakpoint
CREATE FUNCTION analytics_ingestion_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b analytics_ingestion_batches;
BEGIN
 SELECT * INTO b FROM analytics_ingestion_batches WHERE id=NEW.batch_id;
 IF b.id IS NULL OR b.write_transaction=pg_current_xact_id()::text OR NEW.stored_copies+NEW.expired_copies<>jsonb_array_length(b.descriptor) THEN
   RAISE EXCEPTION 'receipt requires a committed admission and exact declared counts' USING ERRCODE='23514';
 END IF;
 NEW.confirmed_at=clock_timestamp();
 IF NEW.confirmed_at<b.recorded_at THEN RAISE EXCEPTION 'ingestion receipt clock regression' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_receipt_guard BEFORE INSERT ON analytics_ingestion_receipts FOR EACH ROW EXECUTE FUNCTION analytics_ingestion_receipt_guard();
