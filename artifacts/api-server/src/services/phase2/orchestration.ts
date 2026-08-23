import {
  evaluateDeterministicSourceExerciseAnswer,
  type DeterministicSourceExerciseEvaluation,
} from "../../lib/deterministic-source-exercise-evaluation.js";
import type { AIStructuredResponse } from "../ai.js";
import { randomUUID } from "node:crypto";
import type { IntentClass } from "../intentRouter.js";
import {
  computeLocalNodeBudget,
  computeSessionBudgetExhausted,
  decideNextPedagogicalAction,
  type CognitiveLevelRow,
  type LevelEvidenceSummary,
  type PedagogicalDecision,
  type PedagogicalDecisionInput,
} from "../pedagogicalDecisionEngine.js";

export type ActiveObjectiveTaskPayload = {
  interactionType: "multiple_choice" | "true_false";
  options: Array<{ key: string; text: string }> | null;
  correctOption: string;
};

export type Phase2ServerAction =
  | "OUTSIDE_PHASE_2"
  | "DELIVER_THEORY"
  | "GENERATE_TASK"
  | "EVALUATE_ACTIVE_TASK"
  | "PRESERVE_ACTIVE_TASK"
  | "DELIVER_FEEDBACK"
  | "REMEDIATE"
  | "DELIVER_SOURCE_EXERCISE"
  | "ADVANCE_COGNITIVE_LEVEL"
  | "COMPLETE_MICRONODE"
  | "DEFER_TO_COMPATIBILITY"
  | "INVALID_PHASE2_STATE";

export type Phase2TaskAuthority =
  | "none"
  | "validated_ai_candidate"
  | "active_objective_payload"
  | "active_source_exercise"
  | "active_constructed_response"
  | "compatibility";

export type Phase2CompatibilityKind =
  | "legacy_micro_check_without_task_payload";

export type Phase2ServerActionPlan = {
  action: Phase2ServerAction;
  reasonCode: string;
  aiGenerationNeeded: boolean;
  activeTaskMayBeCreated: boolean;
  evaluationExpected: boolean;
  progressionMayOccur: boolean;
  responseTeachingMode: "TEACH" | "MICRO_CHECK" | "FEEDBACK" | "TRANSITION" | null;
  taskAuthority: Phase2TaskAuthority;
  compatibilityKind: Phase2CompatibilityKind | null;
  nextActiveCognitiveLevelId: number | null;
  nextNodeTeachingStage: "THEORY" | null;
};

export type Phase2ServerActionInput = {
  currentPhase: number | null;
  currentNodeId: number | null;
  activeCognitiveLevelId: number | null;
  nodeTeachingStage: string | null;
  activeTaskProvenance: string | null;
  activeLessonExerciseId: number | null;
  activeObjectiveTaskPayload: ActiveObjectiveTaskPayload | null;
  learnerIntent: IntentClass;
  evaluated: boolean;
  decision: Pick<
    PedagogicalDecision,
    "metaAction" | "remediationAction" | "newActiveCognitiveLevelId"
  > | null;
  progressionPlan: Pick<
    Phase2ProgressionPlan,
    | "shouldAutoContinueExercise"
    | "shouldResetForCognitiveAdvance"
    | "shouldCompleteNode"
  > | null;
  eligibleSourceExerciseAvailable?: boolean;
};

function makeActionPlan(
  action: Phase2ServerAction,
  reasonCode: string,
  overrides: Partial<Omit<Phase2ServerActionPlan, "action" | "reasonCode">> = {},
): Phase2ServerActionPlan {
  return {
    action,
    reasonCode,
    aiGenerationNeeded: false,
    activeTaskMayBeCreated: false,
    evaluationExpected: false,
    progressionMayOccur: false,
    responseTeachingMode: null,
    taskAuthority: "none",
    compatibilityKind: null,
    nextActiveCognitiveLevelId: null,
    nextNodeTeachingStage: null,
    ...overrides,
  };
}

/**
 * Selects the current Phase-2 workflow action from authoritative server state.
 *
 * This is the Stage-2 ownership boundary: AI workflow metadata is deliberately
 * absent from the input. The caller still owns generation, persistence, and all
 * side effects.
 */
export function derivePhase2ServerAction(
  input: Phase2ServerActionInput,
): Phase2ServerActionPlan {
  if (input.currentPhase !== 2 || input.currentNodeId === null) {
    return makeActionPlan(
      "OUTSIDE_PHASE_2",
      "phase_or_current_node_outside_phase2_action_scope",
    );
  }

  if (input.evaluated && input.decision && input.progressionPlan) {
    if (
      input.progressionPlan.shouldResetForCognitiveAdvance &&
      input.decision.metaAction === "ADVANCE_COGNITIVE_LEVEL"
    ) {
      return makeActionPlan(
        "ADVANCE_COGNITIVE_LEVEL",
        "decision_engine_selected_cognitive_advance",
        {
          progressionMayOccur: true,
          nextActiveCognitiveLevelId:
            input.decision.newActiveCognitiveLevelId,
          nextNodeTeachingStage: "THEORY",
        },
      );
    }

    if (
      input.progressionPlan.shouldCompleteNode &&
      input.decision.metaAction === "COMPLETE_NODE"
    ) {
      return makeActionPlan(
        "COMPLETE_MICRONODE",
        "decision_engine_allowed_micronode_completion",
        { progressionMayOccur: true },
      );
    }

    if (input.progressionPlan.shouldAutoContinueExercise) {
      return makeActionPlan(
        "DELIVER_SOURCE_EXERCISE",
        "server_progression_plan_selected_source_exercise_delivery",
        {
          activeTaskMayBeCreated: true,
          taskAuthority: "compatibility",
        },
      );
    }

    if (
      input.decision.metaAction === "CONTINUE_COGNITIVE_LEVEL" &&
      input.decision.remediationAction !== null
    ) {
      return makeActionPlan(
        "REMEDIATE",
        "decision_engine_selected_same_level_remediation",
      );
    }

    return makeActionPlan(
      "DELIVER_FEEDBACK",
      "evaluated_turn_uses_decision_engine_without_progression",
    );
  }

  // C7.2 persists an evaluated answer as a recoverable FEEDBACK boundary.  A
  // refresh or bounded-provider failure must resume feedback first rather than
  // manufacture a replacement question or task.
  if (
    input.nodeTeachingStage === "FEEDBACK" &&
    input.activeTaskProvenance === null &&
    input.activeLessonExerciseId === null &&
    input.activeObjectiveTaskPayload === null
  ) {
    return makeActionPlan(
      "DELIVER_FEEDBACK",
      "persisted_feedback_boundary_requires_feedback_delivery",
      { responseTeachingMode: "FEEDBACK" },
    );
  }

  const hasGeneratedObjectiveTask =
    input.activeTaskProvenance === "micro_check" &&
    input.activeObjectiveTaskPayload !== null;
  const hasSourceExerciseTask =
    input.activeTaskProvenance === "source_exercise" &&
    input.activeLessonExerciseId !== null;
  const hasConstructedResponseTask =
    input.activeTaskProvenance === "constructed_response" &&
    input.activeObjectiveTaskPayload === null;
  const hasAuthoritativeActiveTask =
    hasGeneratedObjectiveTask || hasSourceExerciseTask || hasConstructedResponseTask;

  if (hasAuthoritativeActiveTask && input.learnerIntent === "ANSWER") {
    return makeActionPlan(
      "EVALUATE_ACTIVE_TASK",
      hasGeneratedObjectiveTask
        ? "learner_answered_active_objective_task"
        : "learner_answered_active_source_exercise",
      {
        aiGenerationNeeded: true,
        evaluationExpected: true,
        progressionMayOccur: true,
        taskAuthority: hasGeneratedObjectiveTask
          ? "active_objective_payload"
          : hasSourceExerciseTask
            ? "active_source_exercise"
            : "active_constructed_response",
      },
    );
  }

  if (hasAuthoritativeActiveTask) {
    return makeActionPlan(
      "PRESERVE_ACTIVE_TASK",
      "non_answer_turn_keeps_authoritative_task_open",
      {
        aiGenerationNeeded: true,
        taskAuthority: hasGeneratedObjectiveTask
          ? "active_objective_payload"
          : hasSourceExerciseTask
            ? "active_source_exercise"
            : "active_constructed_response",
      },
    );
  }

  if (
    input.nodeTeachingStage === "THEORY" &&
    input.activeTaskProvenance === null &&
    input.activeLessonExerciseId === null &&
    input.activeObjectiveTaskPayload === null
  ) {
    return makeActionPlan(
      "DELIVER_THEORY",
      "phase2_theory_has_current_node_and_no_active_task",
      {
        aiGenerationNeeded: true,
        activeTaskMayBeCreated: false,
        responseTeachingMode: "TEACH",
        taskAuthority: "validated_ai_candidate",
      },
    );
  }

  if (
    input.nodeTeachingStage === "TASK_REQUIRED" &&
    input.activeTaskProvenance === null &&
    input.activeLessonExerciseId === null &&
    input.activeObjectiveTaskPayload === null
  ) {
    if (input.eligibleSourceExerciseAvailable) {
      return makeActionPlan(
        "DELIVER_SOURCE_EXERCISE",
        "server_selected_eligible_source_exercise_for_pending_task",
        {
          activeTaskMayBeCreated: true,
          responseTeachingMode: "TRANSITION",
          taskAuthority: "active_source_exercise",
        },
      );
    }
    return makeActionPlan(
      "GENERATE_TASK",
      "server_requires_generated_task_without_eligible_source_exercise",
      {
        aiGenerationNeeded: true,
        activeTaskMayBeCreated: true,
        responseTeachingMode: "MICRO_CHECK",
        taskAuthority: "validated_ai_candidate",
      },
    );
  }

  const hasNoPersistedTaskIdentity =
    input.activeLessonExerciseId === null &&
    input.activeObjectiveTaskPayload === null;

  if (
    input.nodeTeachingStage === "MICRO_CHECK" &&
    hasNoPersistedTaskIdentity &&
    (
      input.activeTaskProvenance === null ||
      input.activeTaskProvenance === "micro_check"
    )
  ) {
    return makeActionPlan(
      "DEFER_TO_COMPATIBILITY",
      "legacy_micro_check_has_no_objective_payload",
      {
        aiGenerationNeeded: true,
        activeTaskMayBeCreated: true,
        evaluationExpected: input.learnerIntent === "ANSWER",
        progressionMayOccur: input.learnerIntent === "ANSWER",
        taskAuthority: "compatibility",
        compatibilityKind: "legacy_micro_check_without_task_payload",
      },
    );
  }

  return makeActionPlan(
    "INVALID_PHASE2_STATE",
    "authoritative_phase2_state_is_incomplete_or_inconsistent",
  );
}

/**
 * The evaluated-turn action remains FEEDBACK/REMEDIATE so that exactly one
 * feedback message is produced. This separate derivation determines whether a
 * FOLLOWING server-owned action is safe after that feedback has been persisted.
 *
 * It is intentionally limited to the previously-invalid state: the Decision
 * Engine says the learner must continue at the same level, but the evaluated
 * task is closed and no learner-answerable task remains. It does not make
 * FEEDBACK or REMEDIATE generically non-blocking.
 */
export function derivePostFeedbackContinuationAction(input: {
  decision: Pick<PedagogicalDecision, "metaAction"> | null;
  progressionPlan: Pick<
    Phase2ProgressionPlan,
    "shouldCompleteNode" | "shouldResetForCognitiveAdvance"
  >;
  hasActiveTask: boolean;
  eligibleSourceExerciseAvailable: boolean;
}): Phase2ServerActionPlan | null {
  const requiresIndependentCheck =
    input.decision?.metaAction === "REQUEST_INDEPENDENT_CHECK";
  const continuesSameLevel =
    input.decision?.metaAction === "CONTINUE_COGNITIVE_LEVEL";

  if (
    (!requiresIndependentCheck && !continuesSameLevel) ||
    (!requiresIndependentCheck && input.hasActiveTask) ||
    input.progressionPlan.shouldCompleteNode ||
    input.progressionPlan.shouldResetForCognitiveAdvance
  ) {
    return null;
  }

  if (input.eligibleSourceExerciseAvailable) {
    return makeActionPlan(
      "DELIVER_SOURCE_EXERCISE",
      requiresIndependentCheck
        ? "post_feedback_independent_check_requires_next_source_task"
        : "post_feedback_continue_level_requires_next_source_task",
      {
        activeTaskMayBeCreated: true,
        responseTeachingMode: "TRANSITION",
        taskAuthority: "active_source_exercise",
      },
    );
  }

  return makeActionPlan(
    "GENERATE_TASK",
    requiresIndependentCheck
      ? "post_feedback_independent_check_requires_next_generated_task"
      : "post_feedback_continue_level_requires_next_generated_task",
    {
      aiGenerationNeeded: true,
      activeTaskMayBeCreated: true,
      responseTeachingMode: "MICRO_CHECK",
      taskAuthority: "validated_ai_candidate",
    },
  );
}

/**
 * A just-answered task may already have advanced EXERCISE -> VERIFIED before
 * post-feedback continuation runs. In that case hasActiveTask is false even
 * though the authoritative continuation plan still requires another task.
 * The route must retire/prepare the session as TASK_REQUIRED before reloading
 * it through the existing continuation owner.
 */
export function shouldPreparePostFeedbackTaskContinuation(input: {
  postFeedbackContinuationPlan: Phase2ServerActionPlan | null;
  hasActiveTask: boolean;
  nodeTeachingStage: string | null;
}): boolean {
  return (
    input.postFeedbackContinuationPlan !== null &&
    (input.hasActiveTask || input.nodeTeachingStage === "VERIFIED")
  );
}

/**
 * Keeps content validation separate from workflow ownership. It rejects AI
 * envelopes that try to manufacture a different active task than the selected
 * server action, while the existing schema/language/source validators retain
 * responsibility for content quality.
 */
export function validatePhase2ResponseForServerAction(
  plan: Phase2ServerActionPlan,
  response: AIStructuredResponse,
): void {
  if (plan.action === "DELIVER_THEORY") {
    if (
      response.teaching_mode !== "TEACH" ||
      response.is_micro_check !== false ||
      response.answer_evaluation.status !== "NOT_APPLICABLE"
    ) {
      throw new Error(
        "Phase-2 action/content mismatch: DELIVER_THEORY requires a theory-only TEACH envelope with no visible task or answer evaluation",
      );
    }
    return;
  }

  if (
    (plan.action === "EVALUATE_ACTIVE_TASK" ||
      plan.action === "PRESERVE_ACTIVE_TASK") &&
    response.is_micro_check === true
  ) {
    throw new Error(
      `Phase-2 action/content mismatch: ${plan.action} cannot create a new MICRO_CHECK`,
    );
  }
}

export type AuthoritativeSourceExercise = {
  id: number;
  exerciseId: string | null;
  interactionType: unknown;
  correctAnswer: unknown;
};

export type EvaluationAuthority =
  | "model_candidate"
  | "non_answer_gate"
  | "objective_task"
  | "source_exercise";

export type AuthoritativeEvaluationResult = {
  response: AIStructuredResponse;
  wasCorrect: boolean | null;
  authority: EvaluationAuthority;
  forceContinueSameNode: boolean;
  normalizedObjectiveAnswer: string | null;
  objectiveAnswerCorrect: boolean | null;
  sourceEvaluation: DeterministicSourceExerciseEvaluation | null;
};

export type EvaluatedTurnAuthority = {
  status: "CORRECT" | "INCORRECT" | "PARTIALLY_CORRECT" | "UNCLEAR" | "NO_RESPONSE";
  evidenceWasCorrect: boolean | null;
  isCorrectnessOutcome: boolean;
};

/**
 * Captures the sole correctness result allowed to drive acknowledgement,
 * evidence, decision-engine input, and task transition for an evaluated turn.
 * UNCLEAR and NO_RESPONSE are valid non-credit evaluator outcomes: they retain
 * bounded feedback/remediation behavior without becoming correctness evidence.
 */
export function establishEvaluatedTurnAuthority(
  evaluation: AIStructuredResponse["answer_evaluation"],
): EvaluatedTurnAuthority {
  switch (evaluation.status) {
    case "CORRECT":
      return {
        status: evaluation.status,
        evidenceWasCorrect: true,
        isCorrectnessOutcome: true,
      };
    case "INCORRECT":
      return {
        status: evaluation.status,
        evidenceWasCorrect: false,
        isCorrectnessOutcome: true,
      };
    case "PARTIALLY_CORRECT":
      return {
        status: evaluation.status,
        evidenceWasCorrect: true,
        isCorrectnessOutcome: true,
      };
    case "UNCLEAR":
    case "NO_RESPONSE":
      return {
        status: evaluation.status,
        evidenceWasCorrect: null,
        isCorrectnessOutcome: false,
      };
    default:
      throw new Error(
        `evaluated turn did not produce a canonical correctness status: ${evaluation.status}`,
      );
  }
}

const NON_ANSWER_EVALUATION_INTENTS = new Set<IntentClass>([
  "CONFUSED",
  "REPEAT",
  "CLARIFY",
  "OFF_TOPIC",
]);

/**
 * Derives the persisted correctness payload for a generated objective
 * MICRO_CHECK. The caller owns persistence; this helper is pure.
 */
export function objectivePayloadFromMicroCheck(
  response: AIStructuredResponse,
): ActiveObjectiveTaskPayload | null {
  if (
    !response.is_micro_check ||
    (response.interaction_type !== "multiple_choice" &&
      response.interaction_type !== "true_false") ||
    !response.correct_option
  ) {
    return null;
  }

  return {
    interactionType: response.interaction_type,
    options: response.interaction_type === "multiple_choice" ? response.options : null,
    correctOption: response.correct_option,
  };
}

export function normalizeObjectiveMicroCheckAnswer(
  answer: string,
  interactionType: ActiveObjectiveTaskPayload["interactionType"],
): string {
  const normalized = answer
    .normalize("NFKC")
    .trim()
    .replace(/[.)\s]+$/u, "")
    .toLocaleLowerCase();

  if (interactionType === "true_false") {
    if (["ճիշտ", "true", "այո"].includes(normalized)) return "TRUE";
    if (["սխալ", "false", "ոչ"].includes(normalized)) return "FALSE";
    return normalized.toUpperCase();
  }

  const optionKeyMap: Record<string, string> = {
    a: "A", "ա": "A",
    b: "B", "բ": "B",
    c: "C", "գ": "C",
    d: "D", "դ": "D",
    e: "E", "ե": "E",
    f: "F", "զ": "F",
  };
  return optionKeyMap[normalized] ?? normalized.toUpperCase();
}

export type Phase2TaskStateUpdate = {
  nodeTeachingStage: string;
  activeLessonExerciseId: number | null;
  activeTaskProvenance: string | null;
  activeTaskReference: string | null;
  activeObjectiveTaskPayload: ActiveObjectiveTaskPayload | null;
  activeAttemptSequence: number;
  activeHelpCount: number;
  activeAssistanceLevel: string;
};

/**
 * C7.2's feedback boundary deliberately reuses the existing persisted teaching
 * stage.  The answered task is retired only after its C3 evidence snapshot has
 * been recorded by the route, so no new schema or parallel state machine is
 * needed.
 */
export function buildMandatoryFeedbackStageUpdate(): Phase2TaskStateUpdate {
  return {
    nodeTeachingStage: "FEEDBACK",
    activeLessonExerciseId: null,
    activeTaskProvenance: null,
    activeTaskReference: null,
    activeObjectiveTaskPayload: null,
    activeAttemptSequence: 0,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  };
}

/**
 * After feedback itself has been persisted, TASK_REQUIRED gives the server sole
 * ownership of selecting the next source exercise or generated MICRO_CHECK.
 * It intentionally never changes C6's active target fields.
 */
export function buildPostFeedbackTransitionUpdate(): Phase2TaskStateUpdate {
  return {
    nodeTeachingStage: "TASK_REQUIRED",
    activeLessonExerciseId: null,
    activeTaskProvenance: null,
    activeTaskReference: null,
    activeObjectiveTaskPayload: null,
    activeAttemptSequence: 0,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  };
}

/**
 * Derives the existing anticipatory THEORY → MICRO_CHECK task state. Validation
 * remains upstream; a false is_micro_check response cannot manufacture a task.
 */
export function deriveGeneratedMicroCheckActivation(
  response: AIStructuredResponse,
  activeTaskReference = `micro_check:${randomUUID()}`,
): Phase2TaskStateUpdate | null {
  if (!response.is_micro_check) return null;
  return {
    nodeTeachingStage: "MICRO_CHECK",
    activeLessonExerciseId: null,
    activeTaskProvenance: "micro_check",
    activeTaskReference,
    activeObjectiveTaskPayload: objectivePayloadFromMicroCheck(response),
    activeAttemptSequence: 1,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  };
}

/**
 * Derives the task reset applied after ADVANCE_COGNITIVE_LEVEL. The route owns
 * the write and the active cognitive-level ID update.
 */
export function deriveCognitiveAdvanceTaskReset(): Phase2TaskStateUpdate {
  return {
    nodeTeachingStage: "THEORY",
    activeLessonExerciseId: null,
    activeTaskProvenance: null,
    activeTaskReference: null,
    activeObjectiveTaskPayload: null,
    activeAttemptSequence: 0,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  };
}

/**
 * Applies the current Phase 2 evaluation authority order without performing
 * I/O. The structured model evaluation is only a candidate:
 *
 * 1. non-answer intents suppress evaluation;
 * 2. an active objective payload owns generated MICRO_CHECK correctness;
 * 3. an active persisted source row owns supported typed source correctness.
 */
export function resolveAuthoritativeEvaluation(input: {
  response: AIStructuredResponse;
  learnerIntent: IntentClass;
  hasActiveTask: boolean;
  activeTaskProvenance: string | null;
  activeLessonExerciseId: number | null;
  activeObjectiveTaskPayload: ActiveObjectiveTaskPayload | null;
  activeSourceExercise: AuthoritativeSourceExercise | null;
  studentAnswer: string;
}): AuthoritativeEvaluationResult {
  let response: AIStructuredResponse = {
    ...input.response,
    answer_evaluation: { ...input.response.answer_evaluation },
    node_decision: { ...input.response.node_decision },
  };
  let authority: EvaluationAuthority = "model_candidate";
  let normalizedObjectiveAnswer: string | null = null;
  let objectiveAnswerCorrect: boolean | null = null;
  let sourceEvaluation: DeterministicSourceExerciseEvaluation | null = null;
  const forceContinueSameNode =
    NON_ANSWER_EVALUATION_INTENTS.has(input.learnerIntent) &&
    input.hasActiveTask;

  if (NON_ANSWER_EVALUATION_INTENTS.has(input.learnerIntent)) {
    response = {
      ...response,
      answer_evaluation: {
        ...response.answer_evaluation,
        status: "NOT_APPLICABLE",
        evidence_quality: "NONE",
      },
      node_decision: forceContinueSameNode
        ? {
            ...response.node_decision,
            action: "CONTINUE_SAME_NODE",
          }
        : response.node_decision,
    };
    authority = "non_answer_gate";
  }

  if (
    input.learnerIntent === "ANSWER" &&
    input.activeTaskProvenance === "micro_check" &&
    input.activeObjectiveTaskPayload
  ) {
    const payload = input.activeObjectiveTaskPayload;
    normalizedObjectiveAnswer = normalizeObjectiveMicroCheckAnswer(
      input.studentAnswer,
      payload.interactionType,
    );
    objectiveAnswerCorrect =
      normalizedObjectiveAnswer === payload.correctOption;
    response = {
      ...response,
      answer_evaluation: {
        ...response.answer_evaluation,
        status: objectiveAnswerCorrect ? "CORRECT" : "INCORRECT",
        evidence_quality: objectiveAnswerCorrect ? "MODERATE" : "NONE",
        error_family: objectiveAnswerCorrect
          ? null
          : response.answer_evaluation.error_family,
        error_stability: objectiveAnswerCorrect
          ? null
          : response.answer_evaluation.error_stability,
        correct_parts: objectiveAnswerCorrect
          ? ["objective answer matched"]
          : [],
        incorrect_parts: objectiveAnswerCorrect
          ? []
          : ["objective answer did not match"],
      },
    };
    authority = "objective_task";
  }

  if (
    input.learnerIntent === "ANSWER" &&
    input.activeTaskProvenance === "source_exercise" &&
    input.activeLessonExerciseId != null &&
    input.activeSourceExercise?.id === input.activeLessonExerciseId
  ) {
    sourceEvaluation = evaluateDeterministicSourceExerciseAnswer({
      learnerIntent: input.learnerIntent,
      activeTaskProvenance: input.activeTaskProvenance,
      activeLessonExerciseId: input.activeLessonExerciseId,
      exerciseId: input.activeSourceExercise.exerciseId,
      interactionType: input.activeSourceExercise.interactionType,
      correctAnswer: input.activeSourceExercise.correctAnswer,
      studentAnswer: input.studentAnswer,
    });

    if (sourceEvaluation) {
      const isCorrect = sourceEvaluation.status === "CORRECT";
      response = {
        ...response,
        answer_evaluation: {
          ...response.answer_evaluation,
          status: sourceEvaluation.status,
          evidence_quality: sourceEvaluation.evidenceQuality,
          error_family: isCorrect
            ? null
            : response.answer_evaluation.error_family,
          error_stability: isCorrect
            ? null
            : response.answer_evaluation.error_stability,
          correct_parts: isCorrect
            ? ["deterministic source answer matched"]
            : [],
          incorrect_parts: isCorrect
            ? []
            : ["deterministic source answer did not match"],
        },
      };
      authority = "source_exercise";
    }
  }

  const finalStatus = response.answer_evaluation.status;
  return {
    response,
    wasCorrect: finalStatus === "CORRECT" || finalStatus === "PARTIALLY_CORRECT"
      ? true
      : finalStatus === "INCORRECT"
        ? false
        : null,
    authority,
    forceContinueSameNode,
    normalizedObjectiveAnswer,
    objectiveAnswerCorrect,
    sourceEvaluation,
  };
}

export type Phase2TurnProgress = {
  status: AIStructuredResponse["answer_evaluation"]["status"];
  quality: AIStructuredResponse["answer_evaluation"]["evidence_quality"];
  isCorrect: boolean;
  isIncorrect: boolean;
  wasEval: boolean;
  currentStage: string;
  newTeachingStage: string | null;
  newMasteryCount: number;
  newConsecutiveCorrect: number;
  newConsecutiveIncorrect: number;
  newAttemptCount: number;
};

/**
 * Computes the current counter and teaching-stage transition intent. The route
 * remains responsible for applying these values to the session.
 */
export function deriveTurnProgress(input: {
  evaluation: AIStructuredResponse["answer_evaluation"];
  currentStage: string;
  classExerciseCount: number;
  masteryEvidenceCount: number;
  consecutiveCorrect: number;
  consecutiveIncorrect: number;
  attemptCount: number;
}): Phase2TurnProgress {
  const status = input.evaluation.status;
  const quality = input.evaluation.evidence_quality;
  const isCorrect = status === "CORRECT" || status === "PARTIALLY_CORRECT";
  const isIncorrect = status === "INCORRECT";
  const wasEval = status !== "NOT_APPLICABLE" && status !== "OFF_TOPIC";

  let newTeachingStage: string | null = null;
  if (input.currentStage === "MICRO_CHECK") {
    if (input.classExerciseCount > 0) {
      newTeachingStage = "EXERCISE";
    }
  } else if (
    input.currentStage === "EXERCISE" &&
    (quality === "STRONG" || quality === "CONCLUSIVE") &&
    isCorrect
  ) {
    newTeachingStage = "VERIFIED";
  }

  return {
    status,
    quality,
    isCorrect,
    isIncorrect,
    wasEval,
    currentStage: input.currentStage,
    newTeachingStage,
    newMasteryCount:
      input.masteryEvidenceCount + (quality !== "NONE" ? 1 : 0),
    newConsecutiveCorrect: isCorrect
      ? input.consecutiveCorrect + 1
      : isIncorrect
        ? 0
        : input.consecutiveCorrect,
    newConsecutiveIncorrect: isIncorrect
      ? input.consecutiveIncorrect + 1
      : isCorrect
        ? 0
        : input.consecutiveIncorrect,
    newAttemptCount: input.attemptCount + 1,
  };
}

export type EvidenceSummaryRow = {
  wasCorrect: boolean | null;
  helpCount: number | null;
  assistanceLevel: string | null;
  metadata: unknown;
  createdAt?: Date | null;
};

const QUALITY_RANK: Record<string, number> = {
  NONE: 1,
  WEAK: 2,
  MODERATE: 3,
  STRONG: 4,
  CONCLUSIVE: 5,
};

/**
 * Durable evidence can outlive a start-fresh reset, but it must never satisfy
 * the current run's Cognitive Path threshold. Node identity is stored in the
 * event metadata; nodeStartedAt is the authoritative existing boundary for the
 * active node within this session.
 */
export function filterEvidenceForCurrentRunNode<T extends EvidenceSummaryRow>(
  rows: readonly T[],
  input: {
    currentNodeId: number;
    nodeStartedAt: Date | null;
    sessionStartedAt: Date | null;
  },
): T[] {
  const boundary = input.nodeStartedAt ?? input.sessionStartedAt;
  return rows.filter((row) => {
    const metadata = row.metadata as { nodeId?: number | string } | null;
    if (String(metadata?.nodeId ?? "") !== String(input.currentNodeId)) {
      return false;
    }
    if (boundary !== null && (row.createdAt === null || row.createdAt === undefined)) {
      return false;
    }
    return boundary === null || row.createdAt!.getTime() >= boundary.getTime();
  });
}

/**
 * Reduces already-fetched evidence rows to the Decision Engine's historical
 * evidence input. The current turn remains excluded, matching the engine
 * contract and existing route query timing.
 */
export function summarizeLevelEvidence(
  rows: EvidenceSummaryRow[],
): LevelEvidenceSummary {
  const independentRows = rows.filter((row) => {
    const metadata = row.metadata as { evidence_quality?: string } | null;
    return (
      row.wasCorrect === true &&
      (row.helpCount ?? 0) <= 1 &&
      (row.assistanceLevel === "none" || row.assistanceLevel === "light") &&
      QUALITY_RANK[metadata?.evidence_quality ?? "NONE"] >= 3
    );
  });
  const bestQuality = independentRows.reduce<
    LevelEvidenceSummary["bestQuality"]
  >((best, row) => {
    const metadata = row.metadata as { evidence_quality?: string } | null;
    const quality = metadata?.evidence_quality ?? null;
    if (!quality || !(quality in QUALITY_RANK)) return best;
    if (!best || QUALITY_RANK[quality] > QUALITY_RANK[best]) {
      return quality as LevelEvidenceSummary["bestQuality"];
    }
    return best;
  }, null);

  return {
    independentCorrectCount: independentRows.length,
    totalCorrectCount: rows.length,
    bestQuality,
  };
}

export type Phase2DecisionContext = {
  lessonNodeId: number;
  lessonId: number;
  sessionId: number;
  userId: number;
  nodeTeachingStage: string;
  remediationStep: number;
  activeCognitiveLevelId: number | null;
  activeCognitiveLevelRow: CognitiveLevelRow | null;
  cognitivePath: CognitiveLevelRow[];
  evaluation: AIStructuredResponse["answer_evaluation"];
  activeHelpCount: number;
  activeAssistanceLevel: string;
  activeAttemptSequence: number;
  activeTaskProvenance: string | null;
  levelEvidenceSummary: LevelEvidenceSummary | null;
  nextNodeHasCriticalDependencyOnCurrentNode: boolean;
  requiredSessionMinutes: number | null;
  activeLearningSeconds: number;
  optionalContinuation: boolean;
  estimatedNodeMinutes: number;
  legacyCompletionAllowed?: boolean;
};

export type Phase2DecisionPlan = {
  input: PedagogicalDecisionInput;
  decision: PedagogicalDecision;
  sessionBudgetExhausted: boolean;
  localNodeBudgetExhausted: boolean;
  effectiveSessionBudgetExhausted: boolean;
};

/**
 * Constructs the deterministic Decision Engine input and invokes the pure
 * engine. No model field can set either budget signal.
 */
export function coordinatePedagogicalDecision(
  context: Phase2DecisionContext,
): Phase2DecisionPlan {
  const sessionBudgetExhausted = computeSessionBudgetExhausted(
    context.requiredSessionMinutes,
    context.activeLearningSeconds,
  );
  const localNodeBudgetExhausted = computeLocalNodeBudget(
    context.estimatedNodeMinutes,
    0,
  );
  const effectiveSessionBudgetExhausted =
    sessionBudgetExhausted && !context.optionalContinuation;
  const input: PedagogicalDecisionInput = {
    lessonNodeId: context.lessonNodeId,
    lessonId: context.lessonId,
    sessionId: context.sessionId,
    userId: context.userId,
    nodeTeachingStage: context.nodeTeachingStage,
    remediationStep: context.remediationStep,
    activeCognitiveLevelId: context.activeCognitiveLevelId,
    activeCognitiveLevelRow: context.activeCognitiveLevelRow,
    cognitivePath: context.cognitivePath,
    answerStatus: context.evaluation.status,
    evidenceQuality: context.evaluation.evidence_quality,
    errorFamily: context.evaluation.error_family ?? null,
    errorStability: context.evaluation.error_stability ?? null,
    activeHelpCount: context.activeHelpCount,
    activeAssistanceLevel: context.activeAssistanceLevel,
    activeAttemptSequence: context.activeAttemptSequence,
    activeTaskProvenance: context.activeTaskProvenance,
    levelEvidenceSummary: context.levelEvidenceSummary,
    nextNodeId: null,
    nextNodeHasCriticalDependencyOnCurrentNode:
      context.nextNodeHasCriticalDependencyOnCurrentNode,
    sessionBudgetExhausted: effectiveSessionBudgetExhausted,
    localNodeBudgetExhausted,
    legacyCompletionAllowed: context.legacyCompletionAllowed ?? false,
  };

  return {
    input,
    decision: decideNextPedagogicalAction(input),
    sessionBudgetExhausted,
    localNodeBudgetExhausted,
    effectiveSessionBudgetExhausted,
  };
}

/**
 * Preserves the pre-Decision-Engine completion policy for nodes without a
 * confirmed cognitive path, while making the engine the explicit grant owner.
 */
export function deriveLegacyCompletionAllowed(input: {
  turn: Phase2TurnProgress;
  classExerciseCount: number;
  hasActiveCognitivePath: boolean;
}): boolean {
  const { turn } = input;
  const stageBecomesVerified = turn.newTeachingStage === "VERIFIED";
  const noExercisesEarlyComplete =
    input.classExerciseCount === 0 &&
    turn.currentStage === "MICRO_CHECK" &&
    turn.newAttemptCount >= 2 &&
    (
      turn.quality === "MODERATE" ||
      turn.quality === "STRONG" ||
      turn.quality === "CONCLUSIVE"
    ) &&
    turn.isCorrect;
  const safetyCapHit = turn.newAttemptCount > 6;

  return (
    !input.hasActiveCognitivePath &&
    (safetyCapHit || stageBecomesVerified || noExercisesEarlyComplete)
  );
}

export type Phase2ProgressionPlan = {
  stageBecomesVerified: boolean;
  noExercisesEarlyComplete: boolean;
  decisionSaysComplete: boolean;
  codeGate: boolean;
  safetyCapHit: boolean;
  hasActiveCognitivePath: boolean;
  shouldResetForCognitiveAdvance: boolean;
  legacyCompletionGate: boolean;
  cognitiveCompletionGate: boolean;
  shouldCompleteNode: boolean;
  shouldAutoContinueExercise: boolean;
};

/**
 * Derives progression intent only. The route still owns all reset, node
 * advancement, response, and persistence side effects.
 */
export function deriveProgressionPlan(input: {
  turn: Phase2TurnProgress;
  classExerciseCount: number;
  cognitivePath: CognitiveLevelRow[];
  activeCognitiveLevelRow: CognitiveLevelRow | null;
  decision: PedagogicalDecision | null;
}): Phase2ProgressionPlan {
  const { turn } = input;
  const stageBecomesVerified = turn.newTeachingStage === "VERIFIED";
  const noExercisesEarlyComplete =
    input.classExerciseCount === 0 &&
    turn.currentStage === "MICRO_CHECK" &&
    turn.newAttemptCount >= 2 &&
    (
      turn.quality === "MODERATE" ||
      turn.quality === "STRONG" ||
      turn.quality === "CONCLUSIVE"
    ) &&
    turn.isCorrect;
  const decisionSaysComplete =
    input.decision?.mayCompleteMicroNode ?? false;
  const codeGate = input.classExerciseCount > 0
    ? (
        turn.newMasteryCount >= 2 &&
        (turn.quality === "STRONG" || turn.quality === "CONCLUSIVE") &&
        turn.newConsecutiveIncorrect < 2
      )
    : (
        turn.newMasteryCount >= 2 &&
        turn.quality !== "NONE" &&
        turn.newConsecutiveIncorrect < 2
      );
  const safetyCapHit = turn.newAttemptCount > 6;
  const hasActiveCognitivePath =
    input.cognitivePath.length > 0 &&
    input.activeCognitiveLevelRow !== null;
  const shouldResetForCognitiveAdvance =
    hasActiveCognitivePath &&
    input.decision?.metaAction === "ADVANCE_COGNITIVE_LEVEL";
  const legacyCompletionGate = deriveLegacyCompletionAllowed({
    turn,
    classExerciseCount: input.classExerciseCount,
    hasActiveCognitivePath,
  });
  const cognitiveCompletionGate = decisionSaysComplete && codeGate;
  const shouldCompleteNode =
    legacyCompletionGate || cognitiveCompletionGate;
  const shouldAutoContinueExercise =
    turn.newTeachingStage === "EXERCISE" &&
    input.classExerciseCount > 0 &&
    !safetyCapHit &&
    !stageBecomesVerified &&
    !noExercisesEarlyComplete &&
    !cognitiveCompletionGate &&
    input.decision?.metaAction !== "ADVANCE_COGNITIVE_LEVEL";

  return {
    stageBecomesVerified,
    noExercisesEarlyComplete,
    decisionSaysComplete,
    codeGate,
    safetyCapHit,
    hasActiveCognitivePath,
    shouldResetForCognitiveAdvance,
    legacyCompletionGate,
    cognitiveCompletionGate,
    shouldCompleteNode,
    shouldAutoContinueExercise,
  };
}