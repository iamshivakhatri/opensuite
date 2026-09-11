CREATE TYPE "public"."provider_credential_provider" AS ENUM('anthropic', 'openai', 'openrouter');--> statement-breakpoint
CREATE TABLE "provider_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" "provider_credential_provider" NOT NULL,
	"encrypted_payload" text NOT NULL,
	"encryption_version" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credential_user_id_provider_uidx" UNIQUE("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_credential_user_id_idx" ON "provider_credential" USING btree ("user_id");