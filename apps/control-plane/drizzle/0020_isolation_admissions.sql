CREATE TABLE "isolation_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"pod_uid" uuid NOT NULL,
	"pod_name" text NOT NULL,
	"node_name" text NOT NULL,
	"boot_id" uuid NOT NULL,
	"probe_public_key" text NOT NULL,
	"challenge" text NOT NULL,
	"challenge_seq" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone,
	"admission_id" uuid,
	"admission" jsonb,
	"kid" text,
	"start_deadline" timestamp with time zone,
	"state" text,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"acked_seq" integer DEFAULT 0 NOT NULL,
	"last_digest" text,
	"last_report_at" timestamp with time zone,
	"last_state" text,
	"last_failed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lease_remaining_ms" integer,
	"last_conclusive_at" timestamp with time zone,
	"kong_stop_confirmed" boolean,
	"violation_released" boolean DEFAULT false NOT NULL,
	CONSTRAINT "isolation_admissions_admission_uq" UNIQUE("admission_id"),
	CONSTRAINT "isolation_admissions_granted_ck" CHECK (("isolation_admissions"."outcome" = 'granted') = ("isolation_admissions"."admission_id" is not null and "isolation_admissions"."state" is not null)),
	CONSTRAINT "isolation_admissions_refused_ck" CHECK (("isolation_admissions"."outcome" = 'refused') = ("isolation_admissions"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "isolation_pendencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"lifecycle" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"node_name" text,
	"pod_uid" uuid,
	"admission_id" uuid,
	"capability" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"released_by" jsonb,
	"justification" text
);
--> statement-breakpoint
CREATE TABLE "isolation_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"pendency_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"release" jsonb NOT NULL,
	"kid" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "isolation_reports" (
	"admission_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"protected" text NOT NULL,
	"payload" text NOT NULL,
	"signature" text NOT NULL,
	"digest" text NOT NULL,
	"prev_digest" text,
	"state" text NOT NULL,
	"failed_capabilities" jsonb NOT NULL,
	"challenge" text,
	"lease_remaining_ms" integer,
	"final" boolean NOT NULL,
	"final_reason" text,
	"kong_stop_confirmed" boolean,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "isolation_reports_admission_id_seq_pk" PRIMARY KEY("admission_id","seq")
);
--> statement-breakpoint
ALTER TABLE "isolation_admissions" ADD CONSTRAINT "isolation_admissions_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "isolation_pendencies" ADD CONSTRAINT "isolation_pendencies_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "isolation_releases" ADD CONSTRAINT "isolation_releases_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "isolation_releases" ADD CONSTRAINT "isolation_releases_pendency_id_isolation_pendencies_id_fk" FOREIGN KEY ("pendency_id") REFERENCES "public"."isolation_pendencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "isolation_reports" ADD CONSTRAINT "isolation_reports_admission_id_isolation_admissions_admission_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."isolation_admissions"("admission_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "isolation_admissions_challenge_uq" ON "isolation_admissions" USING btree ("challenge");--> statement-breakpoint
CREATE UNIQUE INDEX "isolation_admissions_challenge_seq_uq" ON "isolation_admissions" USING btree ("cluster_id","challenge_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "isolation_admissions_pod_boot_uq" ON "isolation_admissions" USING btree ("cluster_id","pod_uid","boot_id") WHERE "isolation_admissions"."outcome" <> 'refused';--> statement-breakpoint
CREATE INDEX "isolation_admissions_cluster_idx" ON "isolation_admissions" USING btree ("cluster_id","outcome");--> statement-breakpoint
CREATE INDEX "isolation_pendencies_cluster_idx" ON "isolation_pendencies" USING btree ("cluster_id","lifecycle");--> statement-breakpoint
CREATE INDEX "isolation_pendencies_admission_idx" ON "isolation_pendencies" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "isolation_releases_pendency_uq" ON "isolation_releases" USING btree ("pendency_id");--> statement-breakpoint
CREATE INDEX "isolation_releases_cluster_idx" ON "isolation_releases" USING btree ("cluster_id","expires_at");--> statement-breakpoint
CREATE INDEX "isolation_reports_challenge_idx" ON "isolation_reports" USING btree ("admission_id","challenge");