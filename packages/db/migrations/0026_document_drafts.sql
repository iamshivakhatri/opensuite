CREATE TABLE "document_draft" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_draft" ADD CONSTRAINT "document_draft_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_draft" ADD CONSTRAINT "document_draft_base_version_id_document_version_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."document_version"("id") ON DELETE cascade ON UPDATE no action;