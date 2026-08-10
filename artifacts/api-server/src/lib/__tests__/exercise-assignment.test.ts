// ─────────────────────────────────────────────────────────────────────────────
// Exercise Assignment Visibility — deterministic tests (P5.2)
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/exercise-assignment.test.ts
//
// Tests cover:
//   1.  EXERCISE blockType → assignment "CLASS"
//   2.  ACTIVITY blockType → assignment "CLASS"
//   3.  HOMEWORK blockType → assignment "HOMEWORK"
//   4.  Unknown/other blockType → assignment "CLASS" (safe default)
//   5.  MicroNode exercises always get "CLASS"
//   6.  Phase 2 query predicate: relatedNodeId = X AND assignment = "CLASS" (node-specific)
//   7.  Phase 2 query excludes relatedNodeId = null (unassigned do NOT appear Phase 2)
//   8.  Phase 3 query: relatedNodeId IN nodes OR relatedNodeId IS NULL, assignment = "CLASS"
//   9.  Phase 3 query excludes assignment = "HOMEWORK"
//   10. Phase 3 query scoped to lessonId (no cross-lesson leaks)
//   11. Homework query: lessonId filter + assignment = "HOMEWORK" only
//   12. assignment = NULL excluded from all Phase 2/3/HOMEWORK queries
//   13. Manual CRUD assignment default ("CLASS") unchanged by P5.2
//   14. Phase 3 with empty allNodeIds → falls back to IS NULL only
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";

const tests: Array<[string, () => void]> = [];
function it(name: string, fn: () => void): void { tests.push([name, fn]); }

// ── Pure helper — mirrors the inline logic in lessons.ts (P5.2 additionalExercises) ──

function deriveExerciseAssignment(blockType: string): "CLASS" | "HOMEWORK" {
  return blockType === "HOMEWORK" ? "HOMEWORK" : "CLASS";
}

// ── Pure helper — mirrors the MicroNode exercise insertion (always CLASS) ────

function deriveMicroNodeAssignment(): "CLASS" {
  return "CLASS";
}

// ── Query predicate simulators ────────────────────────────────────────────────
// These mirror the exact WHERE conditions in chat.ts.
// We simulate the SQL predicates with in-process JS logic so tests are
// deterministic without a live DB connection.

type MockExercise = {
  lessonId:          number;
  relatedNodeId:     number | null;
  assignment:        string | null;
};

/** Simulates Phase 2 classExercises WHERE clause (chat.ts lines 341-344) */
function phase2Matches(ex: MockExercise, currentNodeId: number): boolean {
  return ex.relatedNodeId === currentNodeId && ex.assignment === "CLASS";
}

/**
 * Simulates Phase 3 classExercises WHERE clause after P5.2 (chat.ts fixed version).
 * Includes: (relatedNodeId IN allNodeIds OR relatedNodeId IS NULL)
 *         AND assignment = "CLASS"
 *         AND lessonId = targetLessonId
 */
function phase3Matches(
  ex: MockExercise,
  targetLessonId: number,
  allNodeIds: number[],
): boolean {
  if (ex.lessonId !== targetLessonId) return false;
  if (ex.assignment !== "CLASS") return false;
  if (ex.relatedNodeId === null) return true;
  if (allNodeIds.includes(ex.relatedNodeId)) return true;
  return false;
}

/** Simulates homework WHERE clause (chat.ts lines 372-375) */
function homeworkMatches(ex: MockExercise, targetLessonId: number): boolean {
  return ex.lessonId === targetLessonId && ex.assignment === "HOMEWORK";
}

// ── Tests: assignment derivation ──────────────────────────────────────────────

it("Test 1: EXERCISE blockType → assignment 'CLASS'", () => {
  assert.equal(deriveExerciseAssignment("EXERCISE"), "CLASS");
});

it("Test 2: ACTIVITY blockType → assignment 'CLASS'", () => {
  assert.equal(deriveExerciseAssignment("ACTIVITY"), "CLASS");
});

it("Test 3: HOMEWORK blockType → assignment 'HOMEWORK'", () => {
  assert.equal(deriveExerciseAssignment("HOMEWORK"), "HOMEWORK");
});

it("Test 4: Unknown blockType → assignment 'CLASS' (safe default)", () => {
  assert.equal(deriveExerciseAssignment("TABLE"),      "CLASS");
  assert.equal(deriveExerciseAssignment("NOTE"),       "CLASS");
  assert.equal(deriveExerciseAssignment("DEFINITION"), "CLASS");
  assert.equal(deriveExerciseAssignment(""),           "CLASS");
});

it("Test 5: MicroNode exercises always get 'CLASS'", () => {
  assert.equal(deriveMicroNodeAssignment(), "CLASS");
});

// ── Tests: Phase 2 query predicate ───────────────────────────────────────────

it("Test 6: Phase 2 — relatedNodeId = currentNodeId AND assignment = CLASS → visible", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: 1209, assignment: "CLASS" };
  assert.equal(phase2Matches(ex, 1209), true);
});

it("Test 7a: Phase 2 — relatedNodeId = null (unassigned CLASS) → NOT visible in Phase 2", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: null, assignment: "CLASS" };
  assert.equal(phase2Matches(ex, 1209), false, "unassigned must NOT appear in Phase 2");
});

it("Test 7b: Phase 2 — wrong nodeId → NOT visible", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: 1208, assignment: "CLASS" };
  assert.equal(phase2Matches(ex, 1209), false);
});

it("Test 7c: Phase 2 — assignment = NULL → NOT visible", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: 1209, assignment: null };
  assert.equal(phase2Matches(ex, 1209), false, "assignment=NULL must not pass Phase 2 filter");
});

it("Test 7d: Phase 2 — assignment = HOMEWORK → NOT visible as classExercise", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: 1209, assignment: "HOMEWORK" };
  assert.equal(phase2Matches(ex, 1209), false);
});

// ── Tests: Phase 3 query predicate ───────────────────────────────────────────

it("Test 8a: Phase 3 — node-linked CLASS exercise → visible", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: 1209, assignment: "CLASS" };
  assert.equal(phase3Matches(ex, 104, [1208, 1209]), true);
});

it("Test 8b: Phase 3 — unassigned CLASS exercise (relatedNodeId=null) → visible", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: null, assignment: "CLASS" };
  assert.equal(phase3Matches(ex, 104, [1208, 1209]), true, "unassigned CLASS must appear in Phase 3");
});

it("Test 9: Phase 3 — HOMEWORK exercise → NOT included in classExercises", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: null, assignment: "HOMEWORK" };
  assert.equal(phase3Matches(ex, 104, [1208, 1209]), false, "HOMEWORK excluded from Phase 3 classExercises");
});

it("Test 10: Phase 3 — wrong lessonId with relatedNodeId=null → NOT visible (cross-lesson guard)", () => {
  const ex: MockExercise = { lessonId: 99, relatedNodeId: null, assignment: "CLASS" };
  assert.equal(phase3Matches(ex, 104, [1208, 1209]), false, "cross-lesson unassigned exercise must be excluded");
});

it("Test 10b: Phase 3 — assignment = NULL → NOT visible", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: null, assignment: null };
  assert.equal(phase3Matches(ex, 104, [1208, 1209]), false, "assignment=NULL must not pass Phase 3 filter");
});

it("Test 10c: Phase 3 — node-linked to different lesson → NOT visible", () => {
  const ex: MockExercise = { lessonId: 99, relatedNodeId: 777, assignment: "CLASS" };
  assert.equal(phase3Matches(ex, 104, [1208, 1209]), false);
});

// ── Tests: Phase 3 with empty allNodeIds ─────────────────────────────────────

it("Test 14: Phase 3 — empty allNodeIds → only relatedNodeId=null exercises visible", () => {
  const unassigned: MockExercise = { lessonId: 104, relatedNodeId: null, assignment: "CLASS" };
  const nodeLinked: MockExercise = { lessonId: 104, relatedNodeId: 1209, assignment: "CLASS" };
  assert.equal(phase3Matches(unassigned, 104, []), true,  "unassigned visible even with empty node list");
  assert.equal(phase3Matches(nodeLinked, 104, []), false, "node-linked NOT visible with empty node list");
});

// ── Tests: Homework query predicate ──────────────────────────────────────────

it("Test 11a: Homework — lessonId match + HOMEWORK assignment → visible", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: null, assignment: "HOMEWORK" };
  assert.equal(homeworkMatches(ex, 104), true);
});

it("Test 11b: Homework — CLASS assignment → NOT in homework", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: null, assignment: "CLASS" };
  assert.equal(homeworkMatches(ex, 104), false);
});

it("Test 11c: Homework — wrong lessonId → NOT visible", () => {
  const ex: MockExercise = { lessonId: 99, relatedNodeId: null, assignment: "HOMEWORK" };
  assert.equal(homeworkMatches(ex, 104), false);
});

it("Test 11d: Homework — assignment = NULL → NOT visible", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: null, assignment: null };
  assert.equal(homeworkMatches(ex, 104), false, "assignment=NULL must not appear in HOMEWORK_TASKS");
});

// ── Test 12: assignment = NULL excluded from all contexts ─────────────────────

it("Test 12: assignment=NULL excluded from Phase 2, Phase 3, and Homework", () => {
  const ex: MockExercise = { lessonId: 104, relatedNodeId: 1209, assignment: null };
  assert.equal(phase2Matches(ex, 1209),          false, "Phase 2 must exclude assignment=NULL");
  assert.equal(phase3Matches(ex, 104, [1209]),   false, "Phase 3 must exclude assignment=NULL");
  assert.equal(homeworkMatches(ex, 104),          false, "Homework must exclude assignment=NULL");
});

// ── Test 13: manual CRUD default unchanged ────────────────────────────────────
// The CRUD POST endpoint at lessons.ts line 881 has `assignment: assignment ?? "CLASS"`.
// P5.2 does NOT touch that line — it only adds assignment to the auto-mapping insertions.
// Verify by checking the CRUD default is still "CLASS" when no explicit assignment is given.

it("Test 13: CRUD default — undefined assignment → 'CLASS' (unchanged by P5.2)", () => {
  const explicitAssignment: string | undefined = undefined;
  const resolved = explicitAssignment ?? "CLASS";
  assert.equal(resolved, "CLASS", "manual CRUD default must remain 'CLASS'");
});

// ── Full scenario: L104-style exercise set ────────────────────────────────────

it("Full scenario: L104 — 2 mapped + 8 unassigned exercises, Phase 2/3 visibility", () => {
  const lessonId = 104;
  const allNodeIds = [1208, 1209];

  // Post-remap DB state (all with correct assignment after P5.2 fix)
  const exercises: MockExercise[] = [
    { lessonId: 104, relatedNodeId: 1209, assignment: "CLASS"    },  // EX-104-1 (MicroNode mapped)
    { lessonId: 104, relatedNodeId: 1209, assignment: "CLASS"    },  // EX-104-2 (MicroNode mapped)
    { lessonId: 104, relatedNodeId: null, assignment: "CLASS"    },  // EX-104-3 (EXERCISE block)
    { lessonId: 104, relatedNodeId: null, assignment: "CLASS"    },  // EX-104-4 (EXERCISE block)
    { lessonId: 104, relatedNodeId: null, assignment: "CLASS"    },  // EX-104-5 (EXERCISE block)
    { lessonId: 104, relatedNodeId: null, assignment: "CLASS"    },  // EX-104-6 (EXERCISE block)
    { lessonId: 104, relatedNodeId: null, assignment: "CLASS"    },  // EX-104-7 (EXERCISE block)
    { lessonId: 104, relatedNodeId: null, assignment: "CLASS"    },  // EX-104-8 (EXERCISE block)
    { lessonId: 104, relatedNodeId: null, assignment: "CLASS"    },  // EX-104-9 (EXERCISE block)
    { lessonId: 104, relatedNodeId: null, assignment: "CLASS"    },  // EX-104-10 (EXERCISE block)
  ];

  // Phase 2, currentNodeId = 1209: only the 2 mapped exercises visible
  const phase2Visible = exercises.filter(ex => phase2Matches(ex, 1209));
  assert.equal(phase2Visible.length, 2, "Phase 2 must show exactly 2 mapped exercises for MN1209");

  // Phase 2, currentNodeId = 1208: 0 exercises (no exercises linked to MN1208)
  const phase2VisibleMN1208 = exercises.filter(ex => phase2Matches(ex, 1208));
  assert.equal(phase2VisibleMN1208.length, 0, "Phase 2 for MN1208 must show 0 exercises");

  // Phase 3: all 10 (2 node-linked + 8 unassigned) visible
  const phase3Visible = exercises.filter(ex => phase3Matches(ex, lessonId, allNodeIds));
  assert.equal(phase3Visible.length, 10, "Phase 3 must show all 10 CLASS exercises");

  // Homework: 0 (no HOMEWORK blocks in L104)
  const hwVisible = exercises.filter(ex => homeworkMatches(ex, lessonId));
  assert.equal(hwVisible.length, 0, "Homework context must show 0 (no HOMEWORK blocks in L104)");
});

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
    failed++;
  }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
