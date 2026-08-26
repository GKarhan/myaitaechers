import assert from "node:assert/strict";
import {
  presentAttemptQuestion,
  projectQuizSessionStates,
  scorePresentedAnswer,
} from "../quiz-session.js";

const tests: Array<[string, () => void]> = [
  ["S1 MASTERED is projected to Գիտի only", () => {
    const result = projectQuizSessionStates([1], new Map([[1, { knowledgeState: "MASTERED" }]]));
    assert.deepEqual(result, { masteredNodeIds: [1], learningNodeIds: [], knowsCount: 1, learningCount: 0 });
  }],
  ["S2 PARTIAL is projected to Սովորելու", () => {
    const result = projectQuizSessionStates([1], new Map([[1, { knowledgeState: "PARTIAL" }]]));
    assert.deepEqual(result.learningNodeIds, [1]);
  }],
  ["S3 NOT_KNOWN is projected to Սովորելու", () => {
    const result = projectQuizSessionStates([1], new Map([[1, { knowledgeState: "NOT_KNOWN" }]]));
    assert.deepEqual(result.learningNodeIds, [1]);
  }],
  ["S4 NOT_STUDIED is projected to Սովորելու", () => {
    const result = projectQuizSessionStates([1], new Map([[1, { knowledgeState: "NOT_STUDIED" }]]));
    assert.deepEqual(result.learningNodeIds, [1]);
  }],
  ["S5 unresolved C5 fails into learning scope", () => {
    assert.deepEqual(projectQuizSessionStates([7], new Map()).learningNodeIds, [7]);
  }],
  ["S6 duplicate root nodes are deduplicated in stable order", () => {
    const result = projectQuizSessionStates([2, 1, 2], new Map([[2, { knowledgeState: "MASTERED" }]]));
    assert.deepEqual(result.masteredNodeIds, [2]);
    assert.deepEqual(result.learningNodeIds, [1]);
  }],
  ["S7 empty session scope remains empty", () => {
    assert.deepEqual(projectQuizSessionStates([], new Map()), {
      masteredNodeIds: [], learningNodeIds: [], knowsCount: 0, learningCount: 0,
    });
  }],
  ["S8 presentation follows stored option order without mutating canonical options", () => {
    const options = ["A", "B", "C", "D"];
    const presented = presentAttemptQuestion({
      questionId: 9, questionText: "Q", options, optionOrder: [2, 0, 3, 1],
      sequence: 1, interactionType: "multiple_choice",
    });
    assert.deepEqual(presented.options, ["C", "A", "D", "B"]);
    assert.deepEqual(options, ["A", "B", "C", "D"]);
  }],
  ["S9 shuffled correct answer maps back to canonical truth", () => {
    const result = scorePresentedAnswer({ optionOrder: [2, 0, 3, 1], correctOptionIndex: 3 }, 2);
    assert.equal(result?.isCorrect, true);
    assert.equal(result?.canonicalSelectedOptionIndex, 3);
  }],
  ["S10 shuffled wrong answer preserves selected/correct presentation indices", () => {
    const result = scorePresentedAnswer({ optionOrder: [2, 0, 3, 1], correctOptionIndex: 3 }, 0);
    assert.equal(result?.isCorrect, false);
    assert.equal(result?.selectedPresentationIndex, 0);
    assert.equal(result?.correctPresentationIndex, 2);
  }],
  ["S11 invalid presentation index fails closed", () => {
    assert.equal(scorePresentedAnswer({ optionOrder: [0, 1], correctOptionIndex: 1 }, 4), null);
  }],
  ["S12 trusted explanations and calculation solution are returned from the snapshot", () => {
    const result = scorePresentedAnswer({
      optionOrder: [1, 0],
      correctOptionIndex: 0,
      optionExplanations: ["because zero", "because one"],
      solutionExplanation: "2 + 2 = 4",
    }, 0);
    assert.deepEqual(result?.feedback, {
      whyCorrect: "because zero",
      whyWrong: "because one",
      solutionExplanation: "2 + 2 = 4",
    });
  }],
];

for (const [name, test] of tests) {
  test();
  console.log(`PASS ${name}`);
}
console.log(`Continuous quiz session suite passed (${tests.length}/${tests.length})`);