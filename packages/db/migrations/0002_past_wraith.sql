CREATE TYPE "public"."agent_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'planning', 'running', 'waiting_for_confirmation', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_step_kind" AS ENUM('plan', 'inspect', 'tool', 'confirmation', 'validation', 'final');--> statement-breakpoint
CREATE TYPE "public"."agent_step_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_id_workspace_id_uidx" UNIQUE("id","workspace_id");--> statement-breakpoint
CREATE TABLE "agent_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" "agent_message_role" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"triggering_message_id" uuid,
	"created_by_user_id" text,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"error_code" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "agent_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" "agent_step_kind" NOT NULL,
	"status" "agent_step_status" DEFAULT 'pending' NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"input" jsonb,
	"output" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	CONSTRAINT "agent_step_run_id_sequence_uidx" UNIQUE("run_id","sequence"),
	CONSTRAINT "agent_step_sequence_non_negative" CHECK ("agent_step"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid,
	"created_by_user_id" text,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "agent_message" ADD CONSTRAINT "agent_message_thread_id_agent_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_thread"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_thread_id_agent_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_thread"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_triggering_message_id_agent_message_id_fk" FOREIGN KEY ("triggering_message_id") REFERENCES "public"."agent_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_step" ADD CONSTRAINT "agent_step_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread" ADD CONSTRAINT "agent_thread_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread" ADD CONSTRAINT "agent_thread_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread" ADD CONSTRAINT "agent_thread_document_workspace_fk" FOREIGN KEY ("document_id","workspace_id") REFERENCES "public"."document"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_message_thread_id_created_at_idx" ON "agent_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_run_thread_id_idx" ON "agent_run" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "agent_step_run_id_sequence_idx" ON "agent_step" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_thread_workspace_id_idx" ON "agent_thread" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_thread_document_id_idx" ON "agent_thread" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "agent_thread_workspace_id_updated_at_idx" ON "agent_thread" USING btree ("workspace_id","updated_at");
