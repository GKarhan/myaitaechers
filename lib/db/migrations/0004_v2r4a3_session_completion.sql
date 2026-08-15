-- V2-R4A.3: Required-session completion + optional continuation
-- Non-destructive, idempotent (IF NOT EXISTS on every column).

-- ── lesson_sessions ──────────────────────────────────────────────────────────

ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS required_session_completed_at TIMESTAMPTZ;

ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS optional_continuation BOOLEAN NOT NULL DEFAULT false;
