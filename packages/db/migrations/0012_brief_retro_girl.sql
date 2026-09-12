CREATE TABLE "user_storage_account" (
	"user_id" text PRIMARY KEY NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_storage_account" ADD CONSTRAINT "user_storage_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "user_storage_account" ("user_id", "used_bytes")
SELECT "workspace"."owner_user_id", sum("document_version"."size_bytes")
FROM "document_version"
JOIN "document" ON "document"."id" = "document_version"."document_id"
JOIN "workspace" ON "workspace"."id" = "document"."workspace_id"
GROUP BY "workspace"."owner_user_id"
ON CONFLICT ("user_id") DO UPDATE SET "used_bytes" = EXCLUDED."used_bytes";
