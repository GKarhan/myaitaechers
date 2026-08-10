// ─────────────────────────────────────────────────────────────────────────────
// Activity Rescue — integration tests for the deterministic rescue logic
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/activity-rescue.test.ts
//
// Tests that the comprehensive 3-step activity preservation scan in
// runPass2Pipeline (Steps A+B+C) correctly rescues activity blocks.
//
// These tests call the same helpers exported from lesson-mapping.ts:
//   - isValidBlockIndex
//
// And simulate the rescue algorithm directly (without spawning AI).
//
// Test scenarios correspond to spec sections 12 + 13:
//   Test 1: EXERCISE correctly in microNode.exercises[] — no rescue needed
//   Test 2: EXERCISE in sourceBlockIndices — not a valid activity destination
//   Test 3: EXERCISE in unmappedBlockIndices — rescued (Step B)
//   Test 4: EXERCISE missing from all Pass2 destinations — rescued (Step C)
//   Test 5: additionalExercises has blockIndex: null — rescued (Step C)
//   Test 6: additionalExercises has blockIndex: 999 (out of range) — rescued (Step C)
//   Test 7: block in exercises[] AND additionalExercises[] — duplicate detected
//   Test 8: EXAMPLE block in sourceBlockIndices — no activity rescue needed
//   Test 9: worked EXAMPLE must NOT become a student exercise
//   Test 10: all 8 L104 exercises 9–16 survive final normalization
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { isValidBlockIndex } from "../../services/lesson-mapping.js";

const tests: Array<[string, () => void]> = [];
function it(name: string, fn: () => void): void { tests.push([name, fn]); }

// ── Minimal types mirroring the pipeline's internal structures ─────────────────

interface MockBlock {
  blockType:      string;
  sourceText:     string;
  sourcePage:     number;
  sourceParagraph: string | null;
}

interface MockExercise {
  blockIndex:      unknown;  // unknown to test null/invalid
  sourceParagraph: string | null;
}

interface MockMicroNode {
  title:                   string;
  sourceBlockIndices:      number[];
  exercises:               MockExercise[];
  supportingMaterialIndices: number[];
}

interface MockTopic {
  title:                string;
  microNodes:           MockMicroNode[];
  unmappedBlockIndices: number[];
  additionalExercises:  MockExercise[];
}

// ── Rescue algorithm (mirrors lesson-mapping.ts logic) ────────────────────────

const ACTIVITY_TYPES = new Set(["EXERCISE", "ACTIVITY", "HOMEWORK"]);

function collectValidActivityDestinations(topics: MockTopic[], blocks: MockBlock[]): Set<number> {
  const refs = new Set<number>();
  for (const topic of topics) {
    for (const mn of topic.microNodes) {
      for (const ex of mn.exercises) {
        if (isValidBlockIndex(ex.blockIndex, blocks)) refs.add(ex.blockIndex as number);
      }
    }
    for (const ex of topic.additionalExercises) {
      if (isValidBlockIndex(ex.blockIndex, blocks)) refs.add(ex.blockIndex as number);
    }
  }
  return refs;
}

/**
 * Simulates the 3-step activity preservation rescue.
 * Mutates topics in place (as the pipeline does).
 * Returns the set of rescued indices per step.
 */
function runActivityRescue(topics: MockTopic[], blocks: MockBlock[]): {
  stepBRescued: number[];
  stepCRescued: number[];
  finalDestinations: Set<number>;
} {
  // Step A
  let destinations = collectValidActivityDestinations(topics, blocks);
  const stepBRescued: number[] = [];
  const stepCRescued: number[] = [];

  // Step B: P5.4 — unmapped rescue
  for (const topic of topics) {
    const remaining: number[] = [];
    for (const idx of topic.unmappedBlockIndices) {
      const block = blocks[idx];
      if (block && ACTIVITY_TYPES.has(block.blockType) && !destinations.has(idx)) {
        stepBRescued.push(idx);
        topic.additionalExercises.push({ blockIndex: idx, sourceParagraph: block.sourceParagraph });
        destinations.add(idx);
      } else {
        remaining.push(idx);
      }
    }
    topic.unmappedBlockIndices = remaining;
  }

  // Step C: deterministic missing-activity rescue
  const missingIndices: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block && ACTIVITY_TYPES.has(block.blockType) && !destinations.has(i)) {
      missingIndices.push(i);
    }
  }
  if (missingIndices.length > 0 && topics.length > 0) {
    const target = topics[topics.length - 1];
    for (const idx of missingIndices) {
      const block = blocks[idx];
      if (!block) continue;
      target.additionalExercises.push({ blockIndex: idx, sourceParagraph: block.sourceParagraph });
      destinations.add(idx);
      stepCRescued.push(idx);
    }
  }

  return { stepBRescued, stepCRescued, finalDestinations: destinations };
}

function makeBlock(blockType: string, sourceText: string, sourcePage = 1): MockBlock {
  return { blockType, sourceText, sourcePage, sourceParagraph: sourceText.slice(0, 40) };
}

// ── Test 1 — EXERCISE correctly in exercises[] — no rescue needed ─────────────

it("Test 1: EXERCISE in exercises[] — no rescue needed", () => {
  const blocks: MockBlock[] = [
    makeBlock("RULE",     "Rule text."),
    makeBlock("EXERCISE", "Student task."),
  ];
  const topics: MockTopic[] = [{
    title:                "Topic A",
    microNodes:           [{ title: "MN", sourceBlockIndices: [0], exercises: [{ blockIndex: 1, sourceParagraph: null }], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
    additionalExercises:  [],
  }];
  const { stepBRescued, stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);
  assert.equal(stepBRescued.length, 0, "no Step B rescue needed");
  assert.equal(stepCRescued.length, 0, "no Step C rescue needed");
  assert.ok(finalDestinations.has(1), "block 1 in valid destination");
});

// ── Test 2 — EXERCISE in sourceBlockIndices — not a valid activity destination ─

it("Test 2: EXERCISE in sourceBlockIndices — counted as MISSING (not activity destination)", () => {
  const blocks: MockBlock[] = [
    makeBlock("EXERCISE", "Student task."),
  ];
  // AI put block 0 in sourceBlockIndices (wrong) — no exercises[], no additionalExercises
  const topics: MockTopic[] = [{
    title:                "Topic A",
    microNodes:           [{ title: "MN", sourceBlockIndices: [0], exercises: [], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
    additionalExercises:  [],
  }];
  const { stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);
  // P5.1 ACTIVITY_IN_THEORY is a validator finding, not a rescue action.
  // The rescue (Step C) should rescue block 0 to additionalExercises regardless.
  assert.equal(stepCRescued.length, 1, "Step C should rescue the missing block 0");
  assert.ok(finalDestinations.has(0), "block 0 now has a valid activity destination");
  assert.equal(topics[0].additionalExercises.length, 1);
  assert.equal(topics[0].additionalExercises[0].blockIndex, 0);
});

// ── Test 3 — EXERCISE in unmappedBlockIndices — rescued in Step B ─────────────

it("Test 3: EXERCISE in unmappedBlockIndices — rescued in Step B", () => {
  const blocks: MockBlock[] = [
    makeBlock("NOTE",     "Header."),
    makeBlock("EXERCISE", "Solve this."),
  ];
  const topics: MockTopic[] = [{
    title:                "Topic A",
    microNodes:           [{ title: "MN", sourceBlockIndices: [0], exercises: [], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [1],  // AI put exercise in unmapped
    additionalExercises:  [],
  }];
  const { stepBRescued, stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);
  assert.equal(stepBRescued.length, 1, "Step B should rescue block 1");
  assert.ok(stepBRescued.includes(1));
  assert.equal(stepCRescued.length, 0, "Step C not needed");
  assert.ok(finalDestinations.has(1));
  assert.equal(topics[0].unmappedBlockIndices.length, 0, "unmapped cleaned up");
  assert.equal(topics[0].additionalExercises.length, 1);
  assert.equal(topics[0].additionalExercises[0].blockIndex, 1);
});

// ── Test 4 — EXERCISE missing from all Pass2 destinations — rescued in Step C ─

it("Test 4: EXERCISE missing entirely from Pass2 output — rescued in Step C", () => {
  const blocks: MockBlock[] = [
    makeBlock("RULE",     "Rule."),
    makeBlock("EXERCISE", "Missing exercise."),
  ];
  const topics: MockTopic[] = [{
    title:                "Topic A",
    microNodes:           [{ title: "MN", sourceBlockIndices: [0], exercises: [], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
    additionalExercises:  [],  // AI omitted block 1 entirely
  }];
  const { stepBRescued, stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);
  assert.equal(stepBRescued.length, 0, "Step B: nothing in unmapped");
  assert.equal(stepCRescued.length, 1, "Step C must rescue block 1");
  assert.ok(stepCRescued.includes(1));
  assert.ok(finalDestinations.has(1));
  const rescued = topics[0].additionalExercises.find(e => e.blockIndex === 1);
  assert.ok(rescued, "rescued exercise must be in additionalExercises");
  assert.equal(rescued!.blockIndex, 1, "sourceBlockIndex must be preserved");
});

// ── Test 5 — additionalExercises has null blockIndex — rescued in Step C ──────

it("Test 5: additionalExercises has blockIndex: null — Step C rescues original block", () => {
  const blocks: MockBlock[] = [
    makeBlock("RULE",     "Rule."),
    makeBlock("EXERCISE", "Task.", 38),
  ];
  const topics: MockTopic[] = [{
    title:                "Topic A",
    microNodes:           [{ title: "MN", sourceBlockIndices: [0], exercises: [], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
    additionalExercises:  [{ blockIndex: null, sourceParagraph: null }],  // AI returned null
  }];
  const { stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);
  assert.equal(stepCRescued.length, 1, "Step C must rescue block 1 (null blockIndex didn't register)");
  assert.ok(finalDestinations.has(1));
  // The rescued entry has the correct blockIndex
  const valid = topics[0].additionalExercises.filter(e => isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(valid.length, 1);
  assert.equal(valid[0].blockIndex, 1);
});

// ── Test 6 — additionalExercises has out-of-range blockIndex — rescued in Step C

it("Test 6: additionalExercises has blockIndex: 999 (out of range) — Step C rescues", () => {
  const blocks: MockBlock[] = [
    makeBlock("RULE",     "Rule."),
    makeBlock("EXERCISE", "Task.", 38),
  ];
  const topics: MockTopic[] = [{
    title:                "Topic A",
    microNodes:           [{ title: "MN", sourceBlockIndices: [0], exercises: [], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
    additionalExercises:  [{ blockIndex: 999, sourceParagraph: null }],  // AI used textbook number
  }];
  const { stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);
  assert.equal(stepCRescued.length, 1, "Step C must rescue block 1");
  assert.ok(finalDestinations.has(1));
  const valid = topics[0].additionalExercises.filter(e => isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(valid.length, 1);
  assert.equal(valid[0].blockIndex, 1);
});

// ── Test 7 — block in exercises[] AND additionalExercises[] — duplicate ────────

it("Test 7: block in exercises[] AND additionalExercises[] → duplicate (no extra rescue)", () => {
  const blocks: MockBlock[] = [
    makeBlock("RULE",     "Rule."),
    makeBlock("EXERCISE", "Shared task.", 5),
  ];
  const topics: MockTopic[] = [{
    title:                "Topic A",
    microNodes:           [{ title: "MN", sourceBlockIndices: [0], exercises: [{ blockIndex: 1, sourceParagraph: null }], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
    additionalExercises:  [{ blockIndex: 1, sourceParagraph: null }],  // already in exercises[] too
  }];
  const { stepBRescued, stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);
  assert.equal(stepBRescued.length, 0);
  assert.equal(stepCRescued.length, 0, "no rescue: block 1 already has a valid destination");
  assert.ok(finalDestinations.has(1));
  // Duplicate detection is done by the validator, not the rescue — count additionalExercises
  const validAdditional = topics[0].additionalExercises.filter(e => isValidBlockIndex(e.blockIndex, blocks));
  assert.equal(validAdditional.length, 1, "original additionalExercise with valid blockIndex still present");
});

// ── Test 8 — EXAMPLE in sourceBlockIndices — no activity rescue ───────────────

it("Test 8: EXAMPLE block in sourceBlockIndices — no activity rescue needed", () => {
  const blocks: MockBlock[] = [
    makeBlock("EXAMPLE", "Worked example: 22 + □ = 88", 38),
    makeBlock("RULE",    "Rule text.", 38),
  ];
  const topics: MockTopic[] = [{
    title:                "Topic A",
    microNodes:           [{ title: "MN", sourceBlockIndices: [0, 1], exercises: [], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
    additionalExercises:  [],
  }];
  const { stepBRescued, stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);
  assert.equal(stepBRescued.length, 0, "EXAMPLE is not an activity block");
  assert.equal(stepCRescued.length, 0, "EXAMPLE is not an activity block");
  assert.ok(!finalDestinations.has(0), "EXAMPLE block 0 correctly NOT in activity destinations");
});

// ── Test 9 — worked EXAMPLE must NOT become student exercise ──────────────────

it("Test 9: EXAMPLE blocks must not appear in lesson_exercises (not rescued as activity)", () => {
  const blocks: MockBlock[] = [
    makeBlock("EXAMPLE", "Worked example: 22 + □ = 88",  38),
    makeBlock("EXAMPLE", "Worked example: □ – 22 = 66",  38),
    makeBlock("EXAMPLE", "Worked example: 88 – □ = 22",  38),
    makeBlock("EXERCISE", "Real student exercise.", 39),
  ];
  const topics: MockTopic[] = [{
    title:                "Topic A",
    microNodes:           [{ title: "MN", sourceBlockIndices: [0, 1, 2], exercises: [{ blockIndex: 3, sourceParagraph: null }], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
    additionalExercises:  [],
  }];
  const { stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);
  assert.equal(stepCRescued.length, 0, "No rescue: exercise 3 already placed, examples are theory");
  assert.ok(!finalDestinations.has(0), "EXAMPLE 0 not an activity destination");
  assert.ok(!finalDestinations.has(1), "EXAMPLE 1 not an activity destination");
  assert.ok(!finalDestinations.has(2), "EXAMPLE 2 not an activity destination");
  assert.ok(finalDestinations.has(3),  "EXERCISE 3 correctly in activity destination");
});

// ── Test 10 — L104 regression: all 8 exercises 9–16 survive ──────────────────

it("Test 10: all 8 L104 exercises 9–16 rescued when AI returns null blockIndices", () => {
  const blocks: MockBlock[] = [];
  // Blocks 0-8: non-activity
  for (let i = 0; i <= 8; i++) blocks.push(makeBlock("RULE", `Block ${i}.`, 38));
  // Blocks 9-16: EXERCISE
  for (let i = 9; i <= 16; i++) blocks.push(makeBlock("EXERCISE", `Exercise ${i}.`, 38));
  // Block 17: ACTIVITY
  blocks.push(makeBlock("ACTIVITY", "Class activity.", 41));

  const topics: MockTopic[] = [{
    title: "Topic",
    microNodes: [
      { title: "MN A", sourceBlockIndices: [1, 5], exercises: [], supportingMaterialIndices: [] },
      { title: "MN B", sourceBlockIndices: [2, 6], exercises: [], supportingMaterialIndices: [] },
      { title: "MN C", sourceBlockIndices: [3, 4], exercises: [], supportingMaterialIndices: [] },
      { title: "MN D", sourceBlockIndices: [8], exercises: [{ blockIndex: 17, sourceParagraph: null }], supportingMaterialIndices: [] },
    ],
    unmappedBlockIndices: [0, 7],
    additionalExercises: [
      // AI returned 8 additionalExercises with null blockIndex — the Job 27 failure
      { blockIndex: null, sourceParagraph: null }, { blockIndex: null, sourceParagraph: null },
      { blockIndex: null, sourceParagraph: null }, { blockIndex: null, sourceParagraph: null },
      { blockIndex: null, sourceParagraph: null }, { blockIndex: null, sourceParagraph: null },
      { blockIndex: null, sourceParagraph: null }, { blockIndex: null, sourceParagraph: null },
    ],
  }];

  const { stepBRescued, stepCRescued, finalDestinations } = runActivityRescue(topics, blocks);

  // Step B: blocks 0 and 7 are in unmappedBlockIndices but are RULE/TABLE — not activity
  assert.equal(stepBRescued.length, 0, "Step B: no activity blocks in unmapped");

  // Step C: blocks 9-16 all missing from valid destinations → all rescued
  assert.equal(stepCRescued.length, 8, "Step C must rescue all 8 missing exercise blocks");
  for (let i = 9; i <= 16; i++) {
    assert.ok(stepCRescued.includes(i), `block ${i} must be in Step C rescued`);
    assert.ok(finalDestinations.has(i), `block ${i} must be in final activity destinations`);
  }

  // Block 17 (ACTIVITY) already in exercises[] via MN D — not re-rescued
  assert.ok(finalDestinations.has(17), "block 17 already has valid destination");

  // All rescued blocks have correct blockIndex
  const validAdditional = topics[0].additionalExercises.filter(e => isValidBlockIndex(e.blockIndex, blocks));
  const rescuedIndices = validAdditional.map(e => e.blockIndex as number).sort((a, b) => a - b);
  assert.deepEqual(rescuedIndices, [9, 10, 11, 12, 13, 14, 15, 16], "all 8 exercise indices preserved");

  // missingIndices should now be empty (blocks 0, 7 are RULE/TABLE — unmapped, non-activity)
  const activityIndices = [9, 10, 11, 12, 13, 14, 15, 16, 17];
  for (const idx of activityIndices) {
    assert.ok(finalDestinations.has(idx), `activity block ${idx} must have final valid destination`);
  }
});

// ── isValidBlockIndex helper ──────────────────────────────────────────────────

it("isValidBlockIndex: null → false", () => {
  assert.equal(isValidBlockIndex(null, [1, 2, 3]), false);
});

it("isValidBlockIndex: undefined → false", () => {
  assert.equal(isValidBlockIndex(undefined, [1, 2, 3]), false);
});

it("isValidBlockIndex: 0 → true", () => {
  assert.equal(isValidBlockIndex(0, [1, 2, 3]), true);
});

it("isValidBlockIndex: -1 → false", () => {
  assert.equal(isValidBlockIndex(-1, [1, 2, 3]), false);
});

it("isValidBlockIndex: out of range → false", () => {
  assert.equal(isValidBlockIndex(999, [1, 2, 3]), false);
});

it("isValidBlockIndex: float → false", () => {
  assert.equal(isValidBlockIndex(1.5, [1, 2, 3]), false);
});

it("isValidBlockIndex: string '1' → false", () => {
  assert.equal(isValidBlockIndex("1", [1, 2, 3]), false);
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
