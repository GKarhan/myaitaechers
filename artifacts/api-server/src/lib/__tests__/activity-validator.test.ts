// ─────────────────────────────────────────────────────────────────────────────
// Activity Placement Validator — deterministic tests (Phase 5)
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/activity-validator.test.ts
// No external test framework — uses node:assert/strict + exit code.
//
// Includes a REGRESSION TEST for the confirmed L104 MN1196 production failure:
//   EXERCISE block 12 appeared in sourceBlockIndices with exercise_count=0.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import {
  validateActivityPlacement,
  formatActivityFinding,
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
  microNodes: Array<{ title: string; sourceBlockIndices: number[] }>,
  unmappedBlockIndices: number[] = [],
): ActivityValidatorTopic {
  return { title: "Test Topic", microNodes, unmappedBlockIndices };
}

// ── P5.1 — EXERCISE / ACTIVITY / HOMEWORK in sourceBlockIndices ───────────────

it("clean mapping: no findings when EXERCISE is in exercises[] (not sourceBlockIndices)", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "The rule text."),        // idx 0
    block("EXERCISE", "Calculate 5 + 3."),       // idx 1
  ];
  // MicroNode owns the RULE as source; EXERCISE is correctly in exercises[]
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN A", sourceBlockIndices: [0] }]),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 0, "expected 0 findings for correct placement");
});

it("P5.1: EXERCISE in sourceBlockIndices → ACTIVITY_IN_THEORY finding", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("EXERCISE", "Find the unknown addend.", 38),  // idx 0
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN Alpha", sourceBlockIndices: [0] }]),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue,          "ACTIVITY_IN_THEORY");
  assert.equal(findings[0].blockIndex,     0);
  assert.equal(findings[0].blockType,      "EXERCISE");
  assert.equal(findings[0].microNodeTitle, "MN Alpha");
  assert.equal(findings[0].blockPage,      38);
});

it("P5.1: ACTIVITY in sourceBlockIndices → ACTIVITY_IN_THEORY finding", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("ACTIVITY", "Group activity: discuss in pairs.", 5),  // idx 0
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN Beta", sourceBlockIndices: [0] }]),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue,     "ACTIVITY_IN_THEORY");
  assert.equal(findings[0].blockType, "ACTIVITY");
});

it("P5.1: HOMEWORK in sourceBlockIndices → ACTIVITY_IN_THEORY finding", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("HOMEWORK", "Homework: solve exercises 1–5.", 10),  // idx 0
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN Gamma", sourceBlockIndices: [0] }]),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue,     "ACTIVITY_IN_THEORY");
  assert.equal(findings[0].blockType, "HOMEWORK");
});

it("P5.1: DEFINITION / RULE / EXAMPLE in sourceBlockIndices → no finding", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("DEFINITION", "A verb is a word that expresses action."),  // idx 0
    block("RULE",       "Verbs agree with their subject."),          // idx 1
    block("EXAMPLE",    "Example: she runs, they run."),             // idx 2
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN Correct", sourceBlockIndices: [0, 1, 2] }]),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 0);
});

it("P5.1: multiple MicroNodes — only flags the one with EXERCISE in sourceBlockIndices", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE",     "Rule text."),         // idx 0
    block("EXERCISE", "Fill in blanks.", 7), // idx 1
    block("RULE",     "Another rule."),      // idx 2
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([
      { title: "Clean MN", sourceBlockIndices: [0] },
      { title: "Bad MN",   sourceBlockIndices: [1] },  // EXERCISE in theory
      { title: "Also Clean", sourceBlockIndices: [2] },
    ]),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].microNodeTitle, "Bad MN");
  assert.equal(findings[0].blockIndex,     1);
});

// ── REGRESSION — L104 MN1196 production failure ───────────────────────────────
//
// Block 12 = Exercise 115 "Լratsrw̄ʻ nahadadowt'yownnerǝ ev drantsʻ meknabanerʻ orinaknerov"
// (Fill in the sentences and interpret them with examples.)
// This EXERCISE block appeared in sourceBlockIndices of MN "Anhayt baghadrichneri gtnelu kanonn."
// The MicroNode had exercise_count=0 — the student-facing task was completely lost.

it("REGRESSION — L104 MN1196: EXERCISE block 12 in sourceBlockIndices is flagged", () => {
  // Approximate the production state of Lesson 104 at the point of failure.
  // Only the relevant blocks are included (indices are preserved).
  const lessonBlocks: ActivityValidatorBlock[] = [];
  // Fill with dummy RULE blocks for indices 0–11
  for (let i = 0; i < 12; i++) {
    lessonBlocks.push(block("RULE", `Rule or definition block ${i}.`, 38));
  }
  // Block 12 — the confirmed production failure
  lessonBlocks.push(
    block(
      "EXERCISE",
      "115 Լratsrw̄ʻ nahadadowt'yownnerǝ ev drantsʻ meknabanerʻ orinaknerov.",
      38,
    ),
  );

  const topics: ActivityValidatorTopic[] = [
    topic([
      {
        title: "Anhayt baghadrichneri gtnelu kanonn.",
        sourceBlockIndices: [12],  // ← production failure: EXERCISE block in theory
      },
    ]),
  ];

  const findings = validateActivityPlacement(lessonBlocks, topics);
  assert.equal(findings.length, 1, "expected exactly one ACTIVITY_IN_THEORY finding for block 12");
  assert.equal(findings[0].issue,          "ACTIVITY_IN_THEORY");
  assert.equal(findings[0].blockIndex,     12);
  assert.equal(findings[0].blockType,      "EXERCISE");
  assert.equal(findings[0].blockPage,      38);
  assert.equal(findings[0].microNodeTitle, "Anhayt baghadrichneri gtnelu kanonn.");
  assert.ok(findings[0].blockPreview.includes("Լratsrw̄ʻ"), "preview must include the fill-in imperative");
});

// ── P5.4 — EXERCISE / ACTIVITY / HOMEWORK in unmappedBlockIndices ─────────────

it("P5.4: EXERCISE in unmappedBlockIndices → EXERCISE_IN_UNMAPPED finding", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("NOTE",     "Section heading.",     5),   // idx 0 — legitimately unmapped
    block("EXERCISE", "Solve 37 + 28 = ?",    6),   // idx 1 — must not be unmapped
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [{ title: "MN OK", sourceBlockIndices: [0] }],
      [1],  // idx 1 is in unmappedBlockIndices — WRONG for EXERCISE
    ),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue,      "EXERCISE_IN_UNMAPPED");
  assert.equal(findings[0].blockIndex, 1);
  assert.equal(findings[0].blockType,  "EXERCISE");
});

it("P5.4: NOTE / OBJECTIVE in unmappedBlockIndices → no finding (correctly unmapped)", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("OBJECTIVE", "ԴԱՍ: ՀԱՇՎԻ ԴԱՍ",   3),  // idx 0 — section heading, correctly unmapped
    block("NOTE",      "See also page 12.",  4),  // idx 1 — note, correctly unmapped
  ];
  const topics: ActivityValidatorTopic[] = [
    topic(
      [],        // no MicroNodes
      [0, 1],   // both unmapped
    ),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 0, "NOTE and OBJECTIVE correctly placed in unmapped — no finding expected");
});

it("P5.4: ACTIVITY in unmappedBlockIndices → EXERCISE_IN_UNMAPPED finding", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("ACTIVITY", "Group activity: list 5 verbs.", 9),  // idx 0
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([], [0]),
  ];
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue, "EXERCISE_IN_UNMAPPED");
});

// ── formatActivityFinding ─────────────────────────────────────────────────────

it("formatActivityFinding: ACTIVITY_IN_THEORY message contains required fields", () => {
  const finding = {
    blockIndex:     12,
    blockType:      "EXERCISE",
    blockPage:      38,
    blockPreview:   "Fill in the sentences",
    microNodeTitle: "Rules MicroNode",
    issue:          "ACTIVITY_IN_THEORY" as const,
  };
  const msg = formatActivityFinding(finding);
  assert.ok(msg.includes("ACTIVITY IN THEORY"),   "must include label");
  assert.ok(msg.includes("Block 12"),              "must include block index");
  assert.ok(msg.includes("EXERCISE"),              "must include block type");
  assert.ok(msg.includes("p38"),                   "must include page");
  assert.ok(msg.includes("Rules MicroNode"),       "must include MicroNode title");
  assert.ok(msg.includes("Fill in the sentences"), "must include preview");
  assert.ok(msg.includes("HIGH"),                  "must include severity");
});

it("formatActivityFinding: EXERCISE_IN_UNMAPPED message contains required fields", () => {
  const finding = {
    blockIndex:     5,
    blockType:      "ACTIVITY",
    blockPage:      12,
    blockPreview:   "Group activity text",
    microNodeTitle: "—",
    issue:          "EXERCISE_IN_UNMAPPED" as const,
  };
  const msg = formatActivityFinding(finding);
  assert.ok(msg.includes("EXERCISE IN UNMAPPED"), "must include label");
  assert.ok(msg.includes("Block 5"),              "must include block index");
  assert.ok(msg.includes("ACTIVITY"),             "must include block type");
  assert.ok(msg.includes("additionalExercises"),  "must mention rescue destination");
  assert.ok(msg.includes("HIGH"),                 "must include severity");
});

// ── Empty / edge cases ────────────────────────────────────────────────────────

it("returns empty array for empty input", () => {
  assert.equal(validateActivityPlacement([], []).length, 0);
});

it("out-of-range block index in sourceBlockIndices → no crash (block is undefined → skipped)", () => {
  const blocks: ActivityValidatorBlock[] = [
    block("RULE", "Rule text."),
  ];
  const topics: ActivityValidatorTopic[] = [
    topic([{ title: "MN", sourceBlockIndices: [0, 999] }]),  // 999 is out of range
  ];
  // Should not throw; block[999] is undefined → skipped silently
  assert.doesNotThrow(() => validateActivityPlacement(blocks, topics));
  const findings = validateActivityPlacement(blocks, topics);
  assert.equal(findings.length, 0);  // RULE block[0] is fine; block[999] is undefined → skipped
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
