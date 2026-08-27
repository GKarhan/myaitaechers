import assert from "node:assert/strict";
import {
  COGNITIVE_LEVEL_OPERATIONAL_CONTRACTS,
  COGNITIVE_LEVELS,
  evaluateSemanticReviewResult,
  hasDuplicateQuestionText,
  normalizeQuestionText,
  type CognitiveLevel,
  type NormalizedQuestionCandidate,
  type QuestionQualityContext,
  type SemanticQuestionReviewResult,
  validateGeneratedQuestionCandidate,
} from "../quiz-question-quality.js";

const context: QuestionQualityContext = {
  canonicalNodeId: 42,
  canonicalCognitiveLevelId: 420,
  cognitiveLevel: "understand",
  microNodeTitle: "Ջրի կարևորությունը",
  instructionalContent: "Ջուրը կարևոր է կյանքի համար։",
  performanceObjective: "Սովորողը բացատրում է ջրի կարևորությունը։",
  successCriterion: "Ներկայացնում է ջրի կարևորությունը ճիշտ օրինակով։",
  preferredInteractionTypes: ["multiple_choice"],
};

function candidate(
  overrides: Partial<NormalizedQuestionCandidate> = {},
): NormalizedQuestionCandidate {
  return {
    questionText: "Ինչո՞ւ է ջուրը կարևոր կյանքի համար։",
    options: ["Կյանքի համար", "Միայն գույնի", "Միայն ձայնի", "Ոչ մի պատճառով"],
    correctOptionIndex: 0,
    optionExplanations: null,
    difficultyLevel: "MEDIUM",
    nodeId: 42,
    cognitiveLevelId: 420,
    ...overrides,
  };
}

function assertPass(
  value: ReturnType<typeof validateGeneratedQuestionCandidate>,
): void {
  assert.equal(value.passed, true);
  assert.deepEqual(value.reasonCodes, []);
}

function assertFailsWith(
  value: ReturnType<typeof validateGeneratedQuestionCandidate>,
  reason: string,
): void {
  assert.equal(value.passed, false);
  assert.ok(value.reasonCodes.includes(reason as never), value.reasonCodes.join(", "));
}

function review(
  overrides: Partial<SemanticQuestionReviewResult> = {},
): SemanticQuestionReviewResult {
  return {
    verdict: "PASS",
    reasonCodes: [],
    measuredCognitiveLevel: "understand",
    nodeAligned: true,
    objectiveAligned: true,
    criterionAligned: true,
    interactionCompatible: true,
    sourceGrounded: true,
    ...overrides,
  };
}

const results: Array<{ name: string; passed: boolean }> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, passed: false });
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

console.log("\nCognitive Question Quality Contract\n");

test("A: valid current MC candidate passes deterministic checks", () => {
  const result = validateGeneratedQuestionCandidate(candidate(), context);
  assertPass(result);
});

test("B: empty question fails", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(candidate({ questionText: "  " }), context),
    "INVALID_QUESTION_TEXT",
  );
});

test("C: placeholder question fails", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(candidate({ questionText: "Հարց 1" }), context),
    "PLACEHOLDER_CONTENT",
  );
});

test("D: fewer than four options fails", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(
      candidate({ options: ["Միայն մեկ տարբերակ"] as never }),
      context,
    ),
    "INVALID_OPTIONS",
  );
});

test("E: empty option fails", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(
      candidate({
        options: ["Լավ պատասխան", "", "Այլ տարբերակ", "Եվս մեկ տարբերակ"],
      }),
      context,
    ),
    "INVALID_OPTIONS",
  );
});

test("F: duplicate options fail after normalization", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(
      candidate({
        options: ["Ջուրը կարևոր է", "Ջուրը կարևոր է!", "Այլ", "Մեկ այլ"],
      }),
      context,
    ),
    "DUPLICATE_OPTIONS",
  );
});

test("G: invalid correct option index fails", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(candidate({ correctOptionIndex: 4 }), context),
    "INVALID_CORRECT_OPTION",
  );
});

test("H: malformed option explanations fail", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(
      candidate({ optionExplanations: ["Բացատրություն"] as never }),
      context,
    ),
    "INVALID_OPTION_EXPLANATIONS",
  );
});

test("I: node mismatch fails", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(candidate({ nodeId: 99 }), context),
    "NODE_ID_MISMATCH",
  );
});

test("J: Cognitive Level ID mismatch fails", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(candidate({ cognitiveLevelId: 999 }), context),
    "COGNITIVE_LEVEL_ID_MISMATCH",
  );
});

test("K: invalid difficulty enum fails", () => {
  assertFailsWith(
    validateGeneratedQuestionCandidate(candidate({ difficultyLevel: "EXTREME" as never }), context),
    "INVALID_DIFFICULTY_LEVEL",
  );
});

test("L: exact duplicate question fails", () => {
  const accepted = [candidate()];
  assert.equal(hasDuplicateQuestionText(candidate().questionText, accepted), true);
  assertFailsWith(
    validateGeneratedQuestionCandidate(candidate(), context, accepted),
    "DUPLICATE_QUESTION",
  );
});

test("M: normalized duplicate question fails", () => {
  const accepted = [candidate({ questionText: "Ինչո՞ւ է ջուրը կարևոր կյանքի համար?" })];
  const equivalent = "  Ինչո՞ւ է ջուրը կարևոր կյանքի համար։  ";
  assert.equal(normalizeQuestionText(accepted[0]!.questionText), normalizeQuestionText(equivalent));
  assertFailsWith(
    validateGeneratedQuestionCandidate(candidate({ questionText: equivalent }), context, accepted),
    "DUPLICATE_QUESTION",
  );
});

test("N: HIGH difficulty does not change Understand target", () => {
  const result = validateGeneratedQuestionCandidate(
    candidate({ difficultyLevel: "HIGH" }),
    context,
  );
  assertPass(result);
  assert.equal(context.cognitiveLevel, "understand");
});

test("O: LOW difficulty does not change Apply target", () => {
  const applyContext = { ...context, cognitiveLevel: "apply" as const };
  const result = validateGeneratedQuestionCandidate(
    candidate({ difficultyLevel: "LOW" }),
    applyContext,
  );
  assertPass(result);
  assert.equal(applyContext.cognitiveLevel, "apply");
});

test("P: unsupported preferred interaction is reported explicitly", () => {
  const result = validateGeneratedQuestionCandidate(
    candidate(),
    { ...context, preferredInteractionTypes: ["numeric_answer"] },
  );
  assertFailsWith(result, "PREFERRED_INTERACTION_UNAVAILABLE");
});

test("P2: Create target rejects current MC even without authored preferences", () => {
  const result = validateGeneratedQuestionCandidate(
    candidate(),
    {
      ...context,
      cognitiveLevel: "create",
      preferredInteractionTypes: [],
    },
  );
  assertFailsWith(result, "TARGET_INTERACTION_INCOMPATIBLE");
  assert.equal(result.reasonCodes.includes("PREFERRED_INTERACTION_UNAVAILABLE"), false);
});

test("P3: Evaluate target rejects current MC independently of preferences", () => {
  const result = validateGeneratedQuestionCandidate(
    candidate(),
    {
      ...context,
      cognitiveLevel: "evaluate",
      preferredInteractionTypes: ["constructed_response"],
    },
  );
  assertFailsWith(result, "TARGET_INTERACTION_INCOMPATIBLE");
  assertFailsWith(result, "PREFERRED_INTERACTION_UNAVAILABLE");
});

test("Q: all six Cognitive Levels have an operational contract", () => {
  assert.deepEqual(Object.keys(COGNITIVE_LEVEL_OPERATIONAL_CONTRACTS).sort(), [...COGNITIVE_LEVELS].sort());
});

test("R: every level has required performance", () => {
  for (const level of COGNITIVE_LEVELS) {
    assert.ok(COGNITIVE_LEVEL_OPERATIONAL_CONTRACTS[level].requiredPerformance.length > 0);
  }
});

test("S: every level has rejected lower-level substitutes", () => {
  for (const level of COGNITIVE_LEVELS) {
    assert.ok(COGNITIVE_LEVEL_OPERATIONAL_CONTRACTS[level].rejectedLowerLevelSubstitutes.length > 0);
  }
});

test("T: every level has compatible interaction metadata", () => {
  for (const level of COGNITIVE_LEVELS) {
    assert.ok(COGNITIVE_LEVEL_OPERATIONAL_CONTRACTS[level].naturallyCompatibleInteractionTypes.length > 0);
  }
});

test("U: Apply target plus measured Remember fails as too low", () => {
  const result = evaluateSemanticReviewResult(
    review({ measuredCognitiveLevel: "remember" }),
    { cognitiveLevel: "apply" },
  );
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.includes("COGNITIVE_DEMAND_TOO_LOW"));
});

test("V: Apply target plus aligned Apply passes", () => {
  const result = evaluateSemanticReviewResult(
    review({ measuredCognitiveLevel: "apply" }),
    { cognitiveLevel: "apply" },
  );
  assert.deepEqual(result, { passed: true, reasonCodes: [] });
});

test("W: Analyze target plus measured Apply fails", () => {
  const result = evaluateSemanticReviewResult(
    review({ measuredCognitiveLevel: "apply" }),
    { cognitiveLevel: "analyze" },
  );
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.includes("COGNITIVE_DEMAND_TOO_LOW"));
});

test("X: Evaluate target without criterion alignment fails", () => {
  const result = evaluateSemanticReviewResult(
    review({
      measuredCognitiveLevel: "evaluate",
      criterionAligned: false,
    }),
    { cognitiveLevel: "evaluate" },
  );
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.includes("SUCCESS_CRITERION_MISALIGNED"));
});

test("Y: Create target with selection-only demand fails", () => {
  const result = evaluateSemanticReviewResult(
    review({
      measuredCognitiveLevel: "evaluate",
      reasonCodes: ["COGNITIVE_DEMAND_MISMATCH"],
    }),
    { cognitiveLevel: "create" },
  );
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.includes("COGNITIVE_DEMAND_TOO_LOW"));
});

test("Z: semantic review error fails closed", () => {
  const result = evaluateSemanticReviewResult(
    review({ verdict: "REVIEW_ERROR" }),
    { cognitiveLevel: "apply" },
  );
  assert.deepEqual(result, {
    passed: false,
    reasonCodes: ["SEMANTIC_REVIEW_ERROR"],
  });
});

test("authority: reviewer mismatch never changes the target", () => {
  const target: CognitiveLevel = "apply";
  const result = evaluateSemanticReviewResult(
    review({ measuredCognitiveLevel: "remember" }),
    { cognitiveLevel: target },
  );
  assert.equal(target, "apply");
  assert.equal(result.passed, false);
});

test("authority: a reviewer cannot make a failed verdict pass", () => {
  const result = evaluateSemanticReviewResult(
    review({
      verdict: "FAIL",
      measuredCognitiveLevel: "apply",
    }),
    { cognitiveLevel: "apply" },
  );
  assert.deepEqual(result, {
    passed: false,
    reasonCodes: ["COGNITIVE_DEMAND_MISMATCH"],
  });
});

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
if (failed.length > 0) process.exit(1);