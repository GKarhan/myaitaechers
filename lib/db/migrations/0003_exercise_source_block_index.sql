-- P3.4: Add source_block_index to lesson_exercises for MAPPING → SOURCE traceability.
-- Nullable: existing rows (created before this migration) correctly receive NULL.
ALTER TABLE lesson_exercises ADD COLUMN IF NOT EXISTS source_block_index integer;
