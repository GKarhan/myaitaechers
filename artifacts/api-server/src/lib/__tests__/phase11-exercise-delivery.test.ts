/**
 * Phase 11.1 — Exercise Delivery Hardening Tests
 *
 * Tests the enforceVerbatimExercise and isExerciseDeliveryTurn helpers.
 *
 * Enforcement fires on backend state (phase + nodeTeachingStage + classExerciseCount),
 * independent of the AI model's teaching_mode output.
 *
 * TEST 1  — model already returned verbatim correctly → no modification, no dup
 * TEST 2  — model omits exercise entirely → backend injects verbatim
 * TEST 3  — model paraphrases exercise → authoritative text still delivered
 * TEST 4  — model invents a different question → verbatim still appears
 * TEST 5  — no selected CLASS exercise (undefined/null) → studentMessage unchanged
 * TEST 6  — empty/whitespace exerciseTextVerbatim → studentMessage unchanged
 * TEST 7  — exercise already present once → appears exactly once (no dup)
 * TEST 8  — Additional exercise isolation: Additional text NOT substituted
 * TEST 9  — wrong-node exercise isolation: wrong-node verbatim never delivered
 * TEST 10 — state immutability: function is pure, originals unchanged
 * TEST 11 — isExerciseDeliveryTurn: all conditions hold → true
 * TEST 12 — isExerciseDeliveryTurn: phase != 2 → false
 * TEST 13 — isExerciseDeliveryTurn: stage != MICRO_CHECK → false
 * TEST 14 — isExerciseDeliveryTurn: no class exercises → false
 * TEST 15 — isExerciseDeliveryTurn: multiple class exercises → true
 * TEST 16 — isExerciseDeliveryTurn: enforcement is teaching_mode-agnostic
 */

import assert from "node:assert/strict";
import { enforceVerbatimExercise, isExerciseDeliveryTurn } from "../exercise-delivery";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

const VERBATIM = "2. Ի՞նչ է բնության երևույθը:";

// ─────────────────────────────────────────────────────────────────────────────
// enforceVerbatimExercise
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nenforceVerbatimExercise:");

// TEST 1: model obeys verbatim rule → no modification, no duplication
test("TEST 1 — model returned verbatim correctly: no modification", () => {
  const aiMsg = `Ահa dasagrkqi arradjanken:\n\n${VERBATIM}`;
  const result = enforceVerbatimExercise(aiMsg, VERBATIM);
  assert.equal(result, aiMsg, "should return unchanged when verbatim already present");
  const count = result.split(VERBATIM).length - 1;
  assert.equal(count, 1, "exercise must appear exactly once");
});

// TEST 2: model omits exercise entirely
test("TEST 2 — model omits exercise: backend injects verbatim", () => {
  const aiMsg = "Hima antsnenkm hadjord arradjanqin:";
  const result = enforceVerbatimExercise(aiMsg, VERBATIM);
  assert.ok(result.includes(VERBATIM), "verbatim must appear in result");
});

// TEST 3: model paraphrases exercise
test("TEST 3 — model paraphrases: authoritative text still delivered", () => {
  const paraphrase = "Inchy enkы anvanum bnutyan yerevuyt:";
  const result = enforceVerbatimExercise(paraphrase, VERBATIM);
  assert.ok(result.includes(VERBATIM), "authoritative verbatim must appear");
  assert.ok(result.includes(paraphrase), "transition text is preserved");
});

// TEST 4: model invents a different question
test("TEST 4 — model invents different question: verbatim still appears", () => {
  const aiMsg = "Inch e fizikakan marminy:";
  const result = enforceVerbatimExercise(aiMsg, VERBATIM);
  assert.ok(result.includes(VERBATIM), "verbatim must appear even when model invents question");
});

// TEST 5: no selected CLASS exercise
test("TEST 5 — undefined/null verbatim: studentMessage unchanged", () => {
  const aiMsg = "Shat lav, Elen:";
  assert.equal(enforceVerbatimExercise(aiMsg, undefined), aiMsg);
  assert.equal(enforceVerbatimExercise(aiMsg, null), aiMsg);
});

// TEST 6: empty/whitespace exerciseTextVerbatim
test("TEST 6 — empty/whitespace verbatim: studentMessage unchanged", () => {
  const aiMsg = "Shat lav:";
  assert.equal(enforceVerbatimExercise(aiMsg, ""), aiMsg);
  assert.equal(enforceVerbatimExercise(aiMsg, "   "), aiMsg);
  assert.equal(enforceVerbatimExercise(aiMsg, "\t\n"), aiMsg);
});

// TEST 7: exercise already present exactly once → no duplication
test("TEST 7 — exercise present once: no duplication", () => {
  const aiMsg = `Hima katarenqm arr ardjanken:\n\n${VERBATIM}`;
  const result = enforceVerbatimExercise(aiMsg, VERBATIM);
  const count = result.split(VERBATIM).length - 1;
  assert.equal(count, 1, "must not duplicate the exercise");
  assert.equal(result, aiMsg, "must return original unchanged");
});

// TEST 8: Additional exercise isolation
// Additional exercise (relatedNodeId=null) has DIFFERENT verbatim text.
// Caller (chat.ts) passes only classExercises[0] for currentNodeId — never Additional.
test("TEST 8 — Additional exercise isolation: Additional text not substituted", () => {
  const additionalVerbatim = "1. Inch e bnutyune:"; // relatedNodeId=null (Additional)
  const nodeVerbatim = VERBATIM;                    // relatedNodeId=1354 (assigned)
  const aiMsg = "Hima antsnenkm:";
  const result = enforceVerbatimExercise(aiMsg, nodeVerbatim);
  assert.ok(result.includes(nodeVerbatim), "node exercise must appear");
  assert.ok(!result.includes(additionalVerbatim), "Additional exercise must NOT appear");
});

// TEST 9: wrong-node exercise isolation
test("TEST 9 — wrong-node exercise: correct node's verbatim delivered, not wrong-node text", () => {
  const wrongNodeVerbatim = "7. Inch e nyuthe: Bere'k orinak:"; // node 1356 exercise
  const aiMsg = "Hima katarenqm hadjord arr ardjanken:";
  const result = enforceVerbatimExercise(aiMsg, VERBATIM);
  assert.ok(result.includes(VERBATIM), "correct node exercise must appear");
  assert.ok(!result.includes(wrongNodeVerbatim), "wrong-node exercise must NOT appear");
});

// TEST 10: state immutability — function is pure, no side effects
test("TEST 10 — state immutability: function is pure, originals unchanged", () => {
  const originalMsg = "Hima antsnenkm:";
  const originalVerbatim = VERBATIM;
  const verbatimSnapshot = String(VERBATIM);
  const result = enforceVerbatimExercise(originalMsg, originalVerbatim);
  assert.equal(originalMsg, "Hima antsnenkm:", "input string must be unchanged");
  assert.equal(originalVerbatim, verbatimSnapshot, "verbatim string must be unchanged");
  assert.notEqual(result, originalMsg, "result is a new string");
  assert.ok(result.includes(VERBATIM));
});

// ─────────────────────────────────────────────────────────────────────────────
// isExerciseDeliveryTurn
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nisExerciseDeliveryTurn:");

// TEST 11: all conditions hold → true
test("TEST 11 — all conditions met: returns true", () => {
  assert.equal(isExerciseDeliveryTurn(2, "MICRO_CHECK", 1), true);
});

// TEST 12: phase != 2 → false
test("TEST 12 — phase != 2: returns false", () => {
  assert.equal(isExerciseDeliveryTurn(1, "MICRO_CHECK", 1), false, "phase=1");
  assert.equal(isExerciseDeliveryTurn(3, "MICRO_CHECK", 1), false, "phase=3");
  assert.equal(isExerciseDeliveryTurn(0, "MICRO_CHECK", 1), false, "phase=0");
});

// TEST 13: stage != MICRO_CHECK → false
test("TEST 13 — stage != MICRO_CHECK: returns false", () => {
  assert.equal(isExerciseDeliveryTurn(2, "THEORY",   1), false, "THEORY");
  assert.equal(isExerciseDeliveryTurn(2, "EXERCISE", 1), false, "EXERCISE");
  assert.equal(isExerciseDeliveryTurn(2, "VERIFIED", 1), false, "VERIFIED");
  assert.equal(isExerciseDeliveryTurn(2, "",         1), false, "empty");
});

// TEST 14: no class exercises → false
test("TEST 14 — no class exercises: returns false", () => {
  assert.equal(isExerciseDeliveryTurn(2, "MICRO_CHECK", 0), false);
});

// TEST 15: multiple class exercises still returns true
test("TEST 15 — multiple class exercises: still returns true", () => {
  assert.equal(isExerciseDeliveryTurn(2, "MICRO_CHECK", 6), true);
});

// TEST 16: enforcement is teaching_mode-agnostic
// The function does NOT take teaching_mode — enforcement fires regardless of
// what the model returned (TEACH, FEEDBACK, MICRO_CHECK, TRANSITION, etc.)
test("TEST 16 — enforcement is teaching_mode-agnostic: same result for any model output", () => {
  // isExerciseDeliveryTurn fires on state alone, independent of model output
  // Prove by calling with various "would-be" model states — same result
  assert.equal(isExerciseDeliveryTurn(2, "MICRO_CHECK", 1), true,  "fires when model would say TEACH");
  assert.equal(isExerciseDeliveryTurn(2, "MICRO_CHECK", 1), true,  "fires when model would say FEEDBACK");
  assert.equal(isExerciseDeliveryTurn(2, "MICRO_CHECK", 1), true,  "fires when model would say TRANSITION");
  assert.equal(isExerciseDeliveryTurn(2, "MICRO_CHECK", 1), true,  "fires when model would say MICRO_CHECK");
  // And for enforceVerbatimExercise: injects regardless of model output content
  const aiMsgTeach    = "Hayecir bnutyan oryenqnere.";
  const aiMsgFeedback = "Shat lav es pataskhanem:";
  const aiMsgOther    = "Hima antsnenkm hadjord bаzhum:";
  assert.ok(enforceVerbatimExercise(aiMsgTeach,    VERBATIM).includes(VERBATIM));
  assert.ok(enforceVerbatimExercise(aiMsgFeedback, VERBATIM).includes(VERBATIM));
  assert.ok(enforceVerbatimExercise(aiMsgOther,    VERBATIM).includes(VERBATIM));
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
