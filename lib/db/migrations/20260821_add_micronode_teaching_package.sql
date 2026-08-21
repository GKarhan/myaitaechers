-- Package 1B / C1 structured, teacher-reviewable MicroNode teaching material.
-- Additive only: source fields on lesson_nodes and existing exercise/task tables
-- remain canonical for source fidelity and learner tasks.

CREATE TABLE IF NOT EXISTS lesson_node_teaching_package_items (
  id SERIAL PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  lesson_node_id INTEGER NOT NULL REFERENCES lesson_nodes(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  content TEXT NOT NULL,
  cognitive_level TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  provenance TEXT NOT NULL DEFAULT 'teacher_created',
  is_primary BOOLEAN NOT NULL DEFAULT false,
  resource_id INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  source_item_key TEXT,
  sequence INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lntpi_type_chk CHECK (item_type IN ('MAIN_EXPLANATION','KEY_FACT','RULE_OR_FORMULA','EXAMPLE','COUNTEREXAMPLE','MISCONCEPTION','ALTERNATIVE_EXPLANATION','GUIDING_QUESTION','HINT','RESOURCE')),
  CONSTRAINT lntpi_status_chk CHECK (status IN ('draft','reviewed','approved')),
  CONSTRAINT lntpi_provenance_chk CHECK (provenance IN ('source_material','teacher_created','ai_generated','ai_generated_teacher_approved')),
  CONSTRAINT lntpi_cognitive_level_chk CHECK (cognitive_level IS NULL OR cognitive_level IN ('remember','understand','apply','analyze','evaluate','create')),
  CONSTRAINT lntpi_primary_type_chk CHECK (is_primary = false OR item_type = 'MAIN_EXPLANATION'),
  CONSTRAINT lntpi_sequence_chk CHECK (sequence >= 1)
);

-- The pair is intentionally constrained, not merely validated by routes: the
-- denormalized lesson_id must always be the lesson that owns lesson_node_id.
CREATE UNIQUE INDEX IF NOT EXISTS lesson_nodes_id_lesson_uidx
  ON lesson_nodes (id, lesson_id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lntpi_node_lesson_fk'
  ) THEN
    ALTER TABLE lesson_node_teaching_package_items
      ADD CONSTRAINT lntpi_node_lesson_fk
      FOREIGN KEY (lesson_node_id, lesson_id)
      REFERENCES lesson_nodes (id, lesson_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS lntpi_node_type_sequence_uidx
  ON lesson_node_teaching_package_items (lesson_node_id, item_type, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS lntpi_node_source_key_uidx
  ON lesson_node_teaching_package_items (lesson_node_id, source_item_key)
  WHERE source_item_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lntpi_primary_approved_explanation_uidx
  ON lesson_node_teaching_package_items (lesson_node_id)
  WHERE item_type = 'MAIN_EXPLANATION' AND status = 'approved' AND is_primary = true;
CREATE INDEX IF NOT EXISTS lntpi_lesson_idx ON lesson_node_teaching_package_items (lesson_id);
CREATE INDEX IF NOT EXISTS lntpi_node_idx ON lesson_node_teaching_package_items (lesson_node_id);