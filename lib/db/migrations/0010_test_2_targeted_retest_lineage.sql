-- Test 2.0 T3: a new targeted retest records its immutable source attempt
-- and allowlisted strategy. Existing teacher quizzes remain null.
ALTER TABLE quizzes
  ADD COLUMN IF NOT EXISTS retest_source_attempt_id integer,
  ADD COLUMN IF NOT EXISTS retest_strategy text;

CREATE UNIQUE INDEX IF NOT EXISTS quizzes_retest_lineage_uq
  ON quizzes (retest_source_attempt_id, retest_strategy);