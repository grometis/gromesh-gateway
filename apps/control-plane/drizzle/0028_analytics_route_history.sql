CREATE TABLE "analytics_route_history" (
	"instance_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"revision" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"previous" jsonb,
	"genesis" boolean NOT NULL,
	"reason" text NOT NULL,
	"rollback_of" jsonb,
	"config_hash" text NOT NULL,
	"route_count" integer NOT NULL,
	"mapping_version" integer DEFAULT 2 NOT NULL,
	"provenance" text DEFAULT 'control-plane-domain-v2' NOT NULL,
	"write_transaction" text DEFAULT pg_current_xact_id()::text NOT NULL,
	CONSTRAINT "analytics_route_history_instance_id_epoch_revision_pk" PRIMARY KEY("instance_id","epoch","revision"),
	CONSTRAINT "analytics_route_history_ref_ck" CHECK ("analytics_route_history"."epoch">0 and "analytics_route_history"."revision">0 and "analytics_route_history"."route_count">=0 and "analytics_route_history"."mapping_version"=2),
	CONSTRAINT "analytics_route_history_hash_ck" CHECK ("analytics_route_history"."config_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "analytics_route_history_reason_ck" CHECK ("analytics_route_history"."reason" in ('publish','rollback','promotion','reconcile','mandatory-plugins','values') and (("analytics_route_history"."reason"='rollback') = ("analytics_route_history"."rollback_of" is not null))),
	CONSTRAINT "analytics_route_history_genesis_ck" CHECK (not "analytics_route_history"."genesis" or ("analytics_route_history"."previous" is null and "analytics_route_history"."epoch"=1 and "analytics_route_history"."revision"=1))
);
--> statement-breakpoint
CREATE TABLE "analytics_route_history_routes" (
	"instance_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"revision" integer NOT NULL,
	"route_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"release_version" integer NOT NULL,
	CONSTRAINT "analytics_route_history_routes_instance_id_epoch_revision_route_id_pk" PRIMARY KEY("instance_id","epoch","revision","route_id"),
	CONSTRAINT "analytics_route_history_release_ck" CHECK ("analytics_route_history_routes"."release_version">0)
);
--> statement-breakpoint
ALTER TABLE "analytics_route_history_routes" ADD CONSTRAINT "analytics_route_history_routes_instance_id_epoch_revision_analytics_route_history_instance_id_epoch_revision_fk" FOREIGN KEY ("instance_id","epoch","revision") REFERENCES "public"."analytics_route_history"("instance_id","epoch","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_route_history_time_idx" ON "analytics_route_history" USING btree ("instance_id","recorded_at");--> statement-breakpoint
CREATE INDEX "analytics_route_history_identity_idx" ON "analytics_route_history_routes" USING btree ("instance_id","route_id","workspace_id");--> statement-breakpoint
-- A map is assembled only by its creating transaction; commit verifies the whole set, including empty maps.
CREATE FUNCTION analytics_route_history_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE writer text;
BEGIN
 SELECT write_transaction INTO writer FROM analytics_route_history WHERE instance_id=NEW.instance_id AND epoch=NEW.epoch AND revision=NEW.revision;
 IF writer IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'route history map is sealed' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER analytics_route_history_entry_guard BEFORE INSERT ON analytics_route_history_routes FOR EACH ROW EXECUTE FUNCTION analytics_route_history_entry_guard();
--> statement-breakpoint
CREATE FUNCTION analytics_route_history_complete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.write_transaction <> pg_current_xact_id()::text OR NEW.route_count <> (SELECT count(*) FROM analytics_route_history_routes WHERE instance_id=NEW.instance_id AND epoch=NEW.epoch AND revision=NEW.revision) THEN RAISE EXCEPTION 'incomplete route history map' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER analytics_route_history_complete_guard AFTER INSERT ON analytics_route_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION analytics_route_history_complete_guard();
--> statement-breakpoint
CREATE TRIGGER analytics_route_history_append_only BEFORE UPDATE OR DELETE ON analytics_route_history FOR EACH ROW EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_route_history_no_truncate BEFORE TRUNCATE ON analytics_route_history FOR EACH STATEMENT EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_route_history_routes_append_only BEFORE UPDATE OR DELETE ON analytics_route_history_routes FOR EACH ROW EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE TRIGGER analytics_route_history_routes_no_truncate BEFORE TRUNCATE ON analytics_route_history_routes FOR EACH STATEMENT EXECUTE FUNCTION gromesh_append_only();
--> statement-breakpoint
CREATE FUNCTION analytics_route_history_entry_count_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (
   SELECT 1 FROM (SELECT DISTINCT instance_id, epoch, revision FROM new_routes) n
   JOIN analytics_route_history h USING(instance_id,epoch,revision)
   WHERE h.route_count <> (SELECT count(*) FROM analytics_route_history_routes r WHERE r.instance_id=n.instance_id AND r.epoch=n.epoch AND r.revision=n.revision)
 ) THEN RAISE EXCEPTION 'incomplete route history map' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
-- One complete batch per map; statement-level validation avoids a count scan per route at commit.
CREATE TRIGGER analytics_route_history_entry_count_guard AFTER INSERT ON analytics_route_history_routes REFERENCING NEW TABLE AS new_routes FOR EACH STATEMENT EXECUTE FUNCTION analytics_route_history_entry_count_guard();
