CREATE TABLE "analytics_copy_coverage" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"pruned_through" bigint DEFAULT 0 NOT NULL,
	"pruned_at" timestamp with time zone,
	"prune_transaction" text,
	CONSTRAINT "analytics_copy_coverage_ck" CHECK ("analytics_copy_coverage"."singleton"=true and "analytics_copy_coverage"."pruned_through">=0 and (("analytics_copy_coverage"."pruned_through"=0 and "analytics_copy_coverage"."pruned_at" is null and "analytics_copy_coverage"."prune_transaction" is null) or ("analytics_copy_coverage"."pruned_through">0 and "analytics_copy_coverage"."pruned_at" is not null and "analytics_copy_coverage"."prune_transaction" is not null)))
);
--> statement-breakpoint
CREATE TABLE "analytics_copy_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"source_batch_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"kind" text NOT NULL,
	"left_hash" text NOT NULL,
	"right_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"format_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "analytics_copy_evidence_kind_ck" CHECK ("analytics_copy_evidence"."kind" in ('conflicting-copies','comparison-unavailable')),
	CONSTRAINT "analytics_copy_evidence_hash_ck" CHECK ("analytics_copy_evidence"."left_hash" ~ '^[0-9a-f]{64}$' and (("analytics_copy_evidence"."kind"='conflicting-copies' and "analytics_copy_evidence"."right_hash" ~ '^[0-9a-f]{64}$' and "analytics_copy_evidence"."left_hash"<"analytics_copy_evidence"."right_hash") or ("analytics_copy_evidence"."kind"='comparison-unavailable' and "analytics_copy_evidence"."right_hash"=''))),
	CONSTRAINT "analytics_copy_evidence_version_ck" CHECK ("analytics_copy_evidence"."format_version"=1 and "analytics_copy_evidence"."generation">0)
);
--> statement-breakpoint
ALTER TABLE "analytics_copy_evidence" ADD CONSTRAINT "analytics_copy_evidence_source_batch_id_analytics_ingestion_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."analytics_ingestion_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_copy_evidence_identity_uq" ON "analytics_copy_evidence" USING btree ("source_batch_id","request_id","kind","left_hash","right_hash","expires_at");--> statement-breakpoint
CREATE INDEX "analytics_copy_evidence_request_idx" ON "analytics_copy_evidence" USING btree ("request_id","expires_at");--> statement-breakpoint
CREATE INDEX "analytics_copy_evidence_expiry_idx" ON "analytics_copy_evidence" USING btree ("expires_at","id");
--> statement-breakpoint
CREATE FUNCTION guard_analytics_copy_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source analytics_ingestion_batches%ROWTYPE; minimum_expiry timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO source FROM analytics_ingestion_batches WHERE id=NEW.source_batch_id;
    SELECT max((d->>'expiresAt')::timestamptz) INTO minimum_expiry FROM jsonb_array_elements(source.descriptor) d WHERE d->>'id'=NEW.request_id::text;
    IF source.id IS NULL OR source.write_transaction=pg_current_xact_id()::text OR source.generation<>NEW.generation OR minimum_expiry IS NULL OR NEW.expires_at<minimum_expiry OR NEW.expires_at>clock_timestamp()+interval '7 days' THEN
      RAISE EXCEPTION 'Invalid committed copy evidence source or retention';
    END IF;
    NEW.observed_at:=clock_timestamp();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND OLD.expires_at<=clock_timestamp() AND EXISTS(SELECT 1 FROM analytics_copy_coverage WHERE singleton AND pruned_through>=OLD.generation AND prune_transaction=pg_current_xact_id()::text) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Copy evidence is immutable outside guarded expiry';
END $$;
--> statement-breakpoint
CREATE TRIGGER analytics_copy_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON analytics_copy_evidence FOR EACH ROW EXECUTE FUNCTION guard_analytics_copy_evidence();
--> statement-breakpoint
CREATE FUNCTION guard_analytics_copy_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.singleton=OLD.singleton AND NEW.pruned_through>=OLD.pruned_through AND NEW.pruned_at>=OLD.pruned_at) THEN
    IF NEW.pruned_through>0 AND NEW.prune_transaction=pg_current_xact_id()::text AND NEW.pruned_at<=clock_timestamp() THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Copy evidence coverage cannot be reset';
END $$;
--> statement-breakpoint
CREATE TRIGGER analytics_copy_coverage_guard BEFORE INSERT OR UPDATE OR DELETE ON analytics_copy_coverage FOR EACH ROW EXECUTE FUNCTION guard_analytics_copy_coverage();
--> statement-breakpoint
CREATE TRIGGER analytics_copy_evidence_no_truncate BEFORE TRUNCATE ON analytics_copy_evidence EXECUTE FUNCTION guard_analytics_copy_evidence();
--> statement-breakpoint
CREATE TRIGGER analytics_copy_coverage_no_truncate BEFORE TRUNCATE ON analytics_copy_coverage EXECUTE FUNCTION guard_analytics_copy_coverage();
