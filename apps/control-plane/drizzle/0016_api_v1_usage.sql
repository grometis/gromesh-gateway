CREATE TABLE "api_v1_usage" (
	"day" date NOT NULL,
	"token_id" uuid,
	"token_name" text,
	"owner_id" uuid,
	"calls" integer NOT NULL,
	CONSTRAINT "api_v1_usage_day_token_uq" UNIQUE NULLS NOT DISTINCT("day","token_id")
);
--> statement-breakpoint
CREATE TABLE "api_v1_usage_replicas" (
	"replica_id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"closed" boolean DEFAULT false NOT NULL
);
