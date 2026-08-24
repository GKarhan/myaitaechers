import assert from "node:assert/strict";
import { assessC2GenerationPreflight } from "../c2-generation-preflight.js";
import {
  assessAcceptedCognitivePath,
  getHighConfidenceLearningObjectiveFloor,
  validateCognitivePathGrounding,
} from "../cognitive-path-grounding.js";
import {
  cogPathLevelSchema,
  generateCognitivePath,
} from "../../services/lesson-mapping.js";
import { matchesTargetCognitiveDemand, type TargetCognitiveDemand } from "../c2-target-demand.js";

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

const applyDemand: TargetCognitiveDemand = {
  targetLevel: "apply",
  confidence: "HIGH",
  evidence: ["OBJECTIVE_PERFORMANCE", "SOURCE_PROCEDURE"],
  c1Relation: "MATCHES_C1",
  reviewReasons: [],
  resolverVersion: "test",
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

test("2. source-sufficient Apply node is eligible with its resolved target", () => {
  const result = assessC2GenerationPreflight({
    nodeStatus: "approved",
    theoryContent: applySource,
    learningObjective: applyObjective,
    blockType: "rule",
  });
  assert.equal(result.eligible, true);
  assert.equal(matchesTargetCognitiveDemand(applyDemand, [applyLevel]), true);
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

test("4. a generated target must match the resolved target demand", () => {
  assert.equal(matchesTargetCognitiveDemand(applyDemand, [
    { cognitiveLevel: "apply", isTargetCeiling: false },
    { cognitiveLevel: "analyze", isTargetCeiling: true },
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

test("6. a path may begin above Remember when source evidence supports it", () => {
  assert.equal(applyLevel.cognitiveLevel, "apply");
  assert.equal(matchesTargetCognitiveDemand(applyDemand, [applyLevel]), true);
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

test("8. partially supported C1 objective remains review-required but safe to continue", () => {
  const result = assessC2GenerationPreflight({
    nodeStatus: "approved",
    theoryContent: "Աշակերտը պատմեց թվերի տեղը գրության մեջ իր ընկերոջը դասի ընթացքում։",
    learningObjective: "Բացատրում է թվերի տեղը գրության մեջ։",
    blockType: "note",
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "C1_REVIEW_REQUIRED");
  assert.equal(result.outcome, "REVIEW_REQUIRED");
  assert.equal(result.sourceAlignment?.status, "PARTIAL");
});

test("9. needs_review C1 node remains safe for generation with review required", () => {
  const result = assessC2GenerationPreflight({
    nodeStatus: "needs_review",
    theoryContent: applySource,
    learningObjective: applyObjective,
    blockType: "rule",
  });
  assert.deepEqual(result, {
    eligible: true,
    reason: "C1_REVIEW_REQUIRED",
    sourceAlignment: result.sourceAlignment,
    outcome: "REVIEW_REQUIRED",
  });
});

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

const calculationSource = "Աշակերտը հաշվարկում է 7 + 3 գումարը և ստանում է 10։";
const calculationObjective = "Հաշվարկում է 7 + 3 գումարը։";
const problemSource = "Աշակերտը լուծում է խնդիր՝ գտնելով անհայտ գումարելին։";
const problemObjective = "Լուծում է անհայտ գումարելիով խնդիր։";

test("18. a calculation objective rejects a Remember-only target", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: calculationSource,
    learningObjective: calculationObjective,
    levels: [{
      ...applyLevel,
      cognitiveLevel: "remember",
      performanceObjective: "Հիշում է 7 + 3 գումարը։",
      successCriterion: "Նշում է 7 + 3 գումարը։",
    }],
  });
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.reason, "LEARNING_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION");
});

test("19. a problem-solving objective rejects recall/listing-only target", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: problemSource,
    learningObjective: problemObjective,
    levels: [{
      ...applyLevel,
      cognitiveLevel: "remember",
      performanceObjective: "Հիշում է անհայտ գումարելին։",
      successCriterion: "Նշում է անհայտ գումարելին։",
    }],
  });
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.reason, "LEARNING_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION");
});

test("20. an Apply path satisfies a calculation objective floor", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: calculationSource,
    learningObjective: calculationObjective,
    levels: [{
      ...applyLevel,
      performanceObjective: "Հաշվարկում է 7 + 3 գումարը։",
      successCriterion: "Ճիշտ է հաշվարկում 7 + 3 գումարը։",
    }],
  });
  assert.equal(acceptance.accepted, true);
});

test("21. a Remember objective remains backward compatible", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: rememberSource,
    learningObjective: rememberObjective,
    levels: [{
      ...applyLevel,
      cognitiveLevel: "remember",
      performanceObjective: rememberObjective,
      successCriterion: "Ճիշտ է որոշում բնական թվերի հաջորդ թիվը։",
    }],
  });
  assert.equal(acceptance.accepted, true);
});

test("22. clear Armenian higher-order objectives establish their own floors", () => {
  assert.equal(getHighConfidenceLearningObjectiveFloor("Վերլուծում է թվերի կառուցվածքը։"), "analyze");
  assert.equal(getHighConfidenceLearningObjectiveFloor("Գնահատում է լուծման ճշտությունը։"), "evaluate");
  assert.equal(getHighConfidenceLearningObjectiveFloor("Ստեղծում է սեփական խնդիր։"), "create");
});

test("23. a Create objective rejects a path whose target remains at Apply", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "confirmed",
    theoryContent: applySource,
    learningObjective: "Ստեղծում է սեփական խնդիր 7254 թվի կարգային գումարելիների համար։",
    levels: [{
      ...applyLevel,
      performanceObjective: "Կիրառում է կարգային գումարելիների կանոնը։",
      successCriterion: "Ճիշտ է ներկայացնում 7254 թիվը կարգային գումարելիների գումարով։",
    }],
  });
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.reason, "LEARNING_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION");
});

test("24. vague objectives do not invent a stricter cognitive floor", () => {
  assert.equal(getHighConfidenceLearningObjectiveFloor("Բացատրում է կանոնը։"), null);
  assert.equal(getHighConfidenceLearningObjectiveFloor("Որոշում է պատասխանը։"), null);
});

const failed = results.filter((result) => !result.pass);
console.log(`\nC2 generation quality: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;