-- Migration 0003: V2-R4A Learning Budget Foundation
--
-- Adds required-session budget and active-learning-time tracking fields.
-- All additions use IF NOT EXISTS / DO blocks for idempotency.
-- No destructive changes; all new columns have safe defaults or are nullable.
--
-- R4A.1 fields:
--   lessons.required_session_minutes
--   lesson_sessions.required_session_minutes
--   lesson_sessions.active_learning_seconds
--   lesson_sessions.last_activity_at
--
-- R4A.2 support:
--   knowledge_nodes.revisit_reason
--
-- Deferred (R4A.3):
--   lesson_sessions.required_session_completed_at
--   lesson_sessions.optional_continuation

-- ── lessons ──────────────────────────────────────────────────────────────────

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS required_session_minutes INTEGER;

-- ── lesson_sessions ───────────────────────────────────────────────────────────

ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS required_session_minutes INTEGER;

ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS active_learning_seconds INTEGER NOT NULL DEFAULT 0;

ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

-- ── knowledge_nodes ───────────────────────────────────────────────────────────

ALTER TABLE knowledge_nodes
  ADD COLUMN IF NOT EXISTS revisit_reason TEXT;
