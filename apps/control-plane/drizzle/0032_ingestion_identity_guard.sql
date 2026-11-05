CREATE INDEX "analytics_ingestion_pod_identity_idx" ON "analytics_ingestion_streams" USING btree ("instance_id","cluster_id","pod_uid","node_id");
--> statement-breakpoint
CREATE FUNCTION analytics_ingestion_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.write_transaction IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'invalid ingestion admission transaction' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER analytics_ingestion_transaction_guard BEFORE INSERT ON analytics_ingestion_batches FOR EACH ROW EXECUTE FUNCTION analytics_ingestion_transaction_guard();
