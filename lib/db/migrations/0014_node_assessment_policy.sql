-- Additive and idempotent. NULL preserves legacy quizzes and evidence.
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS assessment_config jsonb;
