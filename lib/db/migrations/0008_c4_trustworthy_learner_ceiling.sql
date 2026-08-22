-- C4: additive learner × MicroNode projection for trustworthy cognitive ceilings.
-- Existing text-only ceilings remain untouched; no historical evidence is inferred.

ALTER TABLE knowledge_nodes
  ADD COLUMN IF NOT EXISTS demonstrated_cognitive_level_id integer
    REFERENCES lesson_node_cognitive_levels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS demonstrated_cognitive_level_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS demonstrated_cognitive_evidence_reference text;

-- Supports the shared projector's qualified evidence lookup without changing
-- legacy scoring behavior or historical evidence rows.
CREATE INDEX IF NOT EXISTS evidence_events_c4_qualified_lookup_idx
  ON evidence_events (user_id, lesson_node_id, cognitive_level_id, created_at)
  WHERE qualification_status = 'qualified' AND was_correct = true;