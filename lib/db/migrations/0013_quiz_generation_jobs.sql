-- Durable, idempotent background jobs for teacher quiz generation.
CREATE TABLE IF NOT EXISTS "quiz_generation_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "teacher_id" integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_snapshot" jsonb NOT NULL,
  "request_fingerprint" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "progress" text,
  "claim_token" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "quiz_id" integer,
  "error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "quiz_generation_jobs_teacher_key_uq" UNIQUE("teacher_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "quiz_generation_jobs"
  ADD COLUMN IF NOT EXISTS "claim_token" text;
--> statement-breakpoint
ALTER TABLE "quiz_generation_jobs"
  ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "quiz_generation_jobs"
    ADD CONSTRAINT "quiz_generation_jobs_teacher_id_users_id_fk"
    FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "quiz_generation_jobs"
    ADD CONSTRAINT "quiz_generation_jobs_quiz_id_quizzes_id_fk"
    FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quiz_generation_jobs_status_idx"
  ON "quiz_generation_jobs" USING btree ("status","updated_at");