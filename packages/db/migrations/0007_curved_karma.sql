CREATE TABLE "model_usage_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" "provider_credential_provider" NOT NULL,
	"model" text NOT NULL,
	"credential_source" "ai_credential_source" NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_input_tokens" integer,
	"reasoning_tokens" integer,
	"agent_run_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_usage_event_input_tokens_nonneg" CHECK ("model_usage_event"."input_tokens" IS NULL OR "model_usage_event"."input_tokens" >= 0),
	CONSTRAINT "model_usage_event_output_tokens_nonneg" CHECK ("model_usage_event"."output_tokens" IS NULL OR "model_usage_event"."output_tokens" >= 0),
	CONSTRAINT "model_usage_event_cached_input_tokens_nonneg" CHECK ("model_usage_event"."cached_input_tokens" IS NULL OR "model_usage_event"."cached_input_tokens" >= 0),
	CONSTRAINT "model_usage_event_reasoning_tokens_nonneg" CHECK ("model_usage_event"."reasoning_tokens" IS NULL OR "model_usage_event"."reasoning_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "model_usage_event" ADD CONSTRAINT "model_usage_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_usage_event_user_id_created_at_idx" ON "model_usage_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_event_agent_run_id_idx" ON "model_usage_event" USING btree ("agent_run_id");