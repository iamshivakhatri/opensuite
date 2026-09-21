CREATE TABLE "agent_thread_context_checkpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"through_message_id" uuid NOT NULL,
	"through_message_created_at" timestamp NOT NULL,
	"content_version" integer NOT NULL,
	"content" text NOT NULL,
	"source_message_count" integer NOT NULL,
	"estimated_characters" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_thread_context_checkpoint_content_version_positive" CHECK ("agent_thread_context_checkpoint"."content_version" > 0),
	CONSTRAINT "agent_thread_context_checkpoint_source_message_count_non_negative" CHECK ("agent_thread_context_checkpoint"."source_message_count" >= 0),
	CONSTRAINT "agent_thread_context_checkpoint_estimated_characters_non_negative" CHECK ("agent_thread_context_checkpoint"."estimated_characters" >= 0),
	CONSTRAINT "agent_thread_context_checkpoint_content_max_length" CHECK (char_length("agent_thread_context_checkpoint"."content") <= 16000)
);
--> statement-breakpoint
ALTER TABLE "agent_thread_context_checkpoint" ADD CONSTRAINT "agent_thread_context_checkpoint_thread_id_agent_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_thread"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread_context_checkpoint" ADD CONSTRAINT "agent_thread_context_checkpoint_through_message_id_agent_message_id_fk" FOREIGN KEY ("through_message_id") REFERENCES "public"."agent_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_thread_context_checkpoint_thread_id_created_at_idx" ON "agent_thread_context_checkpoint" USING btree ("thread_id","created_at");