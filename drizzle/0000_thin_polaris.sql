CREATE TABLE "ci_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_run_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_runs_provider_external_run_id_uq" UNIQUE("provider","external_run_id"),
	CONSTRAINT "ci_runs_status_chk" CHECK ("ci_runs"."status" in ('passed','failed'))
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"sha" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quarantine" (
	"test_identity" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'recommended' NOT NULL,
	"classification" text NOT NULL,
	"reason" text NOT NULL,
	"flaky_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quarantine_status_chk" CHECK ("quarantine"."status" in ('recommended','cleared'))
);
--> statement-breakpoint
CREATE TABLE "test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"test_identity" text NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_results_outcome_chk" CHECK ("test_results"."outcome" in ('passed','failed'))
);
--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_commit_sha_commits_sha_fk" FOREIGN KEY ("commit_sha") REFERENCES "public"."commits"("sha") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_run_id_ci_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ci_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_runs_commit_sha_idx" ON "ci_runs" USING btree ("commit_sha");--> statement-breakpoint
CREATE INDEX "ci_runs_completed_at_idx" ON "ci_runs" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "test_results_test_identity_idx" ON "test_results" USING btree ("test_identity");--> statement-breakpoint
CREATE INDEX "test_results_run_id_idx" ON "test_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "test_results_identity_outcome_idx" ON "test_results" USING btree ("test_identity","outcome");