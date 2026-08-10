// ─────────────────────────────────────────────────────────────────────────────
// Granularity heuristics — deterministic signal tests
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/granularity-heuristics.test.ts
// No external test framework — uses node:assert/strict + exit code.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { detectCompoundLO, detectDuplicateLOs } from "../granularity-heuristics.js";

const tests: Array<[string, () => void]> = [];
function it(name: string, fn: () => void): void { tests.push([name, fn]); }

// ── detectCompoundLO ──────────────────────────────────────────────────────────

it("flags 'define X and identify Y' (two independent verb clauses)", () => {
  const result = detectCompoundLO(
    "Student can define a verb and identify verbs in text.",
  );
  assert.notEqual(result, null);
  assert.equal(result!.flagged, true);
  assert.equal(result!.connector, "and");
});

it("does NOT flag a legitimate single procedure without 'and'", () => {
  const result = detectCompoundLO(
    "Student can decompose a multi-digit number by grouping digits from right to left.",
  );
  assert.equal(result, null);
});

it("does NOT flag when connector is between short or non-verb phrases", () => {
  // "addition and subtraction" — nouns, no second action verb
  const result = detectCompoundLO(
    "Student can solve problems using addition and subtraction operations.",
  );
  assert.equal(result, null);
});

it("does NOT flag short or empty LOs", () => {
  assert.equal(detectCompoundLO(""), null);
  assert.equal(detectCompoundLO("Short"), null);
});

it("flags two English verbs: 'explain X and calculate Y'", () => {
  const result = detectCompoundLO(
    "Student can explain what a fraction is and calculate its decimal equivalent.",
  );
  assert.notEqual(result, null);
  assert.equal(result!.flagged, true);
});

it("flags 'classify X and use Y in sentences'", () => {
  const result = detectCompoundLO(
    "Student can classify nouns into groups and use them in sentences.",
  );
  assert.notEqual(result, null);
  assert.equal(result!.flagged, true);
  assert.equal(result!.connector, "and");
});

it("flags 'compare X and describe Y'", () => {
  const result = detectCompoundLO(
    "Student can compare two fractions and describe which is greater.",
  );
  assert.notEqual(result, null);
  assert.equal(result!.flagged, true);
});

// ── detectDuplicateLOs ────────────────────────────────────────────────────────

it("detects high-overlap pair: 'find unknown addend' + 'rules for finding unknown addend'", () => {
  const nodes = [
    {
      title: "Finding unknown components",
      learningObjective: "Student can find unknown addend using inverse operations.",
    },
    {
      title: "Rules for unknown components",
      learningObjective: "Student can apply the rules for finding the unknown addend.",
    },
  ];
  const candidates = detectDuplicateLOs(nodes);
  assert.ok(candidates.length > 0, "Expected at least one candidate pair");
  assert.equal(candidates[0].titleA, "Finding unknown components");
  assert.equal(candidates[0].titleB, "Rules for unknown components");
  assert.ok(candidates[0].similarity >= 0.25);
});

it("does NOT flag unrelated objectives as candidates", () => {
  const nodes = [
    {
      title: "Explain addition",
      learningObjective: "Student can explain what addition means.",
    },
    {
      title: "Solve word problems",
      learningObjective: "Student can solve subtraction word problems in context.",
    },
  ];
  const candidates = detectDuplicateLOs(nodes);
  assert.equal(candidates.length, 0);
});

it("returns empty array for a single MicroNode (no pairs possible)", () => {
  const nodes = [
    {
      title: "Definition of verbs",
      learningObjective: "Student can define what a verb is.",
    },
  ];
  const result = detectDuplicateLOs(nodes);
  assert.equal(result.length, 0);
});

it("returns empty array for empty input", () => {
  assert.equal(detectDuplicateLOs([]).length, 0);
});

it("flags near-identical LO wordings as candidates", () => {
  const nodes = [
    {
      title: "MN A",
      learningObjective: "Student can identify and name the components of addition.",
    },
    {
      title: "MN B",
      learningObjective: "Student can name and identify the components of addition expressions.",
    },
  ];
  const candidates = detectDuplicateLOs(nodes);
  assert.ok(candidates.length > 0, "Expected near-identical LOs to be flagged as candidates");
});

it("similarity score is between 0 and 1 inclusive", () => {
  const nodes = [
    {
      title: "A",
      learningObjective: "Student can find the unknown component using inverse operations.",
    },
    {
      title: "B",
      learningObjective: "Student can find the unknown addend using inverse operations.",
    },
  ];
  const candidates = detectDuplicateLOs(nodes);
  if (candidates.length > 0) {
    assert.ok(candidates[0].similarity >= 0 && candidates[0].similarity <= 1);
  }
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
