CREATE TABLE "deployment_states" (
	"epoch" integer NOT NULL,
	"revision" integer NOT NULL,
	"seq" integer NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_states_epoch_revision_seq_pk" PRIMARY KEY("epoch","revision","seq"),
	CONSTRAINT "deployment_states_seq_ck" CHECK ("deployment_states"."seq" >= 1),
	CONSTRAINT "deployment_states_state_ck" CHECK ("deployment_states"."state" in ('composed', 'rejected', 'active', 'converging', 'converged', 'degraded', 'failed', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "instance" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"stage" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_singleton_ck" CHECK ("instance"."singleton"),
	CONSTRAINT "instance_stage_ck" CHECK ("instance"."stage" in ('dev', 'hml', 'prd'))
);
--> statement-breakpoint
ALTER TABLE "deployment_states" ADD CONSTRAINT "deployment_states_deployment_fk" FOREIGN KEY ("epoch","revision") REFERENCES "public"."deployments"("epoch","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instance_id_uq" ON "instance" USING btree ("id");--> statement-breakpoint
-- The instance identity (D1) never changes nor disappears; the transitions of a deployment are append-only (C §4).
CREATE FUNCTION "gromesh_instance_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on instance is not allowed: the instance identity is immutable', TG_OP USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "instance_immutable" BEFORE UPDATE OR DELETE ON "instance" FOR EACH ROW EXECUTE FUNCTION "gromesh_instance_immutable"();--> statement-breakpoint
CREATE TRIGGER "instance_no_truncate" BEFORE TRUNCATE ON "instance" FOR EACH STATEMENT EXECUTE FUNCTION "gromesh_instance_immutable"();--> statement-breakpoint
CREATE TRIGGER "deployment_states_append_only" BEFORE UPDATE OR DELETE ON "deployment_states" FOR EACH ROW EXECUTE FUNCTION "gromesh_append_only"();--> statement-breakpoint
CREATE TRIGGER "deployment_states_no_truncate" BEFORE TRUNCATE ON "deployment_states" FOR EACH STATEMENT EXECUTE FUNCTION "gromesh_append_only"();
