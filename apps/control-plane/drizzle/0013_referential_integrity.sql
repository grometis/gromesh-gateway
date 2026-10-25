-- N1: every reference names its workspace (environment_id), so the database refuses one that crosses workspaces.
-- The referenced (environment_id, id) pairs are unique first; then each single-column foreign key becomes composite.
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_env_id_uq" UNIQUE("environment_id","id");
--> statement-breakpoint
ALTER TABLE "consumers" ADD CONSTRAINT "consumers_env_id_uq" UNIQUE("environment_id","id");
--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_env_id_uq" UNIQUE("environment_id","id");
--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_env_id_uq" UNIQUE("environment_id","id");
--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_env_id_uq" UNIQUE("environment_id","id");
--> statement-breakpoint
ALTER TABLE "basicauth_credentials" DROP CONSTRAINT "basicauth_credentials_consumer_id_consumers_id_fk";
--> statement-breakpoint
ALTER TABLE "certificate_snis" DROP CONSTRAINT "certificate_snis_certificate_id_certificates_id_fk";
--> statement-breakpoint
ALTER TABLE "jwt_credentials" DROP CONSTRAINT "jwt_credentials_consumer_id_consumers_id_fk";
--> statement-breakpoint
ALTER TABLE "keyauth_credentials" DROP CONSTRAINT "keyauth_credentials_consumer_id_consumers_id_fk";
--> statement-breakpoint
ALTER TABLE "plugins" DROP CONSTRAINT "plugins_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "plugins" DROP CONSTRAINT "plugins_route_id_routes_id_fk";
--> statement-breakpoint
ALTER TABLE "plugins" DROP CONSTRAINT "plugins_consumer_id_consumers_id_fk";
--> statement-breakpoint
ALTER TABLE "routes" DROP CONSTRAINT "routes_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "targets" DROP CONSTRAINT "targets_upstream_id_upstreams_id_fk";
--> statement-breakpoint
ALTER TABLE "basicauth_credentials" ADD CONSTRAINT "basicauth_consumer_fk" FOREIGN KEY ("environment_id","consumer_id") REFERENCES "public"."consumers"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "certificate_snis" ADD CONSTRAINT "certificate_snis_certificate_fk" FOREIGN KEY ("environment_id","certificate_id") REFERENCES "public"."certificates"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "jwt_credentials" ADD CONSTRAINT "jwt_consumer_fk" FOREIGN KEY ("environment_id","consumer_id") REFERENCES "public"."consumers"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "keyauth_credentials" ADD CONSTRAINT "keyauth_consumer_fk" FOREIGN KEY ("environment_id","consumer_id") REFERENCES "public"."consumers"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_service_fk" FOREIGN KEY ("environment_id","service_id") REFERENCES "public"."services"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_route_fk" FOREIGN KEY ("environment_id","route_id") REFERENCES "public"."routes"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_consumer_fk" FOREIGN KEY ("environment_id","consumer_id") REFERENCES "public"."consumers"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_service_fk" FOREIGN KEY ("environment_id","service_id") REFERENCES "public"."services"("environment_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_upstream_fk" FOREIGN KEY ("environment_id","upstream_id") REFERENCES "public"."upstreams"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- `anonymous` (an authentication plugin's fallback consumer, by id or username, inside config) is a reference too:
-- always a consumer of the plugin's own workspace. Checked only when it is written, so rows written before the rule
-- keep working until edited; a consumer named that way can be neither deleted nor renamed.
CREATE FUNCTION "gromesh_plugin_anonymous"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  anon text := NEW."config"->>'anonymous';
BEGIN
  IF anon IS NULL OR anon = '' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD."config"->>'anonymous' IS NOT DISTINCT FROM anon AND OLD."environment_id" = NEW."environment_id" THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM "consumers" c WHERE c."environment_id" = NEW."environment_id" AND (c."id"::text = lower(anon) OR c."username" = anon)) THEN
    RAISE EXCEPTION 'plugin % names as anonymous a consumer its workspace does not hold', NEW."id" USING ERRCODE = '23503', CONSTRAINT = 'plugins_anonymous_consumer';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "plugins_anonymous" BEFORE INSERT OR UPDATE OF "config", "environment_id" ON "plugins" FOR EACH ROW EXECUTE FUNCTION "gromesh_plugin_anonymous"();--> statement-breakpoint
CREATE FUNCTION "gromesh_consumer_anonymous"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."username" IS NOT DISTINCT FROM OLD."username" AND NEW."environment_id" = OLD."environment_id" THEN RETURN NEW; END IF;
  -- The whole workspace is going away (its environment is already deleted): its plugins go with it.
  IF NOT EXISTS (SELECT 1 FROM "environments" e WHERE e."id" = OLD."environment_id") THEN RETURN COALESCE(NEW, OLD); END IF;
  IF EXISTS (
    SELECT 1 FROM "plugins" p
    WHERE p."environment_id" = OLD."environment_id"
      AND (lower(p."config"->>'anonymous') = OLD."id"::text OR (OLD."username" IS NOT NULL AND p."config"->>'anonymous' = OLD."username"))
      -- A plugin scoped to this very consumer goes with it.
      AND p."consumer_id" IS DISTINCT FROM (CASE WHEN TG_OP = 'DELETE' THEN OLD."id" END)
  ) THEN
    RAISE EXCEPTION 'consumer % is used as anonymous by a plugin', OLD."id" USING ERRCODE = '23503', CONSTRAINT = 'plugins_anonymous_consumer';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER "consumers_anonymous" BEFORE UPDATE OF "username", "environment_id" OR DELETE ON "consumers" FOR EACH ROW EXECUTE FUNCTION "gromesh_consumer_anonymous"();
