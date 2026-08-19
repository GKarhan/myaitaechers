import assert from "node:assert/strict";
import {
  normalizeSourceExerciseAnswerContract,
} from "../source-exercise-answer.js";
import { parseMappingText } from "../../mapping/mapTextParser.js";
import { validateParsedMapping } from "../../mapping/mapTextValidator.js";
import { E_EX_ANSWER_CONTRACT_INVALID } from "../../mapping/mapTextErrors.js";

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function normalize(interactionType: unknown, correctAnswer: unknown) {
  return normalizeSourceExerciseAnswerContract({ interactionType, correctAnswer });
}

function mappingText(interactionType: string | null, correctAnswer: string | null): string {
  const interactionLine = interactionType === null ? "" : `interactionType: ${interactionType}`;
  const answerLine = correctAnswer === null ? "correctAnswer: null" : `correctAnswer: ${correctAnswer}`;
  return `
LESSON
title: Typed answer contract
subject: Test
grade: 5
textbook: Test book
author: Test
section: 1
pages: 1-2

NODE N1
title: Topic

MICRONODE MN-1.1
title: Node
microNodeType: KNOWLEDGE
learningObjective: Answer explicitly
sourceBlockIds: B1
exerciseIds: EX-1
confidenceScore: 100
sourceCoverage: FULL
status: draft

SOURCE BLOCK B1
blockType: DEFINITION
sourceText: Source text.
sourcePage: 1
status: EXTRACTED

EXERCISE EX-1
text: Choose an answer.
exerciseType: RECALL
difficulty: EASY
sequence: 1
${interactionLine}
${answerLine}
relatedMicroNodes: MN-1.1
`.trim();
}

test("A: multiple_choice Բ normalizes to B", () => {
  assert.deepEqual(normalize("multiple_choice", "Բ"), {
    ok: true,
    interactionType: "multiple_choice",
    correctAnswer: "B",
  });
});

test("B: multiple_choice B) normalizes to B", () => {
  assert.deepEqual(normalize("multiple_choice", "B)"), {
    ok: true,
    interactionType: "multiple_choice",
    correctAnswer: "B",
  });
});

test("C: true_false Ճիշտ normalizes to TRUE", () => {
  assert.deepEqual(normalize("true_false", "Ճիշտ"), {
    ok: true,
    interactionType: "true_false",
    correctAnswer: "TRUE",
  });
});

test("D: true_false սխալ normalizes to FALSE", () => {
  assert.deepEqual(normalize("true_false", "սխալ"), {
    ok: true,
    interactionType: "true_false",
    correctAnswer: "FALSE",
  });
});

test("E: constructed_response rejects non-null correctAnswer", () => {
  const result = normalize("constructed_response", "anything");
  assert.equal(result.ok, false);
});

test("F: constructed_response accepts null correctAnswer", () => {
  assert.deepEqual(normalize("constructed_response", null), {
    ok: true,
    interactionType: "constructed_response",
    correctAnswer: null,
  });
});

test("G: legacy null/null remains valid", () => {
  assert.deepEqual(normalize(null, null), {
    ok: true,
    interactionType: null,
    correctAnswer: null,
  });
});

test("H1: TEXT parser preserves and validator canonicalizes explicit answer metadata", () => {
  const parsed = parseMappingText(mappingText("multiple_choice", "Բ"));
  assert.equal(parsed.exercises[0]?.interactionType, "multiple_choice");
  assert.equal(parsed.exercises[0]?.correctAnswer, "Բ");

  const validation = validateParsedMapping(parsed);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(parsed.exercises[0]?.correctAnswer, "B");
});

test("H2: TEXT validator rejects constructed_response with an answer", () => {
  const parsed = parseMappingText(mappingText("constructed_response", "A"));
  const validation = validateParsedMapping(parsed);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.issueType === E_EX_ANSWER_CONTRACT_INVALID));
});

console.log(`\n${passed} source-exercise answer-contract tests passed\n`);