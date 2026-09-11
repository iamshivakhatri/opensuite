ALTER TABLE "model_usage_event" ADD COLUMN "estimated_cost_micros" bigint;--> statement-breakpoint
ALTER TABLE "model_usage_event" ADD COLUMN "cost_currency" text;--> statement-breakpoint
ALTER TABLE "model_usage_event" ADD COLUMN "pricing_version" text;--> statement-breakpoint
ALTER TABLE "model_usage_event" ADD CONSTRAINT "model_usage_event_estimated_cost_micros_nonneg" CHECK ("model_usage_event"."estimated_cost_micros" IS NULL OR "model_usage_event"."estimated_cost_micros" >= 0);--> statement-breakpoint
ALTER TABLE "model_usage_event" ADD CONSTRAINT "model_usage_event_cost_snapshot_consistent" CHECK ((
        ("model_usage_event"."estimated_cost_micros" IS NULL AND "model_usage_event"."cost_currency" IS NULL AND "model_usage_event"."pricing_version" IS NULL)
        OR
        ("model_usage_event"."estimated_cost_micros" IS NOT NULL AND "model_usage_event"."cost_currency" IS NOT NULL AND "model_usage_event"."pricing_version" IS NOT NULL)
      ));