CREATE TYPE "public"."ai_credential_source" AS ENUM('byok', 'managed');--> statement-breakpoint
CREATE TABLE "ai_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"provider" "provider_credential_provider" NOT NULL,
	"model" text NOT NULL,
	"credential_source" "ai_credential_source" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_preference" ADD CONSTRAINT "ai_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;