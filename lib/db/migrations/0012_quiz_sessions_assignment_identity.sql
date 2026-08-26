-- Forward upgrade for installations that already ran the first version of
-- 0011, where one session was incorrectly unique per quiz + learner.
ALTER TABLE quiz_sessions
  DROP CONSTRAINT IF EXISTS quiz_sessions_root_student_uq;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'quiz_sessions'::regclass
      AND conname = 'quiz_sessions_assignment_uq'
  ) THEN
    ALTER TABLE quiz_sessions
      ADD CONSTRAINT quiz_sessions_assignment_uq UNIQUE (root_assignment_id);
  END IF;
END
$$;