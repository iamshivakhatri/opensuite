ALTER TYPE "public"."agent_step_kind" ADD VALUE IF NOT EXISTS 'narration';--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "result_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_result_message_id_agent_message_id_fk" FOREIGN KEY ("result_message_id") REFERENCES "public"."agent_message"("id") ON DELETE restrict ON UPDATE no action;
