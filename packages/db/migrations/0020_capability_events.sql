CREATE TABLE "agent_capability_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "turn" integer,
  "capability_id" text NOT NULL,
  "event_type" text NOT NULL,
  "model" text NOT NULL,
  "occurred_at" timestamp DEFAULT now() NOT NULL,
  "latency_ms" integer,
  "error_code" text,
  CONSTRAINT "agent_capability_event_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "agent_capability_event_event_type_check" CHECK ("event_type" IN ('discovered', 'loaded', 'executed', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "agent_capability_event_run_idx" ON "agent_capability_event" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "agent_capability_event_capability_type_idx" ON "agent_capability_event" USING btree ("capability_id", "event_type");
--> statement-breakpoint
CREATE INDEX "agent_capability_event_model_idx" ON "agent_capability_event" USING btree ("model");
