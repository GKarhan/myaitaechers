/**
 * Phase 2 Orchestration Refactor — Stage 1 extraction contracts.
 *
 * These tests exercise the new pure boundary directly. DB reads/writes,
 * provider calls, source activation, evidence writes, and HTTP responses remain
 * owned by chat.ts and are covered by the Stage 0 real-route baseline.
 *
 * Run: pnpm --filter @workspace/api-server test:phase2-stage1
 */
import assert from "node:assert/strict";
import {
  aiStructuredResponseSchema,
  canonicalizePhase2TheoryEnvelope,
  validateServerOwnedPhase2TheoryEnvelope,
  validateStructuredResponse,
  validateTeachingCycle,
  type AIStructuredResponse,
} from "../../services/ai.js";
import {
  coordinatePedagogicalDecision,
  deriveCognitiveAdvanceTaskReset,
  deriveGeneratedMicroCheckActivation,
  deriveProgressionPlan,
  deriveTurnProgress,
  resolveAuthoritativeEvaluation,
  summarizeLevelEvidence,
  type Phase2DecisionContext,
} from "../../services/phase2/orchestration.js";
import {
  decideNextPedagogicalAction,
  type CognitiveLevelRow,
} from "../../services/pedagogicalDecisionEngine.js";
import {
  enforceActiveSourceExercise,
  resolveEligibleSourceExercise,
  shouldDeliverStandaloneSourceExercise,
} from "../exercise-delivery.js";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function baseResponse(
  overrides: Partial<AIStructuredResponse> = {},
): AIStructuredResponse {
  return aiStructuredResponseSchema.parse({
    student_message: "Ո՞րն է ճիշտ տարբերակը։\nԱ) Առաջին\nԲ) Երկրորդ",
    progress_indicator: {
      current_node_name: "Մոլեկուլներ",
      step: 1,
      total_steps: 3,
      completed_nodes: 0,
      total_nodes: 3,
    },
    teaching_mode: "TEACH",
    is_micro_check: true,
    interaction_type: "multiple_choice",
    options: [
      { key: "A", text: "Առաջին" },
      { key: "B", text: "Երկրորդ" },
    ],
    correct_option: "B",
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
      reason: "Stage 1 fixture",
    },
    source_fidelity: {
      type: "AI_GENERATED",
      exercise_id: null,
    },
    redirect_needed: false,
    mentions_out_of_scope_topic: false,
    question_template: "ընտրել ճիշտ տարբերակը",
    encouragement_used: false,
    encouragement_focus: null,
    ...overrides,
  });
}

function lessonContext(stage: string): string {
  return [
    "CURRENT_NODE: «Մոլեկուլներ» | node_id=2107",
    "ALLOWED_NODES:",
    "  - «Մոլեկուլներ» (id=2107)",
    `STUDENT_STATE: phase=2 | node_stage=${stage} | node_attempts=0 | nodes_done=0/3`,
    "CLASS_EXERCISES: (none)",
  ].join("\n");
}

function makeLevel(
  overrides: Partial<CognitiveLevelRow> = {},
): CognitiveLevelRow {
  return {
    id: 301,
    cognitiveLevel: "remember",
    sequence: 1,
    isTargetCeiling: false,
    isApplicable: true,
    minimumIndependentEvidence: 1,
    preferredInteractionTypes: ["micro_check"],
    performanceObjective: null,
    successCriterion: null,
    ...overrides,
  };
}

const currentLevel = makeLevel();
const ceilingLevel = makeLevel({
  id: 302,
  cognitiveLevel: "understand",
  sequence: 2,
  isTargetCeiling: true,
});
const cognitivePath = [currentLevel, ceilingLevel];

function decisionContext(
  overrides: Partial<Phase2DecisionContext> = {},
): Phase2DecisionContext {
  return {
    lessonNodeId: 2107,
    lessonId: 579,
    sessionId: 8801,
    userId: 7001,
    nodeTeachingStage: "MICRO_CHECK",
    remediationStep: 0,
    activeCognitiveLevelId: currentLevel.id,
    activeCognitiveLevelRow: currentLevel,
    cognitivePath,
    evaluation: {
      status: "CORRECT",
      evidence_quality: "MODERATE",
      error_family: null,
      error_stability: null,
      correct_parts: ["objective answer matched"],
      incorrect_parts: [],
    },
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    activeAttemptSequence: 1,
    activeTaskProvenance: "micro_check",
    levelEvidenceSummary: {
      independentCorrectCount: 0,
      totalCorrectCount: 0,
      bestQuality: null,
    },
    nextNodeHasCriticalDependencyOnCurrentNode: false,
    requiredSessionMinutes: null,
    activeLearningSeconds: 0,
    optionalContinuation: false,
    estimatedNodeMinutes: 5,
    ...overrides,
  };
}

const eligibleExercises = [
  {
    id: 940,
    exerciseId: "EX-579-1",
    exerciseTextVerbatim: "Առաջադրանք 1",
  },
  {
    id: 941,
    exerciseId: "EX-579-2",
    exerciseTextVerbatim: "Առաջադրանք 2",
  },
];

test("A — validated THEORY response derives the frozen objective task state", () => {
  const canonical = canonicalizePhase2TheoryEnvelope(baseResponse(), {
    currentPhase: 2,
    currentNodeId: 2107,
    nodeTeachingStage: "THEORY",
  });
  validateServerOwnedPhase2TheoryEnvelope(canonical, {
    currentPhase: 2,
    currentNodeId: 2107,
    nodeTeachingStage: "THEORY",
  });
  validateTeachingCycle(canonical, [], lessonContext("THEORY"));

  const activation = deriveGeneratedMicroCheckActivation(canonical);
  assert.ok(activation);
  assert.equal(activation.nodeTeachingStage, "MICRO_CHECK");
  assert.equal(activation.activeTaskProvenance, "micro_check");
  assert.equal(activation.activeObjectiveTaskPayload?.correctOption, "B");
  assert.equal(activation.activeAttemptSequence, 1);
});

test("B — structured THEORY failure yields no task-state decision", () => {
  const invalid = canonicalizePhase2TheoryEnvelope(
    baseResponse({
      student_message: "Մեկ։ Երկու։ Երեք։ Չորս։ Հինգ։ Վեց։ Յոթ։",
    }),
    {
      currentPhase: 2,
      currentNodeId: 2107,
      nodeTeachingStage: "THEORY",
    },
  );
  let activation: ReturnType<typeof deriveGeneratedMicroCheckActivation> = null;
  assert.throws(() => {
    validateStructuredResponse(invalid);
    activation = deriveGeneratedMicroCheckActivation(invalid);
  }, /student_message has 7 sentences \(max 5\)/u);
  assert.equal(activation, null);
});

test("C — objective MICRO_CHECK activation preserves the authoritative payload", () => {
  const activation = deriveGeneratedMicroCheckActivation(
    baseResponse({
      interaction_type: "true_false",
      options: null,
      correct_option: "TRUE",
      student_message: "Ճի՞շտ է, որ մոլեկուլները շարժվում են։",
    }),
  );
  assert.deepEqual(activation?.activeObjectiveTaskPayload, {
    interactionType: "true_false",
    options: null,
    correctOption: "TRUE",
  });
  assert.equal(activation?.activeLessonExerciseId, null);
});

test("D — objective payload correctness overrides conflicting model evaluation", () => {
  const candidate = baseResponse({
    teaching_mode: "FEEDBACK",
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
    answer_evaluation: {
      status: "INCORRECT",
      evidence_quality: "NONE",
      error_family: "CONCEPTUAL",
      error_stability: "FIRST_OCCURRENCE",
      correct_parts: [],
      incorrect_parts: ["model candidate"],
    },
  });
  const result = resolveAuthoritativeEvaluation({
    response: candidate,
    learnerIntent: "ANSWER",
    hasActiveTask: true,
    activeTaskProvenance: "micro_check",
    activeLessonExerciseId: null,
    activeObjectiveTaskPayload: {
      interactionType: "multiple_choice",
      options: [
        { key: "A", text: "Առաջին" },
        { key: "B", text: "Երկրորդ" },
      ],
      correctOption: "B",
    },
    activeSourceExercise: null,
    studentAnswer: "բ",
  });
  assert.equal(result.authority, "objective_task");
  assert.equal(result.normalizedObjectiveAnswer, "B");
  assert.equal(result.response.answer_evaluation.status, "CORRECT");
  assert.equal(result.response.answer_evaluation.evidence_quality, "MODERATE");
  assert.equal(result.wasCorrect, true);
});

test("E — exact eligible source request resolves the persisted activation identity", () => {
  const selection = resolveEligibleSourceExercise(
    eligibleExercises,
    "EX-579-2",
  );
  assert.equal(selection.resolution, "requested_eligible");
  assert.equal(selection.selected?.id, 941);
  assert.equal(selection.selected?.exerciseId, "EX-579-2");
  assert.notEqual(selection.selected?.id, eligibleExercises[0].id);
});

test("F — exact active source row deterministically owns typed correctness", () => {
  const candidate = baseResponse({
    teaching_mode: "FEEDBACK",
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
    answer_evaluation: {
      status: "INCORRECT",
      evidence_quality: "NONE",
      error_family: "CONCEPTUAL",
      error_stability: "FIRST_OCCURRENCE",
      correct_parts: [],
      incorrect_parts: ["model candidate"],
    },
  });
  const result = resolveAuthoritativeEvaluation({
    response: candidate,
    learnerIntent: "ANSWER",
    hasActiveTask: true,
    activeTaskProvenance: "source_exercise",
    activeLessonExerciseId: 941,
    activeObjectiveTaskPayload: null,
    activeSourceExercise: {
      id: 941,
      exerciseId: "EX-579-2",
      interactionType: "true_false",
      correctAnswer: "TRUE",
    },
    studentAnswer: "ճիշտ",
  });
  assert.equal(result.authority, "source_exercise");
  assert.equal(result.sourceEvaluation?.lessonExerciseId, 941);
  assert.equal(result.sourceEvaluation?.exerciseId, "EX-579-2");
  assert.equal(result.response.answer_evaluation.status, "CORRECT");
  assert.equal(result.response.answer_evaluation.evidence_quality, "STRONG");
  assert.equal(result.wasCorrect, true);
});

test("G — feedback-only continuation cannot derive a phantom task", () => {
  const feedback = baseResponse({
    teaching_mode: "FEEDBACK",
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
    answer_evaluation: {
      status: "PARTIALLY_CORRECT",
      evidence_quality: "WEAK",
      error_family: "CONCEPTUAL",
      error_stability: "FIRST_OCCURRENCE",
      correct_parts: ["core idea"],
      incorrect_parts: ["missing explanation"],
    },
  });
  assert.equal(deriveGeneratedMicroCheckActivation(feedback), null);
  const plan = coordinatePedagogicalDecision(
    decisionContext({
      evaluation: feedback.answer_evaluation,
      activeCognitiveLevelRow: makeLevel({
        minimumIndependentEvidence: 2,
      }),
      cognitivePath: [
        makeLevel({ minimumIndependentEvidence: 2 }),
        ceilingLevel,
      ],
    }),
  );
  assert.equal(plan.decision.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.equal(plan.decision.preserveActiveTask, true);
});

test("H — cognitive advance derives next level plus THEORY/no-stale-task reset", () => {
  const evidenceSummary = summarizeLevelEvidence([]);
  const decisionPlan = coordinatePedagogicalDecision(
    decisionContext({ levelEvidenceSummary: evidenceSummary }),
  );
  assert.equal(decisionPlan.decision.metaAction, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(decisionPlan.decision.newActiveCognitiveLevelId, 302);

  const turn = deriveTurnProgress({
    evaluation: decisionContext().evaluation,
    currentStage: "MICRO_CHECK",
    classExerciseCount: 1,
    masteryEvidenceCount: 0,
    consecutiveCorrect: 0,
    consecutiveIncorrect: 0,
    attemptCount: 0,
  });
  const progression = deriveProgressionPlan({
    turn,
    classExerciseCount: 1,
    cognitivePath,
    activeCognitiveLevelRow: currentLevel,
    decision: decisionPlan.decision,
  });
  assert.equal(progression.shouldResetForCognitiveAdvance, true);
  assert.equal(progression.shouldCompleteNode, false);
  assert.equal(progression.shouldAutoContinueExercise, false);
  assert.deepEqual(deriveCognitiveAdvanceTaskReset(), {
    nodeTeachingStage: "THEORY",
    activeLessonExerciseId: null,
    activeTaskProvenance: null,
    activeObjectiveTaskPayload: null,
    activeAttemptSequence: 0,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  });
});

test("I — authoritative source text remains a single delivery", () => {
  const selection = resolveEligibleSourceExercise(
    eligibleExercises,
    "EX-579-2",
  );
  const active = selection.selected!;
  const delivered = enforceActiveSourceExercise(
    `Շարունակենք։\n${eligibleExercises[0].exerciseTextVerbatim}`,
    active.exerciseTextVerbatim,
    [eligibleExercises[0].exerciseTextVerbatim],
  );
  assert.equal(
    delivered.split(active.exerciseTextVerbatim).length - 1,
    1,
  );
  assert.ok(!delivered.includes(eligibleExercises[0].exerciseTextVerbatim));
  assert.equal(
    shouldDeliverStandaloneSourceExercise(true, active.id, true),
    false,
  );
});

test("J — extracted Decision Engine preparation preserves remediation exactly", () => {
  const context = decisionContext({
    remediationStep: 0,
    evaluation: {
      status: "INCORRECT",
      evidence_quality: "NONE",
      error_family: "CONCEPTUAL",
      error_stability: "FIRST_OCCURRENCE",
      correct_parts: [],
      incorrect_parts: ["concept"],
    },
  });
  const coordinated = coordinatePedagogicalDecision(context);
  const direct = decideNextPedagogicalAction(coordinated.input);
  assert.deepEqual(coordinated.decision, direct);
  assert.equal(coordinated.decision.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.equal(coordinated.decision.remediationAction, "EXTRA_EXAMPLE");
  assert.equal(coordinated.decision.newRemediationStep, 1);
});

let passed = 0;
let failed = 0;
const failures: string[] = [];

console.log("\n▶ Phase 2 Stage 1 Extraction Contracts\n");
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}`);
    console.error(
      `    ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

console.log(
  `\nPhase 2 Stage 1 Extraction Contracts: ${passed} passed, ${failed} failed (${tests.length} total)`,
);
if (failures.length > 0) {
  console.error("Failures:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}