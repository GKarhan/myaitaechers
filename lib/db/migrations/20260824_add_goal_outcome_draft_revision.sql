ALTER TABLE "lessons"
  ADD COLUMN IF NOT EXISTS "goal_outcome_draft_revision" integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION increment_goal_outcome_draft_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "lessons"
  SET "goal_outcome_draft_revision" = "goal_outcome_draft_revision" + 1
  WHERE "id" = COALESCE(NEW."lesson_id", OLD."lesson_id");
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS lesson_outcomes_draft_revision_trigger ON "lesson_outcomes";

CREATE TRIGGER lesson_outcomes_draft_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON "lesson_outcomes"
FOR EACH ROW
EXECUTE FUNCTION increment_goal_outcome_draft_revision();