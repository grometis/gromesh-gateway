CREATE TABLE "analytics_route_history_visibility" (
	"instance_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"revision" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "analytics_route_history_visibility_instance_id_epoch_revision_pk" PRIMARY KEY("instance_id","epoch","revision")
);
--> statement-breakpoint
ALTER TABLE "analytics_route_history" ADD COLUMN "chain_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_route_history_visibility" ADD CONSTRAINT "analytics_route_history_visibility_instance_id_epoch_revision_analytics_route_history_instance_id_epoch_revision_fk" FOREIGN KEY ("instance_id","epoch","revision") REFERENCES "public"."analytics_route_history"("instance_id","epoch","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION analytics_route_history_visibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE writer text; recorded timestamptz;
BEGIN
 SELECT write_transaction, recorded_at INTO writer, recorded FROM analytics_route_history WHERE instance_id=NEW.instance_id AND epoch=NEW.epoch AND revision=NEW.revision;
 IF writer IS NULL OR writer=pg_current_xact_id()::text THEN RAISE EXCEPTION 'visibility requires a separate committed observation' USING ERRCODE='55000'; END IF;
 NEW.observed_at=clock_timestamp();
 IF NEW.observed_at < recorded THEN RAISE EXCEPTION 'visibility clock precedes recorded history' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER analytics_route_history_visibility_guard BEFORE INSERT ON analytics_route_history_visibility FOR EACH ROW EXECUTE FUNCTION analytics_route_history_visibility_guard();
--> statement-breakpoint
CREATE TRIGGER analytics_route_history_visibility_append_only BEFORE UPDATE OR DELETE ON analytics_route_history_visibility FOR EACH ROW EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_route_history_visibility_no_truncate BEFORE TRUNCATE ON analytics_route_history_visibility FOR EACH STATEMENT EXECUTE FUNCTION gromesh_append_only();
