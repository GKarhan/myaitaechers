import {
  evaluateDeterministicSourceExerciseAnswer,
  type DeterministicSourceExerciseEvaluation,
} from "../../lib/deterministic-source-exercise-evaluation.js";
import type { AIStructuredResponse } from "../ai.js";
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
  activeObjectiveTaskPayload: ActiveObjectiveTaskPayload | null;
  activeAttemptSequence: number;
  activeHelpCount: number;
  activeAssistanceLevel: string;
};

/**
 * Derives the existing anticipatory THEORY → MICRO_CHECK task state. Validation
 * remains upstream; a false is_micro_check response cannot manufacture a task.
 */
export function deriveGeneratedMicroCheckActivation(
  response: AIStructuredResponse,
): Phase2TaskStateUpdate | null {
  if (!response.is_micro_check) return null;
  return {
    nodeTeachingStage: "MICRO_CHECK",
    activeLessonExerciseId: null,
    activeTaskProvenance: "micro_check",
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
    wasCorrect: finalStatus === "CORRECT"
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
};

const QUALITY_RANK: Record<string, number> = {
  NONE: 1,
  WEAK: 2,
  MODERATE: 3,
  STRONG: 4,
  CONCLUSIVE: 5,
};

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
  };

  return {
    input,
    decision: decideNextPedagogicalAction(input),
    sessionBudgetExhausted,
    localNodeBudgetExhausted,
    effectiveSessionBudgetExhausted,
  };
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
  const legacyCompletionGate =
    !hasActiveCognitivePath &&
    (safetyCapHit || stageBecomesVerified || noExercisesEarlyComplete);
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