// ─────────────────────────────────────────────────────────────────────────────
// P1.7 — Final Lesson Approval Validation — deterministic tests
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/lesson-final-approval.test.ts
// No external test framework — uses node:assert/strict + exit code.
// Live DB: Lesson 105 is the canonical fixture (9 nodes approved + Phase 2 complete; node 1348 intentionally deleted).
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { db, lessonsTable, lessonNodesTable, lessonExercisesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { validateLessonForFinalApproval } from "../lesson-final-approval.js";

const LESSON_ID = 105;

const BEARER = jwt.sign(
  { userId: 1, role: "teacher" },
  process.env.SESSION_SECRET ?? "myaiteacher-secret",
  { expiresIn: "1h" },
) as string;

const BASE = "http://localhost:8080/api";

type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>): void { tests.push([name, fn]); }

async function apiPost(path: string) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

// ── snapshot helpers ──────────────────────────────────────────────────────────

type NodeRow = Awaited<ReturnType<typeof db.select<typeof lessonNodesTable>>>[number];
type ExRow = Awaited<ReturnType<typeof db.select<typeof lessonExercisesTable>>>[number];

async function getNode(nodeId: number): Promise<NodeRow | undefined> {
  const [n] = await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.id, nodeId)).limit(1);
  return n;
}

async function restoreNode(snap: NodeRow): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.update(lessonNodesTable).set(snap as any).where(eq(lessonNodesTable.id, snap.id));
}

async function getExercise(exId: number): Promise<ExRow | undefined> {
  const [e] = await db.select().from(lessonExercisesTable).where(eq(lessonExercisesTable.id, exId)).limit(1);
  return e;
}

async function restoreExercise(snap: ExRow): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.update(lessonExercisesTable).set(snap as any).where(eq(lessonExercisesTable.id, snap.id));
}

// ── find test fixtures ────────────────────────────────────────────────────────

const allNodes = await db.select().from(lessonNodesTable)
  .where(and(eq(lessonNodesTable.lessonId, LESSON_ID), eq(lessonNodesTable.status, "approved")));
const allExercises = await db.select().from(lessonExercisesTable)
  .where(eq(lessonExercisesTable.lessonId, LESSON_ID));
const sourceExercises = allExercises.filter((e) => e.sourceType === "textbook");

const NODE = allNodes[0];
const EX = sourceExercises[0];

if (!NODE) throw new Error("No approved node for lesson 105 — cannot run tests");
if (!EX) throw new Error("No textbook exercise for lesson 105 — cannot run tests");

// ── A: Learning Objective gate ────────────────────────────────────────────────

it("A1: blank LO on approved node → MISSING_LO error", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap, "Node snap must exist");
  try {
    await db.update(lessonNodesTable).set({ learningObjective: "" }).where(eq(lessonNodesTable.id, NODE.id));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const err = result.errors.find((e) => e.code === "MISSING_LO");
    assert.ok(err, "Expected MISSING_LO error");
    assert.equal(err?.nodeId, NODE.id, "Error must reference the modified node");
  } finally {
    await restoreNode(snap!);
  }
});

it("A2: MISSING_LO blocks POST final-approve → 422", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable).set({ learningObjective: "   " }).where(eq(lessonNodesTable.id, NODE.id));
    const { status, body } = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(status, 422, `Expected 422, got ${status}`);
    assert.equal(body.approved, false);
    assert.ok(
      (body.errors as Array<{ code: string }>).some((e) => e.code === "MISSING_LO"),
      "Expected MISSING_LO in errors",
    );
  } finally {
    await restoreNode(snap!);
  }
});

// ── B: Empty MicroNode gate ───────────────────────────────────────────────────

it("B1: approved node with no theory + no anchor → EMPTY_NODE error", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable)
      .set({ theoryContent: null, verbatimTheoryAnchor: null })
      .where(eq(lessonNodesTable.id, NODE.id));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const err = result.errors.find((e) => e.code === "EMPTY_NODE");
    assert.ok(err, "Expected EMPTY_NODE error");
    assert.equal(err?.nodeId, NODE.id);
  } finally {
    await restoreNode(snap!);
  }
});

// ── D/E: Lost source exercises ─────────────────────────────────────────────────

it("D1: inflated sourceExerciseCount in meta → LOST_SOURCE_EXERCISES error", async () => {
  const [lesson] = await db.select({ mm: lessonsTable.mappingMetadata })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  const origMeta = (lesson?.mm ?? {}) as Record<string, unknown>;
  try {
    await db.update(lessonsTable)
      .set({ mappingMetadata: { ...origMeta, sourceExerciseCount: 99999 } })
      .where(eq(lessonsTable.id, LESSON_ID));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const err = result.errors.find((e) => e.code === "LOST_SOURCE_EXERCISES");
    assert.ok(err, "Expected LOST_SOURCE_EXERCISES error");
    assert.ok((err?.count ?? 0) > 0, "Lost count must be > 0");
  } finally {
    await db.update(lessonsTable)
      .set({ mappingMetadata: { ...origMeta, sourceExerciseCount: 15 } })
      .where(eq(lessonsTable.id, LESSON_ID));
  }
});

// ── F: Exercise approval states ───────────────────────────────────────────────

it("F1: draft textbook exercise → DRAFT_SOURCE_EXERCISES error", async () => {
  const snap = await getExercise(EX.id);
  assert.ok(snap);
  try {
    await db.update(lessonExercisesTable)
      .set({ status: "draft" })
      .where(eq(lessonExercisesTable.id, EX.id));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const err = result.errors.find((e) => e.code === "DRAFT_SOURCE_EXERCISES");
    assert.ok(err, "Expected DRAFT_SOURCE_EXERCISES error");
    assert.ok((err?.count ?? 0) >= 1, "Count must be ≥ 1");
  } finally {
    await restoreExercise(snap!);
  }
});

it("F2: DRAFT_SOURCE_EXERCISES blocks final-approve → 422", async () => {
  const snap = await getExercise(EX.id);
  assert.ok(snap);
  try {
    await db.update(lessonExercisesTable)
      .set({ status: "draft" })
      .where(eq(lessonExercisesTable.id, EX.id));
    const { status, body } = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(status, 422);
    assert.equal(body.approved, false);
    assert.ok(
      (body.errors as Array<{ code: string }>).some((e) => e.code === "DRAFT_SOURCE_EXERCISES"),
    );
  } finally {
    await restoreExercise(snap!);
  }
});

// ── G: Phase 2 enrichment ─────────────────────────────────────────────────────

it("G1: approved node missing childFriendlyExplanation → MISSING_PHASE2 error", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable)
      .set({ childFriendlyExplanation: null })
      .where(eq(lessonNodesTable.id, NODE.id));
    const result = await validateLessonForFinalApproval(LESSON_ID);
    const err = result.errors.find((e) => e.code === "MISSING_PHASE2");
    assert.ok(err, "Expected MISSING_PHASE2 error");
    assert.equal(err?.nodeId, NODE.id);
  } finally {
    await restoreNode(snap!);
  }
});

it("G2: MISSING_PHASE2 blocks final-approve → 422", async () => {
  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    await db.update(lessonNodesTable)
      .set({ commonMisconception: null })
      .where(eq(lessonNodesTable.id, NODE.id));
    const { status, body } = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
    assert.equal(status, 422);
    assert.equal(body.approved, false);
    assert.ok(
      (body.errors as Array<{ code: string }>).some((e) => e.code === "MISSING_PHASE2"),
    );
  } finally {
    await restoreNode(snap!);
  }
});

// ── P: Positive path ─────────────────────────────────────────────────────────

it("P1: lesson 105 clean → approved: true (200)", async () => {
  const { status, body } = await apiPost(`/lessons/${LESSON_ID}/final-approve`);
  assert.equal(status, 200, `Expected 200, got ${status} body: ${JSON.stringify(body)}`);
  assert.equal(body.approved, true);
  assert.equal((body.errors as unknown[]).length, 0, "Expected 0 errors");
  const summary = body.summary as Record<string, number>;
  assert.ok(summary.approvedNodes > 0, "Must have approved nodes");
  assert.ok(summary.phase2CompleteNodes > 0, "Must have Phase 2 complete nodes");

  const [lesson] = await db.select({ status: lessonsTable.status })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  assert.equal(lesson?.status, "approved", "DB lesson.status must be 'approved'");
});

it("P2: GET /lessons/105 returns authoringStatus: 'approved'", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}`, {
    headers: { Authorization: `Bearer ${BEARER}` },
  });
  const body = await r.json() as Record<string, unknown>;
  assert.equal(body.authoringStatus, "approved", `Expected 'approved', got '${body.authoringStatus}'`);
});

// ── I: Invalidation (POST-P1.12 semantics) ───────────────────────────────────

it("I1: node update while approved + everApproved=true → lesson STAYS approved (not reverted)", async () => {
  // POST-P1.12 AUTHORING SIMPLIFICATION:
  // Once a lesson has ever been approved (everApproved=true), ordinary teacher
  // edits must NOT revert the lesson to needs_review.
  // Lesson 105 has everApproved=true (set by final-approve above).

  // Ensure lesson is approved first
  await db.update(lessonsTable).set({ status: "approved" } as never).where(eq(lessonsTable.id, LESSON_ID));

  const snap = await getNode(NODE.id);
  assert.ok(snap);

  // Node update via the POST .../update route
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "P1.7 invalidation test — new semantics" }),
  });
  assert.equal(r.status, 200, "Node update must succeed");

  // With everApproved=true the lesson must NOT revert to needs_review.
  const [lesson] = await db.select({ status: lessonsTable.status })
    .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
  assert.equal(lesson?.status, "approved", "Lesson must remain approved when everApproved=true");
  await restoreNode(snap!);
});

it("I2: invalidateLessonApproval DID revert when everApproved=false (backward-compat guard)", async () => {
  // Manually set everApproved=false to test the OLD code path still works
  // for lessons that have never been approved.
  await db.update(lessonsTable)
    .set({ status: "approved", everApproved: false } as never)
    .where(eq(lessonsTable.id, LESSON_ID));

  const snap = await getNode(NODE.id);
  assert.ok(snap);
  try {
    const r = await fetch(`${BASE}/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "P1.7 invalidation test — everApproved=false path" }),
    });
    assert.equal(r.status, 200, "Node update must succeed");

    const [lesson] = await db.select({ status: lessonsTable.status })
      .from(lessonsTable).where(eq(lessonsTable.id, LESSON_ID)).limit(1);
    assert.equal(lesson?.status, "needs_review", "Lesson must revert when everApproved=false");
  } finally {
    await restoreNode(snap!);
    // Restore everApproved=true and re-approve for subsequent suite cleanliness
    await db.update(lessonsTable)
      .set({ everApproved: true } as never)
      .where(eq(lessonsTable.id, LESSON_ID));
  }
});

// Restore lesson to "active" so other Phase 1.12 test suites can use lesson 105
// without needing to re-approve it. This is the canonical post-test state for
// the shared fixture. The approval gate is still tested (P1, I1, I2 above).
async function cleanup() {
  await db.update(lessonsTable).set({ status: "active" } as any).where(eq(lessonsTable.id, LESSON_ID));
}

// ── Runner ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

const total = tests.length;
console.log(`\n  lesson-final-approval — ${total} test cases\n`);

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

await cleanup();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
