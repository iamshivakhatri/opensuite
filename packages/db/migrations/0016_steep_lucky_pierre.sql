CREATE TABLE "agent_thread_working_document" (
	"thread_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "agent_thread_working_document_thread_id_document_id_pk" PRIMARY KEY("thread_id","document_id")
);--> statement-breakpoint
ALTER TABLE "agent_thread_working_document" ADD CONSTRAINT "agent_thread_working_document_thread_id_agent_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_thread"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_thread_working_document" ADD CONSTRAINT "agent_thread_working_document_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE restrict ON UPDATE no action;
