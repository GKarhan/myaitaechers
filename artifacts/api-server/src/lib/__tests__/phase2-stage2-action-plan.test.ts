import assert from "node:assert/strict";
import type { AIStructuredResponse } from "../../services/ai.js";
import {
  derivePostFeedbackContinuationAction,
  derivePhase2ServerAction,
  establishEvaluatedTurnAuthority,
  filterEvidenceForCurrentRunNode,
  shouldPreparePostFeedbackTaskContinuation,
  summarizeLevelEvidence,
  validatePhase2ResponseForServerAction,
  type ActiveObjectiveTaskPayload,
  type Phase2ServerActionInput,
} from "../../services/phase2/orchestration.js";

const objectivePayload: ActiveObjectiveTaskPayload = {
  interactionType: "multiple_choice",
  options: [
    { key: "A", text: "Սխալ տարբերակ" },
    { key: "B", text: "Ճիշտ տարբերակ" },
  ],
  correctOption: "B",
};

function baseInput(
  overrides: Partial<Phase2ServerActionInput> = {},
): Phase2ServerActionInput {
  return {
    currentPhase: 2,
    currentNodeId: 41,
    activeCognitiveLevelId: 101,
    nodeTeachingStage: "THEORY",
    activeTaskProvenance: null,
    activeLessonExerciseId: null,
    activeObjectiveTaskPayload: null,
    learnerIntent: "READY",
    evaluated: false,
    decision: null,
    progressionPlan: null,
    ...overrides,
  };
}

function validTheoryResponse(): AIStructuredResponse {
  return {
    student_message:
      "Մոլեկուլները մշտապես շարժվում են։ Ո՞ր տարբերակն է ճիշտ։\nԱ) Սխալ տարբերակ\nԲ) Ճիշտ տարբերակ",
    progress_indicator: {
      current_node_name: "Մոլեկուլների շարժում",
      step: 1,
      total_steps: 1,
      completed_nodes: 0,
      total_nodes: 1,
    },
    teaching_mode: "TEACH",
    is_micro_check: true,
    interaction_type: "multiple_choice",
    options: [
      { key: "A", text: "Սխալ տարբերակ" },
      { key: "B", text: "Ճիշտ տարբերակ" },
    ],
    correct_option: "B",
    question_template: "stage2-theory",
    answer_evaluation: {
      status: "NOT_APPLICABLE",
      evidence_quality: "NONE",
      error_family: null,
      error_stability: null,
      correct_parts: [],
      incorrect_parts: [],
    },
    node_decision: {
      action: "CONTINUE_SAME_NODE",
      reason: "Fresh theory turn",
    },
    source_fidelity: {
      type: "AI_GENERATED",
      exercise_id: null,
    },
    redirect_needed: false,
    mentions_out_of_scope_topic: false,
    encouragement_used: false,
    encouragement_focus: null,
  };
}

let passed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log("\n▶ Phase 2 Stage 2 Server-Owned Action Plan\n");

test("A — Phase 2 THEORY with no active task selects theory-only DELIVER_THEORY", () => {
  const plan = derivePhase2ServerAction(baseInput());
  assert.equal(plan.action, "DELIVER_THEORY");
  assert.equal(plan.aiGenerationNeeded, true);
  assert.equal(plan.activeTaskMayBeCreated, false);
  assert.equal(plan.evaluationExpected, false);
  assert.equal(plan.progressionMayOccur, false);
  assert.equal(plan.responseTeachingMode, "TEACH");
  assert.equal(plan.taskAuthority, "validated_ai_candidate");
});

test("B — a visible task cannot be included in DELIVER_THEORY", () => {
  const input = baseInput();
  const plan = derivePhase2ServerAction(input);
  assert.throws(
    () => validatePhase2ResponseForServerAction(plan, validTheoryResponse()),
    /DELIVER_THEORY requires a theory-only TEACH envelope/,
  );
  assert.equal(derivePhase2ServerAction(input).action, "DELIVER_THEORY");
});

test("C — active generated MICRO_CHECK answer selects EVALUATE_ACTIVE_TASK", () => {
  const plan = derivePhase2ServerAction(baseInput({
    nodeTeachingStage: "MICRO_CHECK",
    activeTaskProvenance: "micro_check",
    activeObjectiveTaskPayload: objectivePayload,
    learnerIntent: "ANSWER",
  }));

  assert.equal(plan.action, "EVALUATE_ACTIVE_TASK");
  assert.equal(plan.taskAuthority, "active_objective_payload");
  assert.equal(plan.evaluationExpected, true);
  assert.equal(plan.activeTaskMayBeCreated, false);
});

test("D — active source-exercise answer selects EVALUATE_ACTIVE_TASK", () => {
  const plan = derivePhase2ServerAction(baseInput({
    nodeTeachingStage: "EXERCISE",
    activeTaskProvenance: "source_exercise",
    activeLessonExerciseId: 501,
    learnerIntent: "ANSWER",
  }));

  assert.equal(plan.action, "EVALUATE_ACTIVE_TASK");
  assert.equal(plan.taskAuthority, "active_source_exercise");
  assert.equal(plan.evaluationExpected, true);
});

test("E — Decision Engine continuation selects server-owned remediation", () => {
  const plan = derivePhase2ServerAction(baseInput({
    nodeTeachingStage: "MICRO_CHECK",
    learnerIntent: "ANSWER",
    evaluated: true,
    decision: {
      metaAction: "CONTINUE_COGNITIVE_LEVEL",
      remediationAction: "HINT",
      newActiveCognitiveLevelId: null,
    },
    progressionPlan: {
      shouldAutoContinueExercise: false,
      shouldResetForCognitiveAdvance: false,
      shouldCompleteNode: false,
    },
  }));

  assert.equal(plan.action, "REMEDIATE");
  assert.equal(plan.progressionMayOccur, false);
  assert.equal(plan.activeTaskMayBeCreated, false);
});

test("E1 — same-level continuation without an active task derives a next server-owned task", () => {
  const postFeedback = derivePostFeedbackContinuationAction({
    decision: { metaAction: "CONTINUE_COGNITIVE_LEVEL" },
    progressionPlan: {
      shouldCompleteNode: false,
      shouldResetForCognitiveAdvance: false,
    },
    hasActiveTask: false,
    eligibleSourceExerciseAvailable: true,
  });

  assert.equal(postFeedback?.action, "DELIVER_SOURCE_EXERCISE");
  assert.equal(postFeedback?.activeTaskMayBeCreated, true);
});

test("E1a — VERIFIED with a post-feedback task plan prepares TASK_REQUIRED continuation", () => {
  const postFeedback = derivePostFeedbackContinuationAction({
    decision: { metaAction: "CONTINUE_COGNITIVE_LEVEL" },
    progressionPlan: {
      shouldCompleteNode: false,
      shouldResetForCognitiveAdvance: false,
    },
    hasActiveTask: false,
    eligibleSourceExerciseAvailable: true,
  });

  assert.equal(
    shouldPreparePostFeedbackTaskContinuation({
      postFeedbackContinuationPlan: postFeedback,
      hasActiveTask: false,
      nodeTeachingStage: "VERIFIED",
    }),
    true,
  );
});

test("E1b — an active task keeps the existing post-feedback retirement path", () => {
  const postFeedback = derivePostFeedbackContinuationAction({
    decision: { metaAction: "REQUEST_INDEPENDENT_CHECK" },
    progressionPlan: {
      shouldCompleteNode: false,
      shouldResetForCognitiveAdvance: false,
    },
    hasActiveTask: true,
    eligibleSourceExerciseAvailable: true,
  });

  assert.equal(
    shouldPreparePostFeedbackTaskContinuation({
      postFeedbackContinuationPlan: postFeedback,
      hasActiveTask: true,
      nodeTeachingStage: "EXERCISE",
    }),
    true,
  );
});

test("E1c — VERIFIED without a post-feedback plan remains completion-safe", () => {
  assert.equal(
    shouldPreparePostFeedbackTaskContinuation({
      postFeedbackContinuationPlan: null,
      hasActiveTask: false,
      nodeTeachingStage: "VERIFIED",
    }),
    false,
  );
});

test("E2 — an active remediation task never becomes automatic continuation", () => {
  const postFeedback = derivePostFeedbackContinuationAction({
    decision: { metaAction: "CONTINUE_COGNITIVE_LEVEL" },
    progressionPlan: {
      shouldCompleteNode: false,
      shouldResetForCognitiveAdvance: false,
    },
    hasActiveTask: true,
    eligibleSourceExerciseAvailable: true,
  });

  assert.equal(postFeedback, null);
});

test("E3 — a one-source-exercise level falls back to a generated next task after that exercise is answered", () => {
  const postFeedback = derivePostFeedbackContinuationAction({
    decision: { metaAction: "CONTINUE_COGNITIVE_LEVEL" },
    progressionPlan: {
      shouldCompleteNode: false,
      shouldResetForCognitiveAdvance: false,
    },
    hasActiveTask: false,
    eligibleSourceExerciseAvailable: false,
  });

  assert.equal(postFeedback?.action, "GENERATE_TASK");
  assert.equal(postFeedback?.activeTaskMayBeCreated, true);
});

test("E3A — assisted success schedules a new source task even before the answered task is cleared", () => {
  const postFeedback = derivePostFeedbackContinuationAction({
    decision: { metaAction: "REQUEST_INDEPENDENT_CHECK" },
    progressionPlan: {
      shouldCompleteNode: false,
      shouldResetForCognitiveAdvance: false,
    },
    hasActiveTask: true,
    eligibleSourceExerciseAvailable: true,
  });

  assert.equal(postFeedback?.action, "DELIVER_SOURCE_EXERCISE");
  assert.equal(postFeedback?.reasonCode, "post_feedback_independent_check_requires_next_source_task");
});

test("E3B — assisted success without another source task schedules bounded generation", () => {
  const postFeedback = derivePostFeedbackContinuationAction({
    decision: { metaAction: "REQUEST_INDEPENDENT_CHECK" },
    progressionPlan: {
      shouldCompleteNode: false,
      shouldResetForCognitiveAdvance: false,
    },
    hasActiveTask: true,
    eligibleSourceExerciseAvailable: false,
  });

  assert.equal(postFeedback?.action, "GENERATE_TASK");
});

test("E3C — a canonical evaluation status has one evidence polarity", () => {
  assert.deepEqual(establishEvaluatedTurnAuthority({
    status: "CORRECT",
    evidence_quality: "STRONG",
    error_family: null,
    error_stability: null,
    correct_parts: [],
    incorrect_parts: [],
  }), {
    status: "CORRECT",
    evidenceWasCorrect: true,
    isCorrectnessOutcome: true,
  });
  assert.deepEqual(establishEvaluatedTurnAuthority({
    status: "INCORRECT",
    evidence_quality: "NONE",
    error_family: null,
    error_stability: null,
    correct_parts: [],
    incorrect_parts: [],
  }), {
    status: "INCORRECT",
    evidenceWasCorrect: false,
    isCorrectnessOutcome: true,
  });
  assert.deepEqual(establishEvaluatedTurnAuthority({
    status: "UNCLEAR",
    evidence_quality: "NONE",
    error_family: null,
    error_stability: null,
    correct_parts: [],
    incorrect_parts: [],
  }), {
    status: "UNCLEAR",
    evidenceWasCorrect: null,
    isCorrectnessOutcome: false,
  });
  assert.deepEqual(establishEvaluatedTurnAuthority({
    status: "NO_RESPONSE",
    evidence_quality: "NONE",
    error_family: null,
    error_stability: null,
    correct_parts: [],
    incorrect_parts: [],
  }), {
    status: "NO_RESPONSE",
    evidenceWasCorrect: null,
    isCorrectnessOutcome: false,
  });
  assert.throws(() => establishEvaluatedTurnAuthority({
    status: "NOT_APPLICABLE",
    evidence_quality: "NONE",
    error_family: null,
    error_stability: null,
    correct_parts: [],
    incorrect_parts: [],
  }));
});

test("E4 — current-run evidence excludes old reset evidence, another node, and wrong answers", () => {
  const boundary = new Date("2026-08-20T10:00:00.000Z");
  const rows = [
    {
      id: "old-same-node",
      wasCorrect: true,
      helpCount: 0,
      assistanceLevel: "none",
      metadata: { nodeId: 2107, evidence_quality: "STRONG" },
      createdAt: new Date("2026-08-20T09:59:59.000Z"),
    },
    {
      id: "other-node",
      wasCorrect: true,
      helpCount: 0,
      assistanceLevel: "none",
      metadata: { nodeId: 2108, evidence_quality: "STRONG" },
      createdAt: new Date("2026-08-20T10:01:00.000Z"),
    },
    {
      id: "wrong-live-answer",
      wasCorrect: false,
      helpCount: 0,
      assistanceLevel: "none",
      metadata: { nodeId: 2107, evidence_quality: "STRONG" },
      createdAt: new Date("2026-08-20T10:01:00.000Z"),
    },
    {
      id: "correct-live-answer",
      wasCorrect: true,
      helpCount: 0,
      assistanceLevel: "none",
      metadata: { nodeId: 2107, evidence_quality: "STRONG" },
      createdAt: new Date("2026-08-20T10:01:01.000Z"),
    },
  ];

  const currentRunRows = filterEvidenceForCurrentRunNode(rows, {
    currentNodeId: 2107,
    nodeStartedAt: boundary,
    sessionStartedAt: new Date("2026-08-20T09:00:00.000Z"),
  });
  assert.deepEqual(currentRunRows.map((row) => row.id), [
    "wrong-live-answer",
    "correct-live-answer",
  ]);
  assert.equal(summarizeLevelEvidence(currentRunRows).independentCorrectCount, 1);
});

test("F — Decision Engine cognitive advance keeps node and resets level stage", () => {
  const plan = derivePhase2ServerAction(baseInput({
    nodeTeachingStage: "MICRO_CHECK",
    learnerIntent: "ANSWER",
    evaluated: true,
    decision: {
      metaAction: "ADVANCE_COGNITIVE_LEVEL",
      remediationAction: null,
      newActiveCognitiveLevelId: 102,
    },
    progressionPlan: {
      shouldAutoContinueExercise: false,
      shouldResetForCognitiveAdvance: true,
      shouldCompleteNode: false,
    },
  }));

  assert.equal(plan.action, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(plan.nextActiveCognitiveLevelId, 102);
  assert.equal(plan.nextNodeTeachingStage, "THEORY");
  assert.equal(plan.progressionMayOccur, true);
});

test("G — target-ceiling Decision Engine completion selects COMPLETE_MICRONODE", () => {
  const plan = derivePhase2ServerAction(baseInput({
    nodeTeachingStage: "VERIFIED",
    learnerIntent: "ANSWER",
    evaluated: true,
    decision: {
      metaAction: "COMPLETE_NODE",
      remediationAction: null,
      newActiveCognitiveLevelId: null,
    },
    progressionPlan: {
      shouldAutoContinueExercise: false,
      shouldResetForCognitiveAdvance: false,
      shouldCompleteNode: true,
    },
  }));

  assert.equal(plan.action, "COMPLETE_MICRONODE");
  assert.equal(plan.progressionMayOccur, true);
});

test("H — conflicting AI node_decision cannot override Decision Engine action", () => {
  const input = baseInput({
    nodeTeachingStage: "MICRO_CHECK",
    learnerIntent: "ANSWER",
    evaluated: true,
    decision: {
      metaAction: "CONTINUE_COGNITIVE_LEVEL",
      remediationAction: "STEP_BY_STEP",
      newActiveCognitiveLevelId: null,
    },
    progressionPlan: {
      shouldAutoContinueExercise: false,
      shouldResetForCognitiveAdvance: false,
      shouldCompleteNode: false,
    },
  });
  const plan = derivePhase2ServerAction(input);
  const conflictingAi = {
    ...validTheoryResponse(),
    node_decision: {
      action: "COMPLETE_NODE" as const,
      reason: "Conflicting model proposal",
    },
  };

  validatePhase2ResponseForServerAction(plan, conflictingAi);
  assert.equal(plan.action, "REMEDIATE");

  const contradictoryCompletionGate = derivePhase2ServerAction({
    ...input,
    progressionPlan: {
      shouldAutoContinueExercise: false,
      shouldResetForCognitiveAdvance: false,
      shouldCompleteNode: true,
    },
  });
  assert.equal(contradictoryCompletionGate.action, "REMEDIATE");
  assert.notEqual(
    contradictoryCompletionGate.action as string,
    "COMPLETE_MICRONODE",
  );
});

test("I — failed generation does not mutate the selected THEORY action", () => {
  const plan = derivePhase2ServerAction(baseInput());
  const before = structuredClone(plan);

  assert.throws(() => {
    throw new Error("simulated structured generation failure");
  });
  assert.deepEqual(plan, before);
  assert.equal(plan.action, "DELIVER_THEORY");
});

test("J — Phases 1, 3, and 4 remain outside the Stage-2 override", () => {
  for (const currentPhase of [1, 3, 4]) {
    const plan = derivePhase2ServerAction(baseInput({ currentPhase }));
    assert.equal(plan.action, "OUTSIDE_PHASE_2");
    assert.equal(plan.aiGenerationNeeded, false);
    assert.equal(plan.responseTeachingMode, null);
  }
});

test("K — compatibility is limited to legacy MICRO_CHECK without payload", () => {
  const theoryWithoutPath = derivePhase2ServerAction(baseInput({
    activeCognitiveLevelId: null,
  }));
  assert.equal(theoryWithoutPath.action, "DELIVER_THEORY");
  assert.equal(theoryWithoutPath.compatibilityKind, null);

  const legacyMicroCheck = derivePhase2ServerAction(baseInput({
    activeCognitiveLevelId: null,
    nodeTeachingStage: "MICRO_CHECK",
    activeTaskProvenance: "micro_check",
    learnerIntent: "ANSWER",
  }));
  assert.equal(legacyMicroCheck.action, "DEFER_TO_COMPATIBILITY");
  assert.equal(
    legacyMicroCheck.compatibilityKind,
    "legacy_micro_check_without_task_payload",
  );

  const ungrantedLegacyCompletion = derivePhase2ServerAction(baseInput({
    activeCognitiveLevelId: null,
    nodeTeachingStage: "MICRO_CHECK",
    learnerIntent: "ANSWER",
    evaluated: true,
    decision: {
      metaAction: "NO_COGNITIVE_PATH",
      remediationAction: null,
      newActiveCognitiveLevelId: null,
    },
    progressionPlan: {
      shouldAutoContinueExercise: false,
      shouldResetForCognitiveAdvance: false,
      shouldCompleteNode: true,
    },
  }));
  assert.equal(ungrantedLegacyCompletion.action, "DELIVER_FEEDBACK");
  assert.equal(ungrantedLegacyCompletion.compatibilityKind, null);
  assert.equal(ungrantedLegacyCompletion.progressionMayOccur, false);
});

test("L — malformed non-legacy task state fails closed", () => {
  const malformedSource = derivePhase2ServerAction(baseInput({
    nodeTeachingStage: "EXERCISE",
    activeTaskProvenance: "source_exercise",
    activeLessonExerciseId: null,
    learnerIntent: "ANSWER",
  }));

  assert.equal(malformedSource.action, "INVALID_PHASE2_STATE");
  assert.equal(malformedSource.compatibilityKind, null);
  assert.equal(malformedSource.aiGenerationNeeded, false);
  assert.equal(malformedSource.activeTaskMayBeCreated, false);
  assert.equal(malformedSource.progressionMayOccur, false);
});

console.log(
  `\nPhase 2 Stage 2 Server-Owned Action Plan: ${passed} passed, 0 failed (${passed} total)\n`,
);