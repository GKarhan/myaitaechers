-- Migration 0006: typed source-exercise answer contract.
-- Nullable for legacy compatibility; success_criteria remains independent.

ALTER TABLE lesson_exercises
  ADD COLUMN IF NOT EXISTS interaction_type TEXT;

ALTER TABLE lesson_exercises
  ADD COLUMN IF NOT EXISTS correct_answer TEXT;

-- Reviewed, explicitly authorized lesson-579 backfill only.
UPDATE lesson_exercises
SET interaction_type = 'multiple_choice',
    correct_answer = 'B'
WHERE lesson_id = 579
  AND exercise_id = 'EX-579-1'
  AND success_criteria = 'Ճիշտ պատասխան՝ Բ';

UPDATE lesson_exercises
SET interaction_type = 'true_false',
    correct_answer = 'TRUE'
WHERE lesson_id = 579
  AND exercise_id = 'EX-579-2'
  AND success_criteria = 'Ճիշտ պատասխան՝ Ճիշտ';