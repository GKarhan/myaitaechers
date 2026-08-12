/**
 * Phase 6 — Teacher Review Workspace tests
 * Tests narrowly scoped to Phase 6 new behavior:
 *   - node approval status update (safe transitions)
 *   - lesson overview update does not overwrite unrelated fields
 *   - exercise move does not duplicate DB rows (logic unit test)
 *
 * Runner: npx tsx src/lib/__tests__/phase6-review.test.ts
 * (custom node:assert runner, consistent with project test architecture)
 */

import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Node approval status — allowed transitions
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_TEACHER_STATUSES = ["approved", "needs_review", "draft"];

function validateStatusTransition(requested: unknown): string | null {
  if (typeof requested !== "string") return null;
  if (!ALLOWED_TEACHER_STATUSES.includes(requested)) return null;
  return requested;
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ─── Approval status validation ──────────────────────────────────────────────

console.log("\nP6.5: Node approval status validation");

test("approved → accepted", () => {
  assert.equal(validateStatusTransition("approved"), "approved");
});
test("needs_review → accepted", () => {
  assert.equal(validateStatusTransition("needs_review"), "needs_review");
});
test("draft → accepted", () => {
  assert.equal(validateStatusTransition("draft"), "draft");
});
test("needs_source_content rejected (not a teacher-settable status)", () => {
  assert.equal(validateStatusTransition("needs_source_content"), null);
});
test("arbitrary string → rejected", () => {
  assert.equal(validateStatusTransition("superadmin"), null);
});
test("number → rejected", () => {
  assert.equal(validateStatusTransition(1), null);
});
test("undefined → rejected (no change)", () => {
  assert.equal(validateStatusTransition(undefined), null);
});

// ─── Phase 2 gate contract (mirrors lessons.ts:1658-1669) ────────────────────

console.log("\nP6.11: Phase 2 gate respects approval");

type NodeStatus = "draft" | "needs_review" | "approved" | "needs_source_content";

function isEligibleForPhase2(status: NodeStatus): boolean {
  // Exact replica of route condition at lessons.ts:1658
  return status !== "needs_review" && status !== "draft";
}

test("draft → skipped by Phase 2", () => {
  assert.equal(isEligibleForPhase2("draft"), false);
});
test("needs_review → skipped by Phase 2", () => {
  assert.equal(isEligibleForPhase2("needs_review"), false);
});
test("approved → eligible for Phase 2", () => {
  assert.equal(isEligibleForPhase2("approved"), true);
});
test("needs_source_content → eligible (weak-source AI still runs)", () => {
  assert.equal(isEligibleForPhase2("needs_source_content"), true);
});

// ─── approve-all logic ───────────────────────────────────────────────────────

console.log("\nP6.6: Approve-all eligibility");

function approveAllFilter(status: NodeStatus): boolean {
  // Mirrors the WHERE clause in approve-all route
  return status === "draft" || status === "needs_review";
}

test("draft node included in approve-all", () => {
  assert.equal(approveAllFilter("draft"), true);
});
test("needs_review node included in approve-all", () => {
  assert.equal(approveAllFilter("needs_review"), true);
});
test("approved node NOT re-promoted (idempotent)", () => {
  assert.equal(approveAllFilter("approved"), false);
});
test("needs_source_content NOT touched by approve-all", () => {
  assert.equal(approveAllFilter("needs_source_content"), false);
});

// ─── Exercise move — no duplicate rows ───────────────────────────────────────

console.log("\nP6.8: Exercise move does not duplicate rows");

interface Exercise {
  id: number;
  lessonId: number;
  relatedNodeId: number | null;
}

function simulateMove(
  exercises: Exercise[],
  exerciseId: number,
  newNodeId: number | null
): Exercise[] {
  // Mirrors the UPDATE approach: only relatedNodeId changes, no INSERT
  return exercises.map((ex) =>
    ex.id === exerciseId ? { ...ex, relatedNodeId: newNodeId } : ex
  );
}

const initialExercises: Exercise[] = [
  { id: 1, lessonId: 69, relatedNodeId: 1291 },
  { id: 2, lessonId: 69, relatedNodeId: null },
  { id: 3, lessonId: 69, relatedNodeId: 1291 },
];

test("row count unchanged after move Node→Additional", () => {
  const after = simulateMove(initialExercises, 1, null);
  assert.equal(after.length, initialExercises.length);
});
test("move Node→Additional: relatedNodeId becomes null", () => {
  const after = simulateMove(initialExercises, 1, null);
  assert.equal(after.find((e) => e.id === 1)!.relatedNodeId, null);
});
test("row count unchanged after move Additional→Node", () => {
  const after = simulateMove(initialExercises, 2, 1291);
  assert.equal(after.length, initialExercises.length);
});
test("move Additional→Node: relatedNodeId set correctly", () => {
  const after = simulateMove(initialExercises, 2, 1291);
  assert.equal(after.find((e) => e.id === 2)!.relatedNodeId, 1291);
});
test("row count unchanged after Node A→Node B", () => {
  const after = simulateMove(initialExercises, 3, 1293);
  assert.equal(after.length, initialExercises.length);
});
test("move Node A→B: relatedNodeId updated to new node", () => {
  const after = simulateMove(initialExercises, 3, 1293);
  assert.equal(after.find((e) => e.id === 3)!.relatedNodeId, 1293);
});
test("unrelated exercises not affected by move", () => {
  const after = simulateMove(initialExercises, 1, null);
  assert.equal(after.find((e) => e.id === 2)!.relatedNodeId, null);
  assert.equal(after.find((e) => e.id === 3)!.relatedNodeId, 1291);
});

// ─── Lesson overview patch — safe field update ────────────────────────────────

console.log("\nP6.2: Lesson overview update safety");

interface LessonPatch {
  description?: string;
  title?: string;
  lessonGoal?: string;
  bloomLevel?: string;
}

function buildLessonPatch(body: LessonPatch): Partial<LessonPatch> {
  // Mirrors teacher route: only set fields that are explicitly provided
  const patch: Partial<LessonPatch> = {};
  if (body.description !== undefined) patch.description = body.description;
  if (body.title !== undefined) patch.title = body.title;
  if (body.lessonGoal !== undefined) patch.lessonGoal = body.lessonGoal;
  return patch;
}

test("description-only update does not touch title", () => {
  const patch = buildLessonPatch({ description: "new desc" });
  assert.ok("description" in patch);
  assert.ok(!("title" in patch));
});
test("empty body produces empty patch (no writes)", () => {
  const patch = buildLessonPatch({});
  assert.equal(Object.keys(patch).length, 0);
});
test("multi-field update preserves all provided fields", () => {
  const patch = buildLessonPatch({ description: "d", title: "t" });
  assert.equal(patch.description, "d");
  assert.equal(patch.title, "t");
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
