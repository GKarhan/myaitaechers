/**
 * C7.4 bounded remediation policy.
 *
 * Provider-free regression matrix for server-owned remediation, evidence
 * polarity, help escalation, and target-safe teaching strategy.
 */
import assert from "node:assert/strict";
import {
  CANONICAL_ERROR_FAMILIES,
  MAX_HELP_COUNT,
  MAX_REMEDIATION_STEPS,
  getNextHelpEscalation,
  mapErrorFamilyToAction,
  normalizeErrorFamily,
  decideNextPedagogicalAction,
  type CognitiveLevelRow,
  type PedagogicalDecisionInput,
} from "../../services/pedagogicalDecisionEngine.js";
import {
  deriveTurnProgress,
  establishEvaluatedTurnAuthority,
} from "../../services/phase2/orchestration.js";

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

const remember: CognitiveLevelRow = {
  id: 101,
  cognitiveLevel: "remember",
  sequence: 1,
  isApplicable: true,
  isTargetCeiling: false,
  performanceObjective: null,
  successCriterion: null,
  preferredInteractionTypes: ["micro_check"],
  minimumIndependentEvidence: 1,
};
const understand: CognitiveLevelRow = {
  ...remember,
  id: 102,
  cognitiveLevel: "understand",
  sequence: 2,
  isTargetCeiling: true,
};

function input(overrides: Partial<PedagogicalDecisionInput> = {}): PedagogicalDecisionInput {
  return {
    lessonNodeId: 31,
    lessonId: 7,
    sessionId: 9,
    userId: 12,
    nodeTeachingStage: "MICRO_CHECK",
    remediationStep: 0,
    activeCognitiveLevelId: remember.id,
    activeCognitiveLevelRow: remember,
    cognitivePath: [remember, understand],
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
    errorFamily: "CONCEPTUAL",
    errorStability: "FIRST_OCCURRENCE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    activeAttemptSequence: 1,
    activeTaskProvenance: "micro_check",
    levelEvidenceSummary: {
      independentCorrectCount: 0,
      totalCorrectCount: 0,
      bestQuality: null,
    },
    nextNodeId: 44,
    nextNodeHasCriticalDependencyOnCurrentNode: false,
    sessionBudgetExhausted: false,
    localNodeBudgetExhausted: false,
    ...overrides,
  };
}

function evaluation(status: "CORRECT" | "INCORRECT" | "PARTIALLY_CORRECT" | "UNCLEAR" | "NO_RESPONSE") {
  return {
    status,
    evidence_quality: status === "CORRECT" ? "MODERATE" : "NONE",
    error_family: status === "CORRECT" ? null : "INCOMPLETE_COMMUNICATION",
    error_stability: status === "CORRECT" ? null : "FIRST_OCCURRENCE",
    correct_parts: status === "PARTIALLY_CORRECT" ? ["one valid component"] : [],
    incorrect_parts: status === "PARTIALLY_CORRECT" ? ["one missing component"] : [],
  } as const;
}

test("01 canonical taxonomy has exactly the approved ten families", () => {
  assert.equal(CANONICAL_ERROR_FAMILIES.length, 10);
  assert.equal(new Set(CANONICAL_ERROR_FAMILIES).size, 10);
});

test("02 aliases normalize only to a canonical family", () => {
  assert.equal(normalizeErrorFamily("reading-language"), "READING_LANGUAGE");
  assert.equal(normalizeErrorFamily("calculation"), "CALCULATION_EXECUTION");
});

test("03 unknown family stays unknown for safe generic handling", () => {
  assert.equal(normalizeErrorFamily("invented taxonomy"), null);
  assert.equal(mapErrorFamilyToAction("invented taxonomy", 0), "EXTRA_EXAMPLE");
});

test("04 first remediation action is deterministic for every family", () => {
  const expected = {
    CONCEPTUAL: "EXTRA_EXAMPLE",
    PREREQUISITE: "RETURN_TO_PREREQUISITE",
    PROCEDURAL: "STEP_BY_STEP",
    CALCULATION_EXECUTION: "VERIFY_SELECTION",
    READING_LANGUAGE: "SIMPLIFY_LANGUAGE",
    ATTENTION_RESPONSE: "VERIFY_SELECTION",
    GUESSING_CONFIDENCE: "REQUIRE_REASONING",
    INCOMPLETE_COMMUNICATION: "GUIDED_QUESTION",
    TRANSFER_BLOOM: "CHANGE_REPRESENTATION",
    COGNITIVE_LOAD_PACE: "RAISE_DIFFICULTY",
  } as const;
  for (const family of CANONICAL_ERROR_FAMILIES) {
    assert.equal(mapErrorFamilyToAction(family, 0), expected[family]);
  }
});

test("05 conceptual remediation changes strategy before its hard stop", () => {
  const actions = [0, 1, 2, 3, 4].map((step) => mapErrorFamilyToAction("CONCEPTUAL", step));
  assert.equal(actions[2], "CONTRAST_EXAMPLE");
  assert.equal(actions[3], "GUIDED_QUESTION");
  assert.equal(actions[4], "LOWER_DIFFICULTY");
  assert.ok(new Set(actions).size >= 4);
});

test("06 remediation stays bounded through MAX_REMEDIATION_STEPS", () => {
  const lastAllowed = decideNextPedagogicalAction(input({ remediationStep: MAX_REMEDIATION_STEPS - 1 }));
  const exhausted = decideNextPedagogicalAction(input({ remediationStep: MAX_REMEDIATION_STEPS }));
  assert.equal(lastAllowed.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.equal(lastAllowed.newRemediationStep, MAX_REMEDIATION_STEPS);
  assert.equal(exhausted.metaAction, "MARK_TARGET_NOT_REACHED");
  assert.equal(exhausted.revisitReason, "REMEDIATION_EXHAUSTED");
});

test("07 remediation does not change the canonical cognitive target", () => {
  const decision = decideNextPedagogicalAction(input({ errorFamily: "COGNITIVE_LOAD_PACE", remediationStep: 1 }));
  assert.equal(decision.remediationAction, "LOWER_DIFFICULTY");
  assert.equal(decision.newActiveCognitiveLevelId, null);
  assert.equal(decision.currentCognitiveLevel, "remember");
  assert.equal(decision.targetCognitiveLevel, "understand");
});

test("08 raising difficulty also stays within the canonical target", () => {
  const decision = decideNextPedagogicalAction(input({ errorFamily: "COGNITIVE_LOAD_PACE" }));
  assert.equal(decision.remediationAction, "RAISE_DIFFICULTY");
  assert.equal(decision.newActiveCognitiveLevelId, null);
});

test("09 prerequisite detection is a C7 signal, not direct routing", () => {
  const decision = decideNextPedagogicalAction(input({ errorFamily: "PREREQUISITE" }));
  assert.equal(decision.remediationAction, "RETURN_TO_PREREQUISITE");
  assert.equal(decision.newActiveCognitiveLevelId, null);
  assert.equal(decision.mayCompleteMicroNode, false);
});

test("10 partial responses receive focused remediation", () => {
  const decision = decideNextPedagogicalAction(input({
    answerStatus: "PARTIALLY_CORRECT",
    evidenceQuality: "MODERATE",
    errorFamily: "INCOMPLETE_COMMUNICATION",
    activeHelpCount: 3,
    activeAssistanceLevel: "guided",
  }));
  assert.equal(decision.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.equal(decision.remediationAction, "GUIDED_QUESTION");
});

test("11 partial response has no boolean mastery polarity", () => {
  assert.equal(establishEvaluatedTurnAuthority(evaluation("PARTIALLY_CORRECT")).evidenceWasCorrect, null);
});

test("12 unclear response has no boolean mastery polarity", () => {
  assert.equal(establishEvaluatedTurnAuthority(evaluation("UNCLEAR")).evidenceWasCorrect, null);
});

test("13 no response has no boolean mastery polarity", () => {
  assert.equal(establishEvaluatedTurnAuthority(evaluation("NO_RESPONSE")).evidenceWasCorrect, null);
});

test("14 incorrect response remains distinct negative evidence", () => {
  assert.equal(establishEvaluatedTurnAuthority(evaluation("INCORRECT")).evidenceWasCorrect, false);
});

test("15 correct response remains distinct positive evidence", () => {
  assert.equal(establishEvaluatedTurnAuthority(evaluation("CORRECT")).evidenceWasCorrect, true);
});

test("16 partial response does not increase mastery or correct streak", () => {
  const progress = deriveTurnProgress({
    evaluation: evaluation("PARTIALLY_CORRECT"),
    currentStage: "MICRO_CHECK",
    classExerciseCount: 0,
    masteryEvidenceCount: 4,
    consecutiveCorrect: 2,
    consecutiveIncorrect: 1,
    attemptCount: 3,
  });
  assert.equal(progress.newMasteryCount, 4);
  assert.equal(progress.newConsecutiveCorrect, 2);
  assert.equal(progress.newConsecutiveIncorrect, 1);
});

test("17 unclear response does not become an incorrect streak", () => {
  const progress = deriveTurnProgress({
    evaluation: evaluation("UNCLEAR"),
    currentStage: "MICRO_CHECK",
    classExerciseCount: 0,
    masteryEvidenceCount: 1,
    consecutiveCorrect: 1,
    consecutiveIncorrect: 2,
    attemptCount: 3,
  });
  assert.equal(progress.newConsecutiveIncorrect, 2);
  assert.equal(progress.newMasteryCount, 1);
});

test("18 help level one is light assistance", () => {
  assert.deepEqual(getNextHelpEscalation(0, false), {
    ok: true, helpLevel: 1, assistanceLevel: "light",
  });
});

test("19 help level two is moderate assistance", () => {
  assert.deepEqual(getNextHelpEscalation(1, false), {
    ok: true, helpLevel: 2, assistanceLevel: "moderate",
  });
});

test("20 help level three is guided assistance", () => {
  assert.deepEqual(getNextHelpEscalation(2, false), {
    ok: true, helpLevel: 3, assistanceLevel: "guided",
  });
});

test("21 answer reveal requires explicit confirmation", () => {
  assert.deepEqual(getNextHelpEscalation(3, false), {
    ok: false, reason: "REVEAL_REQUIRES_CONFIRMATION",
  });
});

test("22 confirmed answer reveal is the fourth help level", () => {
  assert.deepEqual(getNextHelpEscalation(3, true), {
    ok: true, helpLevel: 4, assistanceLevel: "revealed",
  });
});

test("23 a completed help scale cannot overrun", () => {
  assert.equal(MAX_HELP_COUNT, 4);
  assert.deepEqual(getNextHelpEscalation(MAX_HELP_COUNT, true), {
    ok: false, reason: "HELP_BUDGET_EXHAUSTED",
  });
});

test("24 assisted correct success requires a new independent check", () => {
  const decision = decideNextPedagogicalAction(input({
    answerStatus: "CORRECT",
    evidenceQuality: "STRONG",
    activeHelpCount: 2,
    activeAssistanceLevel: "moderate",
  }));
  assert.equal(decision.metaAction, "REQUEST_INDEPENDENT_CHECK");
  assert.equal(decision.levelConfirmed, false);
  assert.equal(decision.preserveActiveTask, false);
});

test("25 assisted success never grants mastery directly", () => {
  const decision = decideNextPedagogicalAction(input({
    answerStatus: "CORRECT",
    evidenceQuality: "CONCLUSIVE",
    activeHelpCount: 4,
    activeAssistanceLevel: "revealed",
  }));
  assert.equal(decision.mayWriteMastery, false);
  assert.equal(decision.mayCompleteMicroNode, false);
});

test("26 independent correct evidence may advance only within the accepted path", () => {
  const decision = decideNextPedagogicalAction(input({
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  assert.equal(decision.metaAction, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(decision.newActiveCognitiveLevelId, understand.id);
});

test("27 session exhaustion preserves remediation state instead of creating failure", () => {
  const decision = decideNextPedagogicalAction(input({
    remediationStep: 2,
    sessionBudgetExhausted: true,
  }));
  assert.equal(decision.metaAction, "END_REQUIRED_SESSION");
  assert.equal(decision.newRemediationStep, 2);
  assert.equal(decision.revisitRequired, false);
});

test("28 critical dependency exhaustion fails closed and never completes", () => {
  const decision = decideNextPedagogicalAction(input({
    remediationStep: MAX_REMEDIATION_STEPS,
    nextNodeHasCriticalDependencyOnCurrentNode: true,
  }));
  assert.equal(decision.metaAction, "REVISIT_LATER");
  assert.equal(decision.mayCompleteMicroNode, false);
  assert.equal(decision.revisitRequired, true);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}
console.log(`\nC7.4 bounded remediation: ${passed}/${tests.length} checks passed.`);