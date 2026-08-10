// ─────────────────────────────────────────────────────────────────────────────
// Activity Placement Validator — deterministic tests (Phase 5)
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/activity-validator.test.ts
// No external test framework — uses node:assert/strict + exit code.
//
// Tests cover all 5 issue types:
//   A. ACTIVITY_IN_THEORY         (P5.1)
//   B. EXERCISE_IN_UNMAPPED       (P5.4)
//   C. INVALID_ACTIVITY_BLOCK_INDEX
//   D. MISSING_ACTIVITY_PLACEMENT
//   E. DUPLICATE_ACTIVITY_PLACEMENT
//
// Includes REGRESSION TEST for L104 MN1196 production failure.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import {
  validateActivityPlacement,
  formatActivityFinding,
  countActivityFindings,
  type ActivityValidatorBlock,
  type ActivityValidatorTopic,
} from "../activity-validator.js";

const tests: Array<[string, () => void]> = [];
function it(name: string, fn: () => void): void { tests.push([name, fn]); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function block(
  blockType: string,
  sourceText: string,
  sourcePage = 1,
): ActivityValidatorBlock {
  return { blockType, sourceText, sourcePage };
}

function topic(
  microNodes: Array<{
    title: string;
    sourceBlockIndices: number[];
    exercises?: Array<{ blockIndex: unknown }>;
  }>,
  unmappedBlockIndices: number[] = [],
  additionalExercises: Array<{ blockIndex: unknown }> = [],
): ActivityValidatorTopic {
  return { title: "Test Topic", microNodes, unmappedBlockIndices, additionalExercises };
}

// ── A: ACTIVITY_IN_THEORY ─────────────────────────────────────────────────────

it("clean mapping: no findings when EXERCISE is in exercises[] correctly", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "The rule text."),
    block("EXERCISE", "Calculate 5 + 3."),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [{ title: "MN A", sourceBlockIndices: [0], exercises: [{ blockIndex: 1 }] }],
    ),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 0, "expected 0 findings for correct placement");
});

it("A: EXERCISE in sourceBlockIndices → ACTIVITY_IN_THEORY", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("EXERCISE", "Find the unknown addend.", 38),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN Alpha", sourceBlockIndices: [0] }]),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  const counts = countActivityFindings(findings);
  assert.equal(counts.ACTIVITY_IN_THEORY, 1);
  assert.equal(findings[0].blockIndex, 0);
  assert.equal(findings[0].microNodeTitle, "MN Alpha");
  // D: also flagged as MISSING (not in exercises[])
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 1);
});

it("A: ACTIVITY in sourceBlockIndices → ACTIVITY_IN_THEORY", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("ACTIVITY", "Group activity: discuss in pairs.", 5),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN Beta", sourceBlockIndices: [0] }]),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.ACTIVITY_IN_THEORY, 1);
});

it("A: HOMEWORK in sourceBlockIndices → ACTIVITY_IN_THEORY", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("HOMEWORK", "Homework: solve exercises 1–5.", 10),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN Gamma", sourceBlockIndices: [0] }]),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.ACTIVITY_IN_THEORY, 1);
});

it("A: DEFINITION / RULE / EXAMPLE in sourceBlockIndices → no ACTIVITY_IN_THEORY", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("DEFINITION", "A verb expresses action."),
    block("RULE",       "Verbs agree with subject."),
    block("EXAMPLE",    "Example: she runs."),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN Correct", sourceBlockIndices: [0, 1, 2] }]),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.ACTIVITY_IN_THEORY, 0);
});

// ── B: EXERCISE_IN_UNMAPPED ───────────────────────────────────────────────────

it("B: EXERCISE in unmappedBlockIndices → EXERCISE_IN_UNMAPPED", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("NOTE",     "Section heading.", 5),
    block("EXERCISE", "Solve 37 + 28 = ?", 6),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [{ title: "MN OK", sourceBlockIndices: [0] }],
      [1],  // idx 1 in unmapped — wrong for EXERCISE
    ),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.EXERCISE_IN_UNMAPPED, 1);
  // D: also flagged as missing (not in valid activity destination)
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 1);
});

it("B: NOTE / OBJECTIVE in unmappedBlockIndices → no EXERCISE_IN_UNMAPPED", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("OBJECTIVE", "ԴԱՍ: ՀԱՇՎԻ ԴԱՍ", 3),
    block("NOTE",      "See also page 12.", 4),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([], [0, 1]),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.EXERCISE_IN_UNMAPPED, 0);
});

// ── C: INVALID_ACTIVITY_BLOCK_INDEX ──────────────────────────────────────────

it("C: null blockIndex in additionalExercises → INVALID_ACTIVITY_BLOCK_INDEX", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Rule text."),
    block("EXERCISE", "Solve this.", 3),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [{ title: "MN A", sourceBlockIndices: [0] }],
      [],
      [{ blockIndex: null }],  // AI returned null
    ),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.INVALID_ACTIVITY_BLOCK_INDEX, 1);
  // D: block 1 still missing from valid destinations
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 1);
});

it("C: out-of-range blockIndex in additionalExercises → INVALID_ACTIVITY_BLOCK_INDEX", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Rule text."),
    block("EXERCISE", "Solve this.", 3),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [{ title: "MN A", sourceBlockIndices: [0] }],
      [],
      [{ blockIndex: 999 }],  // 999 is out of range for 2-block array
    ),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.INVALID_ACTIVITY_BLOCK_INDEX, 1);
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 1);
});

it("C: null blockIndex in mn.exercises → INVALID_ACTIVITY_BLOCK_INDEX", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Rule text."),
    block("EXERCISE", "Solve this.", 3),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{
      title: "MN A",
      sourceBlockIndices: [0],
      exercises: [{ blockIndex: null }],  // AI returned null in exercises[]
    }]),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.INVALID_ACTIVITY_BLOCK_INDEX, 1);
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 1);
});

it("C: valid blockIndex in additionalExercises → no INVALID finding", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Rule text."),
    block("EXERCISE", "Solve this.", 3),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [{ title: "MN A", sourceBlockIndices: [0] }],
      [],
      [{ blockIndex: 1 }],  // valid
    ),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.INVALID_ACTIVITY_BLOCK_INDEX, 0);
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 0);
});

// ── D: MISSING_ACTIVITY_PLACEMENT ────────────────────────────────────────────

it("D: EXERCISE absent from all destinations → MISSING_ACTIVITY_PLACEMENT", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Theory."),
    block("EXERCISE", "Student task.", 7),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN A", sourceBlockIndices: [0] }]),
    // block 1 not in any exercises[] or additionalExercises[]
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 1);
});

it("D: all activity blocks covered → no MISSING_ACTIVITY_PLACEMENT", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Theory."),
    block("EXERCISE", "Task 1.", 7),
    block("HOMEWORK", "Task 2.", 8),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [{ title: "MN A", sourceBlockIndices: [0], exercises: [{ blockIndex: 1 }] }],
      [],
      [{ blockIndex: 2 }],
    ),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 0);
  assert.equal(counts.INVALID_ACTIVITY_BLOCK_INDEX, 0);
});

it("D: non-activity blocks (RULE/EXAMPLE) not covered → no MISSING finding", () => {
  // RULE and EXAMPLE are theory blocks — not activity blocks — so missing from
  // exercises[] is correct and should not generate a MISSING_ACTIVITY_PLACEMENT.
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",    "Theory."),
    block("EXAMPLE", "Example."),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN A", sourceBlockIndices: [0, 1] }]),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 0);
});

// ── E: DUPLICATE_ACTIVITY_PLACEMENT ──────────────────────────────────────────

it("E: block in exercises[] of 2 MicroNodes → DUPLICATE_ACTIVITY_PLACEMENT", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Theory."),
    block("EXERCISE", "Shared exercise.", 5),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([
      { title: "MN A", sourceBlockIndices: [0], exercises: [{ blockIndex: 1 }] },
      { title: "MN B", sourceBlockIndices: [0], exercises: [{ blockIndex: 1 }] },  // duplicate
    ]),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.DUPLICATE_ACTIVITY_PLACEMENT, 1);
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 0);
});

it("E: block in exercises[] AND additionalExercises[] → DUPLICATE_ACTIVITY_PLACEMENT", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Theory."),
    block("EXERCISE", "Task.", 5),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [{ title: "MN A", sourceBlockIndices: [0], exercises: [{ blockIndex: 1 }] }],
      [],
      [{ blockIndex: 1 }],  // also in additionalExercises — duplicate
    ),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.DUPLICATE_ACTIVITY_PLACEMENT, 1);
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 0);
});

it("E: single activity destination → no DUPLICATE_ACTIVITY_PLACEMENT", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Theory."),
    block("EXERCISE", "Task.", 5),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [{ title: "MN A", sourceBlockIndices: [0], exercises: [{ blockIndex: 1 }] }],
    ),
  ];
  const counts = countActivityFindings(validateActivityPlacement(blocks, topics));
  assert.equal(counts.DUPLICATE_ACTIVITY_PLACEMENT, 0);
});

// ── REGRESSION — L104 MN1196 production failure ───────────────────────────────
//
// Block 12 = Exercise 115 "Լratsrw̄ʻ nahadadowt'yownnerǝ..."  (Fill in the sentences)
// Old mapping: block 12 appeared in sourceBlockIndices of MN "Անhay't..."
//              → MicroNode had exercise_count = 0 (student task was buried in theory)

it("REGRESSION — L104 MN1196: EXERCISE block 12 in sourceBlockIndices is flagged", () => {
  const lessonBlocks: ActivityValidatorBlock[] = [];
  for (let i = 0; i < 12; i++) {
    lessonBlocks.push(block("RULE", `Rule or definition block ${i}.`, 38));
  }
  lessonBlocks.push(
    block("EXERCISE", "115 Լratsrw̄ʻ nahadadowt'yownnerǝ ev drantsʻ meknabanerʻ orinaknerov.", 38),
  );

  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "Anhayt baghadrichneri gtnelu kanonn.", sourceBlockIndices: [12] }]),
  ];

  const findings = validateActivityPlacement(lessonBlocks, topics);
  const counts = countActivityFindings(findings);
  assert.equal(counts.ACTIVITY_IN_THEORY, 1);
  assert.equal(findings.find(f => f.issue === "ACTIVITY_IN_THEORY")?.blockIndex, 12);
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 1);
});

// ── REGRESSION — L104 Job 27: 8 null-blockIndex additionalExercises ──────────
//
// Job 27 failure: AI returned additionalExercises with blockIndex: null for all 8 exercises.
// Validator must detect: 8x INVALID_ACTIVITY_BLOCK_INDEX, 8x MISSING_ACTIVITY_PLACEMENT.
// After rescue (in pipeline), both counts should be 0 — but the validator here tests
// the PRE-rescue state (what the AI returned).

it("REGRESSION — L104 Job27: 8 null-blockIndex additionalExercises detected", () => {
  const lessonBlocks: ActivityValidatorBlock[] = [];
  // Blocks 0-8: non-activity
  for (let i = 0; i <= 8; i++) {
    lessonBlocks.push(block("RULE", `Block ${i}.`, 38));
  }
  // Blocks 9-16: EXERCISE (the 8 missing ones)
  for (let i = 9; i <= 16; i++) {
    lessonBlocks.push(block("EXERCISE", `Exercise block ${i}.`, 38 + Math.floor((i - 9) / 4)));
  }
  // Block 17: ACTIVITY
  lessonBlocks.push(block("ACTIVITY", "Class activity.", 41));

  // Simulate Job 27 AI output: 4 MicroNodes with correct theory sourceBlockIndices,
  // block 17 correctly in exercises, but blocks 9-16 as additionalExercises with null indices.
  const topics: ActivityValidatorTopic[] = [
    topic(
      [
        { title: "MN A", sourceBlockIndices: [1, 5] },
        { title: "MN B", sourceBlockIndices: [2, 6] },
        { title: "MN C", sourceBlockIndices: [3, 4] },
        { title: "MN D", sourceBlockIndices: [8], exercises: [{ blockIndex: 17 }] },
      ],
      [],  // unmapped: 0 and 7 — not tested here
      [
        { blockIndex: null }, { blockIndex: null }, { blockIndex: null }, { blockIndex: null },
        { blockIndex: null }, { blockIndex: null }, { blockIndex: null }, { blockIndex: null },
      ],
    ),
  ];

  const findings = validateActivityPlacement(lessonBlocks, topics);
  const counts = countActivityFindings(findings);
  // 8 null blockIndices → INVALID
  assert.equal(counts.INVALID_ACTIVITY_BLOCK_INDEX, 8);
  // blocks 9-16 not in any valid destination → MISSING
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT, 8);
  // block 17 correctly placed
  assert.equal(counts.ACTIVITY_IN_THEORY, 0);
  assert.equal(counts.EXERCISE_IN_UNMAPPED, 0);
  assert.equal(counts.DUPLICATE_ACTIVITY_PLACEMENT, 0);
});

// ── formatActivityFinding ─────────────────────────────────────────────────────

it("formatActivityFinding: ACTIVITY_IN_THEORY message contains required fields", () => {
  const finding = {
    blockIndex: 12, blockType: "EXERCISE", blockPage: 38,
    blockPreview: "Fill in the sentences", microNodeTitle: "Rules MicroNode",
    issue: "ACTIVITY_IN_THEORY" as const,
  };
  const msg = formatActivityFinding(finding);
  assert.ok(msg.includes("ACTIVITY IN THEORY"), "must include label");
  assert.ok(msg.includes("Block 12"),           "must include block index");
  assert.ok(msg.includes("EXERCISE"),           "must include block type");
  assert.ok(msg.includes("p38"),                "must include page");
  assert.ok(msg.includes("Rules MicroNode"),    "must include MicroNode title");
  assert.ok(msg.includes("Fill in the sentences"), "must include preview");
  assert.ok(msg.includes("HIGH"),               "must include severity");
});

it("formatActivityFinding: INVALID_ACTIVITY_BLOCK_INDEX message contains required fields", () => {
  const finding = {
    blockIndex: -1, blockType: "UNKNOWN", blockPage: -1,
    blockPreview: "", microNodeTitle: "—",
    issue: "INVALID_ACTIVITY_BLOCK_INDEX" as const,
    detail: "additionalExercises has blockIndex=null (expected integer 0–17)",
  };
  const msg = formatActivityFinding(finding);
  assert.ok(msg.includes("INVALID BLOCK INDEX"), "must include label");
  assert.ok(msg.includes("HIGH"),                "must include severity");
  assert.ok(msg.includes("rescued"),             "must mention rescue");
});

it("formatActivityFinding: MISSING_ACTIVITY_PLACEMENT message contains required fields", () => {
  const finding = {
    blockIndex: 9, blockType: "EXERCISE", blockPage: 38,
    blockPreview: "Exercise 114 text", microNodeTitle: "—",
    issue: "MISSING_ACTIVITY_PLACEMENT" as const,
  };
  const msg = formatActivityFinding(finding);
  assert.ok(msg.includes("MISSING ACTIVITY"), "must include label");
  assert.ok(msg.includes("Block 9"),          "must include block index");
  assert.ok(msg.includes("HIGH"),             "must include severity");
});

it("formatActivityFinding: DUPLICATE_ACTIVITY_PLACEMENT message contains required fields", () => {
  const finding = {
    blockIndex: 5, blockType: "EXERCISE", blockPage: 12,
    blockPreview: "Task text", microNodeTitle: "—",
    issue: "DUPLICATE_ACTIVITY_PLACEMENT" as const,
    detail: "Block 5 appears in 2 destinations: exercises[MN A], additionalExercises[Topic 1]",
  };
  const msg = formatActivityFinding(finding);
  assert.ok(msg.includes("DUPLICATE ACTIVITY"), "must include label");
  assert.ok(msg.includes("Block 5"),            "must include block index");
  assert.ok(msg.includes("HIGH"),               "must include severity");
});

// ── Edge cases ────────────────────────────────────────────────────────────────

it("returns empty array for empty input", () => {
  assert.equal(validateActivityPlacement([], []).length, 0);
});

it("out-of-range block index in sourceBlockIndices → skipped (no crash)", () => {
  const blocks: ActivityValidatorBlock[] = [block("RULE", "Rule text.")];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN", sourceBlockIndices: [0, 999] }]),
  ];
  assert.doesNotThrow(() => validateActivityPlacement(blocks, topics));
});

it("countActivityFindings returns zero counts for empty findings array", () => {
  const counts = countActivityFindings([]);
  assert.equal(counts.ACTIVITY_IN_THEORY,          0);
  assert.equal(counts.EXERCISE_IN_UNMAPPED,        0);
  assert.equal(counts.INVALID_ACTIVITY_BLOCK_INDEX, 0);
  assert.equal(counts.MISSING_ACTIVITY_PLACEMENT,  0);
  assert.equal(counts.DUPLICATE_ACTIVITY_PLACEMENT, 0);
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
