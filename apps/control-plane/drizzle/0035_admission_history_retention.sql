CREATE TABLE "analytics_ingestion_prune_coverage" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"pruned_through" bigint NOT NULL,
	"pruned_at" timestamp with time zone NOT NULL,
	"prune_transaction" text NOT NULL,
	CONSTRAINT "analytics_ingestion_prune_coverage_ck" CHECK ("analytics_ingestion_prune_coverage"."singleton"=true and "analytics_ingestion_prune_coverage"."pruned_through">0)
);
--> statement-breakpoint
CREATE INDEX "analytics_ingestion_retention_idx" ON "analytics_ingestion_batches" USING btree ("recorded_at","id");--> statement-breakpoint
CREATE FUNCTION analytics_ingestion_history_expired(descriptor jsonb, recorded timestamptz, as_of timestamptz) RETURNS boolean LANGUAGE sql STABLE STRICT AS $$
 SELECT recorded+interval '168 hours'<=as_of
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(descriptor) d WHERE d->>'expiresAt' IS NULL OR (d->>'expiresAt')::timestamptz>as_of)
$$;
--> statement-breakpoint
CREATE FUNCTION guard_analytics_ingestion_prune_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.singleton=OLD.singleton AND NEW.pruned_through>=OLD.pruned_through AND NEW.pruned_at>=OLD.pruned_at) THEN
  IF NEW.prune_transaction=pg_current_xact_id()::text AND NEW.pruned_at<=clock_timestamp() THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Admission history coverage cannot be reset';
END $$;
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_prune_coverage_guard BEFORE INSERT OR UPDATE OR DELETE ON analytics_ingestion_prune_coverage FOR EACH ROW EXECUTE FUNCTION guard_analytics_ingestion_prune_coverage();
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_prune_coverage_no_truncate BEFORE TRUNCATE ON analytics_ingestion_prune_coverage EXECUTE FUNCTION guard_analytics_ingestion_prune_coverage();
--> statement-breakpoint
CREATE FUNCTION guard_analytics_ingestion_history_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source analytics_ingestion_batches;
BEGIN
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='analytics_ingestion_batches' THEN source:=OLD;
  ELSE SELECT * INTO source FROM analytics_ingestion_batches WHERE id=OLD.batch_id; END IF;
  IF source.id IS NOT NULL
   AND analytics_ingestion_history_expired(source.descriptor,source.recorded_at,transaction_timestamp())
   AND EXISTS(SELECT 1 FROM analytics_ingestion_prune_coverage WHERE singleton AND pruned_through>=source.generation AND prune_transaction=pg_current_xact_id()::text)
   AND NOT EXISTS(SELECT 1 FROM analytics_copy_evidence WHERE source_batch_id=source.id)
   AND NOT EXISTS(SELECT 1 FROM analytics_ingestion_workers WHERE batch_id=source.id AND state='persisting' AND lease_until>transaction_timestamp())
  THEN RETURN OLD; END IF;
 END IF;
 RAISE EXCEPTION 'Admission history is immutable outside guarded expiry';
END $$;
--> statement-breakpoint
DROP TRIGGER analytics_ingestion_batches_append_only ON analytics_ingestion_batches;
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_batches_append_only BEFORE UPDATE OR DELETE ON analytics_ingestion_batches FOR EACH ROW EXECUTE FUNCTION guard_analytics_ingestion_history_expiry();
--> statement-breakpoint
DROP TRIGGER analytics_ingestion_receipts_append_only ON analytics_ingestion_receipts;
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_receipts_append_only BEFORE UPDATE OR DELETE ON analytics_ingestion_receipts FOR EACH ROW EXECUTE FUNCTION guard_analytics_ingestion_history_expiry();
