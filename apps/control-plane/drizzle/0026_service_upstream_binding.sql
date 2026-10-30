ALTER TABLE "services" ADD COLUMN "binding" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "upstream_id" uuid;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_upstream_fk" FOREIGN KEY ("environment_id","upstream_id") REFERENCES "public"."upstreams"("environment_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_binding_ck" CHECK ("services"."binding" is null or "services"."binding" = 'explicit');--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_upstream_binding_ck" CHECK ("services"."upstream_id" is null or "services"."binding" = 'explicit');