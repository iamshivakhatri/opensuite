CREATE TABLE "document_user_state" (
	"user_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"starred_at" timestamp,
	"last_opened_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "document_user_state_user_id_document_id_pk" PRIMARY KEY("user_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "document_user_state" ADD CONSTRAINT "document_user_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_user_state" ADD CONSTRAINT "document_user_state_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_user_state_user_starred_idx" ON "document_user_state" USING btree ("user_id","starred");--> statement-breakpoint
CREATE INDEX "document_user_state_user_last_opened_idx" ON "document_user_state" USING btree ("user_id","last_opened_at");