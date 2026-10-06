ALTER TABLE "agent_capability_event" DROP CONSTRAINT "agent_capability_event_event_type_check";
--> statement-breakpoint
ALTER TABLE "agent_capability_event" ADD CONSTRAINT "agent_capability_event_event_type_check" CHECK ("event_type" IN ('recommended', 'discovered', 'loaded', 'executed', 'succeeded', 'failed'));
