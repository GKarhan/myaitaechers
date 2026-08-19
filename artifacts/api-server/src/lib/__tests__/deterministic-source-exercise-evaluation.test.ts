import assert from "node:assert/strict";
import {
  evaluateDeterministicSourceExerciseAnswer,
} from "../deterministic-source-exercise-evaluation.js";

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function evaluate(overrides: Partial<Parameters<typeof evaluateDeterministicSourceExerciseAnswer>[0]> = {}) {
  return evaluateDeterministicSourceExerciseAnswer({
    learnerIntent: "ANSWER",
    activeTaskProvenance: "source_exercise",
    activeLessonExerciseId: 940,
    exerciseId: "EX-579-1",
    interactionType: "multiple_choice",
    correctAnswer: "B",
    studentAnswer: "բ",
    ...overrides,
  });
}

function finalStatus(modelStatus: string, result: ReturnType<typeof evaluate>): string {
  return result?.status ?? modelStatus;
}

test("A: EX-579-1 Armenian Բ overrides model INCORRECT to CORRECT", () => {
  const result = evaluate({ studentAnswer: "Բ" });
  assert.equal(finalStatus("INCORRECT", result), "CORRECT");
  assert.deepEqual(result, {
    lessonExerciseId: 940,
    exerciseId: "EX-579-1",
    interactionType: "multiple_choice",
    normalizedAnswer: "B",
    canonicalCorrectAnswer: "B",
    status: "CORRECT",
    evidenceQuality: "STRONG",
  });
});

test("B: EX-579-1 Armenian Ա overrides model CORRECT to INCORRECT", () => {
  const result = evaluate({ studentAnswer: "ա" });
  assert.equal(finalStatus("CORRECT", result), "INCORRECT");
  assert.equal(result?.evidenceQuality, "NONE");
});

test("C: EX-579-2 ճիշտ overrides model INCORRECT to CORRECT", () => {
  const result = evaluate({
    activeLessonExerciseId: 941,
    exerciseId: "EX-579-2",
    interactionType: "true_false",
    correctAnswer: "TRUE",
    studentAnswer: "ճիշտ",
  });
  assert.equal(finalStatus("INCORRECT", result), "CORRECT");
  assert.equal(result?.normalizedAnswer, "TRUE");
  assert.equal(result?.canonicalCorrectAnswer, "TRUE");
});

test("D: EX-579-2 սխալ overrides model CORRECT to INCORRECT", () => {
  const result = evaluate({
    activeLessonExerciseId: 941,
    exerciseId: "EX-579-2",
    interactionType: "true_false",
    correctAnswer: "TRUE",
    studentAnswer: "սխալ",
  });
  assert.equal(finalStatus("CORRECT", result), "INCORRECT");
  assert.equal(result?.normalizedAnswer, "FALSE");
  assert.equal(result?.evidenceQuality, "NONE");
});

test("E: constructed response preserves AI evaluation", () => {
  const result = evaluate({
    interactionType: "constructed_response",
    correctAnswer: null,
    studentAnswer: "Իմ բացատրությունը",
  });
  assert.equal(result, null);
  assert.equal(finalStatus("PARTIALLY_CORRECT", result), "PARTIALLY_CORRECT");
});

test("F: legacy null metadata preserves AI evaluation", () => {
  const result = evaluate({
    interactionType: null,
    correctAnswer: null,
  });
  assert.equal(result, null);
  assert.equal(finalStatus("CORRECT", result), "CORRECT");
});

test("G: non-source active task cannot invoke source-exercise override", () => {
  const result = evaluate({ activeTaskProvenance: "micro_check" });
  assert.equal(result, null);
});

test("H: missing active lesson exercise ID cannot invoke override", () => {
  const result = evaluate({ activeLessonExerciseId: null });
  assert.equal(result, null);
});

test("I: exact active row metadata is the only comparison authority", () => {
  const result = evaluate({
    activeLessonExerciseId: 940,
    exerciseId: "EX-579-1",
    interactionType: "multiple_choice",
    correctAnswer: "B",
    studentAnswer: "Բ)",
  });
  assert.equal(result?.lessonExerciseId, 940);
  assert.equal(result?.exerciseId, "EX-579-1");
  assert.equal(result?.status, "CORRECT");
});

test("J: non-canonical typed answer preserves existing AI-assisted path", () => {
  const result = evaluate({ studentAnswer: "կարծում եմ երկրորդ տարբերակը" });
  assert.equal(result, null);
  assert.equal(finalStatus("UNCLEAR", result), "UNCLEAR");
});

console.log(`\n${passed} deterministic source-exercise evaluation tests passed\n`);