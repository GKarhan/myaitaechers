-- Test 2.0 T3.1: one learner-visible quiz session rooted in the original
-- teacher assignment, with repeated child attempts and immutable presentation.
ALTER TABLE quiz_questions
  ADD COLUMN IF NOT EXISTS solution_explanation text;

CREATE TABLE IF NOT EXISTS quiz_sessions (
  id serial PRIMARY KEY,
  root_quiz_id integer NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  root_assignment_id integer NOT NULL REFERENCES quiz_assignments(id) ON DELETE CASCADE,
  student_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ACTIVE',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT quiz_sessions_assignment_uq UNIQUE (root_assignment_id)
);
ALTER TABLE quiz_sessions
  DROP CONSTRAINT IF EXISTS quiz_sessions_root_student_uq;

ALTER TABLE quiz_attempts
  DROP CONSTRAINT IF EXISTS quiz_attempts_quiz_assignment_id_unique;
DROP INDEX IF EXISTS quiz_attempts_quiz_assignment_id_unique;
ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS quiz_session_id integer REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS attempt_sequence integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS quiz_attempts_session_sequence_uq
  ON quiz_attempts (quiz_session_id, attempt_sequence)
  WHERE quiz_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quiz_attempts_one_active_session_uq
  ON quiz_attempts (quiz_session_id)
  WHERE quiz_session_id IS NOT NULL AND completed_at IS NULL;

CREATE TABLE IF NOT EXISTS quiz_attempt_questions (
  id serial PRIMARY KEY,
  attempt_id integer NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  question_id integer NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  node_id integer,
  question_text text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  correct_option_index integer NOT NULL,
  option_explanations text[],
  solution_explanation text,
  interaction_type text,
  difficulty_level text NOT NULL DEFAULT 'MEDIUM',
  source_exercise_id integer,
  cognitive_level_id integer,
  sequence integer NOT NULL,
  option_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT quiz_attempt_questions_uq UNIQUE (attempt_id, question_id)
);

ALTER TABLE quiz_answers
  ADD COLUMN IF NOT EXISTS selected_presentation_index integer;
CREATE UNIQUE INDEX IF NOT EXISTS quiz_answers_attempt_question_uq
  ON quiz_answers (attempt_id, question_id);