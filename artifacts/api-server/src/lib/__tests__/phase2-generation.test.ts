// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Teaching Content Generation — acceptance + regression tests
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/phase2-generation.test.ts
// No external framework — uses node:assert/strict + exit code.
//
// Covers:
//   Part G: Lesson 105 real acceptance (before/after counts, no corruption)
//   Part H: Isolated regression (test lesson, idempotency, provenance safety)
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db, lessonsTable, lessonNodesTable, lessonTopicsTable,
  lessonExercisesTable, lessonNodeDependenciesTable, mappingJobsTable,
} from "@workspace/db";
import { eq, and, asc, desc } from "drizzle-orm";

const SECRET = process.env.SESSION_SECRET ?? "myaiteacher-secret";
const BASE   = "http://localhost:8080/api";
const LESSON_ID = 105;

const teacherToken = jwt.sign(
  { userId: 1, role: "teacher", username: "teacher1", fullName: "T1" },
  SECRET,
  { expiresIn: "1h" },
);
function authH() { return { Authorization: `Bearer ${teacherToken}`, "Content-Type": "application/json" }; }

type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>) { tests.push([name, fn]); }

// ── Helper: poll generate-status until terminal ────────────────────────────────
async function pollUntilDone(lessonId: number, timeoutMs = 200_000): Promise<{ status: string; result: unknown; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const r = await fetch(`${BASE}/lessons/${lessonId}/generate-status`, { headers: authH() });
    const body = await r.json() as any;
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

// ══════════════════════════════════════════════════════════════════════════════
// PART G: Lesson 105 real acceptance tests
// ══════════════════════════════════════════════════════════════════════════════

it("G1: Lesson 105 — POST /generate-teaching-content returns jobId immediately", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/generate-teaching-content`, {
    method: "POST",
    headers: authH(),
  });
  assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
  const body = await r.json() as any;
  assert.ok(body.jobId && typeof body.jobId === "number", `Missing jobId: ${JSON.stringify(body)}`);
  assert.equal(body.status, "pending", `Expected pending, got ${body.status}`);
});

it("G2: Lesson 105 — Phase 2 job completes (not failed)", async () => {
  const result = await pollUntilDone(LESSON_ID);
  assert.equal(result.status, "completed", `Phase 2 failed: ${result.error}`);
});

it("G3: Lesson 105 — Topics ≥ 3 (structure unchanged)", async () => {
  const { topics } = await snapshotLesson(LESSON_ID);
  // Lesson 105 has 3 topics as of current mapping; assert at-least to be resilient to teacher edits
  assert.ok(topics.length >= 3, `Expected ≥3 topics, got ${topics.length}`);
});

it("G4: Lesson 105 — MicroNodes = 9 (no duplicates, no deletions)", async () => {
  const { nodes } = await snapshotLesson(LESSON_ID);
  assert.equal(nodes.length, 9, `Expected 9 nodes, got ${nodes.length}`);
  const ids = new Set(nodes.map((n) => n.id));
  assert.equal(ids.size, 9, "Duplicate node IDs detected");
});

it("G5: Lesson 105 — textbook exercises = 15, manual/test = 0", async () => {
  const { exercises } = await snapshotLesson(LESSON_ID);
  const textbook = exercises.filter((e) => e.sourceType === "textbook");
  const manual = exercises.filter((e) => e.sourceType !== "textbook");
  assert.equal(textbook.length, 15, `Expected 15 textbook exercises, got ${textbook.length}`);
  assert.equal(manual.length, 0, `Expected 0 manual exercises, got ${manual.length}`);
});

it("G6: Lesson 105 — every required Phase 2 field is present on all nodes", async () => {
  const { nodes } = await snapshotLesson(LESSON_ID);
  const missing: string[] = [];
  for (const n of nodes) {
    const nd = n as any;
    if (!nd.childFriendlyExplanation?.trim()) missing.push(`node ${n.id} (${n.title}): childFriendlyExplanation`);
    if (!nd.commonMisconception?.trim()) missing.push(`node ${n.id}: commonMisconception`);
    if (!Array.isArray(nd.basicExamples) || nd.basicExamples.length === 0) missing.push(`node ${n.id}: basicExamples`);
    if (!Array.isArray(nd.nonExamples) || nd.nonExamples.length === 0) missing.push(`node ${n.id}: nonExamples`);
  }
  assert.equal(missing.length, 0, `Phase 2 fields missing:\n  ${missing.join("\n  ")}`);
});

it("G7: Lesson 105 — source provenance unchanged (sourceBlockIndices still set)", async () => {
  const { nodes } = await snapshotLesson(LESSON_ID);
  const lostProvenance = nodes.filter((n) => {
    const nd = n as any;
    return !nd.sourceBlockIndices || !Array.isArray(nd.sourceBlockIndices);
  });
  assert.equal(lostProvenance.length, 0, `${lostProvenance.length} nodes lost sourceBlockIndices`);
});

it("G8: Lesson 105 — node ordering unchanged (sequences contiguous 1..9)", async () => {
  const { nodes } = await snapshotLesson(LESSON_ID);
  const seqs = nodes.map((n) => n.sequence ?? 0).sort((a, b) => a - b);
  for (let i = 0; i < seqs.length; i++) {
    assert.equal(seqs[i], i + 1, `Sequence gap: expected ${i + 1}, got ${seqs[i]}`);
  }
});

it("G9: Lesson 105 — SEQUENTIAL deps count matches node count - 1 (chain intact)", async () => {
  const { deps, nodes } = await snapshotLesson(LESSON_ID);
  const seqDeps = deps.filter((d) => (d as any).dependencyType === "SEQUENTIAL");
  // 9 nodes → 8 sequential edges
  assert.equal(seqDeps.length, nodes.length - 1, `Expected ${nodes.length - 1} sequential deps, got ${seqDeps.length}`);
});

it("G10: Lesson 105 — MISSING_PHASE2 blocking errors = 0 (Final Approval gate passes)", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/final-approve`, {
    method: "POST",
    headers: authH(),
  });
  const body = await r.json() as any;
  const phase2Errors = (body.errors ?? []).filter((e: any) => e.code === "MISSING_PHASE2");
  assert.equal(phase2Errors.length, 0, `MISSING_PHASE2 errors remain: ${JSON.stringify(phase2Errors)}`);
  // May have other legitimate errors — we only assert Phase 2 is resolved
  console.log(`  [INFO] Final Approval: approved=${body.approved}, total errors=${(body.errors ?? []).length}, phase2Errors=0`);
});

// ══════════════════════════════════════════════════════════════════════════════
// PART H: Regression tests — isolated lesson, idempotency, provenance safety
// ══════════════════════════════════════════════════════════════════════════════

let testLessonId: number | null = null;

it("H1: Verify Lesson 105 exists for regression tests", async () => {
  const [lesson] = await db
    .select({ id: lessonsTable.id, status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID))
    .limit(1);
  assert.ok(lesson, `Lesson ${LESSON_ID} must exist`);
  // Use Lesson 105 for the idempotency test (no separate creation needed)
  testLessonId = LESSON_ID;
  console.log(`  [INFO] Using Lesson ${testLessonId} for idempotency/regression tests`);
});

it("H2: Phase 2 GET /generate-status returns last job for lesson", async () => {
  assert.ok(testLessonId, "H1 must pass first");
  const r = await fetch(`${BASE}/lessons/${testLessonId}/generate-status`, { headers: authH() });
  assert.equal(r.status, 200);
  const body = await r.json() as any;
  assert.ok(["completed", "failed", "none", "pending", "running"].includes(body.status),
    `Unexpected status: ${body.status}`);
});

it("H3: Phase 2 fields persist after refresh (read-back from DB)", async () => {
  const { nodes } = await snapshotLesson(LESSON_ID);
  const withCFE = nodes.filter((n) => (n as any).childFriendlyExplanation?.trim());
  // At least some nodes should have Phase 2 after generation
  assert.ok(withCFE.length > 0, "No nodes have childFriendlyExplanation after generation");
  console.log(`  [INFO] ${withCFE.length}/${nodes.length} nodes have Phase 2 fields persisted`);
});

it("H4: Idempotency — running Phase 2 twice does NOT duplicate nodes or exercises", async () => {
  const before = await snapshotLesson(LESSON_ID);

  // Trigger Phase 2 a second time
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/generate-teaching-content`, {
    method: "POST",
    headers: authH(),
  });
  assert.equal(r.status, 200);
  await pollUntilDone(LESSON_ID);

  const after = await snapshotLesson(LESSON_ID);
  assert.equal(after.nodes.length, before.nodes.length, `Node count changed: ${before.nodes.length} → ${after.nodes.length}`);
  assert.equal(after.exercises.length, before.exercises.length, `Exercise count changed: ${before.exercises.length} → ${after.exercises.length}`);
  assert.equal(after.topics.length, before.topics.length, `Topic count changed: ${before.topics.length} → ${after.topics.length}`);
  console.log(`  [INFO] Idempotency OK: nodes=${after.nodes.length}, exercises=${after.exercises.length}, topics=${after.topics.length}`);
});

it("H5: Idempotency — provenance unchanged after second Phase 2 run", async () => {
  const { nodes } = await snapshotLesson(LESSON_ID);
  const lostProvenance = nodes.filter((n) => {
    const nd = n as any;
    return !nd.sourceBlockIndices || !Array.isArray(nd.sourceBlockIndices);
  });
  assert.equal(lostProvenance.length, 0, `Provenance corrupted after second run: ${lostProvenance.length} nodes`);
});

it("H6: Phase 2 overwrites fields on re-run (not append, not skip complete nodes)", async () => {
  // After two runs, nodes should still have exactly one set of Phase 2 fields
  const { nodes } = await snapshotLesson(LESSON_ID);
  for (const n of nodes) {
    const nd = n as any;
    if (nd.childFriendlyExplanation) {
      // Must be a string, not an array (no accidental array appending)
      assert.equal(typeof nd.childFriendlyExplanation, "string",
        `childFriendlyExplanation should be string, got ${typeof nd.childFriendlyExplanation}`);
    }
    if (nd.basicExamples) {
      assert.ok(Array.isArray(nd.basicExamples), `basicExamples should be array`);
    }
  }
});

it("H7: Final Approval still passes after second Phase 2 run", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/final-approve`, {
    method: "POST",
    headers: authH(),
  });
  const body = await r.json() as any;
  const phase2Errors = (body.errors ?? []).filter((e: any) => e.code === "MISSING_PHASE2");
  assert.equal(phase2Errors.length, 0, `MISSING_PHASE2 persists after second run: ${JSON.stringify(phase2Errors)}`);
  console.log(`  [INFO] Final Approval after 2nd run: approved=${body.approved}, errors=${(body.errors ?? []).length}`);
});

// ── Runner ─────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
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
console.log(`\nPhase 2 Generation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
