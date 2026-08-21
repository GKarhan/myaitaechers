-- Package 1A / C1 curriculum foundation.
-- Additive only: legacy lessons.lesson_outcomes JSON is intentionally retained.

CREATE TABLE IF NOT EXISTS lesson_outcomes (
  id SERIAL PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  outcome_text TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  provenance TEXT NOT NULL DEFAULT 'teacher_authored',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lo_status_chk CHECK (status IN ('draft','reviewed','approved')),
  CONSTRAINT lo_provenance_chk CHECK (provenance IN ('teacher_authored','legacy_backfill','mapping_import'))
);

CREATE UNIQUE INDEX IF NOT EXISTS lo_lesson_sequence_uidx ON lesson_outcomes (lesson_id, sequence);
CREATE INDEX IF NOT EXISTS lo_lesson_idx ON lesson_outcomes (lesson_id);

CREATE TABLE IF NOT EXISTS lesson_outcome_node_alignments (
  id SERIAL PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  lesson_outcome_id INTEGER NOT NULL REFERENCES lesson_outcomes(id) ON DELETE CASCADE,
  lesson_node_id INTEGER NOT NULL REFERENCES lesson_nodes(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  required_cognitive_depth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lona_role_chk CHECK (role IN ('REQUIRED','SUPPORTING')),
  CONSTRAINT lona_depth_chk CHECK (required_cognitive_depth IN ('remember','understand','apply','analyze','evaluate','create'))
);

CREATE UNIQUE INDEX IF NOT EXISTS lona_outcome_node_uidx
  ON lesson_outcome_node_alignments (lesson_outcome_id, lesson_node_id);
CREATE INDEX IF NOT EXISTS lona_lesson_idx ON lesson_outcome_node_alignments (lesson_id);
CREATE INDEX IF NOT EXISTS lona_node_idx ON lesson_outcome_node_alignments (lesson_node_id);