import assert from "node:assert/strict";
import { assessC2GenerationPreflight } from "../c2-generation-preflight.js";
import {
  assessAcceptedCognitivePath,
  validateCognitivePathGrounding,
} from "../cognitive-path-grounding.js";
import {
  cogPathLevelSchema,
  generateCognitivePath,
  preservesC1TargetCeiling,
} from "../../services/lesson-mapping.js";

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

const rememberSource = "Բնական թվերի հաջորդականությունում յուրաքանչյուր հաջորդ թիվը մեծ է նախորդից մեկով։";
const rememberObjective = "Որոշում է բնական թվերի հաջորդ թիվը։";
const applySource = "7254 թիվը կարելի է ներկայացնել կարգային գումարելիների գումարով՝ 7000 + 200 + 50 + 4։";
const applyObjective = "Ներկայացնում է 7254 թիվը կարգային գումարելիների գումարով։";

const applyLevel = {
  cognitiveLevel: "apply" as const,
  sequence: 1,
  isApplicable: true,
  isTargetCeiling: true,
  performanceObjective: applyObjective,
  successCriterion: "Ճիշտ է ներկայացնում 7254 թիվը կարգային գումարելիների գումարով։",
  preferredInteractionTypes: ["numeric_answer"],
};

test("1. source-sufficient Remember C1 node is eligible", () => {
  const result = assessC2GenerationPreflight({
    nodeStatus: "approved",
    theoryContent: rememberSource,
    learningObjective: rememberObjective,
    blockType: "definition",
  });
  assert.equal(result.eligible, true);
  assert.equal(result.sourceAlignment?.status, "SUFFICIENT");
});

test("2. source-sufficient Apply C1 node is eligible without lowering its ceiling", () => {
  const result = assessC2GenerationPreflight({
    nodeStatus: "approved",
    theoryContent: applySource,
    learningObjective: applyObjective,
    blockType: "rule",
  });
  assert.equal(result.eligible, true);
  assert.equal(preservesC1TargetCeiling(3, [applyLevel]), true);
});

test("3. unsupported success-criterion claims remain invalid", () => {
  const audit = validateCognitivePathGrounding(applySource, applyObjective, [{
    ...applyLevel,
    successCriterion: "Միշտ ճիշտ է ներկայացնում 9999 թիվը կարգային գումարելիների գումարով։",
  }]);
  assert.equal(audit.status, "INVALID");
  assert.ok(audit.issueCounts.NOVEL_NUMERIC_CLAIM);
  assert.ok(audit.issueCounts.UNSUPPORTED_STRONG_CLAIM);
});

test("4. generic higher-level enrichment cannot exceed the C1 ceiling", () => {
  assert.equal(preservesC1TargetCeiling(3, [
    { cognitiveLevel: "apply", isTargetCeiling: true },
    { cognitiveLevel: "analyze", isTargetCeiling: false },
  ]), false);
});

test("5. a fully grounded one-level path is accepted", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: applySource,
    learningObjective: applyObjective,
    levels: [applyLevel],
  });
  assert.equal(acceptance.accepted, true);
});

test("6. a path may begin above Remember when the C1 target supports it", () => {
  assert.equal(applyLevel.cognitiveLevel, "apply");
  assert.equal(preservesC1TargetCeiling(3, [applyLevel]), true);
});

test("7. heading-only C1 source is blocked before C2 generation", () => {
  const result = assessC2GenerationPreflight({
    nodeStatus: "approved",
    theoryContent: "Բնական թվեր. Թեմայի վերնագիր՝ բնական թվերի ընդհանուր ներկայացում։",
    learningObjective: "Բացատրում է բնական թվերը։",
    blockType: "objective",
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "C1_SOURCE_INSUFFICIENT");
  assert.equal(result.sourceAlignment?.reasonCode, "HEADING_ONLY");
});

test("8. partially supported C1 objective is blocked before C2 generation", () => {
  const result = assessC2GenerationPreflight({
    nodeStatus: "approved",
    theoryContent: "Աշակերտը պատմեց թվերի տեղը գրության մեջ իր ընկերոջը դասի ընթացքում։",
    learningObjective: "Բացատրում է թվերի տեղը գրության մեջ։",
    blockType: "note",
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "C1_OBJECTIVE_NOT_GROUNDED");
  assert.equal(result.sourceAlignment?.status, "PARTIAL");
});

test("9. needs_review C1 node returns the strict review-required code", () => {
  const result = assessC2GenerationPreflight({
    nodeStatus: "needs_review",
    theoryContent: applySource,
    learningObjective: applyObjective,
    blockType: "rule",
  });
  assert.deepEqual(result, {
    eligible: false,
    reason: "C1_REVIEW_REQUIRED",
    sourceAlignment: null,
  });
});

await (async () => {
  try {
    const result = await generateCognitivePath({
      nodeId: 1,
      title: "Կարգային միավորներ",
      nodeStatus: "needs_review",
      theoryContent: applySource,
      learningObjective: applyObjective,
      blockType: "rule",
      targetBloomLevel: 3,
      subjectName: "Մաթեմատիկա",
      lessonTitle: "Թվեր",
      topicTitle: null,
      exercises: [],
    });
    assert.equal(result.skipped, true);
    assert.equal(result.skipCode, "C1_REVIEW_REQUIRED");
    assert.deepEqual(result.levels, []);
    results.push({ name: "10. C1 review preflight returns before any provider call", pass: true });
    console.log("  ✓ 10. C1 review preflight returns before any provider call");
  } catch (error) {
    results.push({ name: "10. C1 review preflight returns before any provider call", pass: false, error });
    console.error("  ✗ 10. C1 review preflight returns before any provider call");
    console.error(error);
  }
})();

test("11. malformed Bloom rank order is rejected by canonical C2 acceptance", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: applySource,
    learningObjective: applyObjective,
    levels: [
      applyLevel,
      {
        ...applyLevel,
        cognitiveLevel: "remember",
        sequence: 2,
        isTargetCeiling: false,
      },
    ],
  });
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.reason, "COGNITIVE_LEVEL_ORDER_INVALID");
});

test("12. a target ceiling below a later listed level is rejected", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: applySource,
    learningObjective: applyObjective,
    levels: [
      { ...applyLevel, cognitiveLevel: "remember", sequence: 1, isTargetCeiling: true },
      { ...applyLevel, cognitiveLevel: "apply", sequence: 2, isTargetCeiling: false },
    ],
  });
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.reason, "TARGET_CEILING_INVALID");
});

test("13. runtime acceptance normalizes a valid path returned out of sequence order", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: applySource,
    learningObjective: applyObjective,
    levels: [
      { ...applyLevel, sequence: 2, isTargetCeiling: true },
      { ...applyLevel, cognitiveLevel: "remember", sequence: 1, isTargetCeiling: false },
    ],
  });
  assert.equal(acceptance.accepted, true);
});

test("14. short arbitrary Armenian required text cannot be treated as grounded", () => {
  const audit = validateCognitivePathGrounding(applySource, applyObjective, [{
    ...applyLevel,
    performanceObjective: "Նոր",
    successCriterion: "Նոր",
  }]);
  assert.equal(audit.status, "REVIEW_REQUIRED");
  assert.ok(audit.issueCounts.LOW_SOURCE_ANCHOR);
});

test("15. non-Armenian required text is rejected before persistence or runtime use", () => {
  const audit = validateCognitivePathGrounding(applySource, applyObjective, [{
    ...applyLevel,
    performanceObjective: "Identify the place values",
    successCriterion: "Answer correctly",
  }]);
  assert.equal(audit.status, "INVALID");
  assert.ok(audit.issueCounts.NON_ARMENIAN_REQUIRED_TEXT);
});

test("16. an objective-only claim cannot substitute for textbook source evidence", () => {
  const objectiveOnlyClaim = "Կատարում է բազմապատկման գործողություն";
  const audit = validateCognitivePathGrounding(applySource, objectiveOnlyClaim, [{
    ...applyLevel,
    performanceObjective: objectiveOnlyClaim,
    successCriterion: objectiveOnlyClaim,
  }]);
  assert.equal(audit.status, "REVIEW_REQUIRED");
  assert.ok(audit.issueCounts.LOW_SOURCE_ANCHOR);
});

test("17. independent-evidence budget is capped at five in parsing and acceptance", () => {
  const overBudget = {
    ...applyLevel,
    minimumIndependentEvidence: 6,
  };
  assert.equal(cogPathLevelSchema.safeParse(overBudget).success, false);
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: applySource,
    learningObjective: applyObjective,
    levels: [overBudget],
  });
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.reason, "EVIDENCE_BUDGET_INVALID");
});

const failed = results.filter((result) => !result.pass);
console.log(`\nC2 generation quality: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;