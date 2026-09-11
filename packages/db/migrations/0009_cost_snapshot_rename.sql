ALTER TABLE "model_usage_event" RENAME COLUMN "estimated_cost_micros" TO "cost_micros";--> statement-breakpoint
ALTER TABLE "model_usage_event" RENAME COLUMN "pricing_version" TO "cost_source";--> statement-breakpoint
ALTER TABLE "model_usage_event" DROP CONSTRAINT "model_usage_event_estimated_cost_micros_nonneg";--> statement-breakpoint
ALTER TABLE "model_usage_event" DROP CONSTRAINT "model_usage_event_cost_snapshot_consistent";--> statement-breakpoint
ALTER TABLE "model_usage_event" ADD CONSTRAINT "model_usage_event_cost_micros_nonneg" CHECK ("model_usage_event"."cost_micros" IS NULL OR "model_usage_event"."cost_micros" >= 0);--> statement-breakpoint
ALTER TABLE "model_usage_event" ADD CONSTRAINT "model_usage_event_cost_snapshot_consistent" CHECK ((
        ("model_usage_event"."cost_micros" IS NULL AND "model_usage_event"."cost_currency" IS NULL AND "model_usage_event"."cost_source" IS NULL)
        OR
        ("model_usage_event"."cost_micros" IS NOT NULL AND "model_usage_event"."cost_currency" IS NOT NULL AND "model_usage_event"."cost_source" IS NOT NULL)
));
