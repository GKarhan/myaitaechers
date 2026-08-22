/**
 * C4 self-cleaning PostgreSQL acceptance trace.
 *
 * Run:
 *   DATABASE_URL=$TEST_DATABASE_URL \
 *   pnpm --filter @workspace/api-server test:c4-ceiling-trace
 */
import assert from "node:assert/strict";
import { Client } from "pg";
import { assertTestDb } from "../../lib/__tests__/helpers/test-db.js";
import { projectLearnerCognitiveCeiling } from "../learner-cognitive-ceiling.js";

assertTestDb();

const client = new Client({ connectionString: process.env.DATABASE_URL });
const tag = `c4-ceiling-trace-${Date.now()}`;
let lessonId: number | null = null;
let nodeId: number | null = null;
let knowledgeNodeId: number | null = null;
let quizId: number | null = null;
let quizQuestionId: number | null = null;
let levelIds: number[] = [];
let evidenceIds: number[] = [];

async function cleanup(): Promise<void> {
  if (evidenceIds.length) {
    await client.query("DELETE FROM evidence_events WHERE id = ANY($1::int[])", [evidenceIds]);
  }
  if (quizQuestionId) await client.query("DELETE FROM quiz_questions WHERE id = $1", [quizQuestionId]);
  if (quizId) await client.query("DELETE FROM quizzes WHERE id = $1", [quizId]);
  if (knowledgeNodeId) await client.query("DELETE FROM knowledge_nodes WHERE id = $1", [knowledgeNodeId]);
  if (levelIds.length) {
    await client.query(
      "DELETE FROM lesson_node_cognitive_levels WHERE id = ANY($1::int[])",
      [levelIds],
    );
  }
  if (nodeId) await client.query("DELETE FROM lesson_nodes WHERE id = $1", [nodeId]);
  if (lessonId) await client.query("DELETE FROM lessons WHERE id = $1", [lessonId]);
}

async function insertEvidence(input: {
  userId: number;
  topicId: number;
  levelId: number | null;
  taskSource: "micro_check" | "quiz_question";
  taskReference: string | null;
  quizQuestionId?: number | null;
  qualificationStatus?: "qualified" | "unqualified" | null;
  wasCorrect?: boolean;
}): Promise<number> {
  const result = await client.query<{ id: number }>(
    `INSERT INTO evidence_events
       (user_id, topic_id, event_type, was_correct, hint_used, metadata,
        lesson_node_id, cognitive_level_id, quiz_question_id,
        task_source, task_reference, qualification_status, evidence_quality,
        assistance_level, help_count)
     VALUES ($1, $2, 'answer', $3, false, $4::jsonb, $5, $6, $7,
             $8, $9, $10, 'MODERATE', 'none', 0)
     RETURNING id`,
    [
      input.userId,
      input.topicId,
      input.wasCorrect ?? true,
      JSON.stringify({ source: "c4-trace", tag }),
      nodeId,
      input.levelId,
      input.quizQuestionId ?? null,
      input.taskSource,
      input.taskReference,
      input.qualificationStatus === undefined
        ? "qualified"
        : input.qualificationStatus,
    ],
  );
  const id = result.rows[0]!.id;
  evidenceIds.push(id);
  return id;
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
    ALTER TABLE knowledge_nodes
      ADD COLUMN IF NOT EXISTS demonstrated_cognitive_level_id integer REFERENCES lesson_node_cognitive_levels(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS demonstrated_cognitive_level_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS demonstrated_cognitive_evidence_reference text;
  `);

  const user = await client.query<{ id: number }>("SELECT id FROM users ORDER BY id LIMIT 1");
  const subject = await client.query<{ id: number }>("SELECT id FROM subjects ORDER BY id LIMIT 1");
  assert.ok(user.rows[0] && subject.rows[0], "test database needs user and subject fixtures");

  lessonId = (await client.query<{ id: number }>(
    `INSERT INTO lessons (subject_id, title, content, status)
     VALUES ($1, $2, $3, 'draft') RETURNING id`,
    [subject.rows[0].id, tag, "remember understand apply analyze concept"],
  )).rows[0]!.id;
  nodeId = (await client.query<{ id: number }>(
    `INSERT INTO lesson_nodes
       (lesson_id, sequence, title, theory_content, learning_objective, cog_path_status, status)
     VALUES ($1, 1, $2, $3, $4, 'confirmed', 'approved') RETURNING id`,
    [
      lessonId,
      tag,
      "remember understand apply analyze concept",
      "remember understand apply analyze concept",
    ],
  )).rows[0]!.id;

  for (const [sequence, cognitiveLevel, target] of [
    [1, "remember", false],
    [2, "understand", false],
    [3, "apply", false],
    [4, "analyze", true],
  ] as const) {
    const level = await client.query<{ id: number }>(
      `INSERT INTO lesson_node_cognitive_levels
         (lesson_node_id, cognitive_level, sequence, is_target_ceiling,
          performance_objective, success_criterion, minimum_independent_evidence)
       VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING id`,
      [
        nodeId,
        cognitiveLevel,
        sequence,
        target,
        `${cognitiveLevel} concept`,
        `${cognitiveLevel} concept`,
      ],
    );
    levelIds.push(level.rows[0]!.id);
  }

  knowledgeNodeId = (await client.query<{ id: number }>(
    `INSERT INTO knowledge_nodes
       (subject_id, user_id, topic_name, lesson_node_id, demonstrated_cognitive_level)
     VALUES ($1, $2, $3, $4, 'analyze') RETURNING id`,
    [subject.rows[0].id, user.rows[0].id, tag, nodeId],
  )).rows[0]!.id;

  quizId = (await client.query<{ id: number }>(
    `INSERT INTO quizzes (teacher_id, subject_id, node_ids, title, question_count)
     VALUES ($1, $2, $3::jsonb, $4, 1) RETURNING id`,
    [user.rows[0].id, subject.rows[0].id, JSON.stringify([nodeId]), tag],
  )).rows[0]!.id;
  quizQuestionId = (await client.query<{ id: number }>(
    `INSERT INTO quiz_questions
       (quiz_id, node_id, question_text, options, correct_option_index, sequence, cognitive_level_id)
     VALUES ($1, $2, $3, $4::jsonb, 0, 1, $5) RETURNING id`,
    [quizId, nodeId, tag, JSON.stringify(["a", "b", "c", "d"]), levelIds[1]],
  )).rows[0]!.id;

  // Legacy snapshot text is retained for compatibility but can never be
  // returned as a C4 ceiling before qualified C3 proof exists.
  const legacyOnlyProjection = await projectLearnerCognitiveCeiling(
    user.rows[0].id,
    nodeId,
  );
  assert.equal(legacyOnlyProjection.ceilingLevelId, null);
  assert.equal(legacyOnlyProjection.ceilingLevel, null);

  // Gap scenario: REMEMBER and APPLY exist, but UNDERSTAND does not.
  await insertEvidence({
    userId: user.rows[0].id,
    topicId: knowledgeNodeId,
    levelId: levelIds[0],
    taskSource: "micro_check",
    taskReference: "micro_check:c4-remember",
  });
  await insertEvidence({
    userId: user.rows[0].id,
    topicId: knowledgeNodeId,
    levelId: levelIds[2],
    taskSource: "micro_check",
    taskReference: "micro_check:c4-apply",
  });
  await insertEvidence({
    userId: user.rows[0].id,
    topicId: knowledgeNodeId,
    levelId: levelIds[3],
    taskSource: "micro_check",
    taskReference: "micro_check:c4-legacy",
    qualificationStatus: null,
  });
  await insertEvidence({
    userId: user.rows[0].id,
    topicId: knowledgeNodeId,
    levelId: levelIds[3],
    taskSource: "micro_check",
    taskReference: "micro_check:c4-unqualified",
    qualificationStatus: "unqualified",
  });

  const gapProjection = await projectLearnerCognitiveCeiling(user.rows[0].id, nodeId);
  assert.equal(gapProjection.ceilingLevelId, levelIds[0], "gap must stop at REMEMBER");

  // Add a Quiz-style qualified UNDERSTAND event. The exact same projector now
  // sees the Chat-style micro-checks plus this quiz evidence and reaches APPLY.
  await insertEvidence({
    userId: user.rows[0].id,
    topicId: knowledgeNodeId,
    levelId: levelIds[1],
    taskSource: "quiz_question",
    taskReference: `quiz_question:${quizQuestionId}`,
    quizQuestionId,
  });
  const applyProjection = await projectLearnerCognitiveCeiling(user.rows[0].id, nodeId);
  assert.equal(applyProjection.ceilingLevelId, levelIds[2]);
  assert.equal(applyProjection.ceilingLevel, "apply");

  const persisted = await client.query<{
    demonstrated_cognitive_level_id: number | null;
    demonstrated_cognitive_level: string | null;
    demonstrated_cognitive_evidence_reference: string | null;
  }>(
    `SELECT demonstrated_cognitive_level_id, demonstrated_cognitive_level,
            demonstrated_cognitive_evidence_reference
     FROM knowledge_nodes WHERE id = $1`,
    [knowledgeNodeId],
  );
  assert.deepEqual(persisted.rows[0], {
    demonstrated_cognitive_level_id: levelIds[2],
    demonstrated_cognitive_level: "apply",
    demonstrated_cognitive_evidence_reference: "micro_check:c4-apply",
  });

  // SESSION_TIME_LIMIT uses the same lock but must not overwrite an earlier
  // remediation reason before a target ceiling is reached.
  await client.query(
    `UPDATE knowledge_nodes
     SET revisit_required = true, revisit_reason = 'REMEDIATION_EXHAUSTED'
     WHERE id = $1`,
    [knowledgeNodeId],
  );
  await projectLearnerCognitiveCeiling(user.rows[0].id, nodeId, {
    revisitRequest: { reason: "SESSION_TIME_LIMIT", onlyIfUnset: true },
  });
  const preservedRevisit = await client.query<{
    revisit_required: boolean;
    revisit_reason: string | null;
  }>(
    "SELECT revisit_required, revisit_reason FROM knowledge_nodes WHERE id = $1",
    [knowledgeNodeId],
  );
  assert.deepEqual(preservedRevisit.rows[0], {
    revisit_required: true,
    revisit_reason: "REMEDIATION_EXHAUSTED",
  });

  // A later failed higher-level answer cannot erase the legitimate APPLY ceiling.
  await insertEvidence({
    userId: user.rows[0].id,
    topicId: knowledgeNodeId,
    levelId: levelIds[3],
    taskSource: "micro_check",
    taskReference: "micro_check:c4-analyze-failure",
    wasCorrect: false,
  });
  const afterFailure = await projectLearnerCognitiveCeiling(user.rows[0].id, nodeId);
  assert.equal(afterFailure.ceilingLevelId, levelIds[2]);

  // Revisit requests and target confirmation are serialized in the same
  // projector transaction; the newly confirmed target wins and clears revisit.
  await insertEvidence({
    userId: user.rows[0].id,
    topicId: knowledgeNodeId,
    levelId: levelIds[3],
    taskSource: "micro_check",
    taskReference: "micro_check:c4-analyze-success",
  });
  const targetProjection = await projectLearnerCognitiveCeiling(
    user.rows[0].id,
    nodeId,
    { revisitRequest: { reason: "REMEDIATION_EXHAUSTED" } },
  );
  assert.equal(targetProjection.ceilingLevelId, levelIds[3]);
  const revisitState = await client.query<{
    revisit_required: boolean;
    revisit_reason: string | null;
  }>(
    "SELECT revisit_required, revisit_reason FROM knowledge_nodes WHERE id = $1",
    [knowledgeNodeId],
  );
  assert.deepEqual(revisitState.rows[0], {
    revisit_required: false,
    revisit_reason: null,
  });

  console.log("C4 database acceptance trace passed: contiguous, qualified, parity, and monotonic persistence");
} finally {
  try {
    await cleanup();
  } finally {
    await client.end();
  }
}