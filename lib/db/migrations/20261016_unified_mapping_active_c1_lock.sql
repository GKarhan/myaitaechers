-- Prevent two concurrent C1 map jobs for one lesson across API instances.
-- Prerequisite: inspect existing pending/running duplicate jobs; this migration
-- deliberately fails instead of deleting or altering an in-progress job.
-- This index does not recover orphaned jobs after a process restart.
CREATE UNIQUE INDEX IF NOT EXISTS mapping_jobs_one_active_c1_per_lesson
  ON mapping_jobs (lesson_id)
  WHERE job_type = 'map' AND status IN ('pending', 'running');
