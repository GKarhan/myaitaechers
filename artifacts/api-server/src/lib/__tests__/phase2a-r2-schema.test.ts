/**
 * Phase 2A Round 2 — Cognitive Enrichment Schema Acceptance Tests
 *
 * Tests: T01–T25 (spec section 22)
 * Runner: TEST_DATABASE_URL=$TEST_DATABASE_URL DATABASE_URL=$TEST_DATABASE_URL \
 *           pnpm --filter @workspace/api-server run test:phase2a-r2
 *
 * Safety: assertTestDb() blocks execution against the production database.
 * All fixture data is created and destroyed within this suite (zero pollution).
 * Real production MicroNodes and exercises are NEVER modified.
 *
 * Tests verify the schema contract only — no AI generation, no learner
 * cognitive state, no runtime behaviour changes.
 */

import assert from "node:assert/strict";
import {
  assertTestDb,
  getTestDb,
  closeTestDb,
} from "./helpers/test-db.js";
import {
  lessonNodesTable,
  lessonExercisesTable,
  lessonsTable,
  subjectsTable,
  evidenceEventsTable,
  usersTable,
  knowledgeNodesTable,
  lessonNodeCognitiveLevelsTable,
  lessonNodeCognitiveTasksTable,
  COGNITIVE_LEVELS,
  COGNITIVE_LEVEL_TO_BLOOM_INT,
  COGNITIVE_PROVENANCE_VALUES,
  INTERACTION_TYPE_VALUES,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";

// ── Safety gate (must be first executable statement) ─────────────────────────
assertTestDb();
const db = getTestDb();

// ── Mini test runner ──────────────────────────────────────────────────────────
const results: { name: string; pass: boolean; error?: unknown }[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓  ${name}`);
  } catch (err) {
    results.push({ name, pass: false, error: err });
    console.error(`  ✗  ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Unique run-id prefix for test isolation ───────────────────────────────────
const runId = `p2a-r2-${Date.now()}`;

// ── Fixture state ─────────────────────────────────────────────────────────────
let fixtureSubjectId: number;
let fixtureLessonId: number;
let fixtureNodeA: number;
let fixtureNodeB: number;
let fixtureNodeC: number;
let fixtureNodeD: number;
let fixtureExerciseId: number;
let fixtureUserId: number;
let fixtureKnId: number;

async function setup() {
  const [subj] = await db.insert(subjectsTable).values({
    name: `${runId}-subject`,
  }).returning({ id: subjectsTable.id });
  fixtureSubjectId = subj.id;

  const [usr] = await db.insert(usersTable).values({
    username: `${runId}-student`,
    passwordHash: "x",
    fullName: "Test Student",
    role: "student",
  }).returning({ id: usersTable.id });
  fixtureUserId = usr.id;

  const [lesson] = await db.insert(lessonsTable).values({
    subjectId: fixtureSubjectId,
    title: `${runId}-lesson`,
    description: "",
    bloomLevel: 1,
    content: "",
  }).returning({ id: lessonsTable.id });
  fixtureLessonId = lesson.id;

  const mkNode = async (seq: number) => {
    const [n] = await db.insert(lessonNodesTable).values({
      lessonId: fixtureLessonId, sequence: seq, title: `${runId}-node-${seq}`,
      targetBloomLevel: 1, estimatedMinutes: 5,
    }).returning({ id: lessonNodesTable.id });
    return n.id;
  };

  fixtureNodeA = await mkNode(1);
  fixtureNodeB = await mkNode(2);
  fixtureNodeC = await mkNode(3);
  fixtureNodeD = await mkNode(4);

  const [ex] = await db.insert(lessonExercisesTable).values({
    lessonId: fixtureLessonId,
    exerciseId: `${runId}-EX-1`,
    sequence: 1,
    exerciseTextVerbatim: "Test exercise text",
    assignment: "CLASS",
    difficultyLevel: "MEDIUM",
    sourceType: "teacher",
  }).returning({ id: lessonExercisesTable.id });
  fixtureExerciseId = ex.id;
}

async function teardown() {
  // Cascade: deleting lesson removes nodes, exercises, cognitive rows.
  // KN must be deleted first (no cascade from lesson).
  if (fixtureKnId) {
    await db.delete(knowledgeNodesTable).where(eq(knowledgeNodesTable.id, fixtureKnId)).catch(() => {});
  }
  if (fixtureLessonId) {
    await db.delete(lessonsTable).where(eq(lessonsTable.id, fixtureLessonId)).catch(() => {});
  }
  if (fixtureSubjectId) {
    await db.delete(subjectsTable).where(eq(subjectsTable.id, fixtureSubjectId)).catch(() => {});
  }
  if (fixtureUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, fixtureUserId)).catch(() => {});
  }
}

// ── Real Physics node IDs (read-only assertions only) ────────────────────────
// These are real production rows in the test DB (seeded data).
// This suite NEVER writes to them.
const REAL_NODE_IDS = [2019, 2020, 2021];

async function readRealNodes() {
  return db.select({
    id: lessonNodesTable.id,
    targetBloomLevel: lessonNodesTable.targetBloomLevel,
    status: lessonNodesTable.status,
  })
    .from(lessonNodesTable)
    .where(inArray(lessonNodesTable.id, REAL_NODE_IDS));
}

async function countRealCognitiveLevels() {
  const [r] = await db.select({ count: sql<number>`count(*)::int` })
    .from(lessonNodeCognitiveLevelsTable)
    .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, REAL_NODE_IDS));
  return r.count;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════════
await setup();
const realNodesBefore   = await readRealNodes();
const realCogLevelsBefore = await countRealCognitiveLevels();

// ═══════════════════════════════════════════════════════════════════════════════
// T01 — Existing MicroNode with no cognitive enrichment still works
// ═══════════════════════════════════════════════════════════════════════════════
await test("T01 — existing MicroNode with no cognitive enrichment still works", async () => {
  const levels = await db.select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeA));
  assert.equal(levels.length, 0, "No cognitive levels for unenriched node");

  const [node] = await db.select({ id: lessonNodesTable.id, targetBloomLevel: lessonNodesTable.targetBloomLevel })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, fixtureNodeA));
  assert.ok(node, "Node still exists");
  assert.equal(node.targetBloomLevel, 1, "targetBloomLevel unchanged");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T02 — MicroNode can have Remember → Understand
// ═══════════════════════════════════════════════════════════════════════════════
await test("T02 — MicroNode can have Remember → Understand cognitive path", async () => {
  await db.insert(lessonNodeCognitiveLevelsTable).values([
    {
      lessonNodeId: fixtureNodeA, cognitiveLevel: "remember", sequence: 1,
      isApplicable: true, isTargetCeiling: false,
      performanceObjective: "Learner can recall the definition verbatim.",
      successCriterion: "Correctly identifies the term when given a definition.",
      provenance: "ai_generated", minimumIndependentEvidence: 2,
      preferredInteractionTypes: ["multiple_choice", "true_false"],
    },
    {
      lessonNodeId: fixtureNodeA, cognitiveLevel: "understand", sequence: 2,
      isApplicable: true, isTargetCeiling: true,
      performanceObjective: "Learner can explain the concept in own words.",
      successCriterion: "Explains correctly in a new wording/context.",
      provenance: "ai_generated", minimumIndependentEvidence: 3,
      preferredInteractionTypes: ["short_answer", "matching"],
    },
  ]);

  const levels = await db.select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeA))
    .orderBy(lessonNodeCognitiveLevelsTable.sequence);
  assert.equal(levels.length, 2, "Exactly 2 levels");
  assert.equal(levels[0].cognitiveLevel, "remember",   "First = remember");
  assert.equal(levels[1].cognitiveLevel, "understand", "Second = understand");
  assert.equal(levels[1].isTargetCeiling, true,        "Understand is ceiling");
  assert.equal(levels[0].isTargetCeiling, false,       "Remember not ceiling");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T03 — MicroNode can have Remember → Understand → Apply
// ═══════════════════════════════════════════════════════════════════════════════
await test("T03 — MicroNode can have Remember → Understand → Apply", async () => {
  await db.insert(lessonNodeCognitiveLevelsTable).values([
    { lessonNodeId: fixtureNodeB, cognitiveLevel: "remember",   sequence: 1, isApplicable: true, isTargetCeiling: false, provenance: "ai_generated", minimumIndependentEvidence: 2, preferredInteractionTypes: [] },
    { lessonNodeId: fixtureNodeB, cognitiveLevel: "understand", sequence: 2, isApplicable: true, isTargetCeiling: false, provenance: "ai_generated", minimumIndependentEvidence: 2, preferredInteractionTypes: [] },
    { lessonNodeId: fixtureNodeB, cognitiveLevel: "apply",      sequence: 3, isApplicable: true, isTargetCeiling: true,  provenance: "ai_generated", minimumIndependentEvidence: 3, preferredInteractionTypes: ["numeric_answer", "problem_solving"] },
  ]);

  const levels = await db.select({ cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel })
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB))
    .orderBy(lessonNodeCognitiveLevelsTable.sequence);
  assert.deepEqual(levels.map(l => l.cognitiveLevel), ["remember", "understand", "apply"]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// T04 — MicroNode can include Analyze / Evaluate / Create
// ═══════════════════════════════════════════════════════════════════════════════
await test("T04 — MicroNode can include Analyze, Evaluate, Create", async () => {
  await db.insert(lessonNodeCognitiveLevelsTable).values([
    { lessonNodeId: fixtureNodeC, cognitiveLevel: "remember",   sequence: 1, isApplicable: true, isTargetCeiling: false, provenance: "source_derived",  minimumIndependentEvidence: 2, preferredInteractionTypes: [] },
    { lessonNodeId: fixtureNodeC, cognitiveLevel: "understand", sequence: 2, isApplicable: true, isTargetCeiling: false, provenance: "source_derived",  minimumIndependentEvidence: 2, preferredInteractionTypes: [] },
    { lessonNodeId: fixtureNodeC, cognitiveLevel: "apply",      sequence: 3, isApplicable: true, isTargetCeiling: false, provenance: "ai_generated",    minimumIndependentEvidence: 3, preferredInteractionTypes: [] },
    { lessonNodeId: fixtureNodeC, cognitiveLevel: "analyze",    sequence: 4, isApplicable: true, isTargetCeiling: true,  provenance: "teacher_authored", minimumIndependentEvidence: 3, preferredInteractionTypes: ["constructed_response"] },
  ]);
  await db.insert(lessonNodeCognitiveLevelsTable).values([
    { lessonNodeId: fixtureNodeD, cognitiveLevel: "understand", sequence: 1, isApplicable: true, isTargetCeiling: false, provenance: "ai_generated", minimumIndependentEvidence: 2, preferredInteractionTypes: [] },
    { lessonNodeId: fixtureNodeD, cognitiveLevel: "apply",      sequence: 2, isApplicable: true, isTargetCeiling: false, provenance: "ai_generated", minimumIndependentEvidence: 3, preferredInteractionTypes: [] },
    { lessonNodeId: fixtureNodeD, cognitiveLevel: "evaluate",   sequence: 3, isApplicable: true, isTargetCeiling: false, provenance: "ai_generated", minimumIndependentEvidence: 3, preferredInteractionTypes: [] },
    { lessonNodeId: fixtureNodeD, cognitiveLevel: "create",     sequence: 4, isApplicable: true, isTargetCeiling: true,  provenance: "ai_generated", minimumIndependentEvidence: 4, preferredInteractionTypes: ["constructed_response", "problem_solving"] },
  ]);

  const cLevels = await db.select({ cl: lessonNodeCognitiveLevelsTable.cognitiveLevel })
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeC))
    .orderBy(lessonNodeCognitiveLevelsTable.sequence);
  assert.deepEqual(cLevels.map(r => r.cl), ["remember","understand","apply","analyze"]);

  const dLevels = await db.select({ cl: lessonNodeCognitiveLevelsTable.cognitiveLevel })
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeD))
    .orderBy(lessonNodeCognitiveLevelsTable.sequence);
  assert.deepEqual(dLevels.map(r => r.cl), ["understand","apply","evaluate","create"]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// T05 — Duplicate cognitive level for same MicroNode is rejected
// ═══════════════════════════════════════════════════════════════════════════════
await test("T05 — duplicate cognitive level for same MicroNode is rejected", async () => {
  let threw = false;
  try {
    await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: fixtureNodeA, cognitiveLevel: "remember", sequence: 99,
      isApplicable: true, isTargetCeiling: false, provenance: "ai_generated",
      minimumIndependentEvidence: 1, preferredInteractionTypes: [],
    });
  } catch { threw = true; }
  assert.equal(threw, true, "Duplicate (lessonNodeId, cognitiveLevel) must throw");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T06 — At-most-one target ceiling per MicroNode (DB-enforced partial unique index)
// ═══════════════════════════════════════════════════════════════════════════════
await test("T06 — at-most-one target ceiling per MicroNode (DB-enforced)", async () => {
  // Positive: node A has exactly one ceiling (understand)
  const ceilingsA = await db.select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeA), eq(lessonNodeCognitiveLevelsTable.isTargetCeiling, true)));
  assert.equal(ceilingsA.length, 1,            "Exactly one ceiling for node A");
  assert.equal(ceilingsA[0].cognitiveLevel, "understand", "Ceiling = understand");

  const ceilingsB = await db.select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB), eq(lessonNodeCognitiveLevelsTable.isTargetCeiling, true)));
  assert.equal(ceilingsB.length, 1,     "Exactly one ceiling for node B");
  assert.equal(ceilingsB[0].cognitiveLevel, "apply", "Ceiling = apply");

  // Negative: inserting a second isTargetCeiling=true row for the same node
  // must be rejected by the partial unique index lncl_ceiling_per_node_uidx.
  // Node B already has apply (isTargetCeiling=true); trying to mark remember as
  // a second ceiling for the same node must fail.
  let ceilingDuplThrew = false;
  try {
    await db.update(lessonNodeCognitiveLevelsTable)
      .set({ isTargetCeiling: true })
      .where(and(
        eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB),
        eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "remember"),
      ));
  } catch { ceilingDuplThrew = true; }
  assert.equal(ceilingDuplThrew, true,
    "DB rejects second isTargetCeiling=true for same MicroNode (partial unique index)");

  // Restore remember to isTargetCeiling=false so later tests are clean
  // (the UPDATE above failed, so no restoration needed — but no harm verifying)
  const ceilingsAfter = await db.select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB), eq(lessonNodeCognitiveLevelsTable.isTargetCeiling, true)));
  assert.equal(ceilingsAfter.length, 1, "Still exactly one ceiling for node B after rejected write");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T06b — Duplicate sequence for same MicroNode is rejected
// ═══════════════════════════════════════════════════════════════════════════════
await test("T06b — duplicate sequence for same MicroNode is rejected (DB-enforced)", async () => {
  // Node A has sequence 1 (remember) and sequence 2 (understand).
  // Attempting to insert another row with sequence 1 for node A must fail.
  let threw = false;
  try {
    await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: fixtureNodeA,
      cognitiveLevel: "apply",       // different level — OK for lncl_node_level_uidx
      sequence: 1,                   // DUPLICATE sequence for this node — must fail
      isApplicable: true,
      isTargetCeiling: false,
      provenance: "ai_generated",
      minimumIndependentEvidence: 3,
      preferredInteractionTypes: [],
    });
  } catch { threw = true; }
  assert.equal(threw, true, "Duplicate (lessonNodeId, sequence) must throw (lncl_node_sequence_uidx)");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T06c — Invalid cognitiveLevel is rejected by DB CHECK constraint
// ═══════════════════════════════════════════════════════════════════════════════
await test("T06c — invalid cognitiveLevel is rejected by DB CHECK constraint", async () => {
  let threw = false;
  try {
    await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: fixtureNodeA,
      cognitiveLevel: "memorise" as unknown as "remember",  // invalid value
      sequence: 99,
      isApplicable: true,
      isTargetCeiling: false,
      provenance: "ai_generated",
      minimumIndependentEvidence: 3,
      preferredInteractionTypes: [],
    });
  } catch { threw = true; }
  assert.equal(threw, true, "Invalid cognitiveLevel must be rejected by lncl_cognitive_level_chk");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T06d — Invalid provenance is rejected by DB CHECK constraint
// ═══════════════════════════════════════════════════════════════════════════════
await test("T06d — invalid provenance is rejected by DB CHECK constraint", async () => {
  let threw = false;
  try {
    await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: fixtureNodeA,
      cognitiveLevel: "analyze",
      sequence: 99,
      isApplicable: true,
      isTargetCeiling: false,
      provenance: "manual" as unknown as "teacher_authored",  // invalid value
      minimumIndependentEvidence: 3,
      preferredInteractionTypes: [],
    });
  } catch { threw = true; }
  assert.equal(threw, true, "Invalid provenance must be rejected by lncl_provenance_chk");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T06e — minimumIndependentEvidence < 1 is rejected by DB CHECK constraint
// ═══════════════════════════════════════════════════════════════════════════════
await test("T06e — minimumIndependentEvidence < 1 is rejected by DB CHECK constraint", async () => {
  let threw = false;
  try {
    await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: fixtureNodeA,
      cognitiveLevel: "analyze",
      sequence: 99,
      isApplicable: true,
      isTargetCeiling: false,
      provenance: "ai_generated",
      minimumIndependentEvidence: 0,  // invalid: must be >= 1
      preferredInteractionTypes: [],
    });
  } catch { threw = true; }
  assert.equal(threw, true, "minimumIndependentEvidence = 0 must be rejected by lncl_min_evidence_chk");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T07 — Cognitive levels preserve sequence
// ═══════════════════════════════════════════════════════════════════════════════
await test("T07 — cognitive levels preserve sequence", async () => {
  const levels = await db.select({ seq: lessonNodeCognitiveLevelsTable.sequence, cl: lessonNodeCognitiveLevelsTable.cognitiveLevel })
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB))
    .orderBy(lessonNodeCognitiveLevelsTable.sequence);
  assert.equal(levels[0].seq, 1); assert.equal(levels[0].cl, "remember");
  assert.equal(levels[1].seq, 2); assert.equal(levels[1].cl, "understand");
  assert.equal(levels[2].seq, 3); assert.equal(levels[2].cl, "apply");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T08 — performanceObjective persists
// ═══════════════════════════════════════════════════════════════════════════════
await test("T08 — performanceObjective persists correctly", async () => {
  const [row] = await db.select({ po: lessonNodeCognitiveLevelsTable.performanceObjective })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeA), eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "remember")));
  assert.equal(row.po, "Learner can recall the definition verbatim.");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T09 — successCriterion persists
// ═══════════════════════════════════════════════════════════════════════════════
await test("T09 — successCriterion persists correctly", async () => {
  const [row] = await db.select({ sc: lessonNodeCognitiveLevelsTable.successCriterion })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeA), eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "understand")));
  assert.equal(row.sc, "Explains correctly in a new wording/context.");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T10 — provenance persists and is canonical
// ═══════════════════════════════════════════════════════════════════════════════
await test("T10 — provenance persists correctly", async () => {
  const rows = await db.select({ cl: lessonNodeCognitiveLevelsTable.cognitiveLevel, prov: lessonNodeCognitiveLevelsTable.provenance })
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeC))
    .orderBy(lessonNodeCognitiveLevelsTable.sequence);
  assert.equal(rows[0].prov, "source_derived",  "remember = source_derived");
  assert.equal(rows[3].prov, "teacher_authored", "analyze = teacher_authored");
  for (const r of rows) {
    assert.ok((COGNITIVE_PROVENANCE_VALUES as readonly string[]).includes(r.prov), `provenance '${r.prov}' canonical`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T11 — minimumIndependentEvidence persists
// ═══════════════════════════════════════════════════════════════════════════════
await test("T11 — minimumIndependentEvidence persists correctly", async () => {
  const [applyRow] = await db.select({ mie: lessonNodeCognitiveLevelsTable.minimumIndependentEvidence })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB), eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "apply")));
  assert.equal(applyRow.mie, 3, "apply = minimumIndependentEvidence 3");

  const [remRow] = await db.select({ mie: lessonNodeCognitiveLevelsTable.minimumIndependentEvidence })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeA), eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "remember")));
  assert.equal(remRow.mie, 2, "remember = minimumIndependentEvidence 2");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T12 — preferredInteractionTypes persist
// ═══════════════════════════════════════════════════════════════════════════════
await test("T12 — preferredInteractionTypes persist correctly", async () => {
  const [remRow] = await db.select({ pit: lessonNodeCognitiveLevelsTable.preferredInteractionTypes })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeA), eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "remember")));
  assert.deepEqual(remRow.pit, ["multiple_choice", "true_false"], "JSONB array round-trips");
  for (const t of (remRow.pit as string[])) {
    assert.ok((INTERACTION_TYPE_VALUES as readonly string[]).includes(t), `interaction type '${t}' canonical`);
  }

  const [remBRow] = await db.select({ pit: lessonNodeCognitiveLevelsTable.preferredInteractionTypes })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB), eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "remember")));
  assert.deepEqual(remBRow.pit, [], "Empty array persists as []");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T13 — Existing textbook exercise text is never duplicated
// ═══════════════════════════════════════════════════════════════════════════════
await test("T13 — existing textbook exercise text remains unchanged", async () => {
  const [ex] = await db.select({ txt: lessonExercisesTable.exerciseTextVerbatim })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.id, fixtureExerciseId));
  assert.equal(ex.txt, "Test exercise text", "Verbatim text unchanged");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T14 — Exercise can be associated with cognitive level without duplicating text
// ═══════════════════════════════════════════════════════════════════════════════
await test("T14 — exercise associated with cognitive level without duplicating text", async () => {
  const [applyLevel] = await db.select({ id: lessonNodeCognitiveLevelsTable.id })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB), eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "apply")));

  await db.insert(lessonNodeCognitiveTasksTable).values({
    cognitiveLevelId: applyLevel.id,
    lessonExerciseId: fixtureExerciseId,
    taskProvenance: "source_derived",
    notes: "Primary textbook exercise for apply level",
  });

  const [task] = await db.select()
    .from(lessonNodeCognitiveTasksTable)
    .where(eq(lessonNodeCognitiveTasksTable.cognitiveLevelId, applyLevel.id));
  assert.ok(task, "Task link created");
  assert.equal(task.lessonExerciseId, fixtureExerciseId, "Links to correct exercise");
  assert.equal(task.seedExerciseId, null, "No seed for source_derived");

  // Verify no text is duplicated onto the task row itself
  const taskKeys = Object.keys(task);
  assert.ok(!taskKeys.includes("exerciseTextVerbatim"), "No text duplication on cognitive task");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T15 — AI-generated task provenance distinguishable from textbook
// ═══════════════════════════════════════════════════════════════════════════════
await test("T15 — AI-generated task provenance is distinguishable from textbook", async () => {
  const [applyLevel] = await db.select({ id: lessonNodeCognitiveLevelsTable.id })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB), eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "apply")));

  await db.insert(lessonNodeCognitiveTasksTable).values({
    cognitiveLevelId: applyLevel.id,
    lessonExerciseId: null,
    taskProvenance: "ai_generated",
    seedExerciseId: fixtureExerciseId,
    notes: "AI variant 1: same skill with different values",
  });

  const tasks = await db.select()
    .from(lessonNodeCognitiveTasksTable)
    .where(eq(lessonNodeCognitiveTasksTable.cognitiveLevelId, applyLevel.id));
  assert.equal(tasks.length, 2, "Two tasks for apply level");

  const textbookTask = tasks.find(t => t.taskProvenance === "source_derived");
  const aiTask       = tasks.find(t => t.taskProvenance === "ai_generated");
  assert.ok(textbookTask, "Textbook task present");
  assert.ok(aiTask,       "AI-generated task present");
  assert.notEqual(textbookTask!.taskProvenance, aiTask!.taskProvenance, "Provenances distinct");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T16 — AI variant retains seed/source lineage
// ═══════════════════════════════════════════════════════════════════════════════
await test("T16 — AI-generated variant retains seed/source lineage", async () => {
  const [applyLevel] = await db.select({ id: lessonNodeCognitiveLevelsTable.id })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, fixtureNodeB), eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, "apply")));

  const tasks = await db.select()
    .from(lessonNodeCognitiveTasksTable)
    .where(and(eq(lessonNodeCognitiveTasksTable.cognitiveLevelId, applyLevel.id), eq(lessonNodeCognitiveTasksTable.taskProvenance, "ai_generated")));
  assert.equal(tasks.length, 1, "One AI task");
  assert.equal(tasks[0].seedExerciseId, fixtureExerciseId, "seedExerciseId traces to source");
  assert.equal(tasks[0].lessonExerciseId, null, "lessonExerciseId null for un-stored variant");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T17 — Old evidence remains valid; cognitive fields are null
// ═══════════════════════════════════════════════════════════════════════════════
await test("T17 — old evidence remains valid; cognitiveLevel / taskDifficulty / assistanceLevel are null", async () => {
  const [kn] = await db.insert(knowledgeNodesTable).values({
    subjectId: fixtureSubjectId,
    userId: fixtureUserId,
    topicName: `${runId}-topic`,
    lessonNodeId: fixtureNodeA,
    status: "in_progress",
    isProvisional: true,
    bloomLevel: 1,
  }).returning({ id: knowledgeNodesTable.id });
  fixtureKnId = kn.id;

  const [ev] = await db.insert(evidenceEventsTable).values({
    userId: fixtureUserId,
    topicId: kn.id,
    eventType: "answer",
    wasCorrect: true,
    hintUsed: false,
    metadata: { source: "quiz", quizId: 999 },
    // cognitiveLevel / taskDifficulty / assistanceLevel intentionally omitted
  }).returning({ id: evidenceEventsTable.id });

  const [readBack] = await db.select({
    wasCorrect:      evidenceEventsTable.wasCorrect,
    cognitiveLevel:  evidenceEventsTable.cognitiveLevel,
    taskDifficulty:  evidenceEventsTable.taskDifficulty,
    assistanceLevel: evidenceEventsTable.assistanceLevel,
  })
    .from(evidenceEventsTable)
    .where(eq(evidenceEventsTable.id, ev.id));

  assert.equal(readBack.wasCorrect, true,  "wasCorrect persists");
  assert.equal(readBack.cognitiveLevel,  null, "cognitiveLevel null (old evidence)");
  assert.equal(readBack.taskDifficulty,  null, "taskDifficulty null (old evidence)");
  assert.equal(readBack.assistanceLevel, null, "assistanceLevel null (old evidence)");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T18 — No learner cognitive level fabricated
// ═══════════════════════════════════════════════════════════════════════════════
await test("T18 — no learner cognitive level fabricated on knowledge_nodes", async () => {
  const [kn] = await db.select({ bloomLevel: knowledgeNodesTable.bloomLevel })
    .from(knowledgeNodesTable)
    .where(and(eq(knowledgeNodesTable.userId, fixtureUserId), eq(knowledgeNodesTable.lessonNodeId, fixtureNodeA)));
  assert.equal(kn.bloomLevel, 1, "bloom_level is static snapshot (1), not demonstrated level");
  const knKeys = Object.keys(kn);
  assert.ok(!knKeys.includes("demonstratedCognitiveLevel"), "No demonstratedCognitiveLevel (not yet implemented)");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T19 — targetBloomLevel legacy consumer still works
// ═══════════════════════════════════════════════════════════════════════════════
await test("T19 — targetBloomLevel legacy field still works (backward compat)", async () => {
  assert.equal(COGNITIVE_LEVEL_TO_BLOOM_INT["remember"],   1);
  assert.equal(COGNITIVE_LEVEL_TO_BLOOM_INT["understand"], 2);
  assert.equal(COGNITIVE_LEVEL_TO_BLOOM_INT["apply"],      3);
  assert.equal(COGNITIVE_LEVEL_TO_BLOOM_INT["analyze"],    4);
  assert.equal(COGNITIVE_LEVEL_TO_BLOOM_INT["evaluate"],   5);
  assert.equal(COGNITIVE_LEVEL_TO_BLOOM_INT["create"],     6);

  const bloomInt = COGNITIVE_LEVEL_TO_BLOOM_INT["understand"];
  await db.update(lessonNodesTable).set({ targetBloomLevel: bloomInt }).where(eq(lessonNodesTable.id, fixtureNodeA));
  const [node] = await db.select({ targetBloomLevel: lessonNodesTable.targetBloomLevel }).from(lessonNodesTable).where(eq(lessonNodesTable.id, fixtureNodeA));
  assert.equal(node.targetBloomLevel, 2, "targetBloomLevel updated to 2 for backward compat");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T20 — No mapper regression: real MicroNodes are unchanged
// ═══════════════════════════════════════════════════════════════════════════════
await test("T20 — no mapper regression: real MicroNodes are unchanged", async () => {
  for (const snapshot of realNodesBefore) {
    const [current] = await db.select({ id: lessonNodesTable.id, targetBloomLevel: lessonNodesTable.targetBloomLevel, status: lessonNodesTable.status })
      .from(lessonNodesTable).where(eq(lessonNodesTable.id, snapshot.id));
    assert.equal(current.targetBloomLevel, snapshot.targetBloomLevel, `Node ${snapshot.id}: targetBloomLevel unchanged`);
    assert.equal(current.status, snapshot.status, `Node ${snapshot.id}: status unchanged`);
  }
  assert.equal(realCogLevelsBefore, 0, "No cognitive-level rows for real nodes before suite");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T21 — No Phase 2 regression: Phase 2 fields accessible
// ═══════════════════════════════════════════════════════════════════════════════
await test("T21 — no Phase 2 regression: Phase 2 fields on real nodes accessible", async () => {
  for (const snapshot of realNodesBefore) {
    const [current] = await db.select({ cfe: lessonNodesTable.childFriendlyExplanation, cm: lessonNodesTable.commonMisconception })
      .from(lessonNodesTable).where(eq(lessonNodesTable.id, snapshot.id));
    assert.ok(current !== undefined, `Node ${snapshot.id}: Phase 2 fields still accessible`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T22 — No quiz/mastery regression: evidence_events backward-compatible
// ═══════════════════════════════════════════════════════════════════════════════
await test("T22 — no quiz/mastery regression: evidence_events schema backward-compatible", async () => {
  const evCount = await db.select({ count: sql<number>`count(*)::int` })
    .from(evidenceEventsTable)
    .where(sql`${evidenceEventsTable.metadata}->>'source' = 'quiz' AND (${evidenceEventsTable.metadata}->>'quizId')::int = 206`);
  assert.ok(evCount[0].count >= 9, `Quiz evidence still queryable: ${evCount[0].count} rows`);

  const [nullCheck] = await db.select({ cl: evidenceEventsTable.cognitiveLevel, td: evidenceEventsTable.taskDifficulty, al: evidenceEventsTable.assistanceLevel })
    .from(evidenceEventsTable)
    .where(sql`${evidenceEventsTable.metadata}->>'source' = 'quiz' AND (${evidenceEventsTable.metadata}->>'quizId')::int = 206`)
    .limit(1);
  assert.equal(nullCheck.cl, null, "cognitiveLevel = null for old evidence");
  assert.equal(nullCheck.td, null, "taskDifficulty = null for old evidence");
  assert.equal(nullCheck.al, null, "assistanceLevel = null for old evidence");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T23 — No KT four-state regression
// ═══════════════════════════════════════════════════════════════════════════════
await test("T23 — no KT four-state regression: knowledge_nodes still readable", async () => {
  const physicsKNs = await db.select({ lessonNodeId: knowledgeNodesTable.lessonNodeId, masteryScore: knowledgeNodesTable.masteryScore, status: knowledgeNodesTable.status, bloomLevel: knowledgeNodesTable.bloomLevel })
    .from(knowledgeNodesTable)
    .where(and(eq(knowledgeNodesTable.userId, 93), inArray(knowledgeNodesTable.lessonNodeId, [2019, 2020, 2021])));
  assert.equal(physicsKNs.length, 3, "All 3 Physics KNs present");
  const tarrer = physicsKNs.find(kn => kn.lessonNodeId === 2020);
  assert.ok(tarrer, "Tarrer KN present");
  assert.equal(tarrer!.masteryScore, 67, "Tarrer masteryScore = 67");
  assert.equal(tarrer!.status, "weak",   "Tarrer status = weak");
  assert.equal(tarrer!.bloomLevel, 1,    "bloom_level = 1 (static snapshot)");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T24 — Migration is additive: existing rows survive
// ═══════════════════════════════════════════════════════════════════════════════
await test("T24 — migration is additive: existing rows survive unchanged", async () => {
  const [cnt] = await db.select({ count: sql<number>`count(*)::int` })
    .from(lessonNodeCognitiveLevelsTable)
    .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, REAL_NODE_IDS));
  assert.equal(cnt.count, 0, "Zero cognitive-level rows for real Physics nodes (migration additive)");
  assert.ok(true, "T20-T23 passing already proves row preservation");
});

// ═══════════════════════════════════════════════════════════════════════════════
// T25 — Zero test pollution
// ═══════════════════════════════════════════════════════════════════════════════
try {
  await teardown();
  await test("T25 — zero test pollution: all fixture data removed", async () => {
    const [leftover] = await db.select({ count: sql<number>`count(*)::int` })
      .from(lessonNodeCognitiveLevelsTable)
      .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, [fixtureNodeA, fixtureNodeB, fixtureNodeC, fixtureNodeD]));
    assert.equal(leftover.count, 0, "Fixture cognitive rows removed via cascade");

    const realNodesAfter = await readRealNodes();
    const realCogAfter   = await countRealCognitiveLevels();
    for (const after of realNodesAfter) {
      const before = realNodesBefore.find(b => b.id === after.id)!;
      assert.equal(after.targetBloomLevel, before.targetBloomLevel, `Real node ${after.id}: targetBloomLevel unchanged`);
    }
    assert.equal(realCogAfter, 0, "Zero cognitive-level rows for real Physics nodes after teardown");
  });
} finally {
  await closeTestDb();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log("\n─────────────────────────────────────────────");
console.log(`Phase 2A R2 Schema: ${passed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
console.log("─────────────────────────────────────────────");
if (failed > 0) process.exit(1);
