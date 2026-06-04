CREATE TABLE "quarantine_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_identity" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quarantine_audit_actor_type_chk" CHECK ("quarantine_audit"."actor_type" in ('system','human','board'))
);
--> statement-breakpoint
ALTER TABLE "quarantine" DROP CONSTRAINT "quarantine_status_chk";--> statement-breakpoint
ALTER TABLE "quarantine" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quarantine" ADD COLUMN "confirmed_by" text;--> statement-breakpoint
ALTER TABLE "quarantine" ADD COLUMN "actioned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quarantine" ADD COLUMN "actioned_by" text;--> statement-breakpoint
CREATE INDEX "quarantine_audit_test_identity_idx" ON "quarantine_audit" USING btree ("test_identity");--> statement-breakpoint
CREATE INDEX "quarantine_audit_created_at_idx" ON "quarantine_audit" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "quarantine" ADD CONSTRAINT "quarantine_status_chk" CHECK ("quarantine"."status" in ('recommended','confirmed','actioned','rejected','cleared'));