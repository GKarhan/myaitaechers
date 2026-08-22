/**
 * Provider-free PostgreSQL acceptance trace for C3.
 *
 * It creates only tagged rows in heliumdb_test and deletes them in finally.
 * Run with:
 *   DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/c3-persisted-evidence-trace.test.ts
 */
import assert from "node:assert/strict";
import { Client } from "pg";

const client = new Client({ connectionString: process.env.DATABASE_URL });
const tag = `c3-trace-${Date.now()}`;
let lessonId: number | null = null;
let nodeId: number | null = null;
let levelId: number | null = null;
let exerciseId: number | null = null;
let knowledgeNodeId: number | null = null;
let qualifiedEvidenceId: number | null = null;
let legacyEvidenceId: number | null = null;

async function cleanup(): Promise<void> {
  if (qualifiedEvidenceId || legacyEvidenceId) {
    await client.query(
      "DELETE FROM evidence_events WHERE id = ANY($1::int[])",
      [[qualifiedEvidenceId, legacyEvidenceId].filter((id): id is number => id !== null)],
    );
  }
  if (levelId) {
    await client.query("DELETE FROM lesson_node_cognitive_tasks WHERE cognitive_level_id = $1", [levelId]);
  }
  if (exerciseId) await client.query("DELETE FROM lesson_exercises WHERE id = $1", [exerciseId]);
  if (knowledgeNodeId) await client.query("DELETE FROM knowledge_nodes WHERE id = $1", [knowledgeNodeId]);
  if (levelId) await client.query("DELETE FROM lesson_node_cognitive_levels WHERE id = $1", [levelId]);
  if (nodeId) await client.query("DELETE FROM lesson_nodes WHERE id = $1", [nodeId]);
  if (lessonId) await client.query("DELETE FROM lessons WHERE id = $1", [lessonId]);
}

try {
  await client.connect();
  await client.query(`
    ALTER TABLE evidence_events
      ADD COLUMN IF NOT EXISTS lesson_node_id integer REFERENCES lesson_nodes(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS cognitive_level_id integer REFERENCES lesson_node_cognitive_levels(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS quiz_question_id integer REFERENCES quiz_questions(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS quiz_attempt_id integer REFERENCES quiz_attempts(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS task_source text,
      ADD COLUMN IF NOT EXISTS task_reference text,
      ADD COLUMN IF NOT EXISTS qualification_status text,
      ADD COLUMN IF NOT EXISTS evidence_quality text;
  `);

  const user = await client.query<{ id: number }>("SELECT id FROM users ORDER BY id LIMIT 1");
  const subject = await client.query<{ id: number }>("SELECT id FROM subjects ORDER BY id LIMIT 1");
  assert.ok(user.rows[0] && subject.rows[0], "test database needs one user and one subject fixture");

  lessonId = (await client.query<{ id: number }>(
    `INSERT INTO lessons (subject_id, title, content, status)
     VALUES ($1, $2, $3, 'draft') RETURNING id`,
    [subject.rows[0].id, tag, "Provider-free C3 trace"],
  )).rows[0].id;
  nodeId = (await client.query<{ id: number }>(
    `INSERT INTO lesson_nodes
       (lesson_id, sequence, title, theory_content, learning_objective, cog_path_status, status)
     VALUES ($1, 1, $2, $3, $4, 'confirmed', 'approved') RETURNING id`,
    [lessonId, tag, "Trace theory", "Apply the trace concept"],
  )).rows[0].id;
  levelId = (await client.query<{ id: number }>(
    `INSERT INTO lesson_node_cognitive_levels
       (lesson_node_id, cognitive_level, sequence, is_target_ceiling, performance_objective, success_criterion)
     VALUES ($1, 'apply', 1, true, 'Apply the trace concept', 'Correct answer') RETURNING id`,
    [nodeId],
  )).rows[0].id;
  exerciseId = (await client.query<{ id: number }>(
    `INSERT INTO lesson_exercises
       (lesson_id, exercise_id, exercise_text_verbatim, related_node_id, assignment, sequence, status, correct_answer)
     VALUES ($1, $2, '2 + 2 = ?', $3, 'CLASS', 1, 'approved', '4') RETURNING id`,
    [lessonId, tag, nodeId],
  )).rows[0].id;
  await client.query(
    `INSERT INTO lesson_node_cognitive_tasks (cognitive_level_id, lesson_exercise_id)
     VALUES ($1, $2)`,
    [levelId, exerciseId],
  );
  knowledgeNodeId = (await client.query<{ id: number }>(
    `INSERT INTO knowledge_nodes (subject_id, user_id, topic_name, lesson_node_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [subject.rows[0].id, user.rows[0].id, tag, nodeId],
  )).rows[0].id;

  qualifiedEvidenceId = (await client.query<{ id: number }>(
    `INSERT INTO evidence_events
       (user_id, topic_id, event_type, was_correct, metadata, lesson_exercise_id,
        lesson_node_id, cognitive_level_id, task_source, task_reference,
        qualification_status, evidence_quality, assistance_level, attempt_sequence, help_count)
     VALUES ($1, $2, 'answer', true, $3::jsonb, $4, $5, $6, 'source_exercise', $7,
             'qualified', 'MODERATE', 'light', 2, 1)
     RETURNING id`,
    [
      user.rows[0].id,
      knowledgeNodeId,
      JSON.stringify({ source: "c3-persisted-trace", tag }),
      exerciseId,
      nodeId,
      levelId,
      `source_exercise:${exerciseId}`,
    ],
  )).rows[0].id;
  legacyEvidenceId = (await client.query<{ id: number }>(
    `INSERT INTO evidence_events (user_id, topic_id, event_type, was_correct, metadata)
     VALUES ($1, $2, 'answer', false, $3::jsonb) RETURNING id`,
    [user.rows[0].id, knowledgeNodeId, JSON.stringify({ source: "legacy-compatibility", tag })],
  )).rows[0].id;

  const qualified = await client.query(
    `SELECT lesson_node_id, cognitive_level_id, lesson_exercise_id, task_source,
            task_reference, qualification_status, evidence_quality,
            assistance_level, attempt_sequence, help_count
     FROM evidence_events WHERE id = $1`,
    [qualifiedEvidenceId],
  );
  assert.deepEqual(qualified.rows[0], {
    lesson_node_id: nodeId,
    cognitive_level_id: levelId,
    lesson_exercise_id: exerciseId,
    task_source: "source_exercise",
    task_reference: `source_exercise:${exerciseId}`,
    qualification_status: "qualified",
    evidence_quality: "MODERATE",
    assistance_level: "light",
    attempt_sequence: 2,
    help_count: 1,
  });

  const legacy = await client.query(
    `SELECT cognitive_level_id, task_source, task_reference, qualification_status
     FROM evidence_events WHERE id = $1`,
    [legacyEvidenceId],
  );
  assert.deepEqual(legacy.rows[0], {
    cognitive_level_id: null,
    task_source: null,
    task_reference: null,
    qualification_status: null,
  });

  console.log("C3 persisted evidence trace passed: qualified + legacy compatibility");
} finally {
  try {
    await cleanup();
  } finally {
    await client.end();
  }
}