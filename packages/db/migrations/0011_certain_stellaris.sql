CREATE TABLE "agent_execution_lease" (
	"user_id" text PRIMARY KEY NOT NULL,
	"lease_id" uuid NOT NULL,
	"acquired_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "agent_execution_lease_lease_id_unique" UNIQUE("lease_id")
);
--> statement-breakpoint
ALTER TABLE "agent_execution_lease" ADD CONSTRAINT "agent_execution_lease_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_execution_lease_expires_at_idx" ON "agent_execution_lease" USING btree ("expires_at");