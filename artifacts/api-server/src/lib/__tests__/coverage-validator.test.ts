// ─────────────────────────────────────────────────────────────────────────────
// Deterministic coverage-validator — 7 required test cases
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/coverage-validator.test.ts
// No external test framework — uses node:assert/strict + exit code.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import {
  validateSourceCoverage,
  type ValidatorTopic,
} from "../coverage-validator.js";

const tests: Array<[string, () => void]> = [];
function it(name: string, fn: () => void): void { tests.push([name, fn]); }

// ── helpers ───────────────────────────────────────────────────────────────────

function mn(
  title: string,
  sourceBlockIndices: number[],
  exerciseBlockIndices: number[] = [],
  supportingMaterialIndices: number[] = [],
) {
  return {
    title,
    sourceBlockIndices,
    exercises: exerciseBlockIndices.map((blockIndex) => ({ blockIndex })),
    supportingMaterialIndices,
  };
}

function topic(
  microNodes: ReturnType<typeof mn>[],
  unmappedBlockIndices: number[] = [],
): ValidatorTopic {
  return { microNodes, unmappedBlockIndices };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: 100% valid coverage
// ─────────────────────────────────────────────────────────────────────────────
it("Test 1: 100% valid coverage — all 4 blocks placed, no issues", () => {
  const result = validateSourceCoverage(4, [
    topic([mn("Definition of Noun", [0, 1])]),
    topic([mn("Noun types",         [2, 3])]),
  ]);

  assert.equal(result.valid,            true,  "valid");
  assert.equal(result.totalBlocks,      4);
  assert.equal(result.coveredBlocks,    4);
  assert.equal(result.coveragePercent,  100);
  assert.deepEqual(result.missingIndices,   []);
  assert.deepEqual(result.duplicateIndices, []);
  assert.deepEqual(result.invalidIndices,   []);
  assert.deepEqual(result.emptyMicroNodeTitles, []);
  assert.equal(result.categoryCounts.source, 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: missing block
// ─────────────────────────────────────────────────────────────────────────────
it("Test 2: missing block — block index 2 never placed", () => {
  const result = validateSourceCoverage(4, [
    topic([mn("Node A", [0, 1])]),
    topic([mn("Node B", [3])]),          // block 2 is omitted
  ]);

  assert.equal(result.valid,         false);
  assert.deepEqual(result.missingIndices,   [2]);
  assert.deepEqual(result.duplicateIndices, []);
  assert.deepEqual(result.invalidIndices,   []);
  assert.equal(result.coveredBlocks,   3);
  assert.equal(result.coveragePercent, 75);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: duplicate block
// ─────────────────────────────────────────────────────────────────────────────
it("Test 3: duplicate block — index 1 in sourceBlockIndices of two MicroNodes", () => {
  const result = validateSourceCoverage(3, [
    topic([
      mn("Node A", [0, 1]),
      mn("Node B", [1, 2]),   // index 1 appears twice
    ]),
  ]);

  assert.equal(result.valid,         false);
  assert.deepEqual(result.missingIndices,   []);
  assert.deepEqual(result.duplicateIndices, [1]);
  assert.deepEqual(result.invalidIndices,   []);
  // coveredBlocks counts unique valid seen indices
  assert.equal(result.coveredBlocks,   3);  // 0,1,2 all seen at least once
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: invalid index
// ─────────────────────────────────────────────────────────────────────────────
it("Test 4: invalid index — index 99 used but totalBlocks=3", () => {
  const result = validateSourceCoverage(3, [
    topic([mn("Node A", [0, 1, 99])]),    // 99 is out of range
    topic([mn("Node B", [2])]),
  ]);

  assert.equal(result.valid,         false);
  assert.deepEqual(result.invalidIndices,   [99]);
  assert.deepEqual(result.missingIndices,   []);
  assert.deepEqual(result.duplicateIndices, []);
  assert.equal(result.coveredBlocks,   3);  // 0,1,2 all covered (99 excluded as invalid)
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: empty MicroNode
// ─────────────────────────────────────────────────────────────────────────────
it("Test 5: empty MicroNode — sourceBlockIndices is empty []", () => {
  const result = validateSourceCoverage(2, [
    topic([
      mn("Empty Node", []),      // no source blocks
      mn("Good Node",  [0, 1]),
    ]),
  ]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.emptyMicroNodeTitles, ["Empty Node"]);
  assert.deepEqual(result.missingIndices,   []);
  assert.deepEqual(result.duplicateIndices, []);
  assert.deepEqual(result.invalidIndices,   []);
  assert.equal(result.coveredBlocks, 2);  // 0,1 covered by Good Node
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: exercises + source + supporting material together
// ─────────────────────────────────────────────────────────────────────────────
it("Test 6: all three categories together — 6 blocks, all valid", () => {
  // Blocks:
  //   0,1 → source theory
  //   2,3 → exercises
  //   4   → supporting material
  //   5   → unmapped (header)
  const result = validateSourceCoverage(6, [
    topic(
      [mn("Verb Tenses", [0, 1], [2, 3], [4])],
      [5],  // unmapped: block 5 is a page header
    ),
  ]);

  assert.equal(result.valid,            true);
  assert.equal(result.totalBlocks,      6);
  assert.equal(result.coveredBlocks,    6);
  assert.equal(result.coveragePercent,  100);
  assert.deepEqual(result.missingIndices,   []);
  assert.deepEqual(result.duplicateIndices, []);
  assert.deepEqual(result.invalidIndices,   []);
  assert.equal(result.categoryCounts.source,            2);
  assert.equal(result.categoryCounts.exercises,         2);
  assert.equal(result.categoryCounts.supportingMaterial, 1);
  assert.equal(result.categoryCounts.unmapped,          1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7 (CRITICAL): unmappedBlocks = 0 but real missing block exists
//
// This test proves the validator is independent of the AI self-report.
// The model claims unmappedBlocks=0 (no indices in its unmappedBlocks[]).
// But block index 3 was never assigned to any slot.
// The validator detects the missing block regardless.
// ─────────────────────────────────────────────────────────────────────────────
it("Test 7 (CRITICAL): unmappedBlocks=0 but block 3 is genuinely missing", () => {
  // Simulate: model produced two MicroNodes covering blocks 0,1,2.
  // Block 3 exists in Pass1 but the model silently dropped it.
  // unmappedBlockIndices = [] everywhere (model self-reports 0 unmapped).
  const topicsFromPipeline: ValidatorTopic[] = [
    topic(
      [
        mn("Intro",   [0, 1]),
        mn("Details", [2]),       // block 3 never mentioned
      ],
      [],  // model reported zero unmapped blocks
    ),
  ];

  // AI self-report: unmappedBlocks = 0
  const aiReportedUnmapped = topicsFromPipeline.flatMap(t => t.unmappedBlockIndices);
  assert.equal(aiReportedUnmapped.length, 0, "AI self-report says 0 unmapped");

  // Validator runs independently from totalBlocks=4
  const result = validateSourceCoverage(4, topicsFromPipeline);

  assert.equal(result.valid,        false, "validator correctly marks as invalid");
  assert.deepEqual(result.missingIndices, [3], "validator finds block 3 is missing");
  assert.equal(result.coveredBlocks,   3);
  assert.equal(result.coveragePercent, 75);
  assert.deepEqual(result.duplicateIndices, []);
  assert.deepEqual(result.invalidIndices,   []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

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

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
