DROP INDEX "agent_message_thread_id_created_at_idx";--> statement-breakpoint
CREATE INDEX "agent_message_thread_id_created_at_id_idx" ON "agent_message" USING btree ("thread_id","created_at","id");