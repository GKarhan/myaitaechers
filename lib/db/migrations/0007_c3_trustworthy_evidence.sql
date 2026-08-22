-- C3: additive, backwards-compatible minimum telemetry contract.
-- Historical rows deliberately remain null/legacy; no backfill is performed.

ALTER TABLE evidence_events
  ADD COLUMN IF NOT EXISTS lesson_node_id integer REFERENCES lesson_nodes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cognitive_level_id integer REFERENCES lesson_node_cognitive_levels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quiz_question_id integer REFERENCES quiz_questions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quiz_attempt_id integer REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS task_source text,
  ADD COLUMN IF NOT EXISTS task_reference text,
  ADD COLUMN IF NOT EXISTS qualification_status text,
  ADD COLUMN IF NOT EXISTS evidence_quality text;

ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS active_task_reference text;