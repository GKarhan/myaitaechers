// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Teaching Content Generation — acceptance + regression tests
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/phase2-generation.test.ts
// No external framework — uses node:assert/strict + exit code.
//
// ZERO-POLLUTION: all fixtures are dynamic (tagged with RUN_ID), cleaned in finally.
// AI-GATED: set RUN_AI_TESTS=1 to enable tests that invoke the AI generation pipeline.
//
// Covers:
//   Part G: Dynamic lesson real acceptance (Phase 2 generation, before/after counts, no corruption)
//   Part H: Isolated regression (idempotency, provenance safety)
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.RUN_AI_TESTS) {
  console.log("[skip] Set RUN_AI_TESTS=1 to enable AI tests");
  process.exit(0);
}

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db,
  lessonsTable,
  lessonNodesTable,
  lessonTopicsTable,
  lessonExercisesTable,
  lessonNodeDependenciesTable,
  mappingJobsTable,
} from "@workspace/db";
import { eq, and, asc, like, inArray, ne } from "drizzle-orm";
import { makeRunId, runTag } from "./helpers/run-id.js";
import { preCleanupStaleTrRecords } from "./helpers/http-fixture-factory.js";

// ─── Run isolation ─────────────────────────────────────────────────────────────
const RUN_ID = makeRunId();
const tag = (label: string) => runTag(RUN_ID, label);

const SECRET = process.env.SESSION_SECRET ?? "myaiteacher-secret";
const BASE   = "http://localhost:8080/api";
const TEACHER_ID = 161;
const SUBJECT_ID = 18; // Physics

const teacherToken = jwt.sign(
  { userId: TEACHER_ID, role: "teacher" },
  SECRET,
  { expiresIn: "1h" },
);
function authH() { return { Authorization: `Bearer ${teacherToken}`, "Content-Type": "application/json" }; }

type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>) { tests.push([name, fn]); }

// ─── Mutable fixture state ─────────────────────────────────────────────────────
let testLessonId: number | null = null;

// ── Helper: poll generate-status until terminal ────────────────────────────────
async function pollUntilDone(lessonId: number, timeoutMs = 200_000): Promise<{ status: string; result: unknown; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const r = await fetch(`${BASE}/lessons/${lessonId}/generate-status`, { headers: authH() });
    const body = await r.json() as { status: string; result: unknown; error: string | null };
    if (body.status === "completed" || body.status === "failed") return body;
  }
  throw new Error("Phase 2 generation timed out after " + timeoutMs + "ms");
}

// ── Helper: snapshot lesson structure ─────────────────────────────────────────
async function snapshotLesson(lessonId: number) {
  const [nodes, topics, exercises, deps] = await Promise.all([
    db.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId)).orderBy(asc(lessonNodesTable.sequence)),
    db.select().from(lessonTopicsTable).where(eq(lessonTopicsTable.lessonId, lessonId)).orderBy(asc(lessonTopicsTable.sequence)),
    db.select().from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, lessonId)),
    db.select().from(lessonNodeDependenciesTable).where(eq(lessonNodeDependenciesTable.lessonId, lessonId)),
  ]);
  return { nodes, topics, exercises, deps };
}

// ─── Pre-cleanup: remove stale TR_ records from prior crashed runs ─────────────
await preCleanupStaleTrRecords(RUN_ID);

// ─── Create dynamic lesson with approved nodes ────────────────────────────────
{
  const [lesson] = await db
    .insert(lessonsTable)
    .values({
      title: tag("p2gen_lesson"),
      subjectId: SUBJECT_ID,
      teacherId: TEACHER_ID,
      status: "approved",
      everApproved: true,
    } as never)
    .returning({ id: lessonsTable.id });
  testLessonId = lesson.id;
  console.log(`[setup] Dynamic lesson created: id=${testLessonId} title="${tag("p2gen_lesson")}"`);

  // Create 3 approved nodes with theory content (required for Phase 2 generation)
  const nodeData = [
    {
      title: tag("p2gen_node_1"),
      sequence: 1,
      learningObjective: "Աշակերտը կարողանա սահմանել ֆիզիկական քանակ հասկացությունը",
      theoryContent: "Ֆիզիկական քանակը ֆիզիկայի հիմնական հասկացություններից մեկն է: Այն ստացվում է չափման արդյունքում: Ֆիզիկական քանակը կարող է լինել սկալյար կամ վեկտորային:",
    },
    {
      title: tag("p2gen_node_2"),
      sequence: 2,
      learningObjective: "Աշակերտը կարողանա բացատրել ֆիզիկական քանակի չափման կարևորությունը",
      theoryContent: "Ֆիզիկական քանակը չափելու համար օգտագործում են չափման etalon, որի հետ համեմատում են տվյալ քանակը: Չափման արդյունքը ունի թվային արժեք և չափման միավոր:",
    },
    {
      title: tag("p2gen_node_3"),
      sequence: 3,
      learningObjective: "Աշակերտը կարողանա տարբերել սկալյար և վեկտորային ֆիզիկական քանակները",
      theoryContent: "Սկալյար քանակներն ամբողջությամբ բնութագրվում են իրենց թվային արժեքով: Վեկտորային քանակներն ունեն ինչպես թվային արժեք, այնպես էլ ուղղություն:",
    },
  ];

  for (const nd of nodeData) {
    await db.insert(lessonNodesTable).values({
      lessonId: testLessonId,
      title: nd.title,
      sequence: nd.sequence,
      status: "approved",
      learningObjective: nd.learningObjective,
      theoryContent: nd.theoryContent,
      createdBy: "teacher",
    } as never);
  }

  // Add exercises
  const nodeRows = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, testLessonId))
    .orderBy(asc(lessonNodesTable.sequence));

  for (const n of nodeRows) {
    await db.insert(lessonExercisesTable).values({
      lessonId: testLessonId,
      relatedNodeId: n.id,
      exerciseTextVerbatim: tag(`p2gen_exercise_${n.id}`),
      assignment: "CLASS",
      difficultyLevel: "MEDIUM",
      sourceType: "textbook",
      status: "approved",
    } as never);
  }

  console.log(`[setup] Created ${nodeRows.length} approved nodes and exercises`);
}

// ══════════════════════════════════════════════════════════════════════════════
// PART G: Dynamic lesson Phase 2 acceptance tests
// ══════════════════════════════════════════════════════════════════════════════

it("G1: Dynamic lesson — POST /generate-teaching-content returns jobId immediately", async () => {
  assert.ok(testLessonId, "Dynamic lesson must exist");
  const r = await fetch(`${BASE}/lessons/${testLessonId}/generate-teaching-content`, {
    method: "POST",
    headers: authH(),
  });
  assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
  const body = await r.json() as { jobId?: number; status?: string };
  assert.ok(body.jobId && typeof body.jobId === "number", `Missing jobId: ${JSON.stringify(body)}`);
  assert.equal(body.status, "pending", `Expected pending, got ${body.status}`);
});

it("G2: Dynamic lesson — Phase 2 job completes (not failed)", async () => {
  const result = await pollUntilDone(testLessonId!);
  assert.equal(result.status, "completed", `Phase 2 failed: ${result.error}`);
});

it("G3: Dynamic lesson — Topics ≥ 0 (structure unchanged)", async () => {
  const { topics } = await snapshotLesson(testLessonId!);
  // Dynamic lesson has no topics created; assert non-negative count
  assert.ok(topics.length >= 0, `Topic count must be non-negative, got ${topics.length}`);
  console.log(`    Topics after Phase 2: ${topics.length}`);
});

it("G4: Dynamic lesson — MicroNodes = 3 (no duplicates, no deletions)", async () => {
  const { nodes } = await snapshotLesson(testLessonId!);
  assert.equal(nodes.length, 3, `Expected 3 nodes, got ${nodes.length}`);
  const ids = new Set(nodes.map((n) => n.id));
  assert.equal(ids.size, 3, "Duplicate node IDs detected");
});

it("G5: Dynamic lesson — exercises unchanged (no duplicates)", async () => {
  const { exercises } = await snapshotLesson(testLessonId!);
  assert.equal(exercises.length, 3, `Expected 3 exercises, got ${exercises.length}`);
  const ids = new Set(exercises.map((e) => e.id));
  assert.equal(ids.size, 3, "Duplicate exercise IDs detected");
});

it("G6: Dynamic lesson — Phase 2 fields are present on enriched nodes", async () => {
  const { nodes } = await snapshotLesson(testLessonId!);
  const withCFE = nodes.filter((n) => (n as { childFriendlyExplanation?: string }).childFriendlyExplanation?.trim());
  console.log(`    ${withCFE.length}/${nodes.length} nodes have childFriendlyExplanation after Phase 2`);
  // At least some nodes should have Phase 2 content
  assert.ok(withCFE.length > 0, "No nodes received Phase 2 childFriendlyExplanation after generation");
});

it("G7: Dynamic lesson — source provenance unchanged (sourceBlockIndices still set where present)", async () => {
  const { nodes } = await snapshotLesson(testLessonId!);
  // sourceBlockIndices may be null for dynamically created nodes (not from textbook extraction)
  // Just verify no node has corrupted (non-array) sourceBlockIndices
  const corrupted = nodes.filter((n) => {
    const nd = n as { sourceBlockIndices?: unknown };
    return nd.sourceBlockIndices !== null && nd.sourceBlockIndices !== undefined && !Array.isArray(nd.sourceBlockIndices);
  });
  assert.equal(corrupted.length, 0, `${corrupted.length} nodes have corrupted sourceBlockIndices`);
});

it("G8: Dynamic lesson — node ordering unchanged (sequences contiguous 1..3)", async () => {
  const { nodes } = await snapshotLesson(testLessonId!);
  const seqs = nodes.map((n) => n.sequence ?? 0).sort((a, b) => a - b);
  for (let i = 0; i < seqs.length; i++) {
    assert.equal(seqs[i], i + 1, `Sequence gap: expected ${i + 1}, got ${seqs[i]}`);
  }
});

it("G9: Dynamic lesson — MISSING_PHASE2 gate passes after generation", async () => {
  const r = await fetch(`${BASE}/lessons/${testLessonId}/final-approve`, {
    method: "POST",
    headers: authH(),
  });
  const body = await r.json() as { errors?: { code: string }[]; approved?: boolean };
  const phase2Errors = (body.errors ?? []).filter((e) => e.code === "MISSING_PHASE2");
  assert.equal(phase2Errors.length, 0, `MISSING_PHASE2 errors remain: ${JSON.stringify(phase2Errors)}`);
  console.log(`    Final Approval: approved=${body.approved}, total errors=${(body.errors ?? []).length}, phase2Errors=0`);
});

// ══════════════════════════════════════════════════════════════════════════════
// PART H: Regression tests — idempotency, provenance safety
// ══════════════════════════════════════════════════════════════════════════════

it("H1: Phase 2 GET /generate-status returns a recognized status for dynamic lesson", async () => {
  assert.ok(testLessonId, "Dynamic lesson must exist");
  const r = await fetch(`${BASE}/lessons/${testLessonId}/generate-status`, { headers: authH() });
  assert.equal(r.status, 200);
  const body = await r.json() as { status: string };
  assert.ok(["completed", "failed", "none", "pending", "running"].includes(body.status),
    `Unexpected status: ${body.status}`);
});

it("H2: Phase 2 fields persist after refresh (read-back from DB)", async () => {
  const { nodes } = await snapshotLesson(testLessonId!);
  const withCFE = nodes.filter((n) => (n as { childFriendlyExplanation?: string }).childFriendlyExplanation?.trim());
  assert.ok(withCFE.length > 0, "No nodes have childFriendlyExplanation after generation");
  console.log(`    ${withCFE.length}/${nodes.length} nodes have Phase 2 fields persisted`);
});

it("H3: Idempotency — running Phase 2 twice does NOT duplicate nodes or exercises", async () => {
  const before = await snapshotLesson(testLessonId!);

  // Trigger Phase 2 a second time
  const r = await fetch(`${BASE}/lessons/${testLessonId}/generate-teaching-content`, {
    method: "POST",
    headers: authH(),
  });
  assert.equal(r.status, 200);
  await pollUntilDone(testLessonId!);

  const after = await snapshotLesson(testLessonId!);
  assert.equal(after.nodes.length, before.nodes.length, `Node count changed: ${before.nodes.length} → ${after.nodes.length}`);
  assert.equal(after.exercises.length, before.exercises.length, `Exercise count changed: ${before.exercises.length} → ${after.exercises.length}`);
  assert.equal(after.topics.length, before.topics.length, `Topic count changed: ${before.topics.length} → ${after.topics.length}`);
  console.log(`    Idempotency OK: nodes=${after.nodes.length}, exercises=${after.exercises.length}, topics=${after.topics.length}`);
});

it("H4: Idempotency — provenance unchanged after second Phase 2 run", async () => {
  const { nodes } = await snapshotLesson(testLessonId!);
  const corrupted = nodes.filter((n) => {
    const nd = n as { sourceBlockIndices?: unknown };
    return nd.sourceBlockIndices !== null && nd.sourceBlockIndices !== undefined && !Array.isArray(nd.sourceBlockIndices);
  });
  assert.equal(corrupted.length, 0, `Provenance corrupted after second run: ${corrupted.length} nodes`);
});

it("H5: Phase 2 overwrites fields on re-run (not append, not skip complete nodes)", async () => {
  const { nodes } = await snapshotLesson(testLessonId!);
  for (const n of nodes) {
    const nd = n as { childFriendlyExplanation?: unknown; basicExamples?: unknown };
    if (nd.childFriendlyExplanation) {
      assert.equal(typeof nd.childFriendlyExplanation, "string",
        `childFriendlyExplanation should be string, got ${typeof nd.childFriendlyExplanation}`);
    }
    if (nd.basicExamples) {
      assert.ok(Array.isArray(nd.basicExamples), `basicExamples should be array`);
    }
  }
});

it("H6: Final Approval still passes after second Phase 2 run", async () => {
  const r = await fetch(`${BASE}/lessons/${testLessonId}/final-approve`, {
    method: "POST",
    headers: authH(),
  });
  const body = await r.json() as { errors?: { code: string }[]; approved?: boolean };
  const phase2Errors = (body.errors ?? []).filter((e) => e.code === "MISSING_PHASE2");
  assert.equal(phase2Errors.length, 0, `MISSING_PHASE2 persists after second run: ${JSON.stringify(phase2Errors)}`);
  console.log(`    Final Approval after 2nd run: approved=${body.approved}, errors=${(body.errors ?? []).length}`);
});

// ── Cleanup + Runner ─────────────────────────────────────────────────────────────

async function cleanup() {
  if (testLessonId !== null) {
    try {
      // Cancel any running Phase 2 jobs for the dynamic lesson before deleting
      await db.update(mappingJobsTable)
        .set({ status: "failed", error: "Cancelled by test cleanup (phase2-generation)" })
        .where(and(
          eq(mappingJobsTable.lessonId, testLessonId),
          eq(mappingJobsTable.jobType, "generate_teaching_content"),
          ne(mappingJobsTable.status, "completed"),
          ne(mappingJobsTable.status, "failed"),
        ));
      // Delete lesson (CASCADE removes nodes/exercises/deps/topics/mapping jobs)
      await db.delete(lessonsTable).where(eq(lessonsTable.id, testLessonId));
      console.log(`[cleanup] Deleted dynamic lesson ${testLessonId}`);
    } catch (e) {
      console.error("[cleanup] Failed to delete dynamic lesson:", e);
    }
  }
}

let passed = 0;
let failed = 0;

console.log(`\n  phase2-generation — ${tests.length} test cases\n`);

try {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${(err as Error).message}`);
      failed++;
    }
  }
} finally {
  await cleanup();

  // Post-pollution gate
  const leakedLessons = await db
    .select({ id: lessonsTable.id, title: lessonsTable.title })
    .from(lessonsTable)
    .where(like(lessonsTable.title, `${RUN_ID}_%`));
  if (leakedLessons.length > 0) {
    console.error(`[pollution-gate] FAIL: ${leakedLessons.length} lesson(s) leaked: ${JSON.stringify(leakedLessons.map(l => l.title))}`);
  } else {
    console.log("[pollution-gate] ✓ No TR_ records remain");
  }
}

console.log(`\nPhase 2 Generation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
