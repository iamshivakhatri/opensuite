CREATE TABLE "managed_ai_trial_account" (
	"user_id" text PRIMARY KEY NOT NULL,
	"original_grant_micros" bigint NOT NULL,
	"balance_micros" bigint NOT NULL,
	"blocked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_ai_trial_debit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"model_usage_event_id" uuid NOT NULL,
	"cost_micros" bigint NOT NULL,
	"balance_after_micros" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "managed_ai_trial_debit_model_usage_event_id_unique" UNIQUE("model_usage_event_id")
);
--> statement-breakpoint
ALTER TABLE "managed_ai_trial_account" ADD CONSTRAINT "managed_ai_trial_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_ai_trial_debit" ADD CONSTRAINT "managed_ai_trial_debit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_ai_trial_debit" ADD CONSTRAINT "managed_ai_trial_debit_model_usage_event_id_model_usage_event_id_fk" FOREIGN KEY ("model_usage_event_id") REFERENCES "public"."model_usage_event"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_ai_trial_debit_user_id_idx" ON "managed_ai_trial_debit" USING btree ("user_id");