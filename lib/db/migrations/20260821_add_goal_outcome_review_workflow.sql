ALTER TABLE "lessons"
  ADD COLUMN IF NOT EXISTS "goal_outcome_review_status" text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS "goal_outcome_proposal" jsonb,
  ADD COLUMN IF NOT EXISTS "goal_outcome_confirmed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "goal_outcome_confirmed_by" integer REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "lessons"
  DROP CONSTRAINT IF EXISTS "lessons_goal_outcome_review_status_chk";

ALTER TABLE "lessons"
  ADD CONSTRAINT "lessons_goal_outcome_review_status_chk"
  CHECK ("goal_outcome_review_status" IN ('legacy', 'draft', 'proposed', 'confirmed', 'needs_review'));