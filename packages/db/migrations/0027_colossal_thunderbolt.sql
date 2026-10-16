CREATE TYPE "public"."chat_attachment_kind" AS ENUM('file', 'text');--> statement-breakpoint
CREATE TYPE "public"."chat_attachment_status" AS ENUM('staged', 'bound', 'deleted');--> statement-breakpoint
CREATE TABLE "chat_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"thread_id" uuid,
	"message_id" uuid,
	"kind" "chat_attachment_kind" DEFAULT 'file' NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"status" "chat_attachment_status" DEFAULT 'staged' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"bound_at" timestamp,
	"deleted_at" timestamp,
	CONSTRAINT "chat_attachment_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "agent_message" ADD COLUMN "attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_thread_id_agent_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_thread"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_message_id_agent_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_attachment_workspace_owner_idx" ON "chat_attachment" USING btree ("workspace_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "chat_attachment_thread_idx" ON "chat_attachment" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "chat_attachment_status_created_at_idx" ON "chat_attachment" USING btree ("status","created_at");