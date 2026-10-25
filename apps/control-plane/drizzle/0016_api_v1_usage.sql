CREATE TABLE "api_v1_usage" (
	"day" date NOT NULL,
	"token_id" uuid,
	"calls" integer NOT NULL,
	CONSTRAINT "api_v1_usage_day_token_uq" UNIQUE NULLS NOT DISTINCT("day","token_id")
);
--> statement-breakpoint
ALTER TABLE "api_v1_usage" ADD CONSTRAINT "api_v1_usage_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;