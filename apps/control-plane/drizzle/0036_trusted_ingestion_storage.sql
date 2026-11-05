CREATE TABLE "analytics_ingestion_storage" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"instance_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"database_name" text NOT NULL,
	"database_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"definition" text NOT NULL,
	"writer_id" uuid NOT NULL,
	"reader_id" uuid NOT NULL,
	"auditor_id" uuid NOT NULL,
	"administrator_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_xid" text NOT NULL,
	CONSTRAINT "analytics_ingestion_storage_identity_ck" CHECK ("analytics_ingestion_storage"."singleton"=true and "analytics_ingestion_storage"."database_name" ~ '^[a-z][a-z0-9_]{0,62}$' and "analytics_ingestion_storage"."writer_id"<>"analytics_ingestion_storage"."reader_id" and "analytics_ingestion_storage"."writer_id"<>"analytics_ingestion_storage"."auditor_id" and "analytics_ingestion_storage"."reader_id"<>"analytics_ingestion_storage"."auditor_id" and cardinality("analytics_ingestion_storage"."administrator_ids") between 1 and 8 and "analytics_ingestion_storage"."writer_id"<>all("analytics_ingestion_storage"."administrator_ids") and "analytics_ingestion_storage"."reader_id"<>all("analytics_ingestion_storage"."administrator_ids") and "analytics_ingestion_storage"."auditor_id"<>all("analytics_ingestion_storage"."administrator_ids"))
);
--> statement-breakpoint
ALTER TABLE "analytics_ingestion_storage" ADD CONSTRAINT "analytics_ingestion_storage_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION analytics_ingestion_storage_is_unused() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT position FROM analytics_ingestion_counter WHERE singleton),0)=0
  AND NOT EXISTS(SELECT 1 FROM analytics_ingestion_batches)
  AND NOT EXISTS(SELECT 1 FROM analytics_ingestion_receipts)
  AND NOT EXISTS(SELECT 1 FROM analytics_ingestion_workers)
  AND NOT EXISTS(SELECT 1 FROM analytics_copy_evidence)
  AND NOT EXISTS(SELECT 1 FROM analytics_ingestion_prune_coverage)
  AND NOT EXISTS(SELECT 1 FROM public.analytics_ingestion_storage)
$$;
--> statement-breakpoint
CREATE FUNCTION analytics_ingestion_storage_genesis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(1818,1801);
 IF NEW.created_xid<>pg_current_xact_id()::text OR NEW.created_at>clock_timestamp()
  OR NOT public.analytics_ingestion_storage_is_unused()
 THEN RAISE EXCEPTION 'Storage genesis requires an unused admission namespace'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_storage_genesis BEFORE INSERT ON analytics_ingestion_storage FOR EACH ROW EXECUTE FUNCTION analytics_ingestion_storage_genesis_guard();
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_storage_append_only BEFORE UPDATE OR DELETE ON analytics_ingestion_storage FOR EACH ROW EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_storage_no_truncate BEFORE TRUNCATE ON analytics_ingestion_storage FOR EACH STATEMENT EXECUTE FUNCTION gromesh_append_only();
