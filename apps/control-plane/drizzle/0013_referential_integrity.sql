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
