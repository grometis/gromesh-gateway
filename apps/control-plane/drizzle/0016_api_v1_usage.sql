CREATE TABLE "api_v1_usage" (
	"day" date NOT NULL,
	"token_id" uuid,
	"token_name" text,
	"owner_id" uuid,
	"calls" integer NOT NULL,
	CONSTRAINT "api_v1_usage_day_token_uq" UNIQUE NULLS NOT DISTINCT("day","token_id")
);
--> statement-breakpoint
CREATE TABLE "api_v1_usage_coverage" (
	"day" date PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL
);
