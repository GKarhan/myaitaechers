-- Migration 0005: backend-owned answer keys for objective AI MICRO_CHECKs.
-- Nullable and idempotent: null means no active objective AI-generated task.

ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS active_objective_task_payload JSONB;