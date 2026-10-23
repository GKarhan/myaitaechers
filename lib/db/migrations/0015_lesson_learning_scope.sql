-- Nullable for existing sessions; new scope selections are immutable per run.
ALTER TABLE lesson_sessions ADD COLUMN IF NOT EXISTS learning_scope jsonb;
