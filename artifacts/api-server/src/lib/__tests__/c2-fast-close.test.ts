/**
 * C2 Fast Close — focused acceptance contract tests.
 *
 * Runner:
 *   pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/c2-fast-close.test.ts
 */
import assert from "node:assert/strict";
import {
  assessAcceptedCognitivePath,
  assessApprovedNodeC2Coverage,
} from "../cognitive-path-grounding.js";
import {
  deriveNodeCognitiveCapacity,
  getAlignmentWarnings,
} from "../lesson-outcome-validation.js";

type Level = {
  cognitiveLevel: string;
  sequence: number;
  isApplicable: boolean;
  isTargetCeiling: boolean;
  performanceObjective: string | null;
  successCriterion: string | null;
  preferredInteractionTypes: string[] | null;
};

const source = "Բնական թվերը 1-ից սկսվող թվեր են։ Յուրաքանչյուր բնական թիվ ունի հաջորդ թիվ։";
const objective = "Սովորողը բացատրում է բնական թվերի հաջորդականությունը և գտնում է հաջորդ թիվը։";
const groundedLevels: Level[] = [
  {
    cognitiveLevel: "remember",
    sequence: 1,
    isApplicable: true,
    isTargetCeiling: false,
    performanceObjective: "Սովորողը ճանաչում է բնական թվերը և հաջորդ թիվը։",
    successCriterion: "Ճիշտ է նշում բնական թիվը և դրա հաջորդ թիվը։",
    preferredInteractionTypes: ["short_answer"],
  },
  {
    cognitiveLevel: "apply",
    sequence: 2,
    isApplicable: true,
    isTargetCeiling: true,
    performanceObjective: "Սովորողը գտնում է տրված բնական թվի հաջորդ թիվը։",
    successCriterion: "Առանց հուշման ճիշտ է գրում հաջորդ բնական թիվը։",
    preferredInteractionTypes: ["numeric_answer"],
  },
];

const results: { name: string; pass: boolean; error?: unknown }[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  ✓  ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error });
    console.error(`  ✗  ${name}`);
    console.error(`     ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assess(status: string | null, levels: Level[] = groundedLevels) {
  return assessAcceptedCognitivePath({
    cogPathStatus: status,
    theoryContent: source,
    learningObjective: objective,
    levels,
  });
}

test("A: confirmed + GROUNDED path is accepted for runtime", () => {
  assert.equal(assess("confirmed").accepted, true);
});

test("B: needs_review path is rejected for runtime", () => {
  assert.deepEqual(assess("needs_review").reason, "PATH_NOT_CONFIRMED");
});

test("C: unconfirmed generated path is rejected for runtime", () => {
  assert.deepEqual(assess(null).reason, "PATH_NOT_CONFIRMED");
});

test("D1: REVIEW_REQUIRED grounding is rejected for runtime", () => {
  const reviewLevels = [{
    ...groundedLevels[0],
    isTargetCeiling: true,
    performanceObjective: "Վերլուծում է երկրաչափական համաչափությունները առանց արտաքին աջակցության։",
  }];
  const result = assess("confirmed", reviewLevels);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "GROUNDING_NOT_ACCEPTED");
  assert.equal(result.grounding?.status, "REVIEW_REQUIRED");
});

test("D2: INVALID grounding is rejected for runtime", () => {
  const invalidLevels = [{
    ...groundedLevels[0],
    isTargetCeiling: true,
    performanceObjective: "Սովորողը միշտ գտնում է 999-ի բոլոր բաժանարարները։",
  }];
  const result = assess("confirmed", invalidLevels);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "GROUNDING_NOT_ACCEPTED");
  assert.equal(result.grounding?.status, "INVALID");
});

test("D3: malformed interaction data is rejected fail-closed", () => {
  const malformedLevels = [{
    ...groundedLevels[0],
    isTargetCeiling: true,
    preferredInteractionTypes: "short_answer",
  }] as unknown as Level[];
  assert.equal(assess("confirmed", malformedLevels).reason, "INTERACTION_TYPES_INVALID");
});

test("D4: unordered levels are rejected", () => {
  const unorderedLevels = [
    { ...groundedLevels[1], sequence: 2 },
    { ...groundedLevels[0], sequence: 1 },
  ];
  assert.equal(assess("confirmed", unorderedLevels).reason, "LEVEL_ORDER_INVALID");
});

test("E: approved MicroNode with accepted path passes C2 coverage", () => {
  const coverage = assessApprovedNodeC2Coverage({
    nodeStatus: "approved",
    path: assess("confirmed"),
  });
  assert.deepEqual(coverage, { included: true, accepted: true, reason: "ACCEPTED" });
});

test("F: needs_review MicroNode without a path is excluded, not accepted", () => {
  const coverage = assessApprovedNodeC2Coverage({
    nodeStatus: "needs_review",
    path: assess(null, []),
  });
  assert.deepEqual(coverage, {
    included: false,
    accepted: false,
    reason: "EXCLUDED_NON_APPROVED_NODE",
  });
});

test("G: target below REQUIRED Outcome depth is detected", () => {
  const capacity = deriveNodeCognitiveCapacity({
    targetBloomLevel: 2,
    cogPathStatus: "confirmed",
    levels: [{
      cognitiveLevel: "understand",
      isApplicable: true,
      isTargetCeiling: true,
    }],
  });
  assert.ok(getAlignmentWarnings("REQUIRED", "apply", capacity)
    .includes("REQUIRED_DEPTH_EXCEEDS_NODE_CAPACITY"));
});

test("H: target equal to REQUIRED Outcome depth passes", () => {
  const capacity = deriveNodeCognitiveCapacity({
    targetBloomLevel: 3,
    cogPathStatus: "confirmed",
    levels: [{
      cognitiveLevel: "apply",
      isApplicable: true,
      isTargetCeiling: true,
    }],
  });
  assert.equal(getAlignmentWarnings("REQUIRED", "apply", capacity)
    .includes("REQUIRED_DEPTH_EXCEEDS_NODE_CAPACITY"), false);
});

const failed = results.filter((result) => !result.pass);
console.log(`\nC2 Fast Close: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);