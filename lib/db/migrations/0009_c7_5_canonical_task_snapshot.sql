-- C7.5: frozen task facts are persisted before a learner sees the task.
-- Historical sessions remain null and cannot be newly qualified by inference.
ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS active_task_snapshot jsonb;

-- C3 recovery can retry after a projection failure, but a task attempt may
-- create evidence at most once even when concurrent requests race.
CREATE UNIQUE INDEX IF NOT EXISTS evidence_events_task_attempt_identity_uq
  ON evidence_events (lesson_session_id, task_reference, attempt_sequence)
  WHERE task_reference IS NOT NULL AND attempt_sequence IS NOT NULL;