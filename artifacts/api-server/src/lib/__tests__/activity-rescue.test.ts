// ─────────────────────────────────────────────────────────────────────────────
// Activity Normalization — integration tests for normalizeActivityPlacements()
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/activity-rescue.test.ts
//
// Tests that normalizeActivityPlacements() (lesson-mapping.ts) enforces:
//   ∀ EXERCISE / ACTIVITY / HOMEWORK block N → exactly ONE valid placement in
//   microNode.exercises[] OR topic.additionalExercises[].
//
// Required test cases (per spec):
//   Test  1: activity only in exercises[]          → no rescue
//   Test  2: activity only in additionalExercises[] → no rescue
//   Test  3: activity missing from all Pass2 output → Step C rescue
//   Test  4: blockIndex: null in additionalExercises → correct rescue
//   Test  5: invalid out-of-range blockIndex         → correct rescue
//   Test  6: same block in exercises[] + additionalExercises[] → exactly one placement (exercises[] wins)
//   Test  7: duplicate additionalExercises entries   → exactly one placement
//   Test  8: stripped MicroNode (safety-net) + activity → preserved exactly once
//   Test  9: multiple activity blocks                → each appears exactly once
//   Test 10: regression — L104 block 13 ACTIVITY_IN_THEORY + Step C = old duplicate (now fixed)
//   Test 11: rescue occurs before coverage validation (normalizeActivityPlacements mutates first)
//   Test 12: final coverage has no duplicate activity indices
//
// isValidBlockIndex helper tests follow.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { isValidBlockIndex, normalizeActivityPlacements } from "../../services/lesson-mapping.js";
import { validateSourceCoverage } from "../coverage-validator.js";
import type { Pass2TopicResult, Pass2MicroNode } from "../../services/lesson-mapping.js";

const tests: Array<[string, () => void]> = [];
function it(name: string, fn: () => void): void { tests.push([name, fn]); }

// ── Minimal block factory ─────────────────────────────────────────────────────

interface MockBlock {
  blockType:       string;
  sourceText:      string;
  sourcePage:      number;
  sourceParagraph: string | null;
}

function makeBlock(blockType: string, text = "Text.", page = 1): MockBlock {
  return { blockType, sourceText: text, sourcePage: page, sourceParagraph: text.slice(0, 40) };
}

// Helper: build a minimal Pass2MicroNode for testing.
function makeMN(
  title: string,
  sourceBlockIndices: number[],
  exercises: { blockIndex: unknown }[] = [],
  supportingMaterialIndices: number[] = [],
): Pass2MicroNode {
  return {
    title,
    learningObjective: "test LO",
    microNodeType: "skill" as const,
    sourceBlockIndices,
    exercises: exercises as Pass2MicroNode["exercises"],
    supportingMaterialIndices,
  };
}

// Helper: build a minimal Pass2TopicResult.
function makeTopic(
  title: string,
  microNodes: Pass2MicroNode[],
  unmappedBlockIndices: number[] = [],
  additionalExercises: { blockIndex: unknown; sourceParagraph?: string | null }[] = [],
): Pass2TopicResult {
  return {
    sequence: 1,
    title,
    topicType: "skill",
    microNodes,
    unmappedBlockIndices,
    additionalExercises: additionalExercises as Pass2TopicResult["additionalExercises"],
  };
}

// ── Test 1 — activity only in exercises[] → no rescue ────────────────────────

it("Test 1: activity only in exercises[] — no rescue needed", () => {
  const blocks = [makeBlock("RULE"), makeBlock("EXERCISE")];
  const topics = [makeTopic("T", [makeMN("MN", [0], [{ blockIndex: 1 }])])];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(r.evictedFromSource, [],   "no eviction");
  assert.deepEqual(r.stepBRescued,      [],   "no Step B");
  assert.deepEqual(r.stepCRescued,      [],   "no Step C");
  assert.equal(topics[0].microNodes[0].exercises.length, 1, "exercise kept");
  assert.equal(topics[0].additionalExercises.length,     0, "no additional");
});

// ── Test 2 — activity only in additionalExercises[] → no rescue ──────────────

it("Test 2: activity only in additionalExercises[] — no rescue needed", () => {
  const blocks = [makeBlock("RULE"), makeBlock("EXERCISE")];
  const topics = [makeTopic("T", [makeMN("MN", [0])], [], [{ blockIndex: 1 }])];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(r.stepBRescued, [], "no Step B");
  assert.deepEqual(r.stepCRescued, [], "no Step C");
  assert.equal(topics[0].additionalExercises.length, 1, "additionalExercise kept");
  assert.equal((topics[0].additionalExercises[0] as any).blockIndex, 1);
});

// ── Test 3 — activity missing from all Pass2 output → Step C rescue ──────────

it("Test 3: activity missing entirely from Pass2 output — Step C rescues to last topic", () => {
  const blocks = [makeBlock("RULE"), makeBlock("EXERCISE")];
  const topics = [makeTopic("T", [makeMN("MN", [0])])]; // block 1 not mentioned anywhere

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(r.stepCRescued, [1], "Step C must rescue block 1");
  const valid = (topics[0].additionalExercises as any[]).filter(e => isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(valid.length, 1);
  assert.equal(valid[0].blockIndex, 1);
});

// ── Test 4 — blockIndex: null in additionalExercises → correct rescue ─────────

it("Test 4: additionalExercises has blockIndex: null — Step C rescues original block", () => {
  const blocks = [makeBlock("RULE"), makeBlock("EXERCISE", "Task.", 38)];
  // AI returned null blockIndex — invalid, must be dropped and real block rescued
  const topics = [makeTopic("T", [makeMN("MN", [0])], [], [{ blockIndex: null }])];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(r.stepCRescued, [1], "Step C rescues block 1 (null didn't count)");
  const valid = (topics[0].additionalExercises as any[]).filter(e => isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(valid.length, 1,        "exactly one valid entry after normalization");
  assert.equal(valid[0].blockIndex, 1, "correct blockIndex");
  // The invalid null entry is gone
  const invalid = (topics[0].additionalExercises as any[]).filter(e => !isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(invalid.length, 0, "null entry removed from additionalExercises");
});

// ── Test 5 — invalid out-of-range blockIndex → correct rescue ────────────────

it("Test 5: additionalExercises has blockIndex: 999 (out of range) — Step C rescues", () => {
  const blocks = [makeBlock("RULE"), makeBlock("EXERCISE", "Task.", 38)];
  // AI used textbook exercise number instead of Pass1 block index
  const topics = [makeTopic("T", [makeMN("MN", [0])], [], [{ blockIndex: 999 }])];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(r.stepCRescued, [1], "Step C rescues block 1");
  const valid = (topics[0].additionalExercises as any[]).filter(e => isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(valid.length, 1);
  assert.equal(valid[0].blockIndex, 1);
  // Invalid 999 entry is gone
  const invalid = (topics[0].additionalExercises as any[]).filter(e => !isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(invalid.length, 0, "out-of-range entry removed");
});

// ── Test 6 — same block in exercises[] + additionalExercises[] → exercises[] wins ─

it("Test 6: block in exercises[] AND additionalExercises[] — exercises[] wins, additionalExercises entry removed", () => {
  const blocks = [makeBlock("RULE"), makeBlock("EXERCISE")];
  // exercises[] has blockIndex 1; additionalExercises also has blockIndex 1 (AI duplicate)
  const topics = [makeTopic("T",
    [makeMN("MN", [0], [{ blockIndex: 1 }])],
    [],
    [{ blockIndex: 1 }],
  )];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(r.stepBRescued, [], "no Step B");
  assert.deepEqual(r.stepCRescued, [], "no Step C");
  // exercises[] entry preserved
  assert.equal(topics[0].microNodes[0].exercises.length, 1, "exercise kept in exercises[]");
  assert.equal((topics[0].microNodes[0].exercises[0] as any).blockIndex, 1);
  // additionalExercises entry removed (exercises[] wins)
  assert.equal(topics[0].additionalExercises.length, 0, "duplicate removed from additionalExercises[]");
  assert.ok(r.dedupedAdditional.includes(1), "blockIndex 1 logged as deduped from additional");
});

// ── Test 7 — duplicate additionalExercises entries → exactly one placement ───

it("Test 7: duplicate additionalExercises entries — exactly one final placement", () => {
  const blocks = [makeBlock("RULE"), makeBlock("EXERCISE")];
  // AI returned block 1 twice in additionalExercises
  const topics = [makeTopic("T",
    [makeMN("MN", [0])],
    [],
    [{ blockIndex: 1 }, { blockIndex: 1 }],
  )];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(r.stepCRescued, [], "no Step C — block already placed (first occurrence)");
  const valid = (topics[0].additionalExercises as any[]).filter(e => isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(valid.length, 1,        "exactly one valid additionalExercise entry");
  assert.equal(valid[0].blockIndex, 1, "correct blockIndex");
  assert.ok(r.dedupedAdditional.includes(1), "second occurrence logged as deduped");
});

// ── Test 8 — stripped MicroNode (safety-net) + activity → preserved exactly once ─

it("Test 8: safety-net strips MicroNode — exercise preserved exactly once (no duplicate)", () => {
  // Simulates what the safety-net does in organizeTopicMicroNodes:
  //   - Invalid MicroNode's exercises are pushed to topic.additionalExercises
  //   - Valid MN has block 0 in sourceBlockIndices, block 1 in exercises[]
  //   - Safety-net pushed {blockIndex: null} (invalid) exercises to additionalExercises
  //   - Real EXERCISE block 1 is in exercises[] of valid MN
  const blocks = [makeBlock("RULE"), makeBlock("EXERCISE")];
  const topics = [makeTopic("T",
    [makeMN("MN-valid", [0], [{ blockIndex: 1 }])],
    [],
    // Safety-net pushed invalid exercises (null blockIndex) from stripped MN
    [{ blockIndex: null }, { blockIndex: null }],
  )];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(r.stepCRescued, [], "no Step C — block 1 already in exercises[]");
  // exercises[] entry preserved
  assert.equal(topics[0].microNodes[0].exercises.length, 1, "exercise kept in exercises[]");
  // Invalid additionalExercises (null) removed
  const remaining = (topics[0].additionalExercises as any[]);
  assert.equal(remaining.length, 0, "null entries removed from additionalExercises");

  // Coverage validation: block 1 appears exactly once
  const coverage = validateSourceCoverage(2, topics as any);
  assert.deepEqual(coverage.duplicateIndices, [], "no duplicates");
  assert.deepEqual(coverage.missingIndices,   [], "no missing (block 0 in source, block 1 in exercises)");
});

// ── Test 9 — multiple activity blocks → each appears exactly once ─────────────

it("Test 9: multiple activity blocks — each appears exactly once", () => {
  const blocks = [
    makeBlock("RULE"),     // 0
    makeBlock("EXERCISE"), // 1 → in exercises[MN1]
    makeBlock("ACTIVITY"), // 2 → in additionalExercises
    makeBlock("HOMEWORK"), // 3 → missing from AI output → Step C
    makeBlock("EXERCISE"), // 4 → in unmappedBlockIndices → Step B
    makeBlock("NOTE"),     // 5 → theory, no activity rescue
  ];
  const topics = [makeTopic("T",
    [
      makeMN("MN1", [0], [{ blockIndex: 1 }]),
      makeMN("MN2", [5]),
    ],
    [4], // block 4 EXERCISE wrongly placed in unmapped
    [{ blockIndex: 2 }], // block 2 ACTIVITY in additionalExercises
    // block 3 HOMEWORK entirely missing from AI output
  )];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(r.evictedFromSource, [],  "no eviction");
  assert.deepEqual(r.stepBRescued,      [4], "block 4 rescued from unmapped");
  assert.deepEqual(r.stepCRescued,      [3], "block 3 rescued by Step C");

  // Each activity block appears exactly once
  const coverage = validateSourceCoverage(6, topics as any);
  assert.deepEqual(coverage.duplicateIndices, [], "no duplicates");
  assert.deepEqual(coverage.missingIndices,   [], "no missing");
  assert.equal(coverage.valid, true, "coverage valid");

  // Verify final placements
  const exs = (topics[0].microNodes[0].exercises as any[]).map(e => e.blockIndex);
  assert.deepEqual(exs, [1], "block 1 in MN1.exercises[]");
  const add = (topics[0].additionalExercises as any[]).filter(e => isValidBlockIndex(e.blockIndex, blocks)).map(e => e.blockIndex).sort((a, b) => a - b);
  assert.deepEqual(add, [2, 3, 4], "blocks 2, 3, 4 in additionalExercises");
});

// ── Test 10 — L104 regression: block 13 ACTIVITY_IN_THEORY + Step C = duplicate (now fixed) ──

it("Test 10: L104 regression — EXERCISE block in sourceBlockIndices + Step C = old duplicate; now fixed", () => {
  // 18-block scenario: block 13 is EXERCISE but AI put it in MN.sourceBlockIndices.
  // Old behaviour: Step C rescues 13 to additionalExercises → coverage duplicate.
  // New behaviour: normalizeActivityPlacements evicts 13 from sourceBlockIndices,
  //                rescues it to additionalExercises exactly once.
  const blocks: MockBlock[] = [];
  for (let i = 0; i < 13; i++) blocks.push(makeBlock("DEFINITION", `Theory ${i}.`));
  blocks.push(makeBlock("EXERCISE", "Exercise 13."));       // 13
  for (let i = 14; i < 18; i++) blocks.push(makeBlock("EXERCISE", `Exercise ${i}.`)); // 14-17

  // AI output: MN has block 13 among its sourceBlockIndices (wrong — ACTIVITY_IN_THEORY).
  // Blocks 14-17 EXERCISE: AI returned null blockIndex (invalid additionalExercises entries).
  const invalidAdditional = [14, 15, 16, 17].map(() => ({ blockIndex: null, sourceParagraph: null }));
  const topics = [makeTopic("T",
    // MN has blocks 0-13 in sourceBlockIndices. Block 13 is EXERCISE → evicted but MN stays (0-12 remain).
    [makeMN("MN-main", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], [])],
    [],
    invalidAdditional,
  )];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  // Block 13 must be evicted from sourceBlockIndices
  assert.ok(r.evictedFromSource.includes(13), "block 13 evicted from sourceBlockIndices");
  assert.ok(!topics[0].microNodes[0].sourceBlockIndices.includes(13),
    "block 13 removed from MN.sourceBlockIndices");
  // MN still has blocks 0-12 → NOT stripped by Phase 1b
  assert.equal(topics[0].microNodes.length, 1, "MN kept (still has theory blocks)");
  assert.deepEqual(r.postEvictionStripped, [], "no post-eviction MN stripping needed");

  // Blocks 14-17 and 13 rescued (null entries dropped, then Step C picks them up)
  const valid = (topics[0].additionalExercises as any[]).filter(e => isValidBlockIndex(e.blockIndex, blocks));
  const validIndices = valid.map((e: any) => e.blockIndex).sort((a: number, b: number) => a - b);
  assert.deepEqual(validIndices, [13, 14, 15, 16, 17], "all 5 exercise blocks rescued exactly once");

  // Coverage must be clean — NO duplicates for block 13
  const coverage = validateSourceCoverage(18, topics as any);
  assert.deepEqual(coverage.duplicateIndices, [],  "no duplicate indices (block 13 fixed)");
  assert.deepEqual(coverage.missingIndices,   [],  "no missing indices");
  assert.equal(coverage.valid, true,               "coverage is valid");
});

// ── Test 10b — Phase 1b: MicroNode whose ONLY source block is ACTIVITY → stripped ──

it("Test 10b: MN has ONLY activity blocks in sourceBlockIndices — eviction leaves empty MN, Phase 1b strips it", () => {
  // Scenario: AI creates a MN with sourceBlockIndices = [1] where block 1 is EXERCISE.
  // Old behaviour (after Phase 1 only): evict block 1 → MN.sourceBlockIndices = []
  //   → coverage validator: emptyMicroNodes → coverage_failed.
  // New behaviour (Phase 1b): MN with empty sourceBlockIndices after eviction is stripped;
  //   its exercises are moved to additionalExercises.
  const blocks: MockBlock[] = [
    makeBlock("DEFINITION", "Theory block."),  // 0
    makeBlock("EXERCISE",   "Only exercise."), // 1 — the ONLY source block in the MN
    makeBlock("RULE",       "More theory."),   // 2
  ];
  // MN has sourceBlockIndices = [1] (only block 1 which is EXERCISE — wrong)
  // MN also has exercises = [{blockIndex: 1}] (AI correctly linked exercise too)
  const topics = [makeTopic("T",
    [
      makeMN("MN-theory", [0, 2]),                                    // valid theory MN
      makeMN("MN-activity-only", [1], [{ blockIndex: 1 }]),           // only-activity source → Phase 1b strips it
    ],
  )];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  // Block 1 evicted from sourceBlockIndices
  assert.ok(r.evictedFromSource.includes(1), "block 1 evicted");
  // MN-activity-only stripped by Phase 1b (sourceBlockIndices became empty)
  assert.deepEqual(r.postEvictionStripped, ["MN-activity-only"], "MN-activity-only logged as post-eviction stripped");
  assert.equal(topics[0].microNodes.length, 1, "only MN-theory remains");
  assert.equal(topics[0].microNodes[0].title, "MN-theory", "MN-theory kept");

  // Block 1 preserved exactly once in additionalExercises (from stripped MN's exercises[])
  const valid = (topics[0].additionalExercises as any[]).filter(e => isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(valid.length, 1, "exactly one additionalExercise entry");
  assert.equal(valid[0].blockIndex, 1, "block 1 correctly rescued");

  // Coverage: no duplicates, no missing, no empty MNs
  const coverage = validateSourceCoverage(3, topics as any);
  assert.deepEqual(coverage.duplicateIndices,    [], "no duplicates");
  assert.deepEqual(coverage.missingIndices,      [], "no missing");
  assert.deepEqual(coverage.emptyMicroNodeTitles, [], "no empty MicroNodes");
  assert.equal(coverage.valid, true, "coverage valid");
});

// ── Test 10c — Phase 1b: 28-block run L104 scenario (Job 31/32 regression) ────

it("Test 10c: 28-block L104 regression — ACTIVITY_IN_THEORY + single-source MN eviction + empty-MN strip", () => {
  // Job 31/32 scenario with 28 blocks:
  // - AI puts block 13 (EXERCISE) as the ONLY sourceBlockIndex of one MN
  // - Phase 1: evicts block 13 → MN.sourceBlockIndices = []
  // - Phase 1b: strips that empty MN, rescues its exercises
  // - Result: no emptyMicroNodes, no duplicates, coverage valid
  const blocks: MockBlock[] = [];
  for (let i = 0; i <  8; i++) blocks.push(makeBlock("DEFINITION", `Theory ${i}.`));
  for (let i =  8; i < 14; i++) blocks.push(makeBlock("EXERCISE",  `Exercise ${i}.`)); // 8-13
  for (let i = 14; i < 22; i++) blocks.push(makeBlock("DEFINITION", `Theory ${i}.`));
  for (let i = 22; i < 28; i++) blocks.push(makeBlock("EXERCISE",  `Exercise ${i}.`)); // 22-27

  // MN "main" has theory blocks; MN "activity-only" has only block 13 as source
  const topics = [makeTopic("T",
    [
      makeMN("MN-main",          [0,1,2,3,4,5,6,7,14,15,16,17,18,19,20,21], [{ blockIndex: 8 }, { blockIndex: 9 }]),
      makeMN("MN-activity-only", [13], [{ blockIndex: 10 }, { blockIndex: 11 }]), // 13 is EXERCISE — only source
    ],
    [24, 25, 26, 27], // some exercises in unmapped
    [
      { blockIndex: 12 },  // valid additionalExercise
      { blockIndex: null }, // invalid (safety-net artifact)
    ],
  )];

  const r = normalizeActivityPlacements(topics as any, blocks as any);

  assert.ok(r.evictedFromSource.includes(13),     "block 13 evicted from MN-activity-only sourceBlockIndices");
  assert.ok(r.postEvictionStripped.includes("MN-activity-only"), "MN-activity-only stripped by Phase 1b");
  assert.equal(topics[0].microNodes.length, 1,    "only MN-main remains");
  assert.deepEqual(r.stepBRescued.sort((a,b)=>a-b), [24,25,26,27], "Step B rescues unmapped exercises");

  // Final coverage must be valid
  const coverage = validateSourceCoverage(28, topics as any);
  assert.deepEqual(coverage.duplicateIndices,     [], "no duplicate indices");
  assert.deepEqual(coverage.missingIndices,       [], "no missing indices");
  assert.deepEqual(coverage.emptyMicroNodeTitles, [], "no empty MicroNodes after Phase 1b");
  assert.equal(coverage.valid, true,                  "coverage valid");
});

// ── Test 11 — rescue occurs before coverage validation ───────────────────────

it("Test 11: normalizeActivityPlacements mutates topics BEFORE validateSourceCoverage is called", () => {
  // This verifies the temporal contract: once normalizeActivityPlacements returns,
  // validateSourceCoverage on the same topics array should always be clean.
  const blocks = [
    makeBlock("RULE"),     // 0 — theory
    makeBlock("EXERCISE"), // 1 — in sourceBlockIndices (ACTIVITY_IN_THEORY)
    makeBlock("EXERCISE"), // 2 — missing from AI output entirely
  ];
  const topics = [makeTopic("T",
    [makeMN("MN", [0, 1] /* 1 is EXERCISE — wrong */, [])],
  )];

  // BEFORE normalization: coverage would have duplicates and missings
  const before = validateSourceCoverage(3, topics as any);
  // (block 1 in sourceBlockIndices only — not a duplicate yet, but block 2 is missing)
  assert.ok(before.missingIndices.includes(2), "block 2 missing before normalization");

  // Run normalization
  normalizeActivityPlacements(topics as any, blocks as any);

  // AFTER normalization: coverage must be clean
  const after = validateSourceCoverage(3, topics as any);
  assert.deepEqual(after.duplicateIndices, [], "no duplicates after normalization");
  assert.deepEqual(after.missingIndices,   [], "no missing after normalization");
  assert.equal(after.valid, true,              "coverage valid after normalization");
});

// ── Test 12 — final coverage has no duplicate activity indices ────────────────

it("Test 12: final state — coverage validator sees zero duplicate activity indices in all scenarios combined", () => {
  // Stress test: combine ACTIVITY_IN_THEORY + AI duplicate additionalExercises
  //             + safety-net invalid entries + missing block
  const blocks = [
    makeBlock("RULE"),     // 0 — theory
    makeBlock("EXERCISE"), // 1 — in sourceBlockIndices (ACTIVITY_IN_THEORY) AND additionalExercises (null blockIndex from safety-net)
    makeBlock("ACTIVITY"), // 2 — AI returned it twice in additionalExercises
    makeBlock("HOMEWORK"), // 3 — missing entirely
    makeBlock("EXERCISE"), // 4 — in exercises[] AND additionalExercises[]
    makeBlock("NOTE"),     // 5 — theory
  ];
  const topics = [makeTopic("T",
    [
      makeMN("MN-A", [0, 1] /* 1 is EXERCISE — ACTIVITY_IN_THEORY */, [{ blockIndex: 4 }]),
      makeMN("MN-B", [5]),
    ],
    [],
    [
      { blockIndex: null },   // safety-net invalid
      { blockIndex: 2 },      // block 2 first occurrence
      { blockIndex: 2 },      // block 2 duplicate
      { blockIndex: 4 },      // block 4 also in exercises[] — should be removed (exercises[] wins)
    ],
  )];

  normalizeActivityPlacements(topics as any, blocks as any);

  const coverage = validateSourceCoverage(6, topics as any);
  assert.deepEqual(coverage.duplicateIndices, [], "zero duplicate activity indices in final coverage");
  assert.deepEqual(coverage.missingIndices,   [], "zero missing indices");
  assert.equal(coverage.valid, true,              "coverage valid");

  // Verify placements are exactly right
  const exArr = (topics[0].microNodes[0].exercises as any[]).map(e => e.blockIndex);
  assert.deepEqual(exArr, [4], "block 4 in MN-A.exercises[]");

  const addArr = (topics[0].additionalExercises as any[])
    .filter((e: any) => isValidBlockIndex(e.blockIndex, blocks))
    .map((e: any) => e.blockIndex)
    .sort((a: number, b: number) => a - b);
  assert.deepEqual(addArr, [1, 2, 3], "blocks 1, 2, 3 in additionalExercises (each exactly once)");
});

// ── Tests 13–16 — same-MicroNode source/supporting ownership ──────────────────

it("Test 13: same-MicroNode source wins over supporting material for the same index", () => {
  const blocks = Array.from({ length: 9 }, () => makeBlock("NOTE"));
  const topics = [makeTopic("T",
    [makeMN("MN", [7], [], [7])],
    [0, 1, 2, 3, 4, 5, 6, 8],
  )];

  normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [7]);
  assert.deepEqual(topics[0].microNodes[0].supportingMaterialIndices, []);
  const coverage = validateSourceCoverage(9, topics as any);
  assert.deepEqual(coverage.duplicateIndices, []);
});

it("Test 14: same-MicroNode source removes only the overlapping supporting index", () => {
  const blocks = Array.from({ length: 9 }, () => makeBlock("NOTE"));
  const topics = [makeTopic("T",
    [makeMN("MN", [7], [], [7, 8])],
    [0, 1, 2, 3, 4, 5, 6],
  )];

  normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [7]);
  assert.deepEqual(topics[0].microNodes[0].supportingMaterialIndices, [8]);
  const coverage = validateSourceCoverage(9, topics as any);
  assert.deepEqual(coverage.duplicateIndices, []);
});

it("Test 15: supporting-only block remains supporting material", () => {
  const blocks = Array.from({ length: 9 }, () => makeBlock("NOTE"));
  const topics = [makeTopic("T",
    [makeMN("MN", [7], [], [8])],
    [0, 1, 2, 3, 4, 5, 6],
  )];

  normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [7]);
  assert.deepEqual(topics[0].microNodes[0].supportingMaterialIndices, [8]);
  const coverage = validateSourceCoverage(9, topics as any);
  assert.deepEqual(coverage.duplicateIndices, []);
});

it("Test 16: non-overlapping source and supporting material remain unchanged", () => {
  const blocks = Array.from({ length: 9 }, () => makeBlock("NOTE"));
  const topics = [makeTopic("T",
    [makeMN("MN", [7], [], [8])],
    [0, 1, 2, 3, 4, 5, 6],
  )];
  const beforeSource = [...topics[0].microNodes[0].sourceBlockIndices];
  const beforeSupporting = [...topics[0].microNodes[0].supportingMaterialIndices];

  normalizeActivityPlacements(topics as any, blocks as any);

  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, beforeSource);
  assert.deepEqual(topics[0].microNodes[0].supportingMaterialIndices, beforeSupporting);
  const coverage = validateSourceCoverage(9, topics as any);
  assert.deepEqual(coverage.duplicateIndices, []);
});

// ── isValidBlockIndex helper tests ───────────────────────────────────────────

it("isValidBlockIndex: null → false",        () => assert.equal(isValidBlockIndex(null,      [1, 2, 3]), false));
it("isValidBlockIndex: undefined → false",   () => assert.equal(isValidBlockIndex(undefined, [1, 2, 3]), false));
it("isValidBlockIndex: 0 → true",            () => assert.equal(isValidBlockIndex(0,          [1, 2, 3]), true));
it("isValidBlockIndex: -1 → false",          () => assert.equal(isValidBlockIndex(-1,         [1, 2, 3]), false));
it("isValidBlockIndex: out of range → false",() => assert.equal(isValidBlockIndex(999,        [1, 2, 3]), false));
it("isValidBlockIndex: float → false",       () => assert.equal(isValidBlockIndex(1.5,        [1, 2, 3]), false));
it("isValidBlockIndex: string → false",      () => assert.equal(isValidBlockIndex("1",        [1, 2, 3]), false));

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
