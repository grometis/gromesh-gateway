CREATE TABLE "analytics_cluster_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"previous_event_id" uuid,
	"authorization_id" uuid,
	"operation" text NOT NULL,
	"source_node_id" text,
	"source_epoch" integer,
	"source_revision" integer,
	"config_hash" text,
	"provenance" text NOT NULL,
	"actor" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"complete" boolean NOT NULL,
	"write_transaction" text DEFAULT pg_current_xact_id()::text NOT NULL,
	CONSTRAINT "analytics_cluster_sequence_ck" CHECK ("analytics_cluster_events"."sequence">0 and ("analytics_cluster_events"."previous_event_id" is null)=("analytics_cluster_events"."sequence"=1)),
	CONSTRAINT "analytics_cluster_operation_ck" CHECK ("analytics_cluster_events"."operation" in ('authorize','revoke','delete')),
	CONSTRAINT "analytics_cluster_source_ck" CHECK (coalesce((
    "analytics_cluster_events"."operation"='authorize' and "analytics_cluster_events"."authorization_id" is null and "analytics_cluster_events"."source_node_id" is not null and "analytics_cluster_events"."source_epoch">0 and "analytics_cluster_events"."source_revision">0 and "analytics_cluster_events"."config_hash" ~ '^sha256:[0-9a-f]{64}$' and "analytics_cluster_events"."provenance"='cp-authorized-v2-delivery' and "analytics_cluster_events"."actor"->>'type'='agent' and "analytics_cluster_events"."actor"->>'id'="analytics_cluster_events"."source_node_id"
  ) or (
    "analytics_cluster_events"."operation" in ('revoke','delete') and "analytics_cluster_events"."source_node_id" is null and "analytics_cluster_events"."source_epoch" is null and "analytics_cluster_events"."source_revision" is null and "analytics_cluster_events"."config_hash" is null and "analytics_cluster_events"."provenance"='cp-cluster-lifecycle'
  ),false))
);
--> statement-breakpoint
CREATE TABLE "analytics_cluster_visibility" (
	"authorization_id" uuid PRIMARY KEY NOT NULL,
	"observed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_cluster_events" ADD CONSTRAINT "analytics_cluster_events_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_cluster_events" ADD CONSTRAINT "analytics_cluster_events_previous_event_id_analytics_cluster_events_id_fk" FOREIGN KEY ("previous_event_id") REFERENCES "public"."analytics_cluster_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_cluster_events" ADD CONSTRAINT "analytics_cluster_events_authorization_id_analytics_cluster_events_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."analytics_cluster_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_cluster_events" ADD CONSTRAINT "analytics_cluster_events_source_epoch_source_revision_deployments_epoch_revision_fk" FOREIGN KEY ("source_epoch","source_revision") REFERENCES "public"."deployments"("epoch","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_cluster_visibility" ADD CONSTRAINT "analytics_cluster_visibility_authorization_id_analytics_cluster_events_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."analytics_cluster_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_cluster_sequence_uq" ON "analytics_cluster_events" USING btree ("cluster_id","sequence");--> statement-breakpoint
CREATE INDEX "analytics_cluster_authorization_idx" ON "analytics_cluster_events" USING btree ("authorization_id");--> statement-breakpoint
CREATE INDEX "analytics_cluster_time_idx" ON "analytics_cluster_events" USING btree ("cluster_id","recorded_at");--> statement-breakpoint
CREATE FUNCTION analytics_cluster_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p analytics_cluster_events;
BEGIN
 IF NEW.write_transaction IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'invalid cluster history transaction' USING ERRCODE='23514'; END IF;
 IF NEW.sequence=1 THEN
   IF NEW.operation NOT IN ('authorize','delete') OR NEW.authorization_id IS NOT NULL THEN RAISE EXCEPTION 'cluster history must start with a prospective authorization or terminal deletion' USING ERRCODE='23514'; END IF;
 ELSE
   SELECT * INTO p FROM analytics_cluster_events WHERE id=NEW.previous_event_id;
   IF p.id IS NULL OR p.instance_id<>NEW.instance_id OR p.cluster_id<>NEW.cluster_id OR p.sequence<>NEW.sequence-1 OR p.operation='delete' THEN RAISE EXCEPTION 'invalid cluster history predecessor' USING ERRCODE='23514'; END IF;
   IF NEW.operation='authorize' AND p.operation<>'revoke' THEN RAISE EXCEPTION 'overlapping cluster authorization' USING ERRCODE='23514'; END IF;
   IF NEW.operation='revoke' AND p.operation<>'authorize' THEN RAISE EXCEPTION 'invalid cluster revocation' USING ERRCODE='23514'; END IF;
   IF NEW.operation IN ('revoke','delete') AND NEW.authorization_id IS DISTINCT FROM (CASE WHEN p.operation='authorize' THEN p.id ELSE p.authorization_id END) THEN RAISE EXCEPTION 'invalid cluster revocation target' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER analytics_cluster_chain_guard BEFORE INSERT ON analytics_cluster_events FOR EACH ROW EXECUTE FUNCTION analytics_cluster_chain_guard();
--> statement-breakpoint
CREATE FUNCTION analytics_cluster_visibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a analytics_cluster_events;
BEGIN
 SELECT * INTO a FROM analytics_cluster_events WHERE id=NEW.authorization_id;
 IF a.id IS NULL OR a.operation<>'authorize' OR a.write_transaction=pg_current_xact_id()::text THEN RAISE EXCEPTION 'cluster visibility requires a committed authorization' USING ERRCODE='55000'; END IF;
 NEW.observed_at=clock_timestamp();
 IF NEW.observed_at<a.recorded_at THEN RAISE EXCEPTION 'cluster visibility clock regression' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER analytics_cluster_visibility_guard BEFORE INSERT ON analytics_cluster_visibility FOR EACH ROW EXECUTE FUNCTION analytics_cluster_visibility_guard();
--> statement-breakpoint
CREATE TRIGGER analytics_cluster_events_append_only BEFORE UPDATE OR DELETE ON analytics_cluster_events FOR EACH ROW EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_cluster_events_no_truncate BEFORE TRUNCATE ON analytics_cluster_events FOR EACH STATEMENT EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_cluster_visibility_append_only BEFORE UPDATE OR DELETE ON analytics_cluster_visibility FOR EACH ROW EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_cluster_visibility_no_truncate BEFORE TRUNCATE ON analytics_cluster_visibility FOR EACH STATEMENT EXECUTE FUNCTION gromesh_append_only();
