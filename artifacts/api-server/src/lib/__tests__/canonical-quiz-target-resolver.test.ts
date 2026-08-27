import assert from "node:assert/strict";
import {
  resolveCanonicalQuizTarget,
  type CanonicalQuizTargetLevel,
} from "../cognitive-path-grounding.js";

const source = "Կշեռքի աշխատանքը կատարվում է երկու նժարով։ Հավասարակշռության դեպքում զանգվածները հավասար են։";
const objective = "Սովորողը բացատրում է կշեռքի աշխատանքը։";

function level(
  id: number,
  cognitiveLevel: string,
  sequence: number,
  isTargetCeiling: boolean,
  overrides: Partial<CanonicalQuizTargetLevel> = {},
): CanonicalQuizTargetLevel {
  return {
    id,
    lessonNodeId: 900,
    cognitiveLevel,
    sequence,
    isApplicable: true,
    isTargetCeiling,
    performanceObjective: "Սովորողը բացատրում է կշեռքի աշխատանքը։",
    successCriterion: "Ճիշտ է բացատրում կշեռքի աշխատանքը։",
    minimumIndependentEvidence: 3,
    preferredInteractionTypes: ["multiple_choice"],
    ...overrides,
  };
}

function node(overrides: Partial<{
  id: number;
  cogPathStatus: string | null;
  targetBloomLevel: number | null;
}> = {}) {
  return {
    id: 900,
    cogPathStatus: "confirmed",
    theoryContent: source,
    learningObjective: objective,
    targetBloomLevel: null,
    ...overrides,
  };
}

function resolve(levels: CanonicalQuizTargetLevel[], overrides = {}) {
  return resolveCanonicalQuizTarget(node(overrides), levels);
}

const results: Array<{ name: string; pass: boolean; error?: unknown }> = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error });
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

function assertValid(result: ReturnType<typeof resolve>, cognitiveLevel: string, cognitiveLevelId: number): void {
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.target.cognitiveLevel, cognitiveLevel);
  assert.equal(result.target.cognitiveLevelId, cognitiveLevelId);
  assert.equal(result.target.isCanonicalTarget, true);
  assert.deepEqual(result.target.preferredInteractionTypes, ["multiple_choice"]);
  assert.equal(result.target.minimumIndependentEvidence, 3);
}

test("A: Understand[target] resolves Understand", () => {
  assertValid(resolve([level(1, "understand", 1, true)]), "understand", 1);
});

test("B: Apply[target] resolves Apply", () => {
  assertValid(resolve([level(2, "apply", 1, true)]), "apply", 2);
});

test("C: Understand → Apply[target] resolves Apply", () => {
  assertValid(resolve([
    level(1, "understand", 1, false),
    level(2, "apply", 2, true),
  ]), "apply", 2);
});

test("D: Remember → Understand → Apply[target] resolves Apply", () => {
  assertValid(resolve([
    level(1, "remember", 1, false),
    level(2, "understand", 2, false),
    level(3, "apply", 3, true),
  ]), "apply", 3);
});

test("E: Understand → Apply → Analyze[target] resolves Analyze", () => {
  assertValid(resolve([
    level(1, "understand", 1, false),
    level(2, "apply", 2, false),
    level(3, "analyze", 3, true),
  ]), "analyze", 3);
});

test("F: a confirmed single level does not require lower Bloom levels", () => {
  const result = resolve([level(1, "understand", 1, true)]);
  assert.equal(result.valid, true);
});

test("G: missing target is explicit", () => {
  const result = resolve([level(1, "understand", 1, false)]);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "TARGET_MISSING");
});

test("H: target before a later level is not final", () => {
  const result = resolve([
    level(1, "understand", 1, true),
    level(2, "apply", 2, false),
  ]);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "TARGET_NOT_FINAL");
});

test("I: descending cognitive order is rejected", () => {
  const result = resolve([
    level(1, "apply", 1, true),
    level(2, "understand", 2, false),
  ]);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "INVALID_COGNITIVE_ORDER");
});

test("J: target marked non-applicable is rejected", () => {
  const result = resolve([
    level(1, "understand", 1, true, { isApplicable: false }),
    level(2, "apply", 2, false),
  ]);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "TARGET_NOT_APPLICABLE");
});

test("K: unconfirmed path is rejected before target inference", () => {
  const result = resolve([level(1, "understand", 1, true)], { cogPathStatus: "needs_review" });
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "PATH_NOT_CONFIRMED");
});

test("L: grounding failure is exposed explicitly", () => {
  const result = resolve([level(1, "understand", 1, true, {
    performanceObjective: null,
  })]);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "PATH_GROUNDING_FAILED");
    assert.equal(result.acceptanceReason, "GROUNDING_NOT_ACCEPTED");
  }
});

test("M: duplicate authored sequences are rejected as invalid sequence", () => {
  const result = resolve([
    level(1, "understand", 1, false),
    level(2, "apply", 1, true),
  ]);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "INVALID_SEQUENCE");
});

test("N: legacy targetBloomLevel disagreement is explicit", () => {
  const result = resolve([level(1, "apply", 1, true)], { targetBloomLevel: 2 });
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "TARGET_BLOOM_COPY_MISMATCH");
    assert.equal(result.expectedTargetBloomLevel, 3);
    assert.equal(result.actualTargetBloomLevel, 2);
  }
});

test("O: multiple targets are rejected defensively", () => {
  const result = resolve([
    level(1, "understand", 1, true),
    level(2, "apply", 2, true),
  ]);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "MULTIPLE_TARGETS");
});

const failed = results.filter((result) => !result.pass);
console.log(`\nCanonical Quiz Target Resolver: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
