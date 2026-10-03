ALTER TABLE "agent_capability_event" ADD COLUMN "capability_kind" text;
--> statement-breakpoint
ALTER TABLE "agent_capability_event" ADD CONSTRAINT "agent_capability_event_kind_check" CHECK ("capability_kind" IN ('group', 'tool', 'instruction'));
