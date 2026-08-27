ALTER TABLE "quiz_generation_jobs"
  ADD COLUMN IF NOT EXISTS "error_details" jsonb;