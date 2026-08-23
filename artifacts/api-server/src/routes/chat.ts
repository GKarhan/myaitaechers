import { Router } from "express";
import {
  db, chatMessagesTable, lessonsTable, lessonSessionsTable,
  lessonNodesTable, lessonExercisesTable,
  lessonNodeDependenciesTable, usersTable,
  evidenceEventsTable, knowledgeNodesTable,
  lessonNodeCognitiveLevelsTable, helpEventsTable,
  lessonNodeCognitiveTasksTable,
} from "@workspace/db";
import { eq, and, asc, desc, inArray, gte, or, isNull, sql } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import {
  callAI, callAIStructured,
  type ChatMessage, type AIStructuredResponse, type ProgressIndicator,
} from "../services/ai";
import {
  assertFeedbackConsistentWithServerAction,
  assertFeedbackMatchesAuthority,
  assertFeedbackOnly,
  assertTheoryOnly,
  buildNodeTheoryFallback,
  callPhase2EvaluationJob,
  callPhase2FeedbackJob,
  callPhase2TaskJob,
  callPhase2TheoryJob,
  Phase2TheoryExhaustionError,
  serverOwnedFeedbackAcknowledgement,
  type Phase2EvaluationResult,
} from "../services/phase2/bounded-jobs.js";
import { getDueReviewTopics } from "../services/review-schedule";
import { logger } from "../lib/logger";
import {
  enforceActiveSourceExercise,
  isExerciseDeliveryTurn,
  resolveEligibleSourceExercise,
  shouldDeliverStandaloneSourceExercise,
  type SourceExerciseResolution,
} from "../lib/exercise-delivery";
import {
  isLearnerDeliveryEligible,
  resolveLearnerExerciseContent,
} from "../lib/exercise-content-boundary.js";
import { evaluateDeterministicSourceExerciseAnswer } from "../lib/deterministic-source-exercise-evaluation";
import { updateTopicScoring } from "../services/scoring";
import { classifyIntent, type IntentContext, type IntentResult } from "../services/intentRouter.js";
import {
  computeSessionBudgetExhausted,
  ACTIVE_INTERVAL_CAP_SECONDS,
  getNextHelpEscalation,
  type CognitiveLevelRow,
  type PedagogicalDecision,
} from "../services/pedagogicalDecisionEngine.js";
import {
  coordinatePedagogicalDecision,
  deriveGeneratedMicroCheckActivation,
  buildMandatoryFeedbackStageUpdate,
  buildPostFeedbackTransitionUpdate,
  buildTerminalRevisitStageUpdate,
  deriveLegacyCompletionAllowed,
  derivePostFeedbackContinuationAction,
  derivePhase2ServerAction,
  deriveProgressionPlan,
  deriveTurnProgress,
  establishEvaluatedTurnAuthority,
  filterEvidenceForCurrentRunNode,
  normalizeObjectiveMicroCheckAnswer,
  requiresLegacyTaskRestart,
  requiresPostFeedbackHold,
  resolveAuthoritativeEvaluation,
  summarizeLevelEvidence,
  shouldPreparePostFeedbackTaskContinuation,
  validatePhase2ResponseForServerAction,
  type ActiveObjectiveTaskPayload,
  type AuthoritativeSourceExercise,
  type Phase2ServerActionPlan,
} from "../services/phase2/orchestration.js";
import {
  isC6DeliveryBlocked,
  resolveCanonicalC6Decision,
} from "../services/c6-personalization.js";
import {
  applyAuthorizedTargetTransition,
  applyAuthorizedLevelTransition,
  authorizeCanonicalCompletion,
  buildAuthorizedLevelTransitionUpdate,
} from "../services/phase2/canonical-completion-authority.js";
import {
  MAX_PHASE2_INTERNAL_CONTINUATIONS,
  nextPhase2ActionRequiresLearnerInput,
} from "../services/phase2/continuation.js";
import {
  assertC7ExecutionTargetMatchesSession,
  buildC7TargetContext,
  createC7ExecutionTarget,
  isC7TopicSwitchRequest,
  isExerciseCompatibleWithC7Target,
  validateC7ModelTargetProposal,
  type C7ExecutionTarget,
} from "../services/phase2/c7-execution-target.js";
import { assessAcceptedCognitivePath } from "../lib/cognitive-path-grounding.js";
import {
  projectLearnerCognitiveCeiling,
  type LearnerCeilingProjection,
} from "../services/learner-cognitive-ceiling.js";
import {
  classifyQualifyingEvidence,
  createTaskReference,
  type EvidenceQualificationStatus,
  type TaskSource,
} from "../lib/evidence-contract.js";
import {
  buildCanonicalTaskSnapshot,
  createCanonicalTaskRetrySnapshot,
  isCanonicalTaskSnapshot,
  sourceTaskText,
  taskSnapshotForEvidence,
  type CanonicalTaskSnapshot,
} from "../services/phase2/canonical-task-snapshot.js";

export { normalizeObjectiveMicroCheckAnswer };

type LessonExerciseRow = typeof lessonExercisesTable.$inferSelect;

function learnerExerciseText(exercise: LessonExerciseRow): string | null {
  const content = resolveLearnerExerciseContent(exercise);
  return isLearnerDeliveryEligible(content) ? content.learnerText : null;
}

function canonicalSourcePrompt(exercise: LessonExerciseRow): {
  prompt: string;
  learnerTextSource: "verbatim" | "edited";
} | null {
  // A source exercise must preserve the textbook wording when that wording is
  // safe to deliver. If it is not safe, fail closed instead of silently
  // replacing the displayed task with a teacher edit.
  if (exercise.exerciseTextVerbatim.trim()) {
    const verbatim = resolveLearnerExerciseContent({
      ...exercise,
      exerciseTextEdited: null,
    });
    if (!isLearnerDeliveryEligible(verbatim)) return null;
  } else if (!learnerExerciseText(exercise)) {
    return null;
  }
  return sourceTaskText(exercise);
}

function renderGeneratedTask(task: {
  student_message: string;
  interaction_type: "multiple_choice" | "true_false" | "constructed_response";
  options: Array<{ key: string; text: string }> | null;
}): string {
  const stem = task.interaction_type === "constructed_response"
    ? task.student_message
    : task.student_message
      .split("\n")
      .filter((line) => !/^\s*[A-ZԱ-Ֆ]\s*[.)]/u.test(line))
      .join("\n")
      .trim();
  const renderedOptions = task.interaction_type === "multiple_choice"
    ? task.options!.map((option) => `${option.key}) ${option.text}`).join("\n")
    : task.interaction_type === "true_false"
      ? "Ա) Ճիշտ\nԲ) Սխալ"
      : "";
  return renderedOptions ? `${stem}\n${renderedOptions}` : stem;
}

export function buildActiveTaskReminder(taskText: string | null): string {
  const prefix = "Ընթացիկ առաջադրանքը դեռ բաց է։ Խնդրում եմ պատասխանել։";
  return taskText ? `${prefix}\n${taskText}` : prefix;
}

function filterLearnerSafeExercises(
  exercises: LessonExerciseRow[],
  context: { lessonId: number; phase: number; assignment: "CLASS" | "HOMEWORK" },
): LessonExerciseRow[] {
  return exercises.filter((exercise) => {
    const content = resolveLearnerExerciseContent(exercise);
    if (isLearnerDeliveryEligible(content)) return true;
    logger.warn({
      ...context,
      exerciseId: exercise.id,
      issueCodes: content.ok ? content.reviewWarnings : content.issues.map((issue) => issue.code),
    }, "chat: excluded learner-ineligible source exercise");
    return false;
  });
}

function createStage3EvaluationEnvelope(
  progressIndicator: ProgressIndicator,
  evaluation?: Phase2EvaluationResult,
): AIStructuredResponse {
  return {
    student_message: "",
    progress_indicator: progressIndicator,
    teaching_mode: "FEEDBACK",
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
    answer_evaluation: evaluation ?? {
      status: "NOT_APPLICABLE",
      evidence_quality: "NONE",
      error_family: null,
      error_stability: null,
      correct_parts: [],
      incorrect_parts: [],
    },
    node_decision: {
      action: "CONTINUE_SAME_NODE",
      reason: "stage3_server_owned_evaluation_pending_decision_engine",
    },
    source_fidelity: {
      type: "AI_GENERATED",
      exercise_id: null,
    },
    redirect_needed: false,
    mentions_out_of_scope_topic: false,
    question_template: null,
    encouragement_used: false,
    encouragement_focus: null,
  };
}

/**
 * The only source-exercise activation writer in chat.ts.
 *
 * Callers pass a row resolved from the current eligible CLASS exercise set;
 * this function persists that exact internal row identity before it is
 * learner-visible as the active source-exercise task.
 */
async function activateSourceExercise(
  sessionId: number,
  selection: SourceExerciseResolution<LessonExerciseRow>,
  executionTarget?: C7ExecutionTarget,
): Promise<{ exercise: LessonExerciseRow; renderedPrompt: string } | null> {
  const selectedExercise = selection.selected;
  if (!selectedExercise) return null;
  const rendered = canonicalSourcePrompt(selectedExercise);
  if (!rendered) {
    logger.warn({
      sessionId,
      exerciseId: selectedExercise.id,
      issueCodes: ["canonical-verbatim-task-unavailable"],
    }, "source exercise activation blocked by learner-content boundary");
    return null;
  }
  const taskReference = createTaskReference("source_exercise");
  const taskSnapshot = buildCanonicalTaskSnapshot({
    taskReference,
    taskSource: "source_exercise",
    taskKind: "source",
    renderedPrompt: rendered.prompt,
    executionTarget,
    interactionType: selectedExercise.interactionType,
    lessonExerciseId: selectedExercise.id,
    sourceExerciseId: selectedExercise.exerciseId,
    sourcePage: selectedExercise.sourcePage,
    learnerTextSource: rendered.learnerTextSource,
    sourceAnswer: {
      interactionType: selectedExercise.interactionType,
      correctAnswer: selectedExercise.correctAnswer,
    },
    sourceSuccessCriteria: selectedExercise.successCriteria,
    targetCompatibleAtActivation: executionTarget !== undefined,
  });

  const updated = await db
    .update(lessonSessionsTable)
    .set({
      nodeTeachingStage: "EXERCISE",
      activeLessonExerciseId: selectedExercise.id,
      activeTaskProvenance: "source_exercise",
      activeTaskReference: taskReference,
      activeTaskSnapshot: taskSnapshot,
      activeObjectiveTaskPayload: null,
      activeAttemptSequence: 1,
      activeHelpCount: 0,
      activeAssistanceLevel: "none",
      lastQuestionAsked: rendered.prompt,
    } as any)
    .where(executionTarget
      ? and(
          eq(lessonSessionsTable.id, sessionId),
          eq(lessonSessionsTable.currentNodeId, executionTarget.microNodeId),
          eq(lessonSessionsTable.activeCognitiveLevelId, executionTarget.activeCognitiveLevelId),
        )
      : eq(lessonSessionsTable.id, sessionId))
    .returning({ id: lessonSessionsTable.id });
  if (updated.length === 0) {
    throw new Error("source exercise activation lost the C7 execution-target compare-and-swap");
  }

  logger.info(
    {
      sessionId,
      activeLessonExerciseId: selectedExercise.id,
      exerciseId: selectedExercise.exerciseId,
      requestedExerciseId: selection.requestedExerciseId,
      resolution: selection.resolution,
    },
    "source exercise activated from eligible set"
  );

  return { exercise: selectedExercise, renderedPrompt: rendered.prompt };
}

// ── V2-R2 shared help executor ────────────────────────────────────────────────
// Used by both the inline HELP intent path (text-based "oghni") and the
// dedicated POST /chat/help route.  Never writes evidence or advances stage.
type HelpRequestResult =
  | { ok: true; hintContent: string; helpLevel: number; newHelpCount: number; helpEventId: number | null; isAnswerReveal: boolean }
  | { ok: false; errorCode: string; statusHint: number; message?: string };

type HelpExerciseContent = {
  exerciseTextVerbatim: string;
  exerciseTextEdited: string | null;
  successCriteria: string | null;
  correctAnswer: string | null;
};

export function resolveHelpTaskText(
  activeExercise: HelpExerciseContent | null,
  lastQuestionAsked: string | null,
):
  | { ok: true; taskText: string | null }
  | { ok: false; issueCodes: string[] } {
  if (!activeExercise) return { ok: true, taskText: lastQuestionAsked };
  const learnerContent = resolveLearnerExerciseContent(activeExercise);
  if (!isLearnerDeliveryEligible(learnerContent)) {
    return {
      ok: false,
      issueCodes: learnerContent.ok ? learnerContent.reviewWarnings : learnerContent.issues.map((issue) => issue.code),
    };
  }
  return { ok: true, taskText: learnerContent.learnerText };
}

async function executeHelpRequest(
  session: {
    id: number; currentNodeId: number | null;
    activeTaskProvenance: string | null; activeHelpCount: number;
    activeLessonExerciseId: number | null; activeCognitiveLevelId: number | null;
    lastQuestionAsked: string | null;
  },
  lessonId: number,
  userId: number,
  revealAnswer = false
): Promise<HelpRequestResult> {
  if (!session.activeTaskProvenance) {
    return { ok: false, errorCode: "NO_ACTIVE_TASK", statusHint: 409, message: "No active task" };
  }

  // Help is C7 execution too. Rehydrate the persisted C6/C2 target rather
  // than giving the generic hint model an unbounded curriculum prompt.
  if (session.currentNodeId === null || session.activeCognitiveLevelId === null) {
    return {
      ok: false,
      errorCode: "C7_EXECUTION_TARGET_UNAVAILABLE",
      statusHint: 409,
      message: "No canonical instructional target is available.",
    };
  }
  const [helpNode, helpLevels] = await Promise.all([
    db
      .select({
        id: lessonNodesTable.id,
        title: lessonNodesTable.title,
        learningObjective: lessonNodesTable.learningObjective,
        theoryContent: lessonNodesTable.theoryContent,
        cogPathStatus: lessonNodesTable.cogPathStatus,
      })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.id, session.currentNodeId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: lessonNodeCognitiveLevelsTable.id,
        cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel,
        sequence: lessonNodeCognitiveLevelsTable.sequence,
        isApplicable: lessonNodeCognitiveLevelsTable.isApplicable,
        isTargetCeiling: lessonNodeCognitiveLevelsTable.isTargetCeiling,
        performanceObjective: lessonNodeCognitiveLevelsTable.performanceObjective,
        successCriterion: lessonNodeCognitiveLevelsTable.successCriterion,
        preferredInteractionTypes: lessonNodeCognitiveLevelsTable.preferredInteractionTypes,
        minimumIndependentEvidence: lessonNodeCognitiveLevelsTable.minimumIndependentEvidence,
      })
      .from(lessonNodeCognitiveLevelsTable)
      .where(and(
        eq(lessonNodeCognitiveLevelsTable.lessonNodeId, session.currentNodeId),
        eq(lessonNodeCognitiveLevelsTable.isApplicable, true),
      )),
  ]);
  if (!helpNode) {
    return { ok: false, errorCode: "C7_EXECUTION_TARGET_UNAVAILABLE", statusHint: 409 };
  }
  const helpPathAcceptance = assessAcceptedCognitivePath({
    cogPathStatus: helpNode.cogPathStatus,
    theoryContent: helpNode.theoryContent,
    learningObjective: helpNode.learningObjective,
    levels: helpLevels,
  });
  if (!helpPathAcceptance.accepted) {
    return {
      ok: false,
      errorCode: "C7_EXECUTION_TARGET_UNAVAILABLE",
      statusHint: 409,
      message: "The canonical instructional target is not currently approved.",
    };
  }
  let helpTarget: C7ExecutionTarget;
  try {
    helpTarget = createC7ExecutionTarget({
      lessonId,
      currentNodeId: session.currentNodeId,
      activeCognitiveLevelId: session.activeCognitiveLevelId,
      node: helpNode,
      acceptedPath: helpLevels,
    });
  } catch {
    return { ok: false, errorCode: "C7_EXECUTION_TARGET_UNAVAILABLE", statusHint: 409 };
  }

  const currentHelpCount = session.activeHelpCount ?? 0;
  const helpEscalation = getNextHelpEscalation(currentHelpCount, revealAnswer);
  if (!helpEscalation.ok) {
    return {
      ok: false,
      errorCode: helpEscalation.reason,
      statusHint: 409,
      message: helpEscalation.reason === "REVEAL_REQUIRES_CONFIRMATION"
        ? "Reveal requires explicit confirmation"
        : "Help budget is exhausted for this task",
    };
  }
  const { helpLevel: nextHelpLevel, assistanceLevel } = helpEscalation;

  let taskText: string | null = null;
  if (session.activeLessonExerciseId) {
    const [exRow] = await db
      .select({
        id: lessonExercisesTable.id,
        relatedNodeId: lessonExercisesTable.relatedNodeId,
        exerciseTextVerbatim: lessonExercisesTable.exerciseTextVerbatim,
        exerciseTextEdited: lessonExercisesTable.exerciseTextEdited,
        successCriteria: lessonExercisesTable.successCriteria,
        correctAnswer: lessonExercisesTable.correctAnswer,
      })
      .from(lessonExercisesTable)
      .where(eq(lessonExercisesTable.id, session.activeLessonExerciseId))
      .limit(1);
    if (!exRow) {
      return { ok: false, errorCode: "ACTIVE_TASK_NOT_FOUND", statusHint: 409 };
    }
    const helpExerciseLinks = await db
      .select({ lessonExerciseId: lessonNodeCognitiveTasksTable.lessonExerciseId })
      .from(lessonNodeCognitiveTasksTable)
      .where(eq(
        lessonNodeCognitiveTasksTable.cognitiveLevelId,
        helpTarget.activeCognitiveLevelId,
      ));
    const linkedExerciseIds = new Set(
      helpExerciseLinks
        .map((row) => row.lessonExerciseId)
        .filter((id): id is number => id !== null),
    );
    if (!isExerciseCompatibleWithC7Target(helpTarget, exRow, linkedExerciseIds)) {
      return {
        ok: false,
        errorCode: "ACTIVE_TASK_TARGET_MISMATCH",
        statusHint: 409,
        message: "The active task does not match the canonical instructional target.",
      };
    }
    const helpTask = resolveHelpTaskText(exRow ?? null, session.lastQuestionAsked);
    if (!helpTask.ok) {
      logger.warn({
        sessionId: session.id,
        activeLessonExerciseId: session.activeLessonExerciseId,
        issueCodes: helpTask.issueCodes,
      }, "executeHelpRequest: unsafe active exercise blocked before hint generation");
      return {
        ok: false,
        errorCode: "ACTIVE_TASK_CONTENT_UNSAFE",
        statusHint: 409,
        message: "Active task content is not safe for learner help.",
      };
    }
    taskText = helpTask.taskText;
  } else if (session.lastQuestionAsked) {
    taskText = session.lastQuestionAsked;
  }

  const HINT_INSTRUCTIONS: Record<number, string> = {
    1: "Give a LIGHT directional hint only. No answer steps, no solution. 1-2 sentences in Armenian.",
    2: "Give MODERATE conceptual/procedural guidance. No worked steps, no final answer. 2-3 sentences in Armenian.",
    3: "Give STEP-BY-STEP guidance. Walk through the approach; leave final answer for student. 3-4 sentences in Armenian.",
    4: "Reveal the COMPLETE correct answer with explanation. Student explicitly requested full reveal. In Armenian.",
  };

  let hintContent = "";
  try {
    const helpPrompt = [
      `You are an Armenian AI Teacher giving a level-${nextHelpLevel} hint.`,
      buildC7TargetContext(helpTarget),
      `Task: ${taskText ?? "(no task text available)"}`,
      `Instruction: ${HINT_INSTRUCTIONS[nextHelpLevel] ?? HINT_INSTRUCTIONS[3]}`,
      "Reply ONLY in Armenian. Do not repeat the task verbatim.",
    ].join("\n");
    hintContent = await callAI(
      [{ role: "user" as const, content: helpPrompt }],
      "\u0564\u0578\u0582 AI \u0578\u0582\u057d\u0578\u0582\u0581\u056b\u0579 \u0565\u057d\u0589 \u0570\u0561\u0575\u056f\u0561\u056f\u0561\u0576 \u0570\u0578\u0582\u0577 \u057f\u0578\u0582\u0580\u0589"
    );
  } catch (aiErr) {
    logger.warn({ aiErr, sessionId: session.id }, "executeHelpRequest: AI hint failed");
    hintContent = "\u0553\u0578\u0580\u056e\u056b\u0580 \u056f\u0580\u056f\u056b\u0576 \u0574\u057f\u0561\u056e\u0565\u056c \u056d\u0576\u0564\u056b\u0580\u056b \u0574\u0561\u057d\u056b\u0576, \u056f\u0561\u0574 \u0564\u056b\u0574\u056b\u0580 \u0578\u0582\u057d\u0578\u0582\u0581\u056c\u056b\u0579\u056b\u0576\u0589";
  }

  // Commit the help event and assistance state only if the execution target is
  // still current. It also compare-and-swaps activeHelpCount so concurrent help
  // requests cannot overrun the task-local four-level help budget.
  const helpEvent = await db.transaction(async (tx) => {
    const [freshSession] = await tx
      .select({
        currentNodeId: lessonSessionsTable.currentNodeId,
        activeCognitiveLevelId: lessonSessionsTable.activeCognitiveLevelId,
        activeHelpCount: lessonSessionsTable.activeHelpCount,
      })
      .from(lessonSessionsTable)
      .where(eq(lessonSessionsTable.id, session.id))
      .limit(1);
    if (!freshSession) throw new Error("help session disappeared");
    assertC7ExecutionTargetMatchesSession(helpTarget, {
      lessonId,
      currentNodeId: freshSession.currentNodeId,
      activeCognitiveLevelId: freshSession.activeCognitiveLevelId,
    });
    const freshHelpCount = (freshSession.activeHelpCount ?? 0) as number;
    if (freshHelpCount !== currentHelpCount) {
      throw new Error("help compare-and-swap rejected a stale help count");
    }
    const [created] = await tx
      .insert(helpEventsTable)
      .values({
        userId,
        lessonSessionId: session.id,
        lessonNodeId: helpTarget.microNodeId,
        lessonExerciseId: session.activeLessonExerciseId,
        quizQuestionId: null,
        cognitiveLevelId: helpTarget.activeCognitiveLevelId,
        helpLevel: nextHelpLevel,
        isAnswerReveal: nextHelpLevel === 4,
        hintContent,
      } as any)
      .returning({ id: helpEventsTable.id });
    const updated = await tx
      .update(lessonSessionsTable)
      .set({
        activeHelpCount: currentHelpCount + 1,
        activeAssistanceLevel: assistanceLevel,
      } as any)
      .where(and(
        eq(lessonSessionsTable.id, session.id),
        eq(lessonSessionsTable.currentNodeId, helpTarget.microNodeId),
        eq(lessonSessionsTable.activeCognitiveLevelId, helpTarget.activeCognitiveLevelId),
        eq(lessonSessionsTable.activeHelpCount, currentHelpCount),
      ))
      .returning({ id: lessonSessionsTable.id });
    if (updated.length === 0) {
      throw new Error("help execution-target compare-and-swap rejected a stale write");
    }
    return created;
  });

  return {
    ok:            true,
    hintContent,
    helpLevel:     nextHelpLevel,
    newHelpCount:  currentHelpCount + 1,
    helpEventId:   helpEvent?.id ?? null,
    isAnswerReveal: nextHelpLevel === 4,
  };
}

const router = Router();

// ── P7 Node Lock — scope drift detection ─────────────────────────────────────

const SCOPE_DRIFT_PHRASES = [
  "\u0570\u0561\u057b\u0578\u0580\u0564 \u0569\u0565\u0574\u0561",
  "\u0576\u0578\u0580 \u0564\u0561\u057d",
  "\u0561\u0576\u0581\u0576\u0565\u0576\u0584",
  "\u0561\u057e\u0561\u0580\u057f\u0565\u0581\u056b\u0576\u0584 \u0564\u0561\u057d\u0568",
];

const REDIRECT_CANNED_PREFIX =
  "\u0540\u0561\u057d\u056f\u0561\u0576\u0578\u0582\u0574 \u0565\u0574, " +
  "\u0562\u0561\u0575\u0581 \u0561\u0580\u056b\u055b \u0576\u0561\u056d \u0561\u057e\u0561\u0580\u057f\u0565\u0576\u0584 " +
  "\u0568\u0576\u0569\u0561\u0581\u056b\u056f \u0570\u0561\u0580\u0581\u0568 \ud83d\ude0a";
const C7_EVALUATION_RESERVATION_PREFIX = "__C7_EVALUATING__:";

function c7EvaluationReservation(reference: string, attemptSequence: number): string {
  return `${C7_EVALUATION_RESERVATION_PREFIX}${reference}:${attemptSequence}`;
}

function validateNoScopeDrift(studentMessage: string, allNodeTitles: string[]): boolean {
  const lower = studentMessage.toLowerCase();
  const hasDriftPhrase = SCOPE_DRIFT_PHRASES.some((p) => lower.includes(p));
  if (!hasDriftPhrase) return false;
  const refersToKnownNode = allNodeTitles.some((t) => lower.includes(t.toLowerCase()));
  return !refersToKnownNode;
}

function normalizeShortAnswerToken(message: string): string {
  return message
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;!?։\u0589\u055b\u055c\u055d\u055e\u055f…)\]]+$/g, "")
    .trim();
}

function isCanonicalShortAnswer(message: string): boolean {
  const normalized = normalizeShortAnswerToken(message);
  return /^(?:[a-dա-դ]|ճիշտ|սխալ|true|false)$/iu.test(normalized);
}

function buildPhaseGuidance(phase: number, topicName: string, subjectName: string): string {
  switch (phase) {
    case 1:
      return `REVIEW PHASE — spaced-repetition review of PREVIOUS ${subjectName} lessons (NOT «${topicName}»).
Ask 3-5 questions, one at a time. After student answers each → give feedback → next question.
After all questions, show a brief accuracy summary.
Use DUE_REVIEWS topics (if listed above) as priority targets.`;

    case 2:
      return `TEACHING PHASE — strict server-owned TEACH → MICRO_CHECK → FEEDBACK → TRANSITION cycle:
Step 1. Present ONE concept from APPROVED_EXPLANATION above (2-3 sentences, plain language).
Step 2. Stop. The backend separately creates exactly one MICRO_CHECK question.
Step 3. Wait for student answer → FEEDBACK (correct/guide) only.
Step 4. The backend selects the next concept, generated check, or eligible CLASS_EXERCISE. It renders source exercise text.
Step 5. Do NOT present a new exercise until student demonstrates understanding of the current one.
NEVER give the answer directly — always hint and guide.

EXERCISE TRANSITION RULE (mandatory — never skip):
- If CLASS_EXERCISE_CANDIDATES appear in this context AND you have already asked 2 or more MICRO_CHECK questions on this node → you MUST transition to one candidate NOW using teaching_mode: "TRANSITION". Do NOT invent another MICRO_CHECK.
- Set source_fidelity.exercise_id to the chosen eligible candidate's exact ID. Do NOT quote, paraphrase, or render any source exercise text in student_message; the backend delivers the one active exercise.
- Only move to the next exercise after the student has attempted the current one.

NO-EXERCISE COMPLETION RULE:
- If CLASS_EXERCISE_CANDIDATES is ABSENT from this context (the node has no exercises) AND you have already asked 2+ MICRO_CHECK questions showing the student understands → set node_decision.action = "COMPLETE_NODE" to advance. Do NOT keep inventing more questions.`;

    case 3:
      return `LESSON WRAP-UP PHASE — all lesson nodes have been taught.
STRICT BOUNDARY: Work ONLY with the concepts from COMPLETED_NODES listed above. Do NOT introduce any new mathematical concept, topic, definition, or skill from outside this lesson's node list. Do NOT start a new chapter or curriculum section.
Step 1. Give a warm, concise summary (3-5 sentences) of what was learned in this lesson, referencing the node topics by name.
Step 2. If DEEP_DIVE_EXERCISES are listed above, present them ONE AT A TIME (starting from the given index) verbatim. Ask the student to attempt each before moving on. Evaluate answers using the same MICRO_CHECK/FEEDBACK cycle. Do NOT invent exercises that are not listed.
Step 3. If HOMEWORK_TASKS are listed above, present them warmly and verbatim after exercises are done. Briefly explain why each task matters.
Step 4. When exercises and homework are presented, close the session with encouragement.
If neither DEEP_DIVE_EXERCISES nor HOMEWORK_TASKS are available, proceed directly to a warm closing summary.`;

    case 4:
      return `HOMEWORK PRESENTATION PHASE:
Present the student's homework assignment warmly and clearly.
Use verbatim exercise texts if available. Briefly explain why each task matters.
Close the session with warm encouragement for the next lesson.`;

    default:
      return `Guide the student through «${topicName}» in ${subjectName}. Armenian only.`;
  }
}

async function advanceNodeInSession(
  sessionId: number,
  userId: number,
  lessonId: number,
  currentNodeId: number,
  currentPhase: number,
  reviewNeeded: boolean,
  canonicalC6Decision?: Awaited<ReturnType<typeof resolveCanonicalC6Decision>>,
  expectedExecutionTarget?: Pick<
    C7ExecutionTarget,
    "microNodeId" | "activeCognitiveLevelId"
  >,
): Promise<{
  newNodeId: number | null;
  newPhase: number;
  allNodesDone: boolean;
  c6BlockedReason?: "C2_PATH_UNAVAILABLE" | "DEPENDENCY_CYCLE" | "DEPENDENCY_TARGET_MISSING";
}> {
  const c6Decision = canonicalC6Decision ?? await resolveCanonicalC6Decision({
    learnerId: userId,
    lessonId,
    afterMicroNodeId: currentNodeId,
    entryIntent: "NORMAL_LEARNING",
  });
  const c6BlockedReason =
    c6Decision.reasonCode === "C2_PATH_UNAVAILABLE" ||
    c6Decision.reasonCode === "DEPENDENCY_CYCLE" ||
    c6Decision.reasonCode === "DEPENDENCY_TARGET_MISSING"
      ? c6Decision.reasonCode
      : undefined;
  if (c6BlockedReason) {
    logger.warn(
      {
        sessionId,
        lessonId,
        currentNodeId,
        c6Reason: c6BlockedReason,
      },
      "chat: automatic node completion blocked by unavailable C6 target",
    );
    return {
      newNodeId: currentNodeId,
      newPhase: currentPhase,
      allNodesDone: false,
      c6BlockedReason,
    };
  }

  const allNodesDone =
    c6Decision.microNodeId === null &&
    c6Decision.reasonCode === "NO_ELIGIBLE_MICRONODE" &&
    c6Decision.decisionType === "ADVANCE";
  let newPhase = currentPhase;
  let newNodeId: number | null = c6Decision.microNodeId;

  if (allNodesDone && currentPhase === 2) {
    newPhase = 3;
    newNodeId = null;
  }

  const transitioned = await applyAuthorizedTargetTransition({
    sessionId,
    currentNodeId: newNodeId,
    nextPhase: newPhase,
    nextActiveCognitiveLevelId: c6Decision.nextTargetCognitiveLevelId,
    reviewNeeded,
    expectedCurrentNodeId: expectedExecutionTarget?.microNodeId,
    expectedActiveCognitiveLevelId: expectedExecutionTarget?.activeCognitiveLevelId,
  });
  if (!transitioned) {
    throw new Error("authorized C7 target transition lost its execution-target compare-and-swap");
  }

  logger.info(
    {
      sessionId,
      lessonId,
      c6DecisionType: c6Decision.decisionType,
      c6TargetNodeId: c6Decision.microNodeId,
      c6TargetLevelId: c6Decision.nextTargetCognitiveLevelId,
      c6Reason: c6Decision.reasonCode,
      c6PrerequisiteStatus: c6Decision.prerequisiteStatus,
    },
    "chat: node advancement resolved by canonical C6 decision",
  );

  return { newNodeId, newPhase, allNodesDone };
}

type ChatEvidenceSnapshot = {
  id: number;
  currentNodeId: number | null;
  nodeTeachingStage: string;
  activeTaskProvenance: string | null;
  activeTaskReference: string | null;
  activeLessonExerciseId: number | null;
  activeCognitiveLevelId: number | null;
  activeAttemptSequence: number;
  activeHelpCount: number;
  activeAssistanceLevel: string;
  activeTaskSnapshot: CanonicalTaskSnapshot | null;
};

/**
 * Persists the current answer through C3 before C4 reads it. This is purposefully
 * called before C7's candidate engine; no caller may resolve C6 until it returns.
 */
async function persistAndProjectChatEvidence(input: {
  userId: number;
  lessonId: number;
  snapshot: ChatEvidenceSnapshot;
  currentNodeId: number;
  currentNodeMatchesSnapshot: boolean;
  cognitivePath: CognitiveLevelRow[];
  evidenceQuality: string;
  wasCorrect: boolean | null;
  evidenceResultAuthority: string | null;
  executionTarget: C7ExecutionTarget;
  evaluationSnapshot?: {
    status: string;
    evidenceQuality: string;
    errorFamily: string | null;
    errorStability: string | null;
  };
}): Promise<{
  qualificationStatus: EvidenceQualificationStatus;
  projection: LearnerCeilingProjection;
  taskReference: string | null;
}> {
  const [lessonRow] = await db
    .select({ subjectId: (lessonsTable as any).subjectId })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, input.lessonId))
    .limit(1);
  if (!lessonRow?.subjectId || input.snapshot.currentNodeId === null) {
    throw new Error("chat evidence requires lesson subject and current node");
  }

  const [existingKN] = await db
    .select({ id: knowledgeNodesTable.id })
    .from(knowledgeNodesTable)
    .where(and(
      eq(knowledgeNodesTable.subjectId, lessonRow.subjectId),
      eq(knowledgeNodesTable.userId, input.userId),
      eq(knowledgeNodesTable.lessonNodeId, input.snapshot.currentNodeId),
    ))
    .limit(1);
  let topicId = existingKN?.id ?? null;
  if (!topicId) {
    const [node] = await db
      .select({ title: lessonNodesTable.title, targetBloomLevel: lessonNodesTable.targetBloomLevel })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.id, input.snapshot.currentNodeId))
      .limit(1);
    if (!node) throw new Error("chat evidence requires current lesson node");
    const [created] = await db.insert(knowledgeNodesTable).values({
      subjectId: lessonRow.subjectId,
      userId: input.userId,
      topicName: node.title,
      lessonNodeId: input.snapshot.currentNodeId,
      status: "not_started",
      isProvisional: true,
      bloomLevel: node.targetBloomLevel ?? 1,
    }).returning({ id: knowledgeNodesTable.id });
    topicId = created?.id ?? null;
  }
  if (!topicId) throw new Error("chat evidence could not create knowledge node");

  const activeLevel = input.snapshot.activeCognitiveLevelId == null
    ? null
    : input.cognitivePath.find((level) => level.id === input.snapshot.activeCognitiveLevelId) ?? null;
  const levelBelongsToNode = activeLevel !== null && input.currentNodeMatchesSnapshot;
  const acceptedPath = levelBelongsToNode && input.cognitivePath.length > 0;
  const taskSnapshot = input.snapshot.activeTaskSnapshot;
  if (
    !taskSnapshot ||
    taskSnapshot.taskReference !== input.snapshot.activeTaskReference ||
    taskSnapshot.attemptSequence !== input.snapshot.activeAttemptSequence ||
    taskSnapshot.lessonNodeId !== input.snapshot.currentNodeId ||
    taskSnapshot.cognitiveLevelId !== input.snapshot.activeCognitiveLevelId
  ) {
    throw new Error("chat evidence requires a matching immutable canonical task snapshot");
  }
  const provenance = input.snapshot.activeTaskProvenance;
  const taskSource: TaskSource | null =
    taskSnapshot.taskSource === "micro_check" ? "micro_check"
      : taskSnapshot.taskSource === "source_exercise" ? "source_exercise"
        : taskSnapshot.taskSource === "generated_task" ? "generated_task" : null;
  const cappedQuality =
    provenance === "micro_check" &&
    (input.evidenceQuality === "STRONG" || input.evidenceQuality === "CONCLUSIVE")
      ? "MODERATE"
      : input.evidenceQuality;

  const taskValidForLevel =
    taskSnapshot.targetCompatibleAtActivation &&
    taskSnapshot.lessonNodeId === input.executionTarget.microNodeId &&
    taskSnapshot.cognitiveLevelId === input.executionTarget.activeCognitiveLevelId &&
    (taskSource === "source_exercise" || taskSource === "micro_check");
  const authoritativeResult =
    (taskSource === "micro_check" && input.evidenceResultAuthority === "objective_task") ||
    (taskSource === "source_exercise" && input.evidenceResultAuthority === "source_exercise");
  const qualificationStatus = classifyQualifyingEvidence({
    lessonNodeId: input.snapshot.currentNodeId,
    cognitiveLevelId: input.snapshot.activeCognitiveLevelId,
    taskSource,
    taskReference: input.snapshot.activeTaskReference,
    levelBelongsToNode,
    acceptedPath,
    taskValidForLevel,
    authoritativeResult,
  });
  const assistanceLevel = input.snapshot.activeAssistanceLevel;
  // A reservation can be released after a transient failure. Avoid recording
  // the same immutable task/attempt twice if the evidence insert committed
  // before the mutable session row could be finalized.
  const [existingEvidence] = await db
    .select({
      qualificationStatus: (evidenceEventsTable as any).qualificationStatus,
      metadata: evidenceEventsTable.metadata,
      id: evidenceEventsTable.id,
    })
    .from(evidenceEventsTable)
    .where(and(
      eq((evidenceEventsTable as any).lessonSessionId, input.snapshot.id),
      eq((evidenceEventsTable as any).taskReference, input.snapshot.activeTaskReference),
      eq(
        (evidenceEventsTable as any).attemptSequence,
        input.snapshot.activeAttemptSequence || 1,
      ),
    ))
    .limit(1);
  if (existingEvidence) {
    const projection = await projectLearnerCognitiveCeiling(
      input.userId,
      input.snapshot.currentNodeId,
    );
    const existingMetadata = (existingEvidence.metadata ?? {}) as Record<string, unknown>;
    if (existingMetadata.c4ProjectionCompleted !== true) {
      await db
        .update(evidenceEventsTable)
        .set({
          metadata: {
            ...existingMetadata,
            c4ProjectionCompleted: true,
          },
        } as any)
        .where(eq(evidenceEventsTable.id, existingEvidence.id));
    }
    return {
      qualificationStatus:
        (existingEvidence.qualificationStatus as EvidenceQualificationStatus) ??
        qualificationStatus,
      projection,
      taskReference: input.snapshot.activeTaskReference,
    };
  }
  const evidenceMetadata = {
    source: "chat",
    lessonId: input.lessonId,
    nodeId: input.snapshot.currentNodeId,
    stage: input.snapshot.nodeTeachingStage,
    evidence_quality: cappedQuality,
    qualification_status: qualificationStatus,
    // This immutable C3 record is also the recovery authority for a
    // FEEDBACK retry after the mutable active-task fields are retired.
    evaluation: input.evaluationSnapshot ?? null,
    c7ExecutionTarget: {
      lessonId: input.executionTarget.lessonId,
      microNodeId: input.executionTarget.microNodeId,
      activeCognitiveLevelId: input.executionTarget.activeCognitiveLevelId,
    },
    canonicalTaskSnapshot: taskSnapshotForEvidence(taskSnapshot),
    assistanceAtEvaluation: {
      helpCount: input.snapshot.activeHelpCount,
      assistanceLevel: input.snapshot.activeAssistanceLevel,
    },
    c4ProjectionCompleted: false,
  };
  const [insertedEvidence] = await db.insert(evidenceEventsTable).values({
    userId: input.userId,
    lessonSessionId: input.snapshot.id,
    topicId,
    eventType: "answer",
    wasCorrect: input.wasCorrect,
    responseTimeMs: null,
    hintUsed: assistanceLevel !== "none",
    metadata: evidenceMetadata,
    cognitiveLevel: activeLevel?.cognitiveLevel ?? null,
    taskDifficulty: null,
    assistanceLevel: assistanceLevel !== "none" ? assistanceLevel : "none",
    lessonExerciseId: taskSnapshot.lessonExerciseId,
    interactionType: taskSnapshot.interactionType,
    attemptSequence: input.snapshot.activeAttemptSequence || 1,
    helpCount: input.snapshot.activeHelpCount,
    lessonNodeId: input.snapshot.currentNodeId,
    cognitiveLevelId: input.snapshot.activeCognitiveLevelId,
    quizQuestionId: null,
    taskSource,
    taskReference: input.snapshot.activeTaskReference,
    qualificationStatus,
    evidenceQuality: cappedQuality,
  } as any).onConflictDoNothing().returning({ id: evidenceEventsTable.id });
  if (!insertedEvidence) {
    const [duplicateEvidence] = await db
      .select({ id: evidenceEventsTable.id })
      .from(evidenceEventsTable)
      .where(and(
        eq((evidenceEventsTable as any).lessonSessionId, input.snapshot.id),
        eq((evidenceEventsTable as any).taskReference, input.snapshot.activeTaskReference),
        eq((evidenceEventsTable as any).attemptSequence, input.snapshot.activeAttemptSequence || 1),
      ))
      .limit(1);
    if (!duplicateEvidence) throw new Error("C3 task-attempt conflict could not be recovered");
    const projection = await projectLearnerCognitiveCeiling(input.userId, input.snapshot.currentNodeId);
    return { qualificationStatus, projection, taskReference: input.snapshot.activeTaskReference };
  }
  const projection = await projectLearnerCognitiveCeiling(
    input.userId,
    input.snapshot.currentNodeId,
  );
  await db
    .update(evidenceEventsTable)
    .set({
      metadata: {
        ...evidenceMetadata,
        c4ProjectionCompleted: true,
      },
    } as any)
    .where(eq(evidenceEventsTable.id, insertedEvidence.id));
  updateTopicScoring(topicId, input.userId).catch((err) =>
    logger.error({ err, topicId }, "chat evidence: scoring failed"),
  );
  return { qualificationStatus, projection, taskReference: input.snapshot.activeTaskReference };
}

router.post("/chat", requireAuth, async (req: AuthRequest, res) => {
  const { message, lessonId } = req.body as { message: string; lessonId?: number };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // V2-R4A: Capture the exact moment this qualifying event arrived.
  // Used for active-time credit computation (inter-turn capped interval).
  const requestReceivedAt = new Date();
  const userMessageAt = Date.now();
  let sessionId: number | null = null;
  let teachingMode = "TEACH";
  // Phase 2B: tracks whether this response has an active assessable task
  // (MICRO_CHECK or EXERCISE stage). Sent in res.json so frontend shows/hides Help button.
  let hasActiveTask = false;
  // V2-R1.1: set inside if (wasEval) when FEEDBACK stage machine advances MICRO_CHECK→EXERCISE.
  // Triggers automatic exercise delivery as a second persisted message (no learner "ok" needed).
  let _v2r1AutoContinue: { type: "exercise" } | null = null;

  let lessonContext = "";
  let topicName = "";
  let _allNodeTitles: string[] = [];
  // True only on the turn where introConfirmed flips false→true.
  // Used to inject a "begin teaching now" directive into lessonContext.
  let introConfirmedThisTurn = false;
  // Hoisted so the intro gate (below) can read them outside the lessonId block
  let lesson: (typeof lessonsTable.$inferSelect) | null = null;
  let studentName: string | null = null;
  let progressIndicator: ProgressIndicator = {
    current_node_name: "",
    step: 0,
    total_steps: 0,
    completed_nodes: 0,
    total_nodes: 0,
  };

  type SessionRef = {
    id: number; currentPhase: number; currentNodeId: number | null; status: string;
    lastQuestionAsked: string | null; askedQuestionTemplates: string[]; nodeAttemptCount: number;
    reviewQuestionCount: number; deepDiveExerciseIndex: number;
    startedAt: Date | null;
    nodeStartedAt: Date | null;
    // Per-session node-progress counters (relocated from lessonNodesTable)
    nodeMasteryEvidenceCount: number;
    nodeConsecutiveCorrect: number;
    nodeConsecutiveIncorrect: number;
    nodeLastEvidenceQuality: string | null;
    nodeTeachingStage: string;
    phase1ConsecutiveCorrect: number;
    introConfirmed: boolean;
    // Phase 2B: active task identity for evidence + help
    activeLessonExerciseId: number | null;
    activeCognitiveLevelId: number | null;
    activeTaskProvenance: string | null;
    activeTaskReference: string | null;
    activeObjectiveTaskPayload: ActiveObjectiveTaskPayload | null;
    activeAttemptSequence: number;
    activeHelpCount: number;
    activeAssistanceLevel: string;
    activeTaskSnapshot: CanonicalTaskSnapshot | null;
    // V2-R3: pedagogical remediation step (0 = initial, 1–5 = escalation)
    remediationStep: number;
    // V2-R4A: learning budget fields (snapshot from lesson at session creation)
    requiredSessionMinutes: number | null;
    activeLearningSeconds: number;
    lastActivityAt: Date | null;
    // V2-R4A.3: required-session completion + optional continuation
    requiredSessionCompletedAt: Date | null;
    optionalContinuation: boolean;
  };
  let session: SessionRef | null = null;
  // Source-exercise identity is kept locally only as a mirror of the exact
  // persisted activeLessonExerciseId written by activateSourceExercise().
  let _activeLessonExerciseIdForDelivery: number | null = null;
  let _p11SelectedSourceExercise: LessonExerciseRow | null = null;
  let _sourceExerciseActivatedThisTurn = false;
  let _sourceExerciseDeliveredThisTurn = false;

  type NodeRef = {
    id: number; title: string; theoryContent: string | null;
    targetBloomLevel: number; estimatedMinutes: number;
    childFriendlyExplanation: string | null;
    basicExamples: unknown; realLifeExamples: unknown;
    commonMisconception: string | null; prerequisiteNodes: unknown;
    teachingStage: string | null;
    verbatimTheoryAnchor: string | null;
    nonExamples: unknown;
    learningObjective: string | null;
    cogPathStatus: string | null;
  };
  let currentNodeRecord: NodeRef | null = null;

  // FIX: hoisted to outer scope so the mastery-gate 0-exercise check below can see it.
  let classExercises: (typeof lessonExercisesTable.$inferSelect)[] = [];
  // V2-R3: hoisted so the wasEval block and fire-and-forget evidence block can both access them.
  let _pedagogicalDecision: PedagogicalDecision | null = null;
  let _postFeedbackContinuationPlan: Phase2ServerActionPlan | null = null;
  let _postFeedbackExcludedExerciseId: number | null = null;
  let _feedbackJobInvocationCount = 0;
  let _cognitivePath: CognitiveLevelRow[] = [];
  let _activeCognitiveLevelRow: CognitiveLevelRow | null = null;
  let _c7ExecutionTarget: C7ExecutionTarget | null = null;
  let _nextNodeHasCriticalDep = false;
  let _deferredC7Action: "ADVANCE_COGNITIVE_LEVEL" | "COMPLETE_MICRONODE" | null = null;
  let _deferredC6Decision: Awaited<ReturnType<typeof resolveCanonicalC6Decision>> | null = null;
  let _deferredSafetyCapHit = false;

  if (lessonId) {
    const [lessonRow] = await db
      .select()
      .from(lessonsTable)
      .where(eq(lessonsTable.id, lessonId))
      .limit(1);
    lesson = lessonRow ?? null;

    if (lesson) {
      const [sessionRow] = await db
        .select()
        .from(lessonSessionsTable)
        .where(and(eq(lessonSessionsTable.lessonId, lessonId), eq(lessonSessionsTable.userId, req.userId!)))
        .limit(1);

      if (sessionRow) {
        session = {
          id: sessionRow.id,
          currentPhase: sessionRow.currentPhase,
          currentNodeId: sessionRow.currentNodeId ?? null,
          status: sessionRow.status,
          lastQuestionAsked: sessionRow.lastQuestionAsked ?? null,
          askedQuestionTemplates: Array.isArray(sessionRow.askedQuestionTemplates)
            ? (sessionRow.askedQuestionTemplates as string[])
            : [],
          nodeAttemptCount: sessionRow.nodeAttemptCount ?? 0,
          reviewQuestionCount: sessionRow.reviewQuestionCount ?? 0,
          deepDiveExerciseIndex: sessionRow.deepDiveExerciseIndex ?? 0,
          startedAt: sessionRow.startedAt ?? null,
          nodeStartedAt: sessionRow.nodeStartedAt ?? null,
          nodeMasteryEvidenceCount: sessionRow.nodeMasteryEvidenceCount ?? 0,
          nodeConsecutiveCorrect: sessionRow.nodeConsecutiveCorrect ?? 0,
          nodeConsecutiveIncorrect: sessionRow.nodeConsecutiveIncorrect ?? 0,
          nodeLastEvidenceQuality: sessionRow.nodeLastEvidenceQuality ?? null,
          nodeTeachingStage: sessionRow.nodeTeachingStage ?? "THEORY",
          phase1ConsecutiveCorrect: sessionRow.phase1ConsecutiveCorrect ?? 0,
          introConfirmed: sessionRow.introConfirmed ?? false,
          // Phase 2B active task identity
          activeLessonExerciseId: (sessionRow as any).activeLessonExerciseId ?? null,
          activeCognitiveLevelId: (sessionRow as any).activeCognitiveLevelId ?? null,
          activeTaskProvenance:   (sessionRow as any).activeTaskProvenance   ?? null,
           activeTaskReference:    (sessionRow as any).activeTaskReference    ?? null,
           activeTaskSnapshot: isCanonicalTaskSnapshot((sessionRow as any).activeTaskSnapshot)
             ? (sessionRow as any).activeTaskSnapshot
             : null,
          activeObjectiveTaskPayload: (sessionRow as any).activeObjectiveTaskPayload ?? null,
          activeAttemptSequence:  (sessionRow as any).activeAttemptSequence  ?? 0,
          activeHelpCount:        (sessionRow as any).activeHelpCount        ?? 0,
          activeAssistanceLevel:  (sessionRow as any).activeAssistanceLevel  ?? "none",
          // V2-R3
          remediationStep:        (sessionRow as any).remediationStep        ?? 0,
          // V2-R4A: learning budget
          requiredSessionMinutes:      (sessionRow as any).requiredSessionMinutes      ?? null,
          activeLearningSeconds:       (sessionRow as any).activeLearningSeconds       ?? 0,
          lastActivityAt:              (sessionRow as any).lastActivityAt              ?? null,
          requiredSessionCompletedAt:  (sessionRow as any).requiredSessionCompletedAt  ?? null,
          optionalContinuation:        (sessionRow as any).optionalContinuation        ?? false,
        };
        sessionId = sessionRow.id;
        _activeLessonExerciseIdForDelivery = session.activeLessonExerciseId;

        if (session.activeTaskReference?.startsWith(C7_EVALUATION_RESERVATION_PREFIX)) {
          const marker = session.activeTaskReference;
          const separator = marker.lastIndexOf(":");
          const originalTaskReference =
            separator > C7_EVALUATION_RESERVATION_PREFIX.length
              ? marker.slice(C7_EVALUATION_RESERVATION_PREFIX.length, separator)
              : null;
          const [persistedEvidence] = originalTaskReference === null
            ? []
            : await db
              .select({
                id: evidenceEventsTable.id,
                metadata: evidenceEventsTable.metadata,
              })
              .from(evidenceEventsTable)
              .where(and(
                eq((evidenceEventsTable as any).lessonSessionId, session.id),
                eq((evidenceEventsTable as any).taskReference, originalTaskReference),
              ))
              .limit(1);
          if (persistedEvidence) {
            try {
              const metadata = (persistedEvidence.metadata ?? {}) as Record<string, unknown>;
              if (metadata.c4ProjectionCompleted !== true) {
                // C3 may have committed immediately before a C4 failure.
                // Re-run the idempotent C4 projection before this task can
                // become FEEDBACK-recoverable.
                await projectLearnerCognitiveCeiling(req.userId!, session.currentNodeId!);
                await db
                  .update(evidenceEventsTable)
                  .set({
                    metadata: {
                      ...metadata,
                      c4ProjectionCompleted: true,
                    },
                  } as any)
                  .where(eq(evidenceEventsTable.id, persistedEvidence.id));
              }
              // A process may have stopped after C3/C4 committed but before
              // the mutable session finalized. Recover the safe boundary now.
              await db
                .update(lessonSessionsTable)
                .set(buildMandatoryFeedbackStageUpdate() as any)
                .where(and(
                  eq(lessonSessionsTable.id, session.id),
                  eq((lessonSessionsTable as any).activeTaskReference, marker),
                ));
            } catch (projectionError) {
              logger.error(
                { err: projectionError, sessionId: session.id },
                "C7.1: reservation recovery could not complete C4 projection",
              );
              res.status(503).json({
                error: "EVIDENCE_PROJECTION_RECOVERY_FAILED",
                message: "Պատասխանը գրանցված է, բայց առաջընթացը դեռ վերականգնվում է։ Խնդրում ենք կրկին փորձել։",
              });
              return;
            }
          } else if (originalTaskReference !== null) {
            // C3 did not commit, so make the original immutable task retryable.
            await db
              .update(lessonSessionsTable)
              .set({ activeTaskReference: originalTaskReference } as any)
              .where(and(
                eq(lessonSessionsTable.id, session.id),
                eq((lessonSessionsTable as any).activeTaskReference, marker),
              ));
          }
          res.status(409).json({
            error: persistedEvidence
              ? "TASK_EVALUATION_RECOVERED"
              : "TASK_EVALUATION_RETRYABLE",
            message: persistedEvidence
              ? "Պատասխանը անվտանգ գրանցվել է։ Խնդրում ենք թարմացնել դասը։"
              : "Գնահատումը չի ավարտվել։ Կարող ես նույն առաջադրանքին նորից պատասխանել։",
          });
          return;
        }

        // A completed required session may continue only when the server has
        // explicitly enabled optional continuation. Block before action
        // planning so no post-budget TASK_REQUIRED state can emit new work.
        if (session.requiredSessionCompletedAt !== null && !session.optionalContinuation) {
          res.status(409).json({
            error: "REQUIRED_SESSION_COMPLETE",
            message: "Պարտադիր ուսուցման ժամանակը ավարտվել է։ Շարունակությունը պետք է թույլատրվի ուսուցման պլանով։",
            requiredSessionCompletedAt: session.requiredSessionCompletedAt.toISOString(),
          });
          return;
        }
        if (session.nodeTeachingStage === "REVISIT_REQUIRED") {
          res.status(409).json({
            error: "TARGET_REVISIT_REQUIRED",
            message: "Այս հատվածին պետք է վերադառնալ ավելի ուշ։ Նոր առաջադրանք կարող է ընտրել միայն ուսուցման պլանը։",
          });
          return;
        }
      }

      // Direct chat entry must obey the same C6 reconciliation as normal
      // lesson entry. Keep a real active task immutable; otherwise stale or
      // mastered targets are re-resolved before any teaching prompt is built.
      const hasAuthoritativeActiveTask =
        session?.activeTaskProvenance !== null ||
        session?.activeLessonExerciseId !== null ||
        session?.activeTaskReference !== null ||
        // A C7.2 FEEDBACK boundary owns an immutable evaluated-task snapshot.
        // It must be recovered before C6 resume reconciliation may consider a
        // new target.
        session?.nodeTeachingStage === "FEEDBACK";
      if (
        session &&
        session.currentPhase === 2 &&
        !hasAuthoritativeActiveTask
      ) {
        // A resume must refresh persisted C4 before C6 is allowed to select a
        // different MicroNode. This covers interrupted sessions without
        // reintroducing a second progression authority.
        let resumeC4Projection: LearnerCeilingProjection | null = null;
        if (session.currentNodeId !== null) {
          try {
            resumeC4Projection = await projectLearnerCognitiveCeiling(
              req.userId!,
              session.currentNodeId,
            );
          } catch (err) {
            logger.error(
              { err, sessionId: session.id, nodeId: session.currentNodeId },
              "C7.1: C4 refresh failed during chat resume reconciliation",
            );
            res.status(503).json({
              error: "EVIDENCE_PERSISTENCE_FAILED",
              message: "Դասի առաջընթացը չի հաջողվել վստահելիորեն ստուգել։ Խնդրում ենք կրկին փորձել։",
            });
            return;
          }
        }
        const c6Decision = await resolveCanonicalC6Decision({
          learnerId: req.userId!,
          lessonId,
          requestedMicroNodeId: session.currentNodeId,
          entryIntent: "NORMAL_LEARNING",
        });
        if (isC6DeliveryBlocked(c6Decision)) {
          res.status(409).json({
            error: "C6_TARGET_UNAVAILABLE",
            message: "Այս հանգույցի ճանաչողական ուղին հաստատված չէ, ուստի ուսուցումը դեռ չի կարող շարունակվել։",
            reasonCode: c6Decision.reasonCode,
          });
          return;
        }
        const nodeChanged = session.currentNodeId !== c6Decision.microNodeId;
        const phaseAfterC6 =
          c6Decision.microNodeId === null &&
          c6Decision.decisionType === "ADVANCE"
            ? 3
            : session.currentPhase;
        if (nodeChanged && !resumeC4Projection?.reachedTarget) {
          logger.warn(
            {
              sessionId: session.id,
              currentNodeId: session.currentNodeId,
              c6TargetNodeId: c6Decision.microNodeId,
              c4PathAccepted: resumeC4Projection?.pathAccepted ?? false,
              c4ReachedTarget: resumeC4Projection?.reachedTarget ?? false,
            },
            "C7.1: chat resume refused node change without confirmed C4 target",
          );
          res.status(409).json({
            error: "CURRENT_NODE_NOT_CANONICALLY_COMPLETED",
            message: "Ընթացիկ հանգույցի ճանաչողական ապացույցները դեռ բավարար չեն։",
          });
          return;
        }
        if (
          nodeChanged ||
          session.activeCognitiveLevelId !== c6Decision.nextTargetCognitiveLevelId ||
          session.currentPhase !== phaseAfterC6
        ) {
          if (nodeChanged) {
            const transitioned = await applyAuthorizedTargetTransition({
              sessionId: session.id,
              currentNodeId: c6Decision.microNodeId,
              nextPhase: phaseAfterC6,
              nextActiveCognitiveLevelId: c6Decision.nextTargetCognitiveLevelId,
            });
            if (!transitioned) {
              res.status(409).json({
                error: "STALE_C6_TARGET",
                message: "Ուսուցման թիրախը փոխվել է։ Խնդրում ենք կրկին փորձել։",
              });
              return;
            }
          } else if (c6Decision.nextTargetCognitiveLevelId !== null) {
            const transitioned = await applyAuthorizedLevelTransition({
              sessionId: session.id,
              nextActiveCognitiveLevelId: c6Decision.nextTargetCognitiveLevelId,
              expectedCurrentNodeId: session.currentNodeId,
              expectedActiveCognitiveLevelId: session.activeCognitiveLevelId,
            });
            if (!transitioned) {
              res.status(409).json({
                error: "STALE_C6_TARGET",
                message: "Ուսուցման թիրախը փոխվել է։ Խնդրում ենք կրկին փորձել։",
              });
              return;
            }
          }
          session.currentNodeId = c6Decision.microNodeId;
          session.activeCognitiveLevelId = c6Decision.nextTargetCognitiveLevelId;
          session.currentPhase = phaseAfterC6;
          if (nodeChanged) {
            session.nodeStartedAt = c6Decision.microNodeId ? new Date() : null;
            session.nodeTeachingStage = "THEORY";
          }
        }
      }

      // ── V2-R4A: Active-time accounting ────────────────────────────────────
      // POST /api/chat is the ONLY qualifying event; GET requests, session-state
      // calls, refresh hydration, and frontend polling NEVER reach this path.
      //
      // First-activity semantics (Part 8): if lastActivityAt IS NULL, credit 0 s
      // and set the anchor — avoids crediting idle time before first interaction.
      //
      // Concurrency safety (Part 9): atomic SQL increment on active_learning_seconds
      // (active_learning_seconds = active_learning_seconds + $credit) so concurrent
      // requests cannot overwrite each other's increments.
      if (session) {
        let _activeCredit = 0;
        if (session.lastActivityAt !== null) {
          const deltaMs  = requestReceivedAt.getTime() - session.lastActivityAt.getTime();
          const deltaSec = Math.floor(deltaMs / 1000);
          _activeCredit  = Math.min(deltaSec, ACTIVE_INTERVAL_CAP_SECONDS);
        }
        await db
          .update(lessonSessionsTable)
          .set({
            activeLearningSeconds: sql`${lessonSessionsTable.activeLearningSeconds} + ${_activeCredit}`,
            lastActivityAt: requestReceivedAt,
          })
          .where(eq(lessonSessionsTable.id, session.id));
        // Update local snapshot so budget computation on this turn sees updated value.
        session.activeLearningSeconds += _activeCredit;
        session.lastActivityAt = requestReceivedAt;
      }

      const phase        = session?.currentPhase ?? 1;
      const subjectName  = (lesson as { subjectName?: string }).subjectName ?? "Subject";
      const coreProblem  = (lesson as { coreProblem?: string | null }).coreProblem ?? null;
      const coreIdea     = (lesson as { coreIdea?: string | null }).coreIdea ?? null;
      const essentialQuestion = (lesson as { essentialQuestion?: string | null }).essentialQuestion ?? null;
      const knowledgeBoundaries = (lesson as { knowledgeBoundaries?: string[] }).knowledgeBoundaries ?? [];

      const [studentRow] = await db
        .select({ fullName: usersTable.fullName })
        .from(usersTable)
        .where(eq(usersTable.id, req.userId!))
        .limit(1);
      studentName = studentRow?.fullName ?? null;

      const allNodes = await db
        .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence, title: lessonNodesTable.title })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.lessonId, lessonId))
        .orderBy(asc(lessonNodesTable.sequence));

      const totalNodes      = allNodes.length;
      const currentNodeEntry = allNodes.find((n) => n.id === session?.currentNodeId);
      const currentNodeSeq   = currentNodeEntry?.sequence ?? (totalNodes + 1);
      const completedNodes   = session?.currentNodeId != null ? currentNodeSeq - 1 : totalNodes;
      // Titles of all nodes whose sequence comes before the current node — used in
      // the structured context header to explicitly forbid the AI from reteaching them.
      const completedNodeTitles = allNodes
        .filter((n) => n.sequence < currentNodeSeq)
        .map((n) => n.title);
      const futureNodeTitles = allNodes
        .filter((n) => n.sequence > currentNodeSeq)
        .map((n) => n.title);

      if (session?.currentNodeId) {
        const [nodeRow] = await db
          .select({
            id: lessonNodesTable.id, title: lessonNodesTable.title,
            theoryContent: lessonNodesTable.theoryContent,
            targetBloomLevel: lessonNodesTable.targetBloomLevel,
            estimatedMinutes: lessonNodesTable.estimatedMinutes,
            childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
            basicExamples: lessonNodesTable.basicExamples,
            realLifeExamples: lessonNodesTable.realLifeExamples,
            commonMisconception: lessonNodesTable.commonMisconception,
            prerequisiteNodes: lessonNodesTable.prerequisiteNodes,
            teachingStage: lessonNodesTable.teachingStage,
            verbatimTheoryAnchor: lessonNodesTable.verbatimTheoryAnchor,
            nonExamples: lessonNodesTable.nonExamples,
            learningObjective: lessonNodesTable.learningObjective,
            cogPathStatus: lessonNodesTable.cogPathStatus,
          })
          .from(lessonNodesTable)
          .where(eq(lessonNodesTable.id, session.currentNodeId))
          .limit(1);
        currentNodeRecord = nodeRow ?? null;
      }

      // ── V2-R3: Fetch confirmed cognitive path for current node ─────────────
      // Used by the Pedagogical Decision Engine.  Skipped when node is null.
      // Variables are hoisted to outer scope (_cognitivePath etc.) so the
      // wasEval block and fire-and-forget evidence block can both access them.
      if (session?.currentNodeId) {
        const _nodeId = session.currentNodeId; // narrow for callbacks
        const _sessId = session.id;
        let _sessActiveLevelId = session.activeCognitiveLevelId;

        const cogRows = await db
          .select({
            id:                       lessonNodeCognitiveLevelsTable.id,
            cognitiveLevel:           lessonNodeCognitiveLevelsTable.cognitiveLevel,
            sequence:                 lessonNodeCognitiveLevelsTable.sequence,
            isTargetCeiling:          lessonNodeCognitiveLevelsTable.isTargetCeiling,
            isApplicable:             lessonNodeCognitiveLevelsTable.isApplicable,
            minimumIndependentEvidence: lessonNodeCognitiveLevelsTable.minimumIndependentEvidence,
            preferredInteractionTypes: lessonNodeCognitiveLevelsTable.preferredInteractionTypes,
            performanceObjective:     (lessonNodeCognitiveLevelsTable as any).performanceObjective,
            successCriterion:         (lessonNodeCognitiveLevelsTable as any).successCriterion,
          })
          .from(lessonNodeCognitiveLevelsTable)
          .where(and(
            eq(lessonNodeCognitiveLevelsTable.lessonNodeId, _nodeId),
            eq(lessonNodeCognitiveLevelsTable.isApplicable, true),
          ))
          .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));

        const pathAcceptance = assessAcceptedCognitivePath({
          cogPathStatus: currentNodeRecord?.cogPathStatus ?? null,
          theoryContent: currentNodeRecord?.theoryContent ?? null,
          learningObjective: currentNodeRecord?.learningObjective ?? null,
          levels: cogRows,
        });
        _cognitivePath = pathAcceptance.accepted ? cogRows as CognitiveLevelRow[] : [];
        if (!pathAcceptance.accepted) {
          _activeCognitiveLevelRow = null;
          logger.info({
            sessionId: _sessId,
            lessonNodeId: _nodeId,
            cogPathStatus: currentNodeRecord?.cogPathStatus ?? null,
            reason: pathAcceptance.reason,
            groundingStatus: pathAcceptance.grounding?.status ?? null,
          }, "chat: modern Cognitive Path rejected; C7 delivery fails closed");
        }

        // Resolve active cognitive level from the persisted C6 target. A
        // pre-C6 session re-enters C6 rather than selecting a chat-local
        // first path level.
        if (_sessActiveLevelId) {
          _activeCognitiveLevelRow = _cognitivePath.find(
            (r) => r.id === _sessActiveLevelId
          ) ?? null;
        }
        const c7HasActiveExecutionBoundary =
          session.activeTaskProvenance !== null ||
          session.activeLessonExerciseId !== null ||
          session.activeTaskReference !== null ||
          session.nodeTeachingStage === "FEEDBACK";
        if (
          !_activeCognitiveLevelRow &&
          _cognitivePath.length > 0 &&
          !c7HasActiveExecutionBoundary
        ) {
          const c6Decision = await resolveCanonicalC6Decision({
            learnerId: req.userId!,
            lessonId: lessonId!,
            requestedMicroNodeId: _nodeId,
            entryIntent: "NORMAL_LEARNING",
          });
          if (
            c6Decision.microNodeId === _nodeId &&
            c6Decision.nextTargetCognitiveLevelId !== null
          ) {
            _activeCognitiveLevelRow = _cognitivePath.find(
              (row) => row.id === c6Decision.nextTargetCognitiveLevelId,
            ) ?? null;
            _sessActiveLevelId = _activeCognitiveLevelRow?.id ?? null;
            if (_activeCognitiveLevelRow) {
              if (session) session.activeCognitiveLevelId = _activeCognitiveLevelRow.id;
              await db
                .update(lessonSessionsTable)
                .set(buildAuthorizedLevelTransitionUpdate(
                  _activeCognitiveLevelRow.id,
                ) as any)
                .where(eq(lessonSessionsTable.id, _sessId));
            }
          }
        }

        // C7.3: this is a per-turn execution snapshot, never a second
        // progression authority. A Phase-2 turn without the C6-selected,
        // accepted C2 level fails closed instead of inventing a first/Bloom
        // fallback level.
        if (session.currentPhase === 2) {
          if (!_activeCognitiveLevelRow) {
            res.status(409).json({
              error: "C7_EXECUTION_TARGET_UNAVAILABLE",
              message: "Դասի ընթացիկ ճանաչողական նպատակը հասանելի չէ։ Խնդրում եմ կրկին սկսել դասը։",
            });
            return;
          }
          _c7ExecutionTarget = createC7ExecutionTarget({
            lessonId: lessonId!,
            currentNodeId: session.currentNodeId,
            activeCognitiveLevelId: _activeCognitiveLevelRow.id,
            node: currentNodeRecord!,
            acceptedPath: _cognitivePath,
          });
        }

        // Dependency gate: does the next node have a REQUIRED+CRITICAL dep on this node?
        const allNodesForDep = await db
          .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
          .from(lessonNodesTable)
          .where(eq(lessonNodesTable.lessonId, lessonId!))
          .orderBy(asc(lessonNodesTable.sequence));
        const curSeqForDep = allNodesForDep.find((n) => n.id === _nodeId)?.sequence ?? 0;
        const nextNodeForDep = allNodesForDep.find((n) => n.sequence > curSeqForDep);
        if (nextNodeForDep) {
          const [critDep] = await db
            .select({ id: lessonNodeDependenciesTable.id })
            .from(lessonNodeDependenciesTable)
            .where(and(
              eq(lessonNodeDependenciesTable.lessonId, lessonId!),
              eq(lessonNodeDependenciesTable.fromNodeId, _nodeId),
              eq(lessonNodeDependenciesTable.toNodeId, nextNodeForDep.id),
              eq(lessonNodeDependenciesTable.dependencyType, "REQUIRED"),
              eq((lessonNodeDependenciesTable as any).requiredLevel, "CRITICAL"),
            ))
            .limit(1);
          _nextNodeHasCriticalDep = !!critDep;
        }
      }

      topicName = currentNodeRecord?.title ?? lesson.title;

      progressIndicator = {
        current_node_name: topicName,
        step:            Math.min(currentNodeSeq, Math.max(totalNodes, 1)),
        total_steps:     totalNodes,
        completed_nodes: completedNodes,
        total_nodes:     totalNodes,
      };

      const allNodeIds = allNodes.map((n) => n.id);
      if (phase === 2 && session?.currentNodeId) {
        classExercises = await db
          .select()
          .from(lessonExercisesTable)
          .where(and(
            eq(lessonExercisesTable.relatedNodeId, session.currentNodeId),
            eq(lessonExercisesTable.assignment, "CLASS"),
            // Gate 1.4: only approved exercises reach AI Teacher. Fail-closed.
            eq(lessonExercisesTable.status, "approved"),
          ))
          .orderBy(asc(lessonExercisesTable.sequence));
        // C7.3: a Phase-2 source exercise must match both the C6 MicroNode and
        // the active accepted C2 level. Do not fall back to arbitrary exercises
        // on the node when the level has no linked task; the server will instead
        // choose a bounded generated MICRO_CHECK.
        if (_c7ExecutionTarget && classExercises.length > 0) {
          const cogTasks = await db
            .select({ lessonExerciseId: lessonNodeCognitiveTasksTable.lessonExerciseId })
            .from(lessonNodeCognitiveTasksTable)
            .where(eq(
              lessonNodeCognitiveTasksTable.cognitiveLevelId,
              _c7ExecutionTarget.activeCognitiveLevelId,
            ));
          const linkedIds = new Set(cogTasks.map(t => t.lessonExerciseId).filter((id): id is number => id !== null));
          classExercises = classExercises.filter((exercise) =>
            isExerciseCompatibleWithC7Target(
              _c7ExecutionTarget!,
              exercise,
              linkedIds,
            ),
          );
        }
        logger.info({
          phase,
          currentNodeId: session?.currentNodeId,
          classExercisesCount: classExercises.length,
          exerciseIds: classExercises.map((exercise) => exercise.exerciseId),
        }, "Phase2 classExercises loaded");
      } else if (phase === 3) {
        // P5.2: Phase 3 (wrap-up / DEEP_DIVE) includes both:
        //   - CLASS exercises linked to any lesson node (relatedNodeId IN allNodeIds)
        //   - CLASS exercises that are unassigned (relatedNodeId IS NULL) but belong to
        //     this lesson — these are textbook tasks the pipeline could not attach to a
        //     specific MicroNode (additionalExercises rescued by the deterministic pass).
        // The lessonId guard is mandatory for the IS NULL branch (prevents cross-lesson leaks).
        // Phase 2 is deliberately kept node-specific (relatedNodeId = currentNodeId only),
        // so unassigned exercises never appear during in-node teaching.
        const nodeOrNullFilter = allNodeIds.length > 0
          ? or(
              inArray(lessonExercisesTable.relatedNodeId, allNodeIds),
              isNull(lessonExercisesTable.relatedNodeId),
            )
          : isNull(lessonExercisesTable.relatedNodeId);
        classExercises = await db
          .select()
          .from(lessonExercisesTable)
          .where(and(
            eq(lessonExercisesTable.lessonId, lessonId),
            eq(lessonExercisesTable.assignment, "CLASS"),
            nodeOrNullFilter,
            // Gate 1.4: only approved exercises reach AI Teacher. Fail-closed.
            eq(lessonExercisesTable.status, "approved"),
          ))
          .orderBy(asc(lessonExercisesTable.sequence));
      }
      classExercises = filterLearnerSafeExercises(classExercises, {
        lessonId,
        phase,
        assignment: "CLASS",
      });

      let homeworkExercises: (typeof lessonExercisesTable.$inferSelect)[] = [];
      if (phase >= 3) {
        homeworkExercises = await db
          .select()
          .from(lessonExercisesTable)
          .where(and(
            eq(lessonExercisesTable.lessonId, lessonId),
            eq(lessonExercisesTable.assignment, "HOMEWORK"),
            // Gate 1.4: only approved exercises reach AI Teacher. Fail-closed.
            eq(lessonExercisesTable.status, "approved"),
          ))
          .orderBy(asc(lessonExercisesTable.sequence));
        homeworkExercises = filterLearnerSafeExercises(homeworkExercises, {
          lessonId,
          phase,
          assignment: "HOMEWORK",
        });
      }

      let dueReviewsLine = "";
      if (phase === 1) {
        const dueTopics = await getDueReviewTopics(req.userId!);
        if (dueTopics.length > 0) {
          dueReviewsLine = `DUE_REVIEWS (priority): ${dueTopics.map((t) => t.topicName).join(", ")}`;
        }
      }

      const toStrArr = (v: unknown) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

      const cfeBlock = currentNodeRecord?.childFriendlyExplanation
        ? `\nAPPROVED_EXPLANATION (use near-verbatim):\n${currentNodeRecord.childFriendlyExplanation}`
        : "";

      const verbatimAnchorBlock = currentNodeRecord?.verbatimTheoryAnchor
        ? `\nVERBATIM_THEORY_ANCHOR (if non-empty, ground explanations in this exact wording — cite rules/definitions near-verbatim).\n${currentNodeRecord.verbatimTheoryAnchor}`
        : "";

      const examplesArr = toStrArr(currentNodeRecord?.basicExamples);
      const examplesBlock = examplesArr.length > 0
        ? `\nBASIC_EXAMPLES:\n${examplesArr.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
        : "";

      const nonExamplesArr = toStrArr(currentNodeRecord?.nonExamples);
      const nonExamplesBlock = nonExamplesArr.length > 0
        ? `\nNON_EXAMPLES (use as contrast and wrong-answer distractors in MICRO_CHECK).\n${nonExamplesArr.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
        : "";

      const misconceptionBlock = currentNodeRecord?.commonMisconception
        ? `\nKNOWN_MISCONCEPTION (design MICRO_CHECK distractors around this):\n${currentNodeRecord.commonMisconception}`
        : "";

      const knowledgeBoundariesBlock = knowledgeBoundaries.length > 0
        ? `\nKNOWLEDGE_BOUNDARIES (this lesson deliberately excludes these topics — redirect warmly if student asks).\n${knowledgeBoundaries.map((b: string, i: number) => `${i + 1}. ${b}`).join("\n")}`
        : "";

      const deepDiveIdx = session?.deepDiveExerciseIndex ?? 0;
      const exBlock = phase === 3 && classExercises.length > 0
        ? `\nDEEP_DIVE_EXERCISES (MANDATORY — present these textbook exercises in order; do NOT replace with AI-generated tasks; start from index ${deepDiveIdx}):\n` +
          classExercises.map((e, i) => {
            const eff = learnerExerciseText(e) ?? "";
            return `[idx=${i}] [${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
              `  LEARNER_TASK_TEXT: ${eff.trim()}`;
          }).join("\n")
        : phase === 2 && classExercises.length > 0
        ? `\nCLASS_EXERCISE_CANDIDATES (backend owns exact text delivery):\n` +
          classExercises.map((e) => {
            return `[${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
              `  Do NOT quote, paraphrase, or render this exercise in student_message. ` +
              `If you transition to it, set source_fidelity.exercise_id to this exact ID; the backend renders the exercise.`;
          }).join("\n")
        : "";

      const hwBlock = homeworkExercises.length > 0
        ? `\nHOMEWORK_TASKS (present verbatim, explain why each matters):\n` +
          homeworkExercises.map((e) => {
            const eff = learnerExerciseText(e) ?? "";
            return `[${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
            `  LEARNER_TASK_TEXT: ${eff}`;
          }).join("\n")
        : "";

      const allNodeTitles = allNodes.map((n) => n.title);
      _allNodeTitles = allNodeTitles;

      const absoluteRuleBlock = currentNodeRecord && allNodeTitles.length > 0
        ? [
            `╔══ ABSOLUTE NODE LOCK — NEVER VIOLATE ══╗`,
            `You are teaching EXCLUSIVELY node: «${currentNodeRecord.title}»`,
            `Lesson: «${lesson.title}»`,
            `CURRENT_NODE:     «${currentNodeRecord.title}»`,
            `ALLOWED_NODES (full list): ${allNodeTitles.map((t) => `«${t}»`).join(", ")}`,
            completedNodeTitles.length > 0
              ? `COMPLETED_NODES:  ${completedNodeTitles.map((t) => `«${t}»`).join(", ")}  ← finished; do not reteach`
              : `COMPLETED_NODES:  (none)`,
            futureNodeTitles.length > 0
              ? `FUTURE_NODES:     ${futureNodeTitles.map((t) => `«${t}»`).join(", ")}  ← not yet started; do not teach`
              : `FUTURE_NODES:     (none)`,
            `FORBIDDEN: reteach any COMPLETED_NODE`,
            `FORBIDDEN: jump ahead to any FUTURE_NODE`,
            `FORBIDDEN: introduce any concept, definition, or skill not in ALLOWED_NODES`,
            `FORBIDDEN: declare lesson/node complete (backend decides mastery, not you)`,
            `FORBIDDEN: agree with student if they ask to skip/change topic — instead set redirect_needed:true and warmly redirect back`,
            `╚════════════════════════════════════════╝`,
          ].join("\n")
        : allNodeTitles.length > 0
        ? [
            `╔══ LESSON BOUNDARY — ALL NODES COMPLETED ══╗`,
            `All nodes for lesson «${lesson.title}» have been taught and mastered.`,
            `COMPLETED_NODES (full list): ${allNodeTitles.map((t) => `«${t}»`).join(", ")}`,
            `FORBIDDEN: introduce ANY new mathematical concept, definition, skill, or topic not in COMPLETED_NODES.`,
            `FORBIDDEN: start a new chapter, lesson, or curriculum section.`,
            `FORBIDDEN: invent exercises — use ONLY the DEEP_DIVE_EXERCISES or HOMEWORK_TASKS provided below.`,
            `REQUIRED ACTION: (1) Summarize what was learned using ONLY the COMPLETED_NODES. (2) Present any remaining DEEP_DIVE_EXERCISES or HOMEWORK_TASKS verbatim. (3) Close the session warmly.`,
            `╚══════════════════════════════════════════╝`,
          ].join("\n")
        : "";

      const PHASE1_CAP = 5;
      const reviewQCount = session?.reviewQuestionCount ?? 0;
      const phase1ProgressLine = phase === 1
        ? `PHASE_1_PROGRESS: question ${reviewQCount + 1}/${PHASE1_CAP}${reviewQCount + 1 === PHASE1_CAP ? " — this is the LAST question: after student answers, give a brief summary of the review and do NOT ask a new question" : ""}`
        : "";

      const usedTemplates = session?.askedQuestionTemplates ?? [];
      const usedTemplatesBlock = usedTemplates.length > 0
        ? `USED_QUESTION_TEMPLATES (do NOT repeat these for this node): ${usedTemplates.join(", ")}`
        : "";

      // ── Stage-driven DIRECTIVE (spec-4) + safety override ────────────────
      const teachingStage = phase === 2 ? (session?.nodeTeachingStage ?? "THEORY") : "THEORY";
      const stageDirectiveLine: string = (() => {
        if (phase !== 2) return "";
        if (teachingStage === "THEORY") {
          return (
            `NODE_STAGE: THEORY (first turn on this node)\n` +
            `DIRECTIVE — THIS TURN YOU MUST: ` +
            `Present APPROVED_EXPLANATION in 2-3 plain sentences only. ` +
            `Do NOT ask a question, include options, or create a task. ` +
            `Set teaching_mode: "TEACH", is_micro_check: false, and leave task fields empty.`
          );
        }
        if (teachingStage === "MICRO_CHECK") {
          // V2-R1: if a task is already active, the student is responding to it.
          // Force FEEDBACK-only directive so the AI cannot pack a new question.
          const _hasActiveTaskForDirective =
            ((session as any)?.activeTaskProvenance ?? null) !== null &&
            ((session as any)?.activeTaskProvenance ?? "") !== "";
          if (_hasActiveTaskForDirective) {
            return (
              `NODE_STAGE: MICRO_CHECK — ACTIVE TASK (student is responding)\n` +
              `DIRECTIVE — FEEDBACK ONLY: The student has answered the active micro-check. ` +
              `Evaluate their answer and give concise feedback. ` +
              `MUST set teaching_mode: "FEEDBACK" and is_micro_check: false. ` +
              `Do NOT ask a new question. Do NOT set is_micro_check: true. ` +
              `If the student must retry, set is_micro_check: false (same active task remains open).`
            );
          }
          if (classExercises.length > 0) {
            return (
              `NODE_STAGE: MICRO_CHECK\n` +
              `DIRECTIVE — THIS TURN YOU MUST: Transition to one eligible CLASS_EXERCISE using teaching_mode: "TRANSITION". ` +
              `Set source_fidelity.exercise_id to that candidate's exact ID. ` +
              `Write only concise transition wording; do NOT quote, paraphrase, or render any exercise text. ` +
              `The backend activates and delivers exactly one source exercise.`
            );
          }
          const attempts = session?.nodeAttemptCount ?? 0;
          return (
            `NODE_STAGE: MICRO_CHECK (no exercises for this node)\n` +
            `DIRECTIVE: Ask at most 1 more MICRO_CHECK (${attempts} attempts so far). ` +
            `If student understands, set node_decision.action = "COMPLETE_NODE" (MODERATE evidence sufficient).`
          );
        }
        if (teachingStage === "EXERCISE") {
          return (
            `NODE_STAGE: EXERCISE (student responding to class exercise)\n` +
            `DIRECTIVE: Evaluate the answer. Correct (STRONG quality) \u2192 feedback + COMPLETE_NODE allowed. ` +
            `Incorrect \u2192 warm guidance, let retry. Do NOT ask a new MICRO_CHECK.`
          );
        }
        if (teachingStage === "VERIFIED") {
          return `NODE_STAGE: VERIFIED \u2014 set node_decision.action = "COMPLETE_NODE" and praise the student.`;
        }
        return "";
      })();

      // ── Structured context header (highest priority — always first) ──────────
      // Contains the 7 canonical fields the AI must see before anything else.
      // Missing / null fields are logged as warnings and filled with a fallback.

      const _nodeObjective =
        currentNodeRecord?.learningObjective?.trim() ||
        currentNodeRecord?.childFriendlyExplanation?.trim() ||
        (currentNodeRecord
          ? `Reach Bloom level ${currentNodeRecord.targetBloomLevel} understanding of «${currentNodeRecord.title}» in ~${currentNodeRecord.estimatedMinutes} min.`
          : null);

      const _expectedStep: string = (() => {
        if (phase !== 2 || !currentNodeRecord) return `PHASE_${phase}`;
        const stage = teachingStage;
        const attempts = session?.nodeAttemptCount ?? 0;
        if (stage === "THEORY")     return `THEORY — present APPROVED_EXPLANATION then ask first MICRO_CHECK`;
        if (stage === "MICRO_CHECK") {
          // V2-R1: distinguish FEEDBACK mode (active task exists) from question-asking mode
          const _hasActiveTaskForStep =
            ((session as any)?.activeTaskProvenance ?? null) !== null &&
            ((session as any)?.activeTaskProvenance ?? "") !== "";
          if (_hasActiveTaskForStep) {
            return `MICRO_CHECK — FEEDBACK: evaluate student's answer to active task; is_micro_check: false; no new question`;
          }
          return classExercises.length > 0
            ? `MICRO_CHECK done — present CLASS_EXERCISE verbatim via TRANSITION`
            : `MICRO_CHECK (attempt ${attempts + 1}) — ask or evaluate; COMPLETE_NODE if understood (no exercises)`;
        }
        if (stage === "EXERCISE") return `EXERCISE — evaluate student answer, give COMPLETE_NODE on STRONG+CORRECT`;
        if (stage === "VERIFIED")  return `VERIFIED — set COMPLETE_NODE and praise`;
        return stage;
      })();

      const _prevMicroCheck = session?.lastQuestionAsked?.trim() || null;

      const _studentState = [
        `phase=${phase}`,
        currentNodeRecord ? `node_stage=${teachingStage}` : null,
        `node_attempts=${session?.nodeAttemptCount ?? 0}`,
        `nodes_done=${completedNodes}/${totalNodes}`,
        phase === 1 ? `review_q=${session?.reviewQuestionCount ?? 0}` : null,
      ].filter(Boolean).join(" | ");

      // Log any missing fields so gaps in lesson data are visible in server logs
      const _missingFields: string[] = [];
      if (!currentNodeRecord)          _missingFields.push("CURRENT_NODE");
      if (!_nodeObjective)             _missingFields.push("NODE_OBJECTIVE");
      if (allNodeTitles.length === 0)  _missingFields.push("ALLOWED_NODES");
      if (!_prevMicroCheck)            _missingFields.push("PREVIOUS_MICRO_CHECK (first turn or session reset — ok)");
      if (_missingFields.length > 0) {
        logger.warn(
          { lessonId, phase, missingFields: _missingFields },
          "lessonContext: structured header has missing/null fields"
        );
      }

      const completedNodesBlock = completedNodeTitles.length > 0
        ? `COMPLETED_NODES (already mastered — do NOT reteach; only brief prerequisite references allowed):\n${completedNodeTitles.map((t) => `  - «${t}»`).join("\n")}`
        : `COMPLETED_NODES: (none — this is the first node)`;

      const structuredHeader = [
        `╔══ STRUCTURED CONTEXT (read this first — highest priority) ══╗`,
        `CURRENT_LESSON:   «${lesson.title}» | Subject: ${subjectName}`,
        completedNodesBlock,
        currentNodeRecord
          ? `CURRENT_NODE:     «${currentNodeRecord.title}»  ← the ONLY node you are teaching right now`
          : `CURRENT_NODE:     (none — all nodes completed or phase=${phase})`,
        `INSTRUCTION: Completed nodes are already mastered. Do not reteach them. Do not restart explanations from completed nodes. Only refer to them briefly as prerequisites if needed.`,
        _nodeObjective
          ? `NODE_OBJECTIVE:   ${_nodeObjective}`
          : `NODE_OBJECTIVE:   (not set for this node)`,
        futureNodeTitles.length > 0
          ? `FUTURE_NODES (not yet started — do NOT teach these yet):\n${futureNodeTitles.map((t) => `  - «${t}»`).join("\n")}`
          : `FUTURE_NODES: (none — current node is the last)`,
        `EXPECTED_TEACHING_STEP: ${_expectedStep}`,
        _prevMicroCheck
          ? `PREVIOUS_MICRO_CHECK: ${_prevMicroCheck.slice(0, 200)}`
          : `PREVIOUS_MICRO_CHECK: (none)`,
        `STUDENT_STATE:    ${_studentState}`,
        `╚═════════════════════════════════════════════════════════════╝`,
      ].join("\n");

      lessonContext = [
        structuredHeader,
        _c7ExecutionTarget ? buildC7TargetContext(_c7ExecutionTarget) : "",
        absoluteRuleBlock,
        studentName ? `STUDENT_NAME: ${studentName}` : "",
        essentialQuestion ? `ESSENTIAL_QUESTION: ${essentialQuestion}` : "",
        `LESSON: «${lesson.title}»`,
        `SUBJECT: ${subjectName}`,
        currentNodeRecord
          ? `CURRENT_NODE: «${currentNodeRecord.title}» (Bloom ${currentNodeRecord.targetBloomLevel}, ~${currentNodeRecord.estimatedMinutes} min)`
          : "",
        coreProblem ? `CORE_PROBLEM: ${coreProblem}` : "",
        coreIdea    ? `CORE_IDEA: ${coreIdea}`       : "",
        `PHASE: ${phase} | PROGRESS: node ${currentNodeSeq}/${totalNodes} | completed: ${completedNodes}/${totalNodes}`,
        phase1ProgressLine,
        stageDirectiveLine,
        (() => {
          if (!_activeCognitiveLevelRow) return "";
          const lines = [
            `CURRENT_COGNITIVE_LEVEL: ${_activeCognitiveLevelRow.cognitiveLevel}`,
          ];
          const perf = (_activeCognitiveLevelRow as any).performanceObjective;
          const succ = (_activeCognitiveLevelRow as any).successCriterion;
          const pit: unknown = _activeCognitiveLevelRow.preferredInteractionTypes;
          if (perf && typeof perf === "string" && perf.trim()) {
            lines.push(`COGNITIVE_PERFORMANCE_OBJECTIVE: ${perf.trim()}`);
          }
          if (succ && typeof succ === "string" && succ.trim()) {
            lines.push(`COGNITIVE_SUCCESS_CRITERION: ${succ.trim()}`);
          }
          const pitArr = Array.isArray(pit) ? (pit as string[]).filter(Boolean) : [];
          if (pitArr.length > 0) {
            lines.push(`PREFERRED_INTERACTION_TYPES: ${pitArr.join(", ")}`);
            lines.push(`MICRO_CHECK_FORMAT_RULE: When asking a MICRO_CHECK question at this cognitive level, use one of the PREFERRED_INTERACTION_TYPES listed above.`);
          }
          return lines.join("\n");
        })(),
        phase === 2 && currentNodeRecord
          ? [
              `TEACHING_ORDER:`,
              `1. First explain the concept using NODE_THEORY.`,
              `2. Use APPROVED_EXPLANATION to make the explanation age-appropriate.`,
              `3. Use BASIC_EXAMPLES after explaining the concept.`,
              `4. Only after theory explanation is complete, start MICRO_CHECK questions.`,
              `5. Do not begin with questions before teaching the concept.`,
              `6. Do not invent alternative explanations if the provided node content exists.`,
            ].join("\n")
          : "",
        (lesson as { description?: string | null }).description?.trim()
          ? `LESSON_OVERVIEW (context for this entire lesson — read before the current node):\n${(lesson as { description?: string | null }).description!.trim()}`
          : "",
        currentNodeRecord?.theoryContent ? `NODE_THEORY:\n${currentNodeRecord.theoryContent}` : "",
        cfeBlock,
        verbatimAnchorBlock,
        examplesBlock,
        nonExamplesBlock,
        misconceptionBlock,
        knowledgeBoundariesBlock,
        exBlock,
        hwBlock,
        usedTemplatesBlock,
        dueReviewsLine,
        introConfirmedThisTurn
          ? [
              `INTRO_CONFIRMED_THIS_TURN: true`,
              `The lesson introduction/readiness gate has just been confirmed by the student.`,
              `DO NOT repeat: greeting, lesson title introduction, lesson-level goals/outcomes, readiness question, or any equivalent introduction.`,
              `BEGIN CURRENT MICRONODE TEACHING NOW using CURRENT_NODE and CURRENT_COGNITIVE_LEVEL.`,
              `For this turn: deliver a brief theory explanation, then ask exactly ONE MICRO_CHECK following COGNITIVE_PERFORMANCE_OBJECTIVE, COGNITIVE_SUCCESS_CRITERION, PREFERRED_INTERACTION_TYPES, and MICRO_CHECK_FORMAT_RULE. Then STOP and wait for the student's answer.`,
            ].join("\n")
          : "",
        ``,
        `=== PHASE ${phase} GUIDANCE ===`,
        buildPhaseGuidance(phase, topicName, subjectName),
      ].filter(Boolean).join("\n");

      if (phase === 1) {
        progressIndicator = {
          current_node_name: topicName,
          step: Math.min(reviewQCount + 1, PHASE1_CAP),
          total_steps: PHASE1_CAP,
          completed_nodes: 0,
          total_nodes: totalNodes,
        };
      }

    }
  }

  const nodeStartedAt = session?.nodeStartedAt ?? null;
  const history = await db
    .select()
    .from(chatMessagesTable)
    .where(
      lessonId
        ? and(
            eq(chatMessagesTable.userId, req.userId!),
            eq(chatMessagesTable.lessonId, lessonId),
            ...(nodeStartedAt ? [gte(chatMessagesTable.createdAt, nodeStartedAt)] : [])
          )
        : eq(chatMessagesTable.userId, req.userId!)
    )
    .orderBy(asc(chatMessagesTable.createdAt))
    .limit(nodeStartedAt ? 100 : 10);

  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  const responseTimeMs = lastAssistant
    ? userMessageAt - new Date(lastAssistant.createdAt).getTime()
    : null;

  const [learnerMessage] = await db
    .insert(chatMessagesTable)
    .values({
      userId: req.userId!,
      lessonId: lessonId ?? null,
      role: "user",
      content: message,
    })
    .returning();

  const chatHistory: ChatMessage[] = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: message },
  ];


  // ── Deterministic lesson intro gate ──────────────────────────────────────────
  // Fires on every turn while session.introConfirmed is false.
  // Returns a canned response WITHOUT calling any AI.
  if (lessonId && lesson && session && !session.introConfirmed) {
    // Normalise script-lookalike "ok" before matching:
    // Armenian Oh (U+0555/0585), Cyrillic O/o (U+041E/043E) → Latin o
    // Armenian keh (U+056F), Cyrillic k (U+043A) → Latin k
    const _normalizeOk = (s: string) =>
      s.replace(/[\u0585\u0555\u041e\u043e]/g, "o")
       .replace(/[\u056f\u043a]/g, "k");
    const trimmedLower = message.trim().toLowerCase();
    const isAffirmative =
      _normalizeOk(trimmedLower) === "ok" ||
      new Set([
        "\u056c\u0561\u057e",                              // լավ (good)
        "\u057a\u0561\u057f\u0580\u0561\u057d\u057f",      // պատրաստ
        "\u057a\u0561\u057f\u0580\u0561\u057d\u057f \u0565\u0574", // patrast em
      ]).has(trimmedLower);
    const prevAssistant = history.find((m) => m.role === "assistant");

    if (!prevAssistant) {
      // First turn — return the deterministic intro; no AI call
      const outcomes = Array.isArray(lesson.lessonOutcomes)
        ? (lesson.lessonOutcomes as string[]).filter((x): x is string => typeof x === "string")
        : [];
      const outcomesBlock = outcomes.length > 0
        ? outcomes.map((o) => `\u2022 ${o}`).join("\n")
        : "(not specified)"; // placeholder
      const goalBlock = lesson.lessonGoal?.trim() || "(not specified)";
      const greetLine = studentName
        ? `\u0532\u0561\u0580\u0587, ${studentName}: \ud83d\udc4b`
        : `\u0532\u0561\u0580\u0587: \ud83d\udc4b`;

      const introText = [
        greetLine,
        "",
        `\u0531\u0575\u057d\u0585\u0580\u057e\u0561 \u0564\u0561\u057d\u056b \u0569\u0565\u0574\u0561\u0576 \u0567. \u00ab${lesson.title}\u00bb`,
        "",
        "\u0531\u0575\u057d \u0564\u0561\u057d\u056b \u0576\u057a\u0561\u057f\u0561\u056f\u0576\u0565\u0580\u0576 \u0565\u0576.",
        goalBlock,
        "",
        "\u0531\u0575\u057d \u0564\u0561\u057d\u056b \u0561\u057e\u0561\u0580\u057f\u056b\u0576 \u0564\u0578\u0582 \u056f\u057d\u0578\u057e\u0578\u0580\u0565\u057d.",
        outcomesBlock,
        "",
        "\u0535\u0569\u0565 \u057a\u0561\u057f\u0580\u0561\u057d\u057f \u0565\u057d \u057d\u056f\u057d\u0565\u056c\u0578\u0582, \u0563\u0580\u056b\u0580\u055d \u0555\u056f",
      ].join("\n");

      const [introMsg] = await db
        .insert(chatMessagesTable)
        .values({ userId: req.userId!, lessonId: lessonId ?? null, role: "assistant", content: introText })
        .returning();

      logger.info({ lessonId, sessionId: session.id }, "intro-gate: returned deterministic intro, no AI call");
      res.json({ response: introText, messageId: introMsg.id, progressIndicator, teachingMode: "TEACH" });
      return;
    }

    // Subsequent turn while still un-confirmed — check for affirmative
    if (!isAffirmative) {
      const reminder = "\u0535\u0580\u0562 \u057a\u0561\u057f\u0580\u0561\u057d\u057f \u0565\u057d, \u0563\u0580\u056b\u0580\u055d \u0555\u056f \ud83d\ude42";
      const [reminderMsg] = await db
        .insert(chatMessagesTable)
        .values({ userId: req.userId!, lessonId: lessonId ?? null, role: "assistant", content: reminder })
        .returning();

      logger.info({ lessonId, sessionId: session.id, input: message.slice(0, 40) }, "intro-gate: non-affirmative, returned reminder");
      res.json({ response: reminder, messageId: reminderMsg.id, progressIndicator, teachingMode: "TEACH" });
      return;
    }

    // Affirmative received — flip introConfirmed and fall through to normal AI flow
    await db
      .update(lessonSessionsTable)
      .set({ introConfirmed: true })
      .where(eq(lessonSessionsTable.id, session.id));
    introConfirmedThisTurn = true;
    logger.info({ lessonId, sessionId: session.id }, "intro-gate: confirmed, proceeding to normal AI flow");
  }
  // ── End intro gate ────────────────────────────────────────────────────────────

  // ── V2-R2: Intent Classification ─────────────────────────────────────────────
  // Classify the student message BEFORE any AI answer-evaluation call.
  // Stage A = deterministic phrase matching (no AI).
  // Stage B = AI classification for ANSWER / CLARIFY / OFF_TOPIC ambiguity.
  // Intent is state-aware: hasActiveTask, teachingStage, introConfirmed matter.
  const _intentHasActiveTask =
    session != null && (
      (session.activeTaskProvenance != null && session.activeTaskProvenance !== "") ||
      session.nodeTeachingStage === "MICRO_CHECK" ||
      session.nodeTeachingStage === "EXERCISE"
    );

  let _intentResult: IntentResult = { intent: "ANSWER", confidence: 0.5, reason: "pre-classification-default" };
  if (_intentHasActiveTask && isCanonicalShortAnswer(message)) {
    _intentResult = {
      intent: "ANSWER",
      confidence: 1,
      reason: "deterministic:short_answer_token",
    };
    logger.info(
      {
        sessionId: session?.id ?? null,
        teachingStage: session?.nodeTeachingStage ?? null,
        hasActiveTask: true,
        intent: _intentResult.intent,
        reason: _intentResult.reason,
        msgLen: message.length,
      },
      "V2-R2: deterministic short answer routed as ANSWER"
    );
  } else {
    try {
      const _intentCtx: IntentContext = {
        teachingStage:        session?.nodeTeachingStage ?? null,
        hasActiveTask:        _intentHasActiveTask,
        introConfirmed:       session?.introConfirmed ?? false,
        lastQuestionAsked:    session?.lastQuestionAsked ?? null,
        activeTaskProvenance: session?.activeTaskProvenance ?? null,
      };
      _intentResult = await classifyIntent(message, _intentCtx);
      logger.info(
        {
          sessionId:     session?.id ?? null,
          teachingStage: _intentCtx.teachingStage,
          hasActiveTask: _intentCtx.hasActiveTask,
          intent:        _intentResult.intent,
          reason:        _intentResult.reason,
          msgLen:        message.length,
        },
        "V2-R2: intent classified"
      );
    } catch (intentErr) {
      logger.warn({ intentErr }, "V2-R2: classifyIntent threw unexpectedly — defaulting to ANSWER");
    }
  }

  // ── V2-R2: CONTINUE / READY with active task → fast-return, no task skip ────
  // "sharunakenkh" / "ok" during an open assessable task MUST NOT clear the task,
  // advance the node, or create evidence.  Remind the student and preserve state.
  if (
    (_intentResult.intent === "CONTINUE" || _intentResult.intent === "READY") &&
    _intentHasActiveTask
  ) {
    let activeTaskText = session?.lastQuestionAsked ?? null;
    if (session?.activeLessonExerciseId != null) {
      const [activeExercise] = await db
        .select({
          exerciseTextVerbatim: lessonExercisesTable.exerciseTextVerbatim,
          exerciseTextEdited: lessonExercisesTable.exerciseTextEdited,
          successCriteria: lessonExercisesTable.successCriteria,
          correctAnswer: lessonExercisesTable.correctAnswer,
        })
        .from(lessonExercisesTable)
        .where(eq(lessonExercisesTable.id, session.activeLessonExerciseId))
        .limit(1);
      const resolved = resolveHelpTaskText(activeExercise ?? null, null);
      activeTaskText = resolved.ok ? resolved.taskText : null;
    }
    const taskReminder = buildActiveTaskReminder(activeTaskText);
    const [contMsg] = await db
      .insert(chatMessagesTable)
      .values({ userId: req.userId!, lessonId: lessonId ?? null, role: "assistant", content: taskReminder })
      .returning();
    logger.info({ sessionId: session?.id, intent: _intentResult.intent }, "V2-R2: CONTINUE/READY with active task — task preserved, no AI call");
    res.json({
      response:        taskReminder,
      messageId:       contMsg.id,
      progressIndicator,
      teachingMode,
      hasActiveTask:   true,
      activeHelpCount: session?.activeHelpCount ?? 0,
    });
    return;
  }

  // C7.3: learner topic-switches are handled before any model call, evidence
  // processing, or task selection. Clarifications that do not explicitly ask
  // to switch remain on the normal teaching path.
  if (_c7ExecutionTarget && isC7TopicSwitchRequest(message)) {
    assertC7ExecutionTargetMatchesSession(_c7ExecutionTarget, {
      lessonId: lessonId!,
      currentNodeId: session?.currentNodeId ?? null,
      activeCognitiveLevelId: session?.activeCognitiveLevelId ?? null,
    });
    const redirect = `${REDIRECT_CANNED_PREFIX}\nԵկ շարունակենք «${_c7ExecutionTarget.microNodeTitle}» թեման։`;
    const [redirectMessage] = await db
      .insert(chatMessagesTable)
      .values({
        userId: req.userId!,
        lessonId: lessonId ?? null,
        role: "assistant",
        content: redirect,
      })
      .returning();
    res.json({
      response: redirect,
      messageId: redirectMessage.id,
      progressIndicator,
      teachingMode: "TEACH",
      hasActiveTask: _intentHasActiveTask,
      activeHelpCount: session?.activeHelpCount ?? 0,
      redirect_needed: true,
    });
    return;
  }

  // ── V2-R2: HELP via text → reuse executeHelpRequest (same as 💡 button) ─────
  // Text-based "oghni" / "hushum tur" routes to the same progressive help
  // infrastructure as the button.  Falls through to normal AI if no active task
  // (AI can then respond contextually).
  if (
    _intentResult.intent === "HELP" &&
    session && lessonId &&
    session.currentPhase >= 2 && session.currentNodeId
  ) {
    const _helpRes = await executeHelpRequest(session, lessonId, req.userId!);
    if (_helpRes.ok) {
      const [helpMsg] = await db
        .insert(chatMessagesTable)
        .values({ userId: req.userId!, lessonId, role: "assistant", content: _helpRes.hintContent })
        .returning();
      logger.info({ sessionId: session.id, helpLevel: _helpRes.helpLevel }, "V2-R2: HELP via text — help_event created, active task preserved");
      res.json({
        response:        _helpRes.hintContent,
        messageId:       helpMsg.id,
        progressIndicator,
        teachingMode,
        hasActiveTask:   _intentHasActiveTask,
        activeHelpCount: _helpRes.newHelpCount,
        helpLevel:       _helpRes.helpLevel,
        helpEventId:     _helpRes.helpEventId,
      });
      return;
    }
    // _helpRes.ok=false (NO_ACTIVE_TASK or REVEAL_REQUIRES_CONFIRMATION):
    // fall through to normal AI path so the AI can respond contextually.
    logger.info({ sessionId: session.id, errorCode: _helpRes.errorCode }, "V2-R2: HELP intent but no active task — falling through to AI");
  }
  // ── End V2-R2 intent routing ──────────────────────────────────────────────────

  let _phase2ServerActionPlan: Phase2ServerActionPlan = derivePhase2ServerAction({
    currentPhase: session?.currentPhase ?? null,
    currentNodeId: session?.currentNodeId ?? null,
    activeCognitiveLevelId:
      _activeCognitiveLevelRow?.id ?? null,
    nodeTeachingStage: session?.nodeTeachingStage ?? null,
    activeTaskProvenance: session?.activeTaskProvenance ?? null,
    activeLessonExerciseId: session?.activeLessonExerciseId ?? null,
    activeObjectiveTaskPayload: session?.activeObjectiveTaskPayload ?? null,
    learnerIntent: _intentResult.intent,
    evaluated: false,
    decision: null,
    progressionPlan: null,
    eligibleSourceExerciseAvailable: classExercises.length > 0,
  });
  logger.info(
    {
      sessionId: session?.id ?? null,
      action: _phase2ServerActionPlan.action,
      reasonCode: _phase2ServerActionPlan.reasonCode,
      taskAuthority: _phase2ServerActionPlan.taskAuthority,
    },
    "Phase-2 server action selected before AI generation",
  );
  if (_phase2ServerActionPlan.action === "INVALID_PHASE2_STATE") {
    logger.error(
      {
        sessionId: session?.id ?? null,
        currentPhase: session?.currentPhase ?? null,
        currentNodeId: session?.currentNodeId ?? null,
        nodeTeachingStage: session?.nodeTeachingStage ?? null,
        activeTaskProvenance: session?.activeTaskProvenance ?? null,
        activeLessonExerciseId: session?.activeLessonExerciseId ?? null,
        hasObjectiveTaskPayload:
          session?.activeObjectiveTaskPayload !== null &&
          session?.activeObjectiveTaskPayload !== undefined,
      },
      "Phase-2 server action rejected inconsistent authoritative state",
    );
    res.status(409).json({
      error: "INVALID_PHASE2_STATE",
      message: "Դասի ընթացիկ վիճակը հնարավոր չէ անվտանգ շարունակել։ Խնդրում եմ կրկին սկսել դասը։",
    });
    return;
  }
  if (requiresLegacyTaskRestart(_phase2ServerActionPlan, _intentResult.intent)) {
    // Legacy tasks do not carry an immutable task reference/attempt identity.
    // Evaluating them would bypass C3 evidence polarity and the task-consume
    // CAS, so fail closed instead of allowing false credit or duplicate writes.
    res.status(409).json({
      error: "LEGACY_TASK_RESTART_REQUIRED",
      message: "Այս հին առաջադրանքը չի կարող անվտանգ գնահատվել։ Խնդրում ենք նորից սկսել դասի ընթացիկ հատվածը։",
    });
    return;
  }

  let aiResult: AIStructuredResponse | null = null;
  let studentMessage: string;
  let wasCorrect: boolean | null = null;
  let _evaluatedTurnAuthority: ReturnType<typeof establishEvaluatedTurnAuthority> | null = null;
  let _evidenceResultAuthority: string | null = null;
  let _evaluatedTaskEvidenceContext: {
    id: number;
    currentNodeId: number | null;
    nodeTeachingStage: string;
    activeTaskProvenance: string | null;
    activeTaskReference: string | null;
    activeLessonExerciseId: number | null;
    activeCognitiveLevelId: number | null;
    activeAttemptSequence: number;
    activeHelpCount: number;
    activeAssistanceLevel: string;
    activeTaskSnapshot: CanonicalTaskSnapshot | null;
  } | null = null;
  let _canonicalEvidenceProcessed = false;
  let _canonicalEvidenceQualification: EvidenceQualificationStatus | null = null;
  let _canonicalEvidenceProjection: LearnerCeilingProjection | null = null;
  let _canonicalEvidenceTaskReference: string | null = null;
  let _evaluatedTaskClaimed = false;
  let _evaluatedTaskReservation: {
    reference: string;
    marker: string;
  } | null = null;
  let _stage3BoundedAnswerTurn = false;
  let _stage3SourceExerciseForEvaluation: AuthoritativeSourceExercise | null = null;
  let _stage3HiddenExerciseContent: string[] = [];

  const respondWithPersistedPhase2Message = (
    content: string,
    messageId: number,
    boundedTeachingMode: "TEACH" | "MICRO_CHECK" | "FEEDBACK" | "TRANSITION",
    activeTask: boolean,
  ) => {
    const requiredSessionMinutes = session?.requiredSessionMinutes ?? null;
    const activeLearningSeconds = session?.activeLearningSeconds ?? 0;
    const budgetSeconds = requiredSessionMinutes == null
      ? null
      : requiredSessionMinutes * 60;
    res.json({
      response: content,
      messageId,
      progressIndicator,
      teachingMode: boundedTeachingMode,
      hasActiveTask: activeTask,
      activeHelpCount: session?.activeHelpCount ?? 0,
      requiredSessionMinutes,
      activeLearningSeconds,
      remainingRequiredSeconds: budgetSeconds == null
        ? null
        : Math.max(0, budgetSeconds - activeLearningSeconds),
      sessionBudgetExhausted: computeSessionBudgetExhausted(
        requiredSessionMinutes,
        activeLearningSeconds,
      ),
      sessionDecision: null,
      requiredSessionCompleted: session?.requiredSessionCompletedAt != null,
      requiredSessionCompletedAt:
        session?.requiredSessionCompletedAt?.toISOString() ?? null,
      optionalContinuation: session?.optionalContinuation ?? false,
    });
  };
  const respondWithBoundedPhase2Message = async (
    content: string,
    boundedTeachingMode: "TEACH" | "MICRO_CHECK" | "FEEDBACK" | "TRANSITION",
    activeTask: boolean,
  ) => {
    const [assistantMsg] = await db
      .insert(chatMessagesTable)
      .values({
        userId: req.userId!,
        lessonId: lessonId ?? null,
        role: "assistant",
        content,
      })
      .returning();
    respondWithPersistedPhase2Message(
      content,
      assistantMsg.id,
      boundedTeachingMode,
      activeTask,
    );
  };

  const boundedPhase2Failure = (
    error: unknown,
    job: "THEORY" | "TASK" | "EVALUATION" | "FEEDBACK",
  ) => {
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        sessionId: session?.id ?? null,
        action: _phase2ServerActionPlan.action,
        job,
      },
      "Stage-3 bounded Phase-2 job failed",
    );
    res.status(503).json({
      error: "STRUCTURED_AI_REQUIRED",
      message: "Չհաջողվեց շարունակել դասը։ Խնդրում եմ կրկին փորձել։",
    });
  };

  const assertPhase2TargetLocked = async (): Promise<C7ExecutionTarget | null> => {
    if (session?.currentPhase !== 2) return null;
    if (!_c7ExecutionTarget) {
      throw new Error("C7 execution target was not established for Phase 2");
    }
    // Re-read the canonical state rather than trusting this request's snapshot:
    // another request may have completed the only authorized C7.1 transition
    // while this turn was waiting on a bounded model job.
    const [latestSession] = await db
      .select({
        currentNodeId: lessonSessionsTable.currentNodeId,
        activeCognitiveLevelId: lessonSessionsTable.activeCognitiveLevelId,
      })
      .from(lessonSessionsTable)
      .where(eq(lessonSessionsTable.id, session.id))
      .limit(1);
    if (!latestSession) {
      throw new Error("C7 session disappeared before execution");
    }
    assertC7ExecutionTargetMatchesSession(_c7ExecutionTarget, {
      lessonId: lessonId!,
      currentNodeId: latestSession.currentNodeId,
      activeCognitiveLevelId: latestSession.activeCognitiveLevelId,
    });
    return _c7ExecutionTarget;
  };

  const updateC7TargetLockedSession = async (
    values: Record<string, unknown>,
  ): Promise<void> => {
    const target = await assertPhase2TargetLocked();
    if (!target) {
      await db
        .update(lessonSessionsTable)
        .set(values as any)
        .where(eq(lessonSessionsTable.id, session!.id));
      return;
    }
    const updated = await db
      .update(lessonSessionsTable)
      .set(values as any)
      .where(and(
        eq(lessonSessionsTable.id, session!.id),
        eq(lessonSessionsTable.currentNodeId, target.microNodeId),
        eq(lessonSessionsTable.activeCognitiveLevelId, target.activeCognitiveLevelId),
      ))
      .returning({ id: lessonSessionsTable.id });
    if (updated.length === 0) {
      throw new Error("C7 execution-target compare-and-swap rejected a stale session write");
    }
  };

  const assertActiveSourceExerciseMatchesTarget = async (exercise: {
    id: number;
    relatedNodeId: number | null;
  }): Promise<void> => {
    const target = await assertPhase2TargetLocked();
    if (!target) return;
    const mappings = await db
      .select({ lessonExerciseId: lessonNodeCognitiveTasksTable.lessonExerciseId })
      .from(lessonNodeCognitiveTasksTable)
      .where(eq(
        lessonNodeCognitiveTasksTable.cognitiveLevelId,
        target.activeCognitiveLevelId,
      ));
    const linkedIds = new Set(
      mappings
        .map((mapping) => mapping.lessonExerciseId)
        .filter((id): id is number => id !== null),
    );
    if (!isExerciseCompatibleWithC7Target(target, exercise, linkedIds)) {
      throw new Error("active source exercise does not match the C7 execution target");
    }
  };

  type ContinuationResult = {
    lastContent: string;
    lastMessageId: number;
    teachingMode: "TEACH" | "MICRO_CHECK" | "TRANSITION";
    hasActiveTask: boolean;
    stopReason: "LEARNER_INPUT_REQUIRED" | "COMPLETE" | "SAFETY_CAP";
  } | null;

  /**
   * The single Stage-5 owner for follow-on server actions. It reloads
   * authoritative session state between bounded jobs, persists each visible
   * output as an individual chat row, and returns as soon as a learner-visible
   * task becomes active.
   */
  const runPhase2Continuation = async (
    fromAction: string,
    excludeLessonExerciseId: number | null = null,
  ): Promise<ContinuationResult> => {
    if (!lessonId || !lesson || !session) return null;

    let last: Omit<NonNullable<ContinuationResult>, "hasActiveTask" | "stopReason"> | null = null;
    for (let internalStep = 1; internalStep <= MAX_PHASE2_INTERNAL_CONTINUATIONS; internalStep += 1) {
      const [freshSession] = await db
        .select()
        .from(lessonSessionsTable)
        .where(eq(lessonSessionsTable.id, session.id))
        .limit(1);
      if (!freshSession || freshSession.currentPhase !== 2 || !freshSession.currentNodeId) {
        return last
          ? { ...last, hasActiveTask: false, stopReason: "COMPLETE" }
          : null;
      }

      const [freshNode] = await db
        .select({
          id: lessonNodesTable.id,
          title: lessonNodesTable.title,
          theoryContent: lessonNodesTable.theoryContent,
          childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
          learningObjective: lessonNodesTable.learningObjective,
          basicExamples: lessonNodesTable.basicExamples,
          cogPathStatus: lessonNodesTable.cogPathStatus,
        })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.id, freshSession.currentNodeId))
        .limit(1);
      if (!freshNode) throw new Error("continuation current node was not found");

      const cognitivePath = await db
        .select({
          id: lessonNodeCognitiveLevelsTable.id,
          cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel,
          sequence: lessonNodeCognitiveLevelsTable.sequence,
          isApplicable: lessonNodeCognitiveLevelsTable.isApplicable,
          isTargetCeiling: lessonNodeCognitiveLevelsTable.isTargetCeiling,
          performanceObjective: (lessonNodeCognitiveLevelsTable as any).performanceObjective,
          successCriterion: (lessonNodeCognitiveLevelsTable as any).successCriterion,
          preferredInteractionTypes: lessonNodeCognitiveLevelsTable.preferredInteractionTypes,
          minimumIndependentEvidence: lessonNodeCognitiveLevelsTable.minimumIndependentEvidence,
        })
        .from(lessonNodeCognitiveLevelsTable)
        .where(and(
          eq(lessonNodeCognitiveLevelsTable.lessonNodeId, freshNode.id),
          eq(lessonNodeCognitiveLevelsTable.isApplicable, true),
        ))
        .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));
      const pathAcceptance = assessAcceptedCognitivePath({
        cogPathStatus: freshNode.cogPathStatus,
        theoryContent: freshNode.theoryContent,
        learningObjective: freshNode.learningObjective,
        levels: cognitivePath,
      });
      const acceptedCognitivePath = pathAcceptance.accepted ? cognitivePath : [];
      if (!pathAcceptance.accepted) {
        logger.info({
          sessionId: freshSession.id,
          lessonNodeId: freshNode.id,
          cogPathStatus: freshNode.cogPathStatus,
          reason: pathAcceptance.reason,
          groundingStatus: pathAcceptance.grounding?.status ?? null,
        }, "chat continuation: modern Cognitive Path rejected; C7 delivery fails closed");
      }
      let activeLevel = acceptedCognitivePath.find(
        (level) => level.id === (freshSession as any).activeCognitiveLevelId,
      ) ?? null;
      if (!activeLevel) {
        // C7.3: continuation is not a second C6/C2 selector. In particular,
        // never substitute acceptedCognitivePath[0] (which could invent a
        // REMEMBER target before a C6-selected UNDERSTAND target).
        throw new Error(
          "continuation active cognitive level is absent from the accepted C2 path",
        );
      }
      const continuationTarget = createC7ExecutionTarget({
        lessonId,
        currentNodeId: freshSession.currentNodeId,
        activeCognitiveLevelId: activeLevel.id,
        node: freshNode,
        acceptedPath: acceptedCognitivePath,
      });
      assertC7ExecutionTargetMatchesSession(continuationTarget, {
        lessonId,
        currentNodeId: freshSession.currentNodeId,
        activeCognitiveLevelId: (freshSession as any).activeCognitiveLevelId ?? null,
      });
      const updateContinuationTargetSession = async (
        values: Record<string, unknown>,
      ): Promise<void> => {
        const updated = await db
          .update(lessonSessionsTable)
          .set(values as any)
          .where(and(
            eq(lessonSessionsTable.id, freshSession.id),
            eq(lessonSessionsTable.currentNodeId, continuationTarget.microNodeId),
            eq(
              lessonSessionsTable.activeCognitiveLevelId,
              continuationTarget.activeCognitiveLevelId,
            ),
          ))
          .returning({ id: lessonSessionsTable.id });
        if (updated.length === 0) {
          throw new Error("continuation execution-target compare-and-swap rejected a stale write");
        }
      };

      let eligibleExercises = await db
        .select()
        .from(lessonExercisesTable)
        .where(and(
          eq(lessonExercisesTable.relatedNodeId, freshNode.id),
          eq(lessonExercisesTable.assignment, "CLASS"),
          eq(lessonExercisesTable.status, "approved"),
        ))
        .orderBy(asc(lessonExercisesTable.sequence));
      if (activeLevel) {
        const mappings = await db
          .select({ lessonExerciseId: lessonNodeCognitiveTasksTable.lessonExerciseId })
          .from(lessonNodeCognitiveTasksTable)
          .where(eq(lessonNodeCognitiveTasksTable.cognitiveLevelId, activeLevel.id));
        const linkedIds = new Set(
          mappings.map((mapping) => mapping.lessonExerciseId).filter((id): id is number => id !== null),
        );
        eligibleExercises = eligibleExercises.filter((exercise) =>
          isExerciseCompatibleWithC7Target(
            continuationTarget,
            exercise,
            linkedIds,
          ),
        );
      }
      eligibleExercises = filterLearnerSafeExercises(eligibleExercises, {
        lessonId,
        phase: 2,
        assignment: "CLASS",
      });
      if (excludeLessonExerciseId !== null) {
        eligibleExercises = eligibleExercises.filter(
          (exercise) => exercise.id !== excludeLessonExerciseId,
        );
      }

      const continuationHistory = await db
        .select({ role: chatMessagesTable.role, content: chatMessagesTable.content })
        .from(chatMessagesTable)
        .where(and(
          eq(chatMessagesTable.userId, req.userId!),
          eq(chatMessagesTable.lessonId, lessonId),
        ))
        .orderBy(asc(chatMessagesTable.createdAt))
        .limit(100);
      const activeLevelBlock = activeLevel
        ? [
            `CURRENT_COGNITIVE_LEVEL: ${activeLevel.cognitiveLevel}`,
            activeLevel.performanceObjective
              ? `COGNITIVE_PERFORMANCE_OBJECTIVE: ${String(activeLevel.performanceObjective)}`
              : "",
            activeLevel.successCriterion
              ? `COGNITIVE_SUCCESS_CRITERION: ${String(activeLevel.successCriterion)}`
              : "",
            Array.isArray(activeLevel.preferredInteractionTypes)
              ? `PREFERRED_INTERACTION_TYPES: ${activeLevel.preferredInteractionTypes.join(", ")}`
              : "",
          ].filter(Boolean).join("\n")
        : "";
      const continuationContext = [
        "STAGE_5_SERVER_OWNED_CONTINUATION: true",
        "This is an internal server continuation, not a learner message.",
        buildC7TargetContext(continuationTarget),
        `PHASE: 2 | CURRENT_NODE: «${freshNode.title}»`,
        `NODE_STAGE: ${freshSession.nodeTeachingStage ?? "THEORY"}`,
        `LESSON: «${lesson.title}»`,
        freshNode.learningObjective ? `NODE_OBJECTIVE: ${freshNode.learningObjective}` : "",
        activeLevelBlock,
        freshNode.theoryContent ? `NODE_THEORY:\n${freshNode.theoryContent}` : "",
        freshNode.childFriendlyExplanation
          ? `APPROVED_EXPLANATION:\n${freshNode.childFriendlyExplanation}`
          : "",
        Array.isArray(freshNode.basicExamples) && freshNode.basicExamples.length > 0
          ? `BASIC_EXAMPLES:\n${freshNode.basicExamples.join("\n")}`
          : "",
        "THEORY and TASK are separate bounded actions. Do not merge them. A visible task must be answerable and match persisted server state.",
      ].filter(Boolean).join("\n");

      const plan = derivePhase2ServerAction({
        currentPhase: freshSession.currentPhase,
        currentNodeId: freshSession.currentNodeId,
        activeCognitiveLevelId: (freshSession as any).activeCognitiveLevelId ?? null,
        nodeTeachingStage: freshSession.nodeTeachingStage ?? null,
        activeTaskProvenance: (freshSession as any).activeTaskProvenance ?? null,
        activeLessonExerciseId: (freshSession as any).activeLessonExerciseId ?? null,
        activeObjectiveTaskPayload: (freshSession as any).activeObjectiveTaskPayload ?? null,
        learnerIntent: "READY",
        evaluated: false,
        decision: null,
        progressionPlan: null,
        eligibleSourceExerciseAvailable: eligibleExercises.length > 0,
      });
      const hasFreshActiveTask =
        ((freshSession as any).activeTaskProvenance ?? null) !== null ||
        freshSession.nodeTeachingStage === "MICRO_CHECK" ||
        freshSession.nodeTeachingStage === "EXERCISE";
      if (nextPhase2ActionRequiresLearnerInput({
        action: plan.action,
        hasActiveTask: hasFreshActiveTask,
      })) {
        logger.info(
          { sessionId: freshSession.id, fromAction, toAction: plan.action, internalStep, stopReason: "LEARNER_INPUT_REQUIRED" },
          "Stage-5 continuation stopped",
        );
        return last
          ? { ...last, hasActiveTask: hasFreshActiveTask, stopReason: "LEARNER_INPUT_REQUIRED" }
          : null;
      }

      logger.info(
        { sessionId: freshSession.id, fromAction, toAction: plan.action, internalStep },
        "Stage-5 continuation executing server-owned action",
      );

      if (plan.action === "DELIVER_THEORY") {
        const theory = await callPhase2TheoryJob(
          continuationHistory.map((message) => ({ role: message.role as "user" | "assistant", content: message.content })),
          continuationContext,
        );
        assertTheoryOnly(theory);
        await updateContinuationTargetSession({
            nodeTeachingStage: "TASK_REQUIRED",
            activeLessonExerciseId: null,
            activeTaskProvenance: null,
            activeTaskReference: null,
            activeTaskSnapshot: null,
            activeObjectiveTaskPayload: null,
            activeAttemptSequence: 0,
            activeHelpCount: 0,
            activeAssistanceLevel: "none",
          });
        const [theoryMessage] = await db
          .insert(chatMessagesTable)
          .values({ userId: req.userId!, lessonId, role: "assistant", content: theory.student_message })
          .returning();
        last = {
          lastContent: theory.student_message,
          lastMessageId: theoryMessage.id,
          teachingMode: "TEACH",
        };
        continue;
      }

      if (plan.action === "DELIVER_SOURCE_EXERCISE") {
        const activatedSource = await activateSourceExercise(
          freshSession.id,
          resolveEligibleSourceExercise(eligibleExercises, null),
          continuationTarget,
        );
        if (!activatedSource) {
          throw new Error("continuation could not activate a learner-deliverable source exercise");
        }
        const sourceContent = activatedSource.renderedPrompt;
        const [sourceMessage] = await db
          .insert(chatMessagesTable)
          .values({ userId: req.userId!, lessonId, role: "assistant", content: sourceContent })
          .returning();
        logger.info(
          { sessionId: freshSession.id, fromAction, toAction: plan.action, internalStep, stopReason: "LEARNER_INPUT_REQUIRED" },
          "Stage-5 continuation delivered source task",
        );
        return {
          lastContent: sourceContent,
          lastMessageId: sourceMessage.id,
          teachingMode: "TRANSITION",
          hasActiveTask: true,
          stopReason: "LEARNER_INPUT_REQUIRED",
        };
      }

      if (plan.action === "GENERATE_TASK") {
        const task = await callPhase2TaskJob(
          continuationHistory.map((message) => ({ role: message.role as "user" | "assistant", content: message.content })),
          continuationContext,
        );
        const isObjective =
          task.interaction_type === "multiple_choice" ||
          task.interaction_type === "true_false";
        const taskReference = createTaskReference(
          task.interaction_type === "constructed_response" ? "generated_task" : "micro_check",
        );
        const objectivePayload = isObjective
          ? {
              interactionType: task.interaction_type,
              options: task.interaction_type === "multiple_choice" ? task.options : null,
              correctOption: task.correct_option,
            } as ActiveObjectiveTaskPayload
          : null;
        const taskContent = renderGeneratedTask(task);
        const taskSnapshot = buildCanonicalTaskSnapshot({
          taskReference,
          taskSource: task.interaction_type === "constructed_response" ? "generated_task" : "micro_check",
          taskKind: task.interaction_type === "constructed_response" ? "generated" : "micro_check",
          renderedPrompt: taskContent,
          executionTarget: continuationTarget,
          interactionType: task.interaction_type,
          learnerTextSource: "generated",
          objectivePayload,
          questionTemplate: task.question_template,
          targetCompatibleAtActivation: true,
        });
        await db
          .update(lessonSessionsTable)
          .set({
            nodeTeachingStage: "MICRO_CHECK",
            activeLessonExerciseId: null,
            activeTaskProvenance: task.interaction_type === "constructed_response"
              ? "constructed_response"
              : "micro_check",
            activeTaskReference: taskReference,
            activeTaskSnapshot: taskSnapshot,
            activeObjectiveTaskPayload: objectivePayload,
            activeAttemptSequence: 1,
            activeHelpCount: 0,
            activeAssistanceLevel: "none",
            lastQuestionAsked: taskContent,
          } as any)
          .where(eq(lessonSessionsTable.id, freshSession.id));
        const [taskMessage] = await db
          .insert(chatMessagesTable)
          .values({ userId: req.userId!, lessonId, role: "assistant", content: taskContent })
          .returning();
        logger.info(
          { sessionId: freshSession.id, fromAction, toAction: plan.action, internalStep, stopReason: "LEARNER_INPUT_REQUIRED" },
          "Stage-5 continuation delivered generated task",
        );
        return {
          lastContent: taskContent,
          lastMessageId: taskMessage.id,
          teachingMode: "MICRO_CHECK",
          hasActiveTask: true,
          stopReason: "LEARNER_INPUT_REQUIRED",
        };
      }

      throw new Error(`continuation selected unsupported server action: ${plan.action}`);
    }

    logger.error(
      { sessionId: session.id, fromAction, continuationCount: MAX_PHASE2_INTERNAL_CONTINUATIONS, stopReason: "SAFETY_CAP" },
      "Stage-5 continuation safety cap reached",
    );
    return last
      ? { ...last, hasActiveTask: false, stopReason: "SAFETY_CAP" }
      : null;
  };

  if (
    session?.currentPhase === 2 &&
    _phase2ServerActionPlan.action === "DELIVER_THEORY"
  ) {
    try {
      await assertPhase2TargetLocked();
      const theory = await callPhase2TheoryJob(chatHistory, lessonContext);
      assertTheoryOnly(theory);
      const driftDetected = session.currentNodeId
        ? validateNoScopeDrift(theory.student_message, _allNodeTitles)
        : false;
      if (driftDetected) {
        throw new Error("bounded THEORY response mentioned an out-of-scope node");
      }
      const [theoryMessage] = await db
        .insert(chatMessagesTable)
        .values({
          userId: req.userId!,
          lessonId: lessonId ?? null,
          role: "assistant",
          content: theory.student_message,
        })
        .returning();
      // Make TEACH visible before releasing TASK_REQUIRED. A failed state write
      // can at worst repeat theory; it can never silently skip to a task.
      await updateC7TargetLockedSession(buildPostFeedbackTransitionUpdate() as any);
      // C7.2: TEACH is an observable turn.  Do not immediately chain into a
      // task or let the response hide the explanation from the learner.
      respondWithPersistedPhase2Message(
        theory.student_message,
        theoryMessage.id,
        "TEACH",
        false,
      );
      return;
    } catch (error) {
      // Stage 5.5 — narrow fallback: both bounded THEORY attempts included a
      // visible task. Compose safe Armenian theory from approved node content
      // and persist it, then reuse the existing continuation to deliver the
      // next answerable task. No evidence, mastery, or cognitive-progression
      // side effects occur here.
      if (error instanceof Phase2TheoryExhaustionError && currentNodeRecord) {
        try {
          const fallback = buildNodeTheoryFallback({
            title: currentNodeRecord.title,
            learningObjective: currentNodeRecord.learningObjective,
            theoryContent: currentNodeRecord.theoryContent,
            childFriendlyExplanation: currentNodeRecord.childFriendlyExplanation,
            basicExamples: currentNodeRecord.basicExamples as readonly string[] | null | undefined,
          });
          logger.warn(
            {
              sessionId: session.id,
              nodeId: session.currentNodeId,
              originalError: error.originalMessage,
            },
            "Stage-5.5: both THEORY attempts included a visible task — using safe node-content fallback",
          );
          const [fallbackMessage] = await db
            .insert(chatMessagesTable)
            .values({
              userId: req.userId!,
              lessonId: lessonId ?? null,
              role: "assistant",
              content: fallback.student_message,
            })
            .returning();
          await updateC7TargetLockedSession(buildPostFeedbackTransitionUpdate() as any);
          // C7.2 keeps the deterministic fallback identical to normal
          // teaching: persist and display TEACH before a later task turn.
          respondWithPersistedPhase2Message(
            fallback.student_message,
            fallbackMessage.id,
            "TEACH",
            false,
          );
          return;
        } catch (fallbackError) {
          // Fallback itself failed (e.g. approved node content contained a task
          // marker). Treat as a normal bounded failure so the route stays
          // fail-closed.
          logger.error(
            {
              sessionId: session.id,
              err: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            },
            "Stage-5.5: node-content fallback also failed — closing with bounded failure",
          );
          boundedPhase2Failure(fallbackError, "THEORY");
          return;
        }
      }
      boundedPhase2Failure(error, "THEORY");
      return;
    }
  }

  if (
    session?.currentPhase === 2 &&
    _phase2ServerActionPlan.action === "DELIVER_SOURCE_EXERCISE" &&
    session.nodeTeachingStage === "TASK_REQUIRED"
  ) {
    const selection = resolveEligibleSourceExercise(classExercises, null);
    const activatedSource = await activateSourceExercise(
      session.id,
      selection,
      await assertPhase2TargetLocked() ?? undefined,
    );
    if (!activatedSource) {
      res.status(409).json({
        error: "SOURCE_EXERCISE_UNAVAILABLE",
        message: "Հաջորդ առաջադրանքը հասանելի չէ։ Խնդրում եմ կրկին փորձել։",
      });
      return;
    }
    await respondWithBoundedPhase2Message(
      activatedSource.renderedPrompt,
      "TRANSITION",
      true,
    );
    return;
  }

  if (
    session?.currentPhase === 2 &&
    _phase2ServerActionPlan.action === "GENERATE_TASK"
  ) {
    try {
      await assertPhase2TargetLocked();
      const task = await callPhase2TaskJob(chatHistory, lessonContext);
      const isObjective =
        task.interaction_type === "multiple_choice" ||
        task.interaction_type === "true_false";
      const taskReference = createTaskReference(
        task.interaction_type === "constructed_response" ? "generated_task" : "micro_check",
      );
      const objectivePayload = isObjective
        ? {
            interactionType: task.interaction_type,
            options: task.interaction_type === "multiple_choice" ? task.options : null,
            correctOption: task.correct_option,
          } as ActiveObjectiveTaskPayload
        : null;
      const taskContent = renderGeneratedTask(task);
      const taskUpdate: Record<string, unknown> = {
        nodeTeachingStage: "MICRO_CHECK",
        activeLessonExerciseId: null,
        activeTaskProvenance: task.interaction_type === "constructed_response"
          ? "constructed_response"
          : "micro_check",
        activeTaskReference: taskReference,
        activeTaskSnapshot: buildCanonicalTaskSnapshot({
          taskReference,
          taskSource: task.interaction_type === "constructed_response" ? "generated_task" : "micro_check",
          taskKind: task.interaction_type === "constructed_response" ? "generated" : "micro_check",
          renderedPrompt: taskContent,
          executionTarget: _c7ExecutionTarget ?? undefined,
          interactionType: task.interaction_type,
          learnerTextSource: "generated",
          objectivePayload,
          questionTemplate: task.question_template,
          targetCompatibleAtActivation: _c7ExecutionTarget !== null,
        }),
        activeObjectiveTaskPayload: objectivePayload,
        activeAttemptSequence: 1,
        activeHelpCount: 0,
        activeAssistanceLevel: "none",
        lastQuestionAsked: taskContent,
      };
      await updateC7TargetLockedSession(taskUpdate);
      await respondWithBoundedPhase2Message(
        taskContent,
        "MICRO_CHECK",
        true,
      );
      return;
    } catch (error) {
      boundedPhase2Failure(error, "TASK");
      return;
    }
  }

  if (
    session?.currentPhase === 2 &&
    _phase2ServerActionPlan.action === "PRESERVE_ACTIVE_TASK"
  ) {
    try {
      const feedback = await callPhase2FeedbackJob(
        chatHistory,
        [
          lessonContext,
          "AUTHORITATIVE FEEDBACK FACTS:",
          "Evaluation: {\"status\":\"NOT_APPLICABLE\",\"evidence_quality\":\"NONE\",\"error_family\":null,\"error_stability\":null,\"correct_parts\":[],\"incorrect_parts\":[]}",
          "Decision Engine meta action: PRESERVE_ACTIVE_TASK",
          "Decision Engine remediation action: NONE",
          `Server action: ${_phase2ServerActionPlan.action}`,
          "The learner has an active task but did not submit an answer.",
          "Keep the same active task open. Do not create or append another task.",
          `Learner message: ${message}`,
        ].join("\n"),
        _stage3HiddenExerciseContent,
      );
      assertFeedbackOnly(feedback);
      await respondWithBoundedPhase2Message(feedback.student_message, "FEEDBACK", true);
      return;
    } catch (error) {
      boundedPhase2Failure(error, "FEEDBACK");
      return;
    }
  }

  if (
    session?.currentPhase === 2 &&
    _phase2ServerActionPlan.action === "DELIVER_FEEDBACK" &&
    session.nodeTeachingStage === "FEEDBACK"
  ) {
    try {
      // Recover only the feedback boundary after a bounded-feedback failure.
      // The evaluator result was already persisted into immutable C3 evidence
      // before the stage changed. Do not infer correctness from chat history.
      const [feedbackEvidence] = await db
        .select({ metadata: evidenceEventsTable.metadata, taskReference: (evidenceEventsTable as any).taskReference })
        .from(evidenceEventsTable)
        .where(and(
          eq((evidenceEventsTable as any).lessonSessionId, session.id),
          eq((evidenceEventsTable as any).lessonNodeId, session.currentNodeId),
        ))
        .orderBy(desc(evidenceEventsTable.createdAt))
        .limit(1);
      const retryEvaluation = (feedbackEvidence?.metadata as any)?.evaluation ?? null;
      const retryTransition = (feedbackEvidence?.metadata as any)?.c7DeferredTransition ?? null;
      const retryTarget = (feedbackEvidence?.metadata as any)?.c7ExecutionTarget ?? null;
      if (!retryEvaluation?.status) {
        throw new Error("FEEDBACK recovery requires persisted canonical evaluation evidence");
      }
      if (
        !retryTarget ||
        retryTarget.lessonId !== lessonId ||
        retryTarget.microNodeId !== session.currentNodeId ||
        retryTarget.activeCognitiveLevelId !== session.activeCognitiveLevelId
      ) {
        throw new Error("FEEDBACK recovery target does not match its immutable evaluated-task snapshot");
      }
      await assertPhase2TargetLocked();
      const feedback = await callPhase2FeedbackJob(
        chatHistory,
        [
          lessonContext,
          "AUTHORITATIVE FEEDBACK FACTS:",
          `Evaluation: ${JSON.stringify(retryEvaluation)}`,
          `Evidence task reference: ${feedbackEvidence?.taskReference ?? "unknown"}`,
          "The learner has already submitted an answer. Provide only concise feedback consistent with this evaluation.",
          "Do not ask a question, create a task, or change the current target.",
          "Server action: DELIVER_FEEDBACK",
        ].join("\n"),
        _stage3HiddenExerciseContent,
      );
      assertFeedbackOnly(feedback);
      const [feedbackMessage] = await db
        .insert(chatMessagesTable)
        .values({ userId: req.userId!, lessonId: lessonId ?? null, role: "assistant", content: feedback.student_message })
        .returning();
      // The message is observable before this boundary may release. Reapply a
      // C7.1 transition only from the persisted authorization snapshot.
      if (retryTransition?.action === "ADVANCE_COGNITIVE_LEVEL") {
        const nextLevelId = retryTransition.c6Decision?.nextTargetCognitiveLevelId;
        if (typeof nextLevelId !== "number") {
          throw new Error("FEEDBACK recovery transition is missing its C6 level target");
        }
        await updateC7TargetLockedSession(
          buildAuthorizedLevelTransitionUpdate(nextLevelId) as any,
        );
      } else if (retryTransition?.action === "COMPLETE_MICRONODE") {
        const advanceResult = await advanceNodeInSession(
          session.id,
          req.userId!,
          lessonId!,
          session.currentNodeId!,
          session.currentPhase,
          Boolean(retryTransition.safetyCapHit),
          retryTransition.c6Decision as Awaited<ReturnType<typeof resolveCanonicalC6Decision>>,
          await assertPhase2TargetLocked() ?? undefined,
        );
        if (advanceResult.c6BlockedReason) {
          throw new Error(`FEEDBACK recovery C6 target unavailable: ${advanceResult.c6BlockedReason}`);
        }
      } else {
        await updateC7TargetLockedSession(buildPostFeedbackTransitionUpdate() as any);
      }
      respondWithPersistedPhase2Message(feedback.student_message, feedbackMessage.id, "FEEDBACK", false);
      return;
    } catch (error) {
      // Leave FEEDBACK untouched so a later retry resumes the same safe
      // boundary rather than replacing the evaluated task.
      boundedPhase2Failure(error, "FEEDBACK");
      return;
    }
  }

  if (
    session?.currentPhase === 2 &&
    _phase2ServerActionPlan.action === "EVALUATE_ACTIVE_TASK" &&
    session
  ) {
    try {
      let evaluation: Phase2EvaluationResult | undefined;
      const activeTaskSnapshot = isCanonicalTaskSnapshot(session.activeTaskSnapshot)
        ? session.activeTaskSnapshot
        : null;
      if (
        !activeTaskSnapshot ||
        activeTaskSnapshot.taskReference !== session.activeTaskReference ||
        activeTaskSnapshot.attemptSequence !== session.activeAttemptSequence
      ) {
        throw new Error("bounded evaluation requires an immutable canonical task snapshot");
      }
      if (session.activeTaskProvenance === "constructed_response") {
        evaluation = await callPhase2EvaluationJob(
          chatHistory,
          [
            lessonContext,
            "AUTHORITATIVE EVALUATION INPUT:",
            `Task: ${activeTaskSnapshot.renderedPrompt}`,
            `Learner answer: ${message}`,
            "Evaluate the answer only. Do not write learner-facing feedback.",
          ].join("\n"),
        );
      } else if (session.activeTaskProvenance === "source_exercise") {
        if (!activeTaskSnapshot.sourceAnswer || activeTaskSnapshot.lessonExerciseId === null) {
          throw new Error("source evaluation snapshot lacks a persisted answer contract");
        }
        const activeSourceExercise = {
          id: activeTaskSnapshot.lessonExerciseId,
          exerciseId: activeTaskSnapshot.sourceExerciseId ?? "snapshot",
          interactionType: activeTaskSnapshot.sourceAnswer.interactionType,
          correctAnswer: activeTaskSnapshot.sourceAnswer.correctAnswer,
        };
        _stage3HiddenExerciseContent = [
          activeTaskSnapshot.sourceSuccessCriteria,
          activeSourceExercise.correctAnswer,
        ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
        _stage3SourceExerciseForEvaluation = activeSourceExercise;
        const deterministicSourcePreview = evaluateDeterministicSourceExerciseAnswer({
          learnerIntent: _intentResult.intent,
          activeTaskProvenance: session.activeTaskProvenance,
          activeLessonExerciseId: session.activeLessonExerciseId,
          exerciseId: activeSourceExercise.exerciseId,
          interactionType: activeSourceExercise.interactionType,
          correctAnswer: activeSourceExercise.correctAnswer,
          studentAnswer: message,
        });
        if (deterministicSourcePreview === null) {
          evaluation = await callPhase2EvaluationJob(
            chatHistory,
            [
              lessonContext,
              "AUTHORITATIVE EVALUATION INPUT:",
              `LEARNER_TASK_TEXT:\n${activeTaskSnapshot.renderedPrompt}`,
              `EVALUATOR_ONLY_SUCCESS_CRITERIA:\n${activeTaskSnapshot.sourceSuccessCriteria?.trim() || "(not provided)"}`,
              `Interaction type: ${String(activeSourceExercise.interactionType ?? "constructed_response")}`,
              `Learner answer: ${message}`,
              "Evaluate the answer only. Do not write learner-facing feedback.",
            ].join("\n"),
          );
        }
      }
      aiResult = createStage3EvaluationEnvelope(progressIndicator, evaluation);
      _stage3BoundedAnswerTurn = true;
    } catch (error) {
      boundedPhase2Failure(error, "EVALUATION");
      return;
    }
  }

  try {
    if (!_stage3BoundedAnswerTurn) {
      aiResult = await callAIStructured(chatHistory, lessonContext, {
        currentPhase: session?.currentPhase ?? null,
        currentNodeId: session?.currentNodeId ?? null,
        nodeTeachingStage: session?.nodeTeachingStage ?? null,
      });

      validatePhase2ResponseForServerAction(_phase2ServerActionPlan, aiResult);
    }

    if (!aiResult) {
      throw new Error("No Phase-2 response was available for evaluation");
    }

    // The structured contract currently does not require target proposal
    // fields, but reject them if a provider/legacy response includes them.
    // This is a server-side boundary, not a prompt-only convention.
    if (
      _c7ExecutionTarget &&
      !validateC7ModelTargetProposal(
        _c7ExecutionTarget,
        aiResult as unknown as {
          lessonId?: number | null;
          microNodeId?: number | null;
          cognitiveLevelId?: number | null;
        },
      )
    ) {
      throw new Error("model response proposed a target outside the immutable C7 execution target");
    }

    {
      const _p9msg = aiResult.student_message.trimStart();
      const _p9match = _p9msg.match(/^(\u0548\u0579[,\u0589]|\u054d\u056d\u0561\u056c \u0567[,\u0589]|\u0534\u0578\u0582 \u0579\u0565\u057d)/u);
      if (_p9match) {
        const stripped = _p9msg.replace(/^(\u0548\u0579[,\u0589]|\u054d\u056d\u0561\u056c \u0567[,\u0589]|\u0534\u0578\u0582 \u0579\u0565\u057d)\s*/u, "");
        if (stripped.length > 10) {
          (aiResult as { student_message: string }).student_message = stripped;
          logger.info({ opener: _p9msg.slice(0, 50) }, "P9: stripped denial opener");
        }
      }
    }

    if (session?.currentNodeId && aiResult.student_message) {
      const driftDetected = validateNoScopeDrift(aiResult.student_message, _allNodeTitles);
      if (driftDetected) {
        logger.warn(
          {
            lessonId, sessionId: session.id,
            userInput: message,
            modelOutput: aiResult,
          },
          "P7 scope-drift incident: model mentioned out-of-scope topic — suppressing response"
        );
        const lastQ = session.lastQuestionAsked;
        const canned = lastQ
          ? `${REDIRECT_CANNED_PREFIX}\n${lastQ}`
          : REDIRECT_CANNED_PREFIX;
        const [assistantMsgCanned] = await db
          .insert(chatMessagesTable)
          .values({ userId: req.userId!, lessonId: lessonId ?? null, role: "assistant", content: canned })
          .returning();
        res.json({ response: canned, messageId: assistantMsgCanned.id, progressIndicator, teachingMode });
        return;
      }
    }

    if (aiResult.redirect_needed) {
      aiResult.node_decision = { action: "CONTINUE_SAME_NODE", reason: "redirect_needed: student tried to skip" };
      if (aiResult.answer_evaluation.evidence_quality === "STRONG" ||
          aiResult.answer_evaluation.evidence_quality === "CONCLUSIVE") {
        aiResult.answer_evaluation = {
          ...aiResult.answer_evaluation,
          status: "NOT_APPLICABLE",
          evidence_quality: "NONE",
        };
      }
    }

    studentMessage = aiResult.student_message;
    teachingMode =
      _phase2ServerActionPlan.responseTeachingMode ??
      aiResult.teaching_mode;
    const _activeCanonicalTaskSnapshot = isCanonicalTaskSnapshot(session?.activeTaskSnapshot)
      ? session.activeTaskSnapshot
      : null;
    if (
      session !== null &&
      session.currentPhase >= 2 &&
      _intentResult.intent === "ANSWER" &&
      _intentHasActiveTask &&
      (
        !_activeCanonicalTaskSnapshot ||
        _activeCanonicalTaskSnapshot.taskReference !== session.activeTaskReference ||
        _activeCanonicalTaskSnapshot.attemptSequence !== session.activeAttemptSequence
      )
    ) {
      res.status(409).json({
        error: "ACTIVE_TASK_SNAPSHOT_UNAVAILABLE",
        message: "Ընթացիկ առաջադրանքը չի կարող անվտանգ գնահատվել։ Խնդրում ենք նորից սկսել այն։",
      });
      return;
    }
    const _activeObjectiveTaskPayload = (
      _intentResult.intent === "ANSWER" &&
      session?.activeTaskProvenance === "micro_check" &&
      _activeCanonicalTaskSnapshot?.objectivePayload
    )
      ? _activeCanonicalTaskSnapshot.objectivePayload
      : null;

    // Active typed source exercises have a separate, database-backed correctness
    // authority from AI-generated MICRO_CHECK payloads. The route owns the read;
    // the pure Phase 2 coordinator applies the authoritative evaluation.
    let _activeSourceExerciseForEvaluation: AuthoritativeSourceExercise | null =
      _stage3SourceExerciseForEvaluation;
    if (
      _activeSourceExerciseForEvaluation === null &&
      _intentResult.intent === "ANSWER" &&
      session?.activeTaskProvenance === "source_exercise" &&
      _activeCanonicalTaskSnapshot?.sourceAnswer
    ) {
      _activeSourceExerciseForEvaluation = {
        id: _activeCanonicalTaskSnapshot.lessonExerciseId ?? -1,
        exerciseId: _activeCanonicalTaskSnapshot.sourceExerciseId ?? "snapshot",
        interactionType: _activeCanonicalTaskSnapshot.sourceAnswer.interactionType,
        correctAnswer: _activeCanonicalTaskSnapshot.sourceAnswer.correctAnswer,
      };
    }

    const _authoritativeEvaluation = resolveAuthoritativeEvaluation({
      response: aiResult,
      learnerIntent: _intentResult.intent,
      hasActiveTask: _intentHasActiveTask,
      activeTaskProvenance: session?.activeTaskProvenance ?? null,
      activeLessonExerciseId: session?.activeLessonExerciseId ?? null,
      activeObjectiveTaskPayload: _activeObjectiveTaskPayload,
      activeSourceExercise: _activeSourceExerciseForEvaluation,
      studentAnswer: message,
    });
    aiResult = _authoritativeEvaluation.response;
    wasCorrect = _authoritativeEvaluation.wasCorrect;
    _evidenceResultAuthority = _authoritativeEvaluation.authority;
    if (_stage3BoundedAnswerTurn) {
      _evaluatedTurnAuthority = establishEvaluatedTurnAuthority(
        aiResult.answer_evaluation,
      );
      logger.info(
        {
          sessionId: session?.id ?? null,
          requestId: (req as any).id ?? null,
          learnerMessageId: learnerMessage.id,
          activeTaskProvenance: session?.activeTaskProvenance ?? null,
          activeLessonExerciseId: session?.activeLessonExerciseId ?? null,
          evaluationAuthority: _authoritativeEvaluation.authority,
          evaluationStatus: _evaluatedTurnAuthority.status,
          evidenceWasCorrect: _evaluatedTurnAuthority.evidenceWasCorrect,
          isCorrectnessOutcome: _evaluatedTurnAuthority.isCorrectnessOutcome,
        },
        "Stage-5.3 authoritative evaluated-turn snapshot established",
      );
    }

    if (_authoritativeEvaluation.authority === "non_answer_gate") {
      logger.info(
        { sessionId: session?.id, intent: _intentResult.intent },
        "V2-R2: non-ANSWER intent — answer_evaluation forced NOT_APPLICABLE, no evidence/attempt"
      );
    }
    if (
      _authoritativeEvaluation.authority === "objective_task" &&
      _activeObjectiveTaskPayload
    ) {
      logger.info(
        {
          sessionId: session?.id,
          interactionType: _activeObjectiveTaskPayload.interactionType,
          normalizedAnswer: _authoritativeEvaluation.normalizedObjectiveAnswer,
          isObjectiveAnswerCorrect:
            _authoritativeEvaluation.objectiveAnswerCorrect,
        },
        "Objective MICRO_CHECK correctness overridden deterministically"
      );
    }
    if (_authoritativeEvaluation.sourceEvaluation) {
      const deterministicEvaluation = _authoritativeEvaluation.sourceEvaluation;
      logger.info(
        {
          lessonExerciseId: deterministicEvaluation.lessonExerciseId,
          exerciseId: deterministicEvaluation.exerciseId,
          interactionType: deterministicEvaluation.interactionType,
          normalizedAnswer: deterministicEvaluation.normalizedAnswer,
          canonicalCorrectAnswer: deterministicEvaluation.canonicalCorrectAnswer,
          finalStatus: deterministicEvaluation.status,
        },
        "Source exercise correctness overridden deterministically"
      );
    }

  } catch (err) {
    const structuredFailure = {
      event:     "ai_structured_fallback",
      userId:    req.userId,
      lessonId,
      sessionId: session?.id ?? null,
      firstError: err instanceof Error ? err.message : String(err),
    };

    // Phase 2 MicroNode teaching relies on structured metadata to keep the
    // visible task and persisted session state in sync. Do not let plain-text
    // fallback display an untracked teaching response or micro-check.
    if (session?.currentPhase === 2 && session.currentNodeId) {
      logger.error(
        structuredFailure,
        "callAIStructured failed twice — structured response required for controlled Phase 2 teaching"
      );
      res.status(503).json({
        error: "STRUCTURED_AI_REQUIRED",
        message: "Չհաջողվեց շարունակել դասը։ Խնդրում եմ կրկին փորձել։",
      });
      return;
    }

    logger.error(
      structuredFailure,
      "callAIStructured failed twice — falling back to callAI"
    );
    try {
      studentMessage = await callAI(chatHistory, lessonContext || undefined);
      const evalMatch = studentMessage.match(/\s*###EVAL:(CORRECT|INCORRECT|NONE)###\s*$/);
      wasCorrect = evalMatch?.[1] === "CORRECT" ? true : evalMatch?.[1] === "INCORRECT" ? false : null;
      if (evalMatch) studentMessage = studentMessage.slice(0, evalMatch.index).trimEnd();
    } catch (err2) {
      logger.error({ err: err2 }, "callAI fallback also failed");
      res.status(503).json({ error: "AI service unavailable" });
      return;
    }
  }

  // ── Phase 11.1: Verbatim exercise delivery enforcement ─────────────────────
  // The resolved eligible row is activated before this request can expose it as
  // the next answerable source exercise. P11.1 owns the primary-message
  // delivery, so V2-R1.1 must not append a second visible copy later this turn.
  let _p11StudentMessageBeforeDelivery: string | null = null;
  let _p11TeachingModeBeforeDelivery: string | null = null;
  let _p11AiTeachingModeBeforeDelivery: AIStructuredResponse["teaching_mode"] | null = null;
  let _p11SourceExerciseIdBeforeDelivery: string | null = null;
  if (
    !_stage3BoundedAnswerTurn &&
    session &&
    (
      _phase2ServerActionPlan.action === "EVALUATE_ACTIVE_TASK" ||
      _phase2ServerActionPlan.compatibilityKind ===
        "legacy_micro_check_without_task_payload"
    ) &&
    _intentResult.intent === "ANSWER" &&
    (aiResult === null || aiResult.answer_evaluation.status !== "OFF_TOPIC") &&
    isExerciseDeliveryTurn(session.currentPhase, session.nodeTeachingStage ?? "THEORY", classExercises.length)
  ) {
    _p11StudentMessageBeforeDelivery = studentMessage;
    _p11TeachingModeBeforeDelivery = teachingMode;
    _p11AiTeachingModeBeforeDelivery = aiResult?.teaching_mode ?? null;
    _p11SourceExerciseIdBeforeDelivery = aiResult?.source_fidelity?.exercise_id ?? null;
    const selection = resolveEligibleSourceExercise(
      classExercises,
      aiResult?.source_fidelity?.exercise_id ?? null,
    );
    const activatedExercise = await activateSourceExercise(
      session.id,
      selection,
      await assertPhase2TargetLocked() ?? undefined,
    );

    if (activatedExercise) {
      _activeLessonExerciseIdForDelivery = activatedExercise.exercise.id;
      const activeExercise = classExercises.find(
        (exercise) => exercise.id === _activeLessonExerciseIdForDelivery,
      ) ?? null;
      if (!activeExercise) {
        // Impossible when activation only accepts a current eligible row; fail
        // closed rather than substituting a different exercise for delivery.
        logger.error(
          { sessionId: session.id, activeLessonExerciseId: _activeLessonExerciseIdForDelivery },
          "P11.1: activated source exercise was not present in eligible delivery set"
        );
      } else {
        _p11SelectedSourceExercise = activeExercise;
        _sourceExerciseActivatedThisTurn = true;
        const enforced = enforceActiveSourceExercise(
          studentMessage,
          activatedExercise.renderedPrompt,
          classExercises
            .filter((exercise) => exercise.id !== activeExercise.id)
            .map((exercise) => canonicalSourcePrompt(exercise)?.prompt ?? null)
            .filter((text): text is string => text !== null),
        );
        if (enforced !== studentMessage) {
          logger.info(
            { sessionId: session.id, nodeId: session.currentNodeId, exerciseId: activeExercise.exerciseId },
            "P11.1: backend injected active source exercise text"
          );
          studentMessage = enforced;
        }
        _sourceExerciseDeliveredThisTurn = true;
        hasActiveTask = true;
        // Always set teachingMode to TRANSITION for exercise delivery turns.
        teachingMode = "TRANSITION";
        if (aiResult) {
          // The AI-provided value is a request only. Replace it with the external
          // ID of the exact eligible row that was activated.
          (aiResult as { teaching_mode: string }).teaching_mode = "TRANSITION";
          (aiResult as unknown as { source_fidelity: { exercise_id: string | null } }).source_fidelity = {
            ...(aiResult.source_fidelity ?? {}),
            exercise_id: activeExercise.exerciseId,
          };
        }
      }
    }
  }

  if (aiResult && session?.currentNodeId && session.currentPhase >= 2 && lessonId) {
    const _turnProgress = deriveTurnProgress({
      evaluation: aiResult.answer_evaluation,
      currentStage: session.nodeTeachingStage,
      classExerciseCount: classExercises.length,
      masteryEvidenceCount: session.nodeMasteryEvidenceCount,
      consecutiveCorrect: session.nodeConsecutiveCorrect,
      consecutiveIncorrect: session.nodeConsecutiveIncorrect,
      attemptCount: session.nodeAttemptCount,
    });
    if (
      _evaluatedTurnAuthority !== null &&
      _turnProgress.status !== _evaluatedTurnAuthority.status
    ) {
      throw new Error("evaluated-turn status diverged before state transition");
    }
    if (_turnProgress.wasEval) {
      // Capture the evaluated task before continuation can clear it. Evidence
      // is written after res.json(), so reading the mutable session there can
      // otherwise turn an assisted answer into false independent evidence.
      _evaluatedTaskEvidenceContext = {
        id: session.id,
        currentNodeId: session.currentNodeId,
        nodeTeachingStage: session.nodeTeachingStage,
        activeTaskProvenance: session.activeTaskProvenance,
        activeTaskReference: session.activeTaskReference,
        activeLessonExerciseId: session.activeLessonExerciseId,
        activeCognitiveLevelId: session.activeCognitiveLevelId,
        activeAttemptSequence: session.activeAttemptSequence,
        activeHelpCount: session.activeHelpCount,
        activeAssistanceLevel: session.activeAssistanceLevel,
        activeTaskSnapshot: isCanonicalTaskSnapshot(session.activeTaskSnapshot)
          ? session.activeTaskSnapshot
          : null,
      };
    }
    const {
      status,
      quality,
      isCorrect,
      wasEval,
    } = _turnProgress;

    // C7.1 order is deliberate: C3 qualification and its persisted C4
    // projection happen before the candidate-only pedagogical engine can
    // request any cognitive or MicroNode progression.
    if (wasEval && _evaluatedTaskEvidenceContext) {
      try {
        // Claim the exact persisted task before evidence is written. A second
        // answer submission for the same task fails this CAS and cannot append
        // duplicate evidence or overwrite the terminal/remediation decision.
        if (_stage3BoundedAnswerTurn) {
          const taskReference = _evaluatedTaskEvidenceContext.activeTaskReference;
          const taskNodeId = _evaluatedTaskEvidenceContext.currentNodeId;
          const taskCognitiveLevelId = _evaluatedTaskEvidenceContext.activeCognitiveLevelId;
          if (!taskReference || taskNodeId === null || taskCognitiveLevelId === null) {
            res.status(409).json({
              error: "ACTIVE_TASK_IDENTITY_UNAVAILABLE",
              message: "Ընթացիկ առաջադրանքը չի կարող անվտանգ գնահատվել։ Խնդրում ենք նորից սկսել այն։",
            });
            return;
          }
          const reservationMarker = c7EvaluationReservation(
            taskReference,
            _evaluatedTaskEvidenceContext.activeAttemptSequence,
          );
          const claimed = await db
            .update(lessonSessionsTable)
            .set({ activeTaskReference: reservationMarker } as any)
            .where(and(
              eq(lessonSessionsTable.id, session.id),
              eq(lessonSessionsTable.currentNodeId, taskNodeId),
              eq(lessonSessionsTable.activeCognitiveLevelId, taskCognitiveLevelId),
              eq((lessonSessionsTable as any).activeTaskReference, taskReference),
              eq((lessonSessionsTable as any).activeAttemptSequence, _evaluatedTaskEvidenceContext.activeAttemptSequence),
            ))
            .returning({ id: lessonSessionsTable.id });
          if (claimed.length === 0) {
            res.status(409).json({
              error: "STALE_TASK_SUBMISSION",
              message: "Այս առաջադրանքն արդեն գնահատվել է կամ փոխվել է։ Խնդրում ենք թարմացնել դասը։",
            });
            return;
          }
          _evaluatedTaskReservation = {
            reference: taskReference,
            marker: reservationMarker,
          };
        }
        const canonicalEvidence = await persistAndProjectChatEvidence({
          userId: req.userId!,
          lessonId,
          snapshot: _evaluatedTaskEvidenceContext,
          currentNodeId: session.currentNodeId,
          currentNodeMatchesSnapshot:
            currentNodeRecord?.id === _evaluatedTaskEvidenceContext.currentNodeId,
          cognitivePath: _cognitivePath,
          evidenceQuality: quality,
          // UNCLEAR and NO_RESPONSE are observations, not negative mastery
          // evidence. Persist the nullable C3 correctness authority exactly.
          wasCorrect: _evaluatedTurnAuthority?.evidenceWasCorrect ?? null,
          evidenceResultAuthority: _evidenceResultAuthority,
          executionTarget: (await assertPhase2TargetLocked())!,
          evaluationSnapshot: {
            status: aiResult.answer_evaluation.status,
            evidenceQuality: aiResult.answer_evaluation.evidence_quality,
            errorFamily: aiResult.answer_evaluation.error_family,
            errorStability: aiResult.answer_evaluation.error_stability,
          },
        });
        _canonicalEvidenceProcessed = true;
        _canonicalEvidenceQualification = canonicalEvidence.qualificationStatus;
        _canonicalEvidenceProjection = canonicalEvidence.projection;
        _canonicalEvidenceTaskReference = canonicalEvidence.taskReference;
        if (_evaluatedTaskReservation) {
          const finalized = await db
            .update(lessonSessionsTable)
            .set(buildMandatoryFeedbackStageUpdate() as any)
            .where(and(
              eq(lessonSessionsTable.id, session.id),
              eq(
                (lessonSessionsTable as any).activeTaskReference,
                _evaluatedTaskReservation.marker,
              ),
            ))
            .returning({ id: lessonSessionsTable.id });
          if (finalized.length === 0) {
            throw new Error("evaluated task reservation could not be finalized");
          }
          _evaluatedTaskClaimed = true;
        }
      } catch (err) {
        if (_evaluatedTaskReservation) {
          try {
            const [persistedEvidence] = await db
              .select({ id: evidenceEventsTable.id })
              .from(evidenceEventsTable)
              .where(and(
                eq((evidenceEventsTable as any).lessonSessionId, session.id),
                eq(
                  (evidenceEventsTable as any).taskReference,
                  _evaluatedTaskReservation.reference,
                ),
              ))
              .limit(1);
            if (!persistedEvidence) {
              // C3 did not commit: release the reservation so the identical
              // task can be evaluated again.
              await db
                .update(lessonSessionsTable)
                .set({ activeTaskReference: _evaluatedTaskReservation.reference } as any)
                .where(and(
                  eq(lessonSessionsTable.id, session.id),
                  eq(
                    (lessonSessionsTable as any).activeTaskReference,
                    _evaluatedTaskReservation.marker,
                  ),
                ));
            }
            // If C3 committed, retain the reservation. The request-entry
            // recovery path detects its evidence and finalizes FEEDBACK without
            // sending the task through a fresh model evaluation.
          } catch (restoreError) {
            logger.error(
              { err: restoreError, sessionId: session.id },
              "C7.1: failed to restore task after evidence reservation failure",
            );
          }
          _evaluatedTaskReservation = null;
        }
        logger.error({ err, sessionId: session.id }, "C7.1: evidence/C4 projection failed before progression");
        res.status(503).json({
          error: "EVIDENCE_PERSISTENCE_FAILED",
          message: "Պատասխանը չի հաջողվել վստահելիորեն գրանցել։ Խնդրում ենք կրկին փորձել։",
        });
        return;
      }
    }

    // ── Initialize hasActiveTask from existing session state ──────────────
    // Covers backward-compat with sessions created before Phase 2B (null provenance)
    // and cases where the task was set in a previous turn.
    hasActiveTask = (session.activeTaskProvenance !== null && session.activeTaskProvenance !== "")
      || session.nodeTeachingStage === "MICRO_CHECK"
      || session.nodeTeachingStage === "EXERCISE";

    // ── Anticipatory THEORY→MICRO_CHECK stage advance ─────────────────────
    // Fixes: on the very first turn of a node, the AI delivers THEORY +
    // asks the first MICRO_CHECK in one turn. Since the student hasn't
    // answered anything yet, status=NOT_APPLICABLE (wasEval=false), so the
    // stage-machine block below never runs and teachingStage stays "THEORY".
    // On the NEXT turn (student's actual answer), the directive would then
    // wrongly say "give THEORY again" instead of "evaluate the answer".
    // This block pushes the stage forward immediately, independent of wasEval.
    // Phase 2B fix: also write active task identity fields (previously omitted).
    const _serverAllowsGeneratedTask =
      session.currentPhase !== 2 ||
      _phase2ServerActionPlan.action === "DELIVER_THEORY";
    if (
      !wasEval &&
      _serverAllowsGeneratedTask &&
      (session?.nodeTeachingStage ?? "THEORY") === "THEORY" &&
      aiResult.is_micro_check
    ) {
      const isConstructedResponse = aiResult.interaction_type === "constructed_response";
      const taskSource = isConstructedResponse ? "generated_task" : "micro_check";
      const taskActivation = deriveGeneratedMicroCheckActivation(
        aiResult,
        createTaskReference(taskSource),
      );
      if (taskActivation) {
        const generatedPrompt =
          aiResult.interaction_type === "multiple_choice" ||
          aiResult.interaction_type === "true_false" ||
          aiResult.interaction_type === "constructed_response"
            ? renderGeneratedTask({
                student_message: aiResult.student_message,
                interaction_type: aiResult.interaction_type,
                options: aiResult.options,
              })
            : aiResult.student_message;
        const taskSnapshot = buildCanonicalTaskSnapshot({
          taskReference: taskActivation.activeTaskReference!,
          taskSource,
          taskKind: isConstructedResponse ? "generated" : "micro_check",
          renderedPrompt: generatedPrompt,
          executionTarget: _c7ExecutionTarget ?? undefined,
          interactionType: aiResult.interaction_type,
          learnerTextSource: "generated",
          objectivePayload: taskActivation.activeObjectiveTaskPayload,
          questionTemplate: aiResult.question_template,
          targetCompatibleAtActivation: _c7ExecutionTarget !== null,
        });
        await db
          .update(lessonSessionsTable)
          .set({
            ...taskActivation,
            activeTaskSnapshot: taskSnapshot,
            lastQuestionAsked: generatedPrompt,
          } as any)
          .where(eq(lessonSessionsTable.id, session.id));
        hasActiveTask = true;
        logger.info(
          {
            sessionId: session.id,
            nodeId: session.currentNodeId,
            serverAction: _phase2ServerActionPlan.action,
          },
          "teachingStage anticipatory advance: THEORY -> MICRO_CHECK"
        );
      }
    }

    // ── Anticipatory MICRO_CHECK→EXERCISE stage advance ───────────────────
    // When the AI presents a class exercise (teaching_mode=TRANSITION with a
    // filled exercise_id) before the student has answered anything (wasEval=false),
    // push the stage forward immediately so the NEXT turn directive correctly
    // says "evaluate the answer" instead of "present the exercise again".
    // Phase 2B fix: also write active task identity fields (previously omitted).
    //
    // V2-R2 gate: only advance on ANSWER intent.  If the student said "chgidem"
    // (CONFUSED) / "krkni" (REPEAT) / CLARIFY / OFF_TOPIC and the AI happens to
    // reply with TRANSITION+exercise_id (re-presenting the task), we must NOT
    // advance the stage or set activeAttemptSequence=1 — that would register a
    // phantom attempt and change the session teaching stage without the student
    // having answered anything.  The anticipatory advance is only meaningful when
    // the AI is introducing the exercise fresh to a student who is about to answer.
    // Also exclude status="OFF_TOPIC": when Stage B returns ANSWER intent for an
    // off-topic message and the AI flags answer_evaluation.status="OFF_TOPIC",
    // wasEval is already false (OFF_TOPIC excluded from wasEval above) — but the
    // anticipatory block would still fire unless we add this guard.
    if (!wasEval && _intentResult.intent === "ANSWER" && status !== "OFF_TOPIC" &&
        (
          _phase2ServerActionPlan.action === "EVALUATE_ACTIVE_TASK" ||
          _phase2ServerActionPlan.compatibilityKind ===
            "legacy_micro_check_without_task_payload"
        ) &&
        (session?.nodeTeachingStage ?? "THEORY") === "MICRO_CHECK" &&
        aiResult.source_fidelity.exercise_id) {
      const selection = _p11SelectedSourceExercise
        ? {
            selected: _p11SelectedSourceExercise,
            requestedExerciseId: aiResult.source_fidelity.exercise_id,
            resolution: "requested_eligible" as const,
          }
        : resolveEligibleSourceExercise(classExercises, aiResult.source_fidelity.exercise_id);
      const selectedExercise = _sourceExerciseActivatedThisTurn
        ? (selection.selected
          ? { exercise: selection.selected, renderedPrompt: canonicalSourcePrompt(selection.selected)?.prompt ?? "" }
          : null)
        : await activateSourceExercise(
            session.id,
            selection,
            await assertPhase2TargetLocked() ?? undefined,
          );
      if (selectedExercise) {
        _activeLessonExerciseIdForDelivery = selectedExercise.exercise.id;
        _sourceExerciseActivatedThisTurn = true;
        hasActiveTask = true;
        logger.info(
          { sessionId: session.id, nodeId: session.currentNodeId, exerciseId: selectedExercise.exercise.exerciseId },
          "teachingStage anticipatory advance: MICRO_CHECK -> EXERCISE"
        );
      }
    }

    if (wasEval) {
      logger.info(
        {
          nodeId: session.currentNodeId,
          status,
          quality,
          errorFamily: aiResult.answer_evaluation.error_family,
          errorStability: aiResult.answer_evaluation.error_stability,
          nodeAction: aiResult.node_decision.action,
        },
        "P5/P7 decision snapshot"
      );
      const {
        currentStage,
        newTeachingStage,
        newMasteryCount,
        newConsecutiveCorrect: newConsecCorrect,
        newConsecutiveIncorrect: newConsecIncorrect,
        newAttemptCount,
      } = _turnProgress;

      await db
        .update(lessonSessionsTable)
        .set({
          nodeMasteryEvidenceCount: newMasteryCount,
          nodeLastEvidenceQuality:  quality,
          nodeConsecutiveCorrect:   newConsecCorrect,
          nodeConsecutiveIncorrect: newConsecIncorrect,
          nodeAttemptCount:         newAttemptCount,
        })
        .where(eq(lessonSessionsTable.id, session.id));

      const mustEnterFeedbackBoundary =
        session.currentPhase === 2 &&
        (session.nodeTeachingStage === "MICRO_CHECK" ||
          session.nodeTeachingStage === "EXERCISE") &&
        session.activeTaskProvenance !== null;
      if (mustEnterFeedbackBoundary) {
        // C7.2: every evaluated answer, whether correct, incorrect, unclear,
        // generated, or source-backed, retires into an explicit FEEDBACK
        // state.  The task cannot be replaced while bounded feedback is
        // pending or being retried.
        if (!_evaluatedTaskClaimed) {
          await db
            .update(lessonSessionsTable)
            .set(buildMandatoryFeedbackStageUpdate() as any)
            .where(eq(lessonSessionsTable.id, session.id));
        }
        hasActiveTask = false;
        _activeLessonExerciseIdForDelivery = null;
        session.nodeTeachingStage = "FEEDBACK";
        session.activeLessonExerciseId = null;
        session.activeTaskProvenance = null;
        session.activeTaskReference = null;
        session.activeTaskSnapshot = null;
        session.activeObjectiveTaskPayload = null;
        session.activeAttemptSequence = 0;
        session.activeHelpCount = 0;
        session.activeAssistanceLevel = "none";
        logger.info(
          { sessionId: session.id, nodeId: session.currentNodeId, currentStage },
          "C7.2: evaluated task retired into mandatory FEEDBACK boundary",
        );
      } else if (newTeachingStage) {
        // Phase 2B: update active task identity when stage transitions.
        // MICRO_CHECK is not tied to a source exercise. EXERCISE activation is
        // delegated to activateSourceExercise(), which persists the exact
        // eligible row selected for delivery.
        const stage3DefersSourceTask =
          _stage3BoundedAnswerTurn &&
          newTeachingStage === "EXERCISE" &&
          classExercises.length > 0;
        const activeTaskUpdate: Record<string, unknown> = {
          nodeTeachingStage: stage3DefersSourceTask ? "TASK_REQUIRED" : newTeachingStage,
        };
        if (newTeachingStage === "MICRO_CHECK") {
          activeTaskUpdate.activeLessonExerciseId = null;
          activeTaskUpdate.activeTaskProvenance   = "micro_check";
          activeTaskUpdate.activeTaskReference    = null;
          activeTaskUpdate.activeTaskSnapshot     = null;
          activeTaskUpdate.activeObjectiveTaskPayload = null;
          activeTaskUpdate.activeAttemptSequence  = 1;
          activeTaskUpdate.activeHelpCount        = 0;
          activeTaskUpdate.activeAssistanceLevel  = "none";
        } else if (stage3DefersSourceTask) {
          activeTaskUpdate.activeLessonExerciseId = null;
          activeTaskUpdate.activeTaskProvenance = null;
          activeTaskUpdate.activeTaskReference = null;
          activeTaskUpdate.activeTaskSnapshot = null;
          activeTaskUpdate.activeObjectiveTaskPayload = null;
          activeTaskUpdate.activeAttemptSequence = 0;
          activeTaskUpdate.activeHelpCount = 0;
          activeTaskUpdate.activeAssistanceLevel = "none";
          _activeLessonExerciseIdForDelivery = null;
        } else if (newTeachingStage === "EXERCISE" && classExercises.length > 0) {
          const selection = _p11SelectedSourceExercise
            ? {
                selected: _p11SelectedSourceExercise,
                requestedExerciseId: aiResult.source_fidelity.exercise_id,
                resolution: "requested_eligible" as const,
              }
            : resolveEligibleSourceExercise(classExercises, aiResult.source_fidelity.exercise_id);
          const selectedExercise = _sourceExerciseActivatedThisTurn
            ? (selection.selected
              ? { exercise: selection.selected, renderedPrompt: canonicalSourcePrompt(selection.selected)?.prompt ?? "" }
              : null)
            : await activateSourceExercise(
                session.id,
                selection,
                await assertPhase2TargetLocked() ?? undefined,
              );
          if (selectedExercise) {
            _activeLessonExerciseIdForDelivery = selectedExercise.exercise.id;
            _sourceExerciseActivatedThisTurn = true;
          }
        } else if (newTeachingStage === "VERIFIED") {
          activeTaskUpdate.activeLessonExerciseId = null;
          activeTaskUpdate.activeTaskProvenance   = null;
          activeTaskUpdate.activeTaskReference    = null;
          activeTaskUpdate.activeTaskSnapshot     = null;
          activeTaskUpdate.activeObjectiveTaskPayload = null;
          activeTaskUpdate.activeAttemptSequence  = 0;
          activeTaskUpdate.activeHelpCount        = 0;
          activeTaskUpdate.activeAssistanceLevel  = "none";
          _activeLessonExerciseIdForDelivery = null;
        }
        await updateC7TargetLockedSession(activeTaskUpdate);
        // Update hasActiveTask to reflect the new stage
        hasActiveTask = !stage3DefersSourceTask &&
          (newTeachingStage === "MICRO_CHECK" || newTeachingStage === "EXERCISE");
        logger.info({ sessionId: session.id, nodeId: session.currentNodeId, currentStage, newTeachingStage }, "teachingStage advanced");
      } else if (wasEval && session.activeTaskProvenance !== null) {
        // A retry is a new immutable task attempt, even if its learner-visible
        // prompt is unchanged. It must not mutate the already evaluated
        // snapshot or reuse its evidence identity.
        const activeTaskSnapshot = isCanonicalTaskSnapshot(session.activeTaskSnapshot)
          ? session.activeTaskSnapshot
          : null;
        if (!activeTaskSnapshot || !session.activeTaskReference) {
          throw new Error("same-stage retry requires a canonical active task snapshot");
        }
        if (activeTaskSnapshot.taskSource === "legacy_compatibility") {
          throw new Error("legacy task snapshots cannot be retried as C3 evidence");
        }
        const nextAttemptSequence = session.activeAttemptSequence + 1;
        const retryTaskReference = createTaskReference(activeTaskSnapshot.taskSource);
        const retrySnapshot = createCanonicalTaskRetrySnapshot(activeTaskSnapshot, {
          taskReference: retryTaskReference,
          attemptSequence: nextAttemptSequence,
        });
        await db
          .update(lessonSessionsTable)
          .set({
            activeTaskReference: retryTaskReference,
            activeTaskSnapshot: retrySnapshot,
            activeAttemptSequence: nextAttemptSequence,
            activeHelpCount: 0,
            activeAssistanceLevel: "none",
          } as any)
          .where(eq(lessonSessionsTable.id, session.id));
      }

      // ── V2-R3: Pedagogical Decision Engine ──────────────────────────────────
      // Query historical evidence for the current cognitive level then run the
      // pure decision function.  No DB writes inside the engine itself.
      {
        let _levelEvidenceSummary = null;
        if (_activeCognitiveLevelRow) {
          const evRows = await db
            .select({
              wasCorrect:     (evidenceEventsTable as any).wasCorrect,
              helpCount:      (evidenceEventsTable as any).helpCount,
              assistanceLevel:(evidenceEventsTable as any).assistanceLevel,
              metadata:       evidenceEventsTable.metadata,
              taskReference:  (evidenceEventsTable as any).taskReference,
              createdAt:      evidenceEventsTable.createdAt,
            })
            .from(evidenceEventsTable)
            .where(and(
              eq((evidenceEventsTable as any).lessonSessionId, session.id),
              eq((evidenceEventsTable as any).cognitiveLevel, _activeCognitiveLevelRow.cognitiveLevel),
              eq((evidenceEventsTable as any).wasCorrect, true),
            ));
          _levelEvidenceSummary = summarizeLevelEvidence(
            filterEvidenceForCurrentRunNode(
              evRows.filter((row) => row.taskReference !== _canonicalEvidenceTaskReference),
              {
              currentNodeId: session.currentNodeId,
              nodeStartedAt: session.nodeStartedAt,
              sessionStartedAt: session.startedAt,
              },
            ),
          );
        }

        const _decisionPlan = coordinatePedagogicalDecision({
          lessonNodeId: session.currentNodeId,
          lessonId,
          sessionId: session.id,
          userId: req.userId!,
          nodeTeachingStage: _evaluatedTaskEvidenceContext?.nodeTeachingStage ?? session.nodeTeachingStage,
          remediationStep: session.remediationStep,
          activeCognitiveLevelId: session.activeCognitiveLevelId,
          activeCognitiveLevelRow: _activeCognitiveLevelRow,
          cognitivePath: _cognitivePath,
          evaluation: aiResult.answer_evaluation,
          activeHelpCount: _evaluatedTaskEvidenceContext?.activeHelpCount ?? session.activeHelpCount,
          activeAssistanceLevel: _evaluatedTaskEvidenceContext?.activeAssistanceLevel ?? session.activeAssistanceLevel,
          activeAttemptSequence: _evaluatedTaskEvidenceContext?.activeAttemptSequence ?? session.activeAttemptSequence,
          activeTaskProvenance: _evaluatedTaskEvidenceContext?.activeTaskProvenance ?? session.activeTaskProvenance,
          levelEvidenceSummary: _levelEvidenceSummary,
          nextNodeHasCriticalDependencyOnCurrentNode: _nextNodeHasCriticalDep,
          requiredSessionMinutes: session.requiredSessionMinutes,
          activeLearningSeconds: session.activeLearningSeconds,
          optionalContinuation: session.optionalContinuation,
          estimatedNodeMinutes: currentNodeRecord?.estimatedMinutes ?? 0,
          legacyCompletionAllowed: deriveLegacyCompletionAllowed({
            turn: _turnProgress,
            classExerciseCount: classExercises.length,
            hasActiveCognitivePath:
              _cognitivePath.length > 0 &&
              _activeCognitiveLevelRow !== null,
          }),
        });
        _pedagogicalDecision = _decisionPlan.decision;

        // The pedagogical engine is candidate-only. It may update remediation
        // state, but its proposed cognitive level cannot mutate the session.
        const dUpdates: Record<string, unknown> = {
          remediationStep: _pedagogicalDecision.newRemediationStep,
        };
        await db
          .update(lessonSessionsTable)
          .set(dUpdates as any)
          .where(eq(lessonSessionsTable.id, session.id));

        // V2-R4A.3: Mark required-session completion (idempotent — written ONCE).
        // Must happen synchronously (before res.json) so the response includes
        // the correct requiredSessionCompletedAt value on the very first turn
        // that exhausts the budget.
        if (
          _pedagogicalDecision.metaAction === "END_REQUIRED_SESSION" &&
          session.requiredSessionCompletedAt === null
        ) {
          const _completedAt = new Date();
          await db
            .update(lessonSessionsTable)
            .set({ requiredSessionCompletedAt: _completedAt } as any)
            .where(eq(lessonSessionsTable.id, session.id));
          session.requiredSessionCompletedAt = _completedAt;
          logger.info({ sessionId: session.id }, "V2-R4A.3: requiredSessionCompletedAt written");
        }

        logger.info({
          sessionId:          session.id,
          nodeId:             session.currentNodeId,
          metaAction:         _pedagogicalDecision.metaAction,
          remediationAction:  _pedagogicalDecision.remediationAction,
          reasonCode:         _pedagogicalDecision.reasonCode,
          currentLevel:       _pedagogicalDecision.currentCognitiveLevel,
          targetLevel:        _pedagogicalDecision.targetCognitiveLevel,
          newRemediationStep: _pedagogicalDecision.newRemediationStep,
          mayComplete:        _pedagogicalDecision.mayCompleteMicroNode,
          levelConfirmed:     _pedagogicalDecision.levelConfirmed,
          revisitRequired:    _pedagogicalDecision.revisitRequired,
        }, "V2-R3 pedagogical decision");

        // P11.1 runs from the request-start MICRO_CHECK stage, but a same-turn
        // Cognitive Path advance has final ownership of the response state.
        // Restore the pre-delivery feedback so no previous-level exercise leaks
        // into a response that now starts the next level at THEORY.
        if (
          _pedagogicalDecision.metaAction === "ADVANCE_COGNITIVE_LEVEL" &&
          _p11StudentMessageBeforeDelivery !== null &&
          _p11TeachingModeBeforeDelivery !== null
        ) {
          studentMessage = _p11StudentMessageBeforeDelivery;
          teachingMode = _p11TeachingModeBeforeDelivery;
          if (aiResult) {
            if (_p11AiTeachingModeBeforeDelivery !== null) {
              aiResult.teaching_mode = _p11AiTeachingModeBeforeDelivery;
            }
            aiResult.source_fidelity = {
              ...aiResult.source_fidelity,
              exercise_id: _p11SourceExerciseIdBeforeDelivery,
            };
          }
          logger.info(
            { sessionId: session.id, nodeId: session.currentNodeId },
            "Cognitive Path advance: suppressed stale P11.1 source exercise delivery"
          );
        }
      }

      // ── Mastery gate check ───────────────────────────────────────────────
      const _progressionPlan = deriveProgressionPlan({
        turn: _turnProgress,
        classExerciseCount: classExercises.length,
        cognitivePath: _cognitivePath,
        activeCognitiveLevelRow: _activeCognitiveLevelRow,
        decision: _pedagogicalDecision,
      });
      const _currentLevelIndex = _cognitivePath.findIndex(
        (level) => level.id === _activeCognitiveLevelRow?.id,
      );
      const _ceilingIndex = _cognitivePath.findIndex(
        (level) => level.id === _canonicalEvidenceProjection?.ceilingLevelId,
      );
      const _currentLevelConfirmedByC4 =
        _currentLevelIndex >= 0 && _ceilingIndex >= _currentLevelIndex;
      const _candidateType =
        _pedagogicalDecision?.metaAction === "ADVANCE_COGNITIVE_LEVEL"
          ? "ADVANCE_COGNITIVE_LEVEL"
          : "COMPLETE_MICRONODE";
      const _candidateRequiresAuthorization =
        _pedagogicalDecision?.metaAction === "ADVANCE_COGNITIVE_LEVEL" ||
        _progressionPlan.shouldCompleteNode;
      const _completionAuthorization = _candidateRequiresAuthorization
        ? authorizeCanonicalCompletion({
            candidate: _candidateType,
            qualificationStatus: _canonicalEvidenceQualification,
            projection: _canonicalEvidenceProjection,
            currentLevelConfirmed: _currentLevelConfirmedByC4,
          })
        : null;
      let _authorizedC6Decision: Awaited<ReturnType<typeof resolveCanonicalC6Decision>> | null = null;
      if (_completionAuthorization?.authorized) {
        _authorizedC6Decision = await resolveCanonicalC6Decision({
          learnerId: req.userId!,
          lessonId,
          requestedMicroNodeId: session.currentNodeId,
          entryIntent: "NORMAL_LEARNING",
        });
        if (isC6DeliveryBlocked(_authorizedC6Decision)) {
          _authorizedC6Decision = null;
        }
      }
      const _authorizedLevelAdvance =
        _pedagogicalDecision?.metaAction === "ADVANCE_COGNITIVE_LEVEL" &&
        _completionAuthorization?.authorized === true &&
        _authorizedC6Decision?.microNodeId === session.currentNodeId &&
        _authorizedC6Decision.nextTargetCognitiveLevelId !== null;
      const _authorizedNodeCompletion =
        _progressionPlan.shouldCompleteNode &&
        _completionAuthorization?.authorized === true &&
        _authorizedC6Decision !== null &&
        (_authorizedC6Decision.decisionType === "ADVANCE" ||
          _authorizedC6Decision.reasonCode === "NO_ELIGIBLE_MICRONODE");
      const _authorizedProgressionPlan = {
        ..._progressionPlan,
        cognitiveCompletionGate: _authorizedNodeCompletion,
        shouldCompleteNode: _authorizedNodeCompletion,
        shouldResetForCognitiveAdvance: _authorizedLevelAdvance,
        shouldAutoContinueExercise:
          _progressionPlan.shouldAutoContinueExercise && !_candidateRequiresAuthorization,
      };
      _postFeedbackContinuationPlan = derivePostFeedbackContinuationAction({
        decision: _pedagogicalDecision,
        progressionPlan: _authorizedProgressionPlan,
        hasActiveTask,
        // Do not select source delivery if the just-answered source task was
        // the sole eligible exercise; that safe path falls back to a bounded
        // generated task instead of throwing or repeating the task.
        eligibleSourceExerciseAvailable: classExercises.some(
          (exercise) =>
            !(
              session.activeTaskProvenance === "source_exercise" &&
              exercise.id === session.activeLessonExerciseId
            ),
        ),
      });

      // Continuing at this level, including a helped success that needs an
      // independent check, must retire the answered task before server-owned
      // continuation can deliver a new learner-answerable task. A successful
      // EXERCISE answer may already have advanced the stage to VERIFIED (the
      // DB write happened above, but session.nodeTeachingStage is not yet
      // mirrored in memory at this point). Pass the authoritative post-advance
      // stage from _turnProgress so the VERIFIED path is correctly detected.
      const _postAdvanceTeachingStage =
        _turnProgress.newTeachingStage ?? session.nodeTeachingStage;
      if (
        shouldPreparePostFeedbackTaskContinuation({
          postFeedbackContinuationPlan: _postFeedbackContinuationPlan,
          hasActiveTask,
          nodeTeachingStage: _postAdvanceTeachingStage,
        })
      ) {
        _postFeedbackExcludedExerciseId =
          session.activeTaskProvenance === "source_exercise"
            ? session.activeLessonExerciseId
            : null;
        await db
          .update(lessonSessionsTable)
          .set({
            nodeTeachingStage: "TASK_REQUIRED",
            activeLessonExerciseId: null,
            activeTaskProvenance: null,
            activeObjectiveTaskPayload: null,
            activeAttemptSequence: 0,
            activeHelpCount: 0,
            activeAssistanceLevel: "none",
          } as any)
          .where(eq(lessonSessionsTable.id, session.id));
        session.nodeTeachingStage = "TASK_REQUIRED";
        session.activeLessonExerciseId = null;
        session.activeTaskProvenance = null;
        session.activeObjectiveTaskPayload = null;
        session.activeAttemptSequence = 0;
        session.activeHelpCount = 0;
        session.activeAssistanceLevel = "none";
        hasActiveTask = false;
        logger.info(
          {
            sessionId: session.id,
            nodeId: session.currentNodeId,
            postFeedbackAction: _postFeedbackContinuationPlan!.action,
            excludedExerciseId: _postFeedbackExcludedExerciseId,
          },
          "Stage-5.3 retired answered task before independent-check continuation",
        );
      }
      _phase2ServerActionPlan = derivePhase2ServerAction({
        currentPhase: session.currentPhase,
        currentNodeId: session.currentNodeId,
        activeCognitiveLevelId:
          _activeCognitiveLevelRow?.id ?? session.activeCognitiveLevelId,
        nodeTeachingStage: session.nodeTeachingStage,
        activeTaskProvenance: session.activeTaskProvenance,
        activeLessonExerciseId: session.activeLessonExerciseId,
        activeObjectiveTaskPayload: session.activeObjectiveTaskPayload,
        learnerIntent: _intentResult.intent,
        evaluated: true,
        decision: _pedagogicalDecision,
        progressionPlan: _authorizedProgressionPlan,
        eligibleSourceExerciseAvailable: classExercises.length > 0,
      });
      const { safetyCapHit } = _progressionPlan;
      logger.info(
        {
          sessionId: session.id,
          action: _phase2ServerActionPlan.action,
          reasonCode: _phase2ServerActionPlan.reasonCode,
          decisionMetaAction: _pedagogicalDecision.metaAction,
        },
        "Phase-2 server action selected after authoritative evaluation",
      );

      // C7.2 defers any already-authorized C7.1 transition until the bounded
      // feedback message is actually persisted below.  C3 → C4 → C6
      // authorization has already happened; this only keeps the selected
      // C6 target locked through the visible feedback boundary.
      if (
        (_phase2ServerActionPlan.action === "ADVANCE_COGNITIVE_LEVEL" ||
          _phase2ServerActionPlan.action === "COMPLETE_MICRONODE") &&
        _authorizedC6Decision
      ) {
        _deferredC7Action = _phase2ServerActionPlan.action;
        _deferredC6Decision = _authorizedC6Decision;
        _deferredSafetyCapHit = safetyCapHit;
        // C7.2 recovery must survive a feedback-provider or message-write
        // failure. Attach the already-authorized C7.1 transition to the same
        // immutable evidence record that owns the evaluator facts; never
        // re-derive it from learner chat.
        if (_canonicalEvidenceTaskReference) {
          const [evidenceRecord] = await db
            .select({ id: evidenceEventsTable.id, metadata: evidenceEventsTable.metadata })
            .from(evidenceEventsTable)
            .where(and(
              eq((evidenceEventsTable as any).lessonSessionId, session.id),
              eq((evidenceEventsTable as any).taskReference, _canonicalEvidenceTaskReference),
            ))
            .orderBy(desc(evidenceEventsTable.createdAt))
            .limit(1);
          if (!evidenceRecord) {
            throw new Error("C7.2 deferred transition requires its canonical evidence record");
          }
          await db
            .update(evidenceEventsTable)
            .set({
              metadata: {
                ...(evidenceRecord.metadata as Record<string, unknown>),
                c7DeferredTransition: {
                  action: _deferredC7Action,
                  c6Decision: _deferredC6Decision,
                  safetyCapHit: _deferredSafetyCapHit,
                },
              },
            } as any)
            .where(eq(evidenceEventsTable.id, evidenceRecord.id));
        }
      }

      // ── V2-R1.1: flag exercise delivery for auto-progression ─────────────────
      // After FEEDBACK advances MICRO_CHECK→EXERCISE (class exercises exist),
      // the exercise text must be delivered automatically — the learner must NOT need
      // to send any "ok" or "continue" to see the exercise.
      // Guard: mastery gate must NOT have fired (which would have advanced the node instead).
      if (
        !_stage3BoundedAnswerTurn &&
        _phase2ServerActionPlan.action === "DELIVER_SOURCE_EXERCISE"
      ) {
        _v2r1AutoContinue = { type: "exercise" as const };
      }
    }

    // ── V2-R1: persist lastQuestionAsked on ANY turn where AI issues a micro-check ──
    // Fix: previously only written inside if (wasEval), so anticipatory THEORY→MICRO_CHECK
    // turns (wasEval=false) never wrote this field, causing the intro-repeat loop on the
    // following student turn (lastQuestionAsked=null → AI regenerated intro).
    const _serverAllowsQuestionPersistence =
      session.currentPhase !== 2 ||
      _phase2ServerActionPlan.action === "DELIVER_THEORY";
    if (
      aiResult?.is_micro_check === true &&
      _serverAllowsQuestionPersistence
    ) {
      const _lqaTmpl = aiResult.question_template ?? null;
      const _lqaCurrent: string[] = session?.askedQuestionTemplates ?? [];
      const _lqaNew = _lqaTmpl && !_lqaCurrent.includes(_lqaTmpl)
        ? [..._lqaCurrent, _lqaTmpl]
        : _lqaCurrent;
      await db
        .update(lessonSessionsTable)
        .set({
          lastQuestionAsked: aiResult.student_message.slice(0, 500),
          askedQuestionTemplates: _lqaNew,
        })
        .where(eq(lessonSessionsTable.id, session.id));
      logger.info(
        { sessionId: session.id, wasEval, questionLen: aiResult.student_message.length },
        "V2-R1: lastQuestionAsked persisted (any is_micro_check turn, not gated by wasEval)"
      );
    }
  }

  if (session && session.currentPhase === 1 && lessonId && aiResult) {
    const PHASE1_CAP = 5;
    const newReviewCount = (session.reviewQuestionCount ?? 0) + 1;

    // Phase 1 early-exit: track consecutive correct review answers in the session.
    // Replaces the old evidenceEventsTable query (which depended on rows chat.ts
    // was creating for itself — now removed).
    const prevPhase1CC = session.phase1ConsecutiveCorrect;
    const newPhase1CC  = wasCorrect === true ? prevPhase1CC + 1 : 0;
    const earlyExit    = newPhase1CC >= 2;

    if (newReviewCount >= PHASE1_CAP || earlyExit) {
      const c6Decision = await resolveCanonicalC6Decision({
        learnerId: req.userId!,
        lessonId,
        entryIntent: "NORMAL_LEARNING",
      });
      if (isC6DeliveryBlocked(c6Decision)) {
        res.status(409).json({
          error: "C6_TARGET_UNAVAILABLE",
          message: "Դասի առաջին հասանելի հանգույցի ճանաչողական ուղին հաստատված չէ, ուստի ուսուցումը դեռ չի կարող շարունակվել։",
          reasonCode: c6Decision.reasonCode,
        });
        return;
      }
      await db
        .update(lessonSessionsTable)
        .set({
          currentPhase:
            c6Decision.microNodeId === null &&
            c6Decision.decisionType === "ADVANCE"
              ? 3
              : 2,
          reviewQuestionCount: newReviewCount,
          nodeAttemptCount: 0,
          askedQuestionTemplates: [],
          currentNodeId: c6Decision.microNodeId,
          activeCognitiveLevelId: c6Decision.nextTargetCognitiveLevelId,
          nodeStartedAt: c6Decision.microNodeId ? new Date() : null,
          phase1ConsecutiveCorrect: 0,   // reset on Phase 1 exit
          nodeTeachingStage: "THEORY",   // prepare for the first teaching node
        })
        .where(eq(lessonSessionsTable.id, session.id));
      logger.info(
        {
          lessonId,
          sessionId: session.id,
          reason: earlyExit ? "early_exit" : "cap",
          newPhase1CC,
          c6TargetNodeId: c6Decision.microNodeId,
          c6TargetLevelId: c6Decision.nextTargetCognitiveLevelId,
        },
        "P8: Phase 1 complete — auto-advanced to Phase 2 through C6"
      );
    } else {
      await db
        .update(lessonSessionsTable)
        .set({ reviewQuestionCount: newReviewCount, phase1ConsecutiveCorrect: newPhase1CC })
        .where(eq(lessonSessionsTable.id, session.id));
    }
  }

  if (
    _stage3BoundedAnswerTurn &&
    session &&
    session.currentPhase === 2 &&
    aiResult
  ) {
    try {
      _feedbackJobInvocationCount += 1;
      const feedback = await callPhase2FeedbackJob(
        chatHistory,
        [
          lessonContext,
          "AUTHORITATIVE FEEDBACK FACTS:",
          `Evaluation: ${JSON.stringify(aiResult.answer_evaluation)}`,
          `Decision Engine meta action: ${_pedagogicalDecision?.metaAction ?? "NONE"}`,
          `Decision Engine remediation action: ${_pedagogicalDecision?.remediationAction ?? "NONE"}`,
          `Server action: ${_phase2ServerActionPlan.action}`,
          "The feedback must not include a new question, answer options, source exercise text, or a next task.",
        ].join("\n"),
        _stage3HiddenExerciseContent,
      );
      assertFeedbackOnly(feedback);
      const acknowledgement = serverOwnedFeedbackAcknowledgement(
        _evaluatedTurnAuthority?.status ?? aiResult.answer_evaluation.status,
      );
      try {
        const feedbackServerAction =
          _postFeedbackContinuationPlan?.action ??
          _phase2ServerActionPlan.action;
        assertFeedbackConsistentWithServerAction(feedback, {
          serverAction: feedbackServerAction,
          hasActiveTask,
        });
        if (_evaluatedTurnAuthority?.isCorrectnessOutcome) {
          assertFeedbackMatchesAuthority(
            feedback,
            _evaluatedTurnAuthority.status as "CORRECT" | "INCORRECT" | "PARTIALLY_CORRECT",
          );
        }
        studentMessage = acknowledgement
          ? `${acknowledgement}\n${feedback.student_message}`
          : feedback.student_message;
      } catch (authorityError) {
        logger.warn(
          {
            sessionId: session.id,
            requestId: (req as any).id ?? null,
            learnerMessageId: learnerMessage.id,
            feedbackJobInvocationCount: _feedbackJobInvocationCount,
            evaluationStatus: aiResult.answer_evaluation.status,
            serverAction:
              _postFeedbackContinuationPlan?.action ??
              _phase2ServerActionPlan.action,
            err: authorityError instanceof Error
              ? authorityError.message
              : String(authorityError),
          },
          "Stage-5 feedback authority guard used server fallback",
        );
        studentMessage = acknowledgement ?? "Շարունակենք առաջադրանքը։";
      }
      teachingMode = "FEEDBACK";
      aiResult.student_message = studentMessage;
      // Only a successfully persisted bounded feedback response may release
      // the FEEDBACK boundary.  Progression transitions already authorized by
      // C7.1 retain their C3 → C4 → C6 ownership; all other paths return to
      // server-selected TASK_REQUIRED for the following interaction.
      // Release occurs only after the assistant feedback message has been
      // inserted below; a provider/message failure therefore leaves FEEDBACK
      // recoverable and unable to create a replacement task.
    } catch (error) {
      boundedPhase2Failure(error, "FEEDBACK");
      return;
    }
  }

  const [assistantMsg] = await db
    .insert(chatMessagesTable)
    .values({ userId: req.userId!, lessonId: lessonId ?? null, role: "assistant", content: studentMessage })
    .returning();
  if (
    _stage3BoundedAnswerTurn &&
    session &&
    !_deferredC7Action
  ) {
    await updateC7TargetLockedSession(
      (requiresPostFeedbackHold(_pedagogicalDecision?.metaAction)
        ? buildTerminalRevisitStageUpdate()
        : buildPostFeedbackTransitionUpdate()) as any,
    );
  }
  if (
    _stage3BoundedAnswerTurn &&
    session &&
    lessonId &&
    _deferredC7Action &&
    _deferredC6Decision
  ) {
    if (_deferredC7Action === "ADVANCE_COGNITIVE_LEVEL") {
      const nextLevelId = _deferredC6Decision.nextTargetCognitiveLevelId;
      if (nextLevelId === null) {
        throw new Error("C7.2 deferred cognitive transition lost its C6 level target");
      }
      await updateC7TargetLockedSession(
        buildAuthorizedLevelTransitionUpdate(nextLevelId) as any,
      );
      logger.info(
        { sessionId: session.id, nodeId: session.currentNodeId, nextCognitiveLevelId: nextLevelId },
        "C7.2: applied C7.1-authorized cognitive transition after feedback persistence",
      );
    } else {
      const advanceResult = await advanceNodeInSession(
        session.id,
        req.userId!,
        lessonId,
        session.currentNodeId!,
        session.currentPhase,
        _deferredSafetyCapHit,
        _deferredC6Decision,
        await assertPhase2TargetLocked() ?? undefined,
      );
      if (advanceResult.c6BlockedReason) {
        logger.error(
          { sessionId: session.id, reasonCode: advanceResult.c6BlockedReason },
          "C7.2: deferred C6 target became unavailable after feedback persistence",
        );
      } else {
        logger.info(
          {
            sessionId: session.id,
            fromNodeId: session.currentNodeId,
            toNodeId: advanceResult.newNodeId,
            nextPhase: advanceResult.newPhase,
          },
          "C7.2: applied C7.1-authorized node transition after feedback persistence",
        );
      }
    }
  }
  let responseContent = studentMessage;
  let responseMessageId = assistantMsg.id;
  let responseTeachingMode = teachingMode;
  if (_stage3BoundedAnswerTurn) {
    logger.info(
      {
        sessionId: session?.id ?? null,
        requestId: (req as any).id ?? null,
        learnerMessageId: learnerMessage.id,
        feedbackJobInvocationCount: _feedbackJobInvocationCount,
        feedbackMessageId: assistantMsg.id,
        postFeedbackAction: _postFeedbackContinuationPlan?.action ?? null,
      },
      "Stage-5 bounded feedback persisted",
    );
  }

  // C7.2 deliberately returns the feedback turn itself.  The next task is
  // selected from persisted server state on the next interaction, preventing
  // a feedback response from being hidden or merged with a new question.

  // ── V2-R1.1: Auto-progression — exercise delivery after FEEDBACK ──────────────
  // P11.1 normally delivers the newly activated exercise in the primary assistant
  // message. This retained continuation path is a fallback only: it resolves the
  // exact persisted activeLessonExerciseId and runs only when P11.1 did not
  // already expose that exercise on this transition.
  const _activeSourceExercise = _activeLessonExerciseIdForDelivery == null
    ? null
    : classExercises.find((exercise) => exercise.id === _activeLessonExerciseIdForDelivery) ?? null;
  if (
    shouldDeliverStandaloneSourceExercise(
      _v2r1AutoContinue?.type === "exercise",
      _activeLessonExerciseIdForDelivery,
      _sourceExerciseDeliveredThisTurn,
    ) &&
    _activeSourceExercise &&
    lessonId &&
    session
  ) {
    const _ex = _activeSourceExercise;
    const _snapshot = isCanonicalTaskSnapshot(session.activeTaskSnapshot) &&
      session.activeTaskSnapshot.taskSource === "source_exercise" &&
      session.activeTaskSnapshot.lessonExerciseId === _ex.id
        ? session.activeTaskSnapshot
        : null;
    if (!_snapshot) {
      logger.error(
        { sessionId: session.id, exerciseId: _ex.id },
        "standalone source exercise continuation blocked by learner-content boundary",
      );
      res.status(409).json({
        error: "SOURCE_EXERCISE_CONTENT_UNSAFE",
        message: "Հաջորդ առաջադրանքը հասանելի չէ։ Խնդրում եմ կրկին փորձել։",
      });
      return;
    }
    const _exContent = _snapshot.renderedPrompt;
    await db
      .insert(chatMessagesTable)
      .values({ userId: req.userId!, lessonId, role: "assistant", content: _exContent });
    logger.info(
      { sessionId: session.id, exerciseId: _ex.id, nodeId: session.currentNodeId },
      "V2-R1.1: auto-progression — exercise persisted as continuation (no learner input required)"
    );
  }

  // ── V2-R4A / R4A.3: Compute derived budget fields for response ───────────
  const _rsmins    = session?.requiredSessionMinutes ?? null;
  const _als       = session?.activeLearningSeconds ?? 0;
  const _budgetSec = _rsmins != null ? _rsmins * 60 : null;
  const _remainSec = _budgetSec != null ? Math.max(0, _budgetSec - _als) : null;
  const _budgetExhausted = computeSessionBudgetExhausted(_rsmins, _als);

  // ── C3: awaited canonical AI Teacher evidence ──────────────────────────────
  // Writes an evidence_events row when the learner submits an assessable answer.
  // The canonical row is persisted before reporting the turn as recorded.
  // Scoring remains a derived, non-blocking effect after the durable insert.
  let _canonicalEvidenceWriteFailed = false;
  if (
    session && aiResult && lessonId &&
    session.currentPhase >= 2 && session.currentNodeId &&
    !_canonicalEvidenceProcessed
  ) {
    const evtQuality  = aiResult.answer_evaluation.evidence_quality;
    const evtStatus   = _evaluatedTurnAuthority?.status ?? aiResult.answer_evaluation.status;
    const evtWasEval  = _evaluatedTurnAuthority
      ? _evaluatedTurnAuthority.isCorrectnessOutcome
      : evtStatus !== "NOT_APPLICABLE" && evtStatus !== "OFF_TOPIC";
    const evtIsCorrect = _evaluatedTurnAuthority?.evidenceWasCorrect ??
      (evtStatus === "CORRECT");
    // Fire-and-forget block runs when:
    // 1. There is an assessable answer with non-NONE quality (evidence write), OR
    // 2. The decision engine has state to write to knowledge_nodes (levelConfirmed or revisitRequired)
    //    — this allows revisit_required to be set even when quality=NONE (wrong/no-quality answers).
    const _decisionHasKNState =
      !!(_pedagogicalDecision?.levelConfirmed || _pedagogicalDecision?.revisitRequired);
    // Compatibility turns are allowed to persist evidence only through the
    // canonical snapshot-required writer. They cannot recreate the former
    // mutable-state C3 path when a pre-C7.5 session lacks a task snapshot.
    if (evtWasEval && (evtQuality !== "NONE" || _decisionHasKNState)) {
      const compatibilitySnapshot = _evaluatedTaskEvidenceContext;
      try {
        if (
          !compatibilitySnapshot ||
          !isCanonicalTaskSnapshot(compatibilitySnapshot.activeTaskSnapshot) ||
          compatibilitySnapshot.activeTaskSnapshot.taskReference !== compatibilitySnapshot.activeTaskReference ||
          compatibilitySnapshot.activeTaskSnapshot.attemptSequence !== compatibilitySnapshot.activeAttemptSequence ||
          compatibilitySnapshot.currentNodeId === null
        ) {
          throw new Error("compatibility evidence requires a matching canonical task snapshot");
        }
        const compatibilityTarget = await assertPhase2TargetLocked();
        if (!compatibilityTarget) {
          throw new Error("compatibility evidence requires a locked C7 target");
        }
        const canonicalEvidence = await persistAndProjectChatEvidence({
          userId: req.userId!,
          lessonId,
          snapshot: compatibilitySnapshot,
          currentNodeId: compatibilitySnapshot.currentNodeId,
          currentNodeMatchesSnapshot:
            currentNodeRecord?.id === compatibilitySnapshot.currentNodeId,
          cognitivePath: _cognitivePath,
          evidenceQuality: evtQuality,
          wasCorrect: evtIsCorrect,
          evidenceResultAuthority: _evidenceResultAuthority,
          executionTarget: compatibilityTarget,
          evaluationSnapshot: {
            status: evtStatus,
            evidenceQuality: evtQuality,
            errorFamily: aiResult.answer_evaluation.error_family,
            errorStability: aiResult.answer_evaluation.error_stability,
          },
        });
        _canonicalEvidenceProcessed = true;
        _canonicalEvidenceQualification = canonicalEvidence.qualificationStatus;
        _canonicalEvidenceProjection = canonicalEvidence.projection;
        _canonicalEvidenceTaskReference = canonicalEvidence.taskReference;
      } catch (err) {
        _canonicalEvidenceWriteFailed = true;
        logger.error(
          { err, sessionId: session.id },
          "compatibility evidence was blocked without a canonical task snapshot",
        );
      }
    }

    /*
     * Removed C7.5 legacy mutable-state writer. It is retained below only as
     * a non-executable migration reference until the previous release branch
     * is retired; C3 authority above is exclusively snapshot-required.
     *
    if (evtWasEval && (evtQuality !== "NONE" || _decisionHasKNState)) {
      const legacySession = session!;
      const legacyLessonId = lessonId!;
      const _sessionSnap = _evaluatedTaskEvidenceContext ?? {
        id: legacySession.id,
        currentNodeId: legacySession.currentNodeId,
        nodeTeachingStage: legacySession.nodeTeachingStage,
        activeTaskProvenance: legacySession.activeTaskProvenance,
        activeTaskReference: legacySession.activeTaskReference,
        activeLessonExerciseId: legacySession.activeLessonExerciseId,
        activeCognitiveLevelId: legacySession.activeCognitiveLevelId,
        activeAttemptSequence: legacySession.activeAttemptSequence,
        activeHelpCount: legacySession.activeHelpCount,
        activeAssistanceLevel: legacySession.activeAssistanceLevel,
        activeTaskSnapshot: isCanonicalTaskSnapshot(legacySession.activeTaskSnapshot)
          ? legacySession.activeTaskSnapshot
          : null,
      };
      const _lessonId    = legacyLessonId;
      const _userId      = req.userId!;
      await (async () => {
        try {
          // Determine lesson subject for knowledge_nodes lookup
          const [lessonRow2] = await db
            .select({ subjectId: (lessonsTable as any).subjectId })
            .from(lessonsTable)
            .where(eq(lessonsTable.id, _lessonId))
            .limit(1);
          if (!lessonRow2?.subjectId) {
            throw new Error("chat evidence requires lesson subject");
          }

          // Find or create knowledge_nodes for this student + lesson_node
          const [existingKN] = await db
            .select({ id: knowledgeNodesTable.id })
            .from(knowledgeNodesTable)
            .where(
              and(
                eq(knowledgeNodesTable.subjectId,   lessonRow2.subjectId),
                eq(knowledgeNodesTable.userId,        _userId),
                eq(knowledgeNodesTable.lessonNodeId,  _sessionSnap.currentNodeId!),
              )
            )
            .limit(1);

          let topicId: number | null = existingKN?.id ?? null;
          if (!topicId) {
            const [nodeRow2] = await db
              .select({ title: lessonNodesTable.title, targetBloomLevel: lessonNodesTable.targetBloomLevel })
              .from(lessonNodesTable)
              .where(eq(lessonNodesTable.id, _sessionSnap.currentNodeId!))
              .limit(1);
            if (!nodeRow2) {
              throw new Error("chat evidence requires current lesson node");
            }
            const [newKN] = await db
              .insert(knowledgeNodesTable)
              .values({
                subjectId:    lessonRow2.subjectId,
                userId:       _userId,
                topicName:    nodeRow2.title,
                lessonNodeId: _sessionSnap.currentNodeId!,
                status:       "not_started",
                isProvisional: true,
                bloomLevel:   nodeRow2.targetBloomLevel ?? 1,
              })
              .returning({ id: knowledgeNodesTable.id });
            topicId = newKN?.id ?? null;
          }
          if (!topicId) {
            throw new Error("chat evidence could not create knowledge node");
          }

          // The accepted path is resolved at request start. A level outside that
          // exact path is never accepted as C3 qualifying evidence.
          const activeLevel = _sessionSnap.activeCognitiveLevelId == null
            ? null
            : _cognitivePath.find((level) =>
                level.id === _sessionSnap.activeCognitiveLevelId,
              ) ?? null;
          const levelBelongsToNode =
            activeLevel !== null &&
            currentNodeRecord?.id === _sessionSnap.currentNodeId;
          const acceptedPath =
            levelBelongsToNode &&
            _cognitivePath.length > 0;
          const cogLevelText = activeLevel?.cognitiveLevel ?? null;

          // Cap evidence quality: MICRO_CHECK interactions cannot be STRONG/CONCLUSIVE
          const provenance = _sessionSnap.activeTaskProvenance;
          const cappedQuality =
            provenance === "micro_check" && (evtQuality === "STRONG" || evtQuality === "CONCLUSIVE")
              ? "MODERATE"
              : evtQuality;

          const taskSource: TaskSource | null =
            provenance === "micro_check" ? "micro_check"
            : provenance === "source_exercise" ? "source_exercise"
            : provenance === "constructed_response" ? "generated_task"
            : null;

          let taskValidForLevel = false;
          if (
            taskSource === "source_exercise" &&
            _sessionSnap.activeCognitiveLevelId !== null &&
            _sessionSnap.activeLessonExerciseId !== null
          ) {
            const [linkedTask] = await db
              .select({ id: lessonNodeCognitiveTasksTable.id })
              .from(lessonNodeCognitiveTasksTable)
              .where(and(
                eq(
                  lessonNodeCognitiveTasksTable.cognitiveLevelId,
                  _sessionSnap.activeCognitiveLevelId,
                ),
                eq(
                  lessonNodeCognitiveTasksTable.lessonExerciseId,
                  _sessionSnap.activeLessonExerciseId,
                ),
              ))
              .limit(1);
            taskValidForLevel = linkedTask !== undefined;
          } else if (taskSource === "micro_check") {
            // Generated objective micro-checks are server-owned tasks, not
            // exercise rows. Their immutable reference was created at activation.
            taskValidForLevel = !!_sessionSnap.activeTaskReference;
          }

          const authoritativeResult =
            (taskSource === "micro_check" &&
              _evidenceResultAuthority === "objective_task") ||
            (taskSource === "source_exercise" &&
              _evidenceResultAuthority === "source_exercise");
          const qualificationStatus = classifyQualifyingEvidence({
            lessonNodeId: _sessionSnap.currentNodeId,
            cognitiveLevelId: _sessionSnap.activeCognitiveLevelId,
            taskSource,
            taskReference: _sessionSnap.activeTaskReference,
            levelBelongsToNode,
            acceptedPath,
            taskValidForLevel,
            authoritativeResult,
          });

          // Map assistance level to hint_used (backward compat)
          const assistLvl = _sessionSnap.activeAssistanceLevel;
          const hintUsedBool = assistLvl !== "none";

          // Determine interaction type from provenance
          const interactionType =
            provenance === "source_exercise" ? "short_answer"
            : provenance === "micro_check"   ? "micro_check"
            : null;

          await db.insert(evidenceEventsTable).values({
            userId:          _userId,
            lessonSessionId: _sessionSnap.id,
            topicId,
            eventType:       "answer",
            wasCorrect:      evtIsCorrect,
            responseTimeMs:  null,
            hintUsed:        hintUsedBool,
            metadata:        {
              source:         "chat",
              lessonId:       _lessonId,
              nodeId:         _sessionSnap.currentNodeId,
              stage:          _sessionSnap.nodeTeachingStage,
              evidence_quality: cappedQuality,
                qualification_status: qualificationStatus,
            },
            cognitiveLevel:    cogLevelText,
            taskDifficulty:    null, // not available from AI micro-check
            assistanceLevel:   assistLvl !== "none" ? assistLvl : "none",
            // Phase 2B new fields:
            lessonExerciseId: _sessionSnap.activeLessonExerciseId,
            interactionType,
            attemptSequence:  _sessionSnap.activeAttemptSequence || 1,
            helpCount:        _sessionSnap.activeHelpCount,
              // C3 normalized task/node/level identity.
              lessonNodeId:      _sessionSnap.currentNodeId,
              cognitiveLevelId:  _sessionSnap.activeCognitiveLevelId,
              quizQuestionId:    null,
              taskSource,
              taskReference:     _sessionSnap.activeTaskReference,
              qualificationStatus,
              evidenceQuality:   cappedQuality,
          } as any);

          // ── C4: shared authoritative learner ceiling projection ────────────
          // Chat does not promote demonstrated_cognitive_level directly. Once
          // canonical evidence exists, one locked projector transaction owns
          // both the C3→C2 ceiling projection and any revisit-state request.
          const _ceilingProjection = await projectLearnerCognitiveCeiling(
            _userId,
            _sessionSnap.currentNodeId!,
            _pedagogicalDecision?.revisitRequired
              ? { revisitRequest: { reason: _pedagogicalDecision.revisitReason ?? null } }
              : {},
          );
          logger.info({
            topicId,
            lessonNodeId: _sessionSnap.currentNodeId,
            ceilingLevelId: _ceilingProjection.ceilingLevelId,
            ceilingLevel: _ceilingProjection.ceilingLevel,
            reachedTarget: _ceilingProjection.reachedTarget,
            revisitRequested: _pedagogicalDecision?.revisitRequired ?? false,
          }, "C4: learner cognitive ceiling projected from chat evidence");

          // Update knowledge scoring in background (no quizId — chat-sourced evidence)
          updateTopicScoring(topicId, _userId).catch((err) =>
            logger.error({ err, topicId }, "chat evidence: scoring failed")
          );
        } catch (err) {
          _canonicalEvidenceWriteFailed = true;
          logger.error({ err, sessionId: _sessionSnap.id }, "Phase 2B evidence write failed");
        }
      })();
    }
    */
  }

  if (_canonicalEvidenceWriteFailed) {
    res.status(503).json({
      error: "EVIDENCE_PERSISTENCE_FAILED",
      message: "Պատասխանը չի հաջողվել վստահելիորեն գրանցել։ Խնդրում ենք կրկին փորձել։",
    });
    return;
  }

  res.json({
    response:       responseContent,
    messageId:      responseMessageId,
    progressIndicator,
    teachingMode:   responseTeachingMode,
    hasActiveTask,          // Phase 2B: true when a MICRO_CHECK or EXERCISE task is active
    activeHelpCount:        session ? ((session as any).activeHelpCount ?? 0) : 0,
    // V2-R4A: deterministic budget state
    requiredSessionMinutes:   _rsmins,
    activeLearningSeconds:    _als,
    remainingRequiredSeconds: _remainSec,
    sessionBudgetExhausted:   _budgetExhausted,
    sessionDecision:          _pedagogicalDecision?.metaAction ?? null,
    // V2-R4A.3: required-session completion + optional continuation
    requiredSessionCompleted:    session?.requiredSessionCompletedAt != null,
    requiredSessionCompletedAt:  session?.requiredSessionCompletedAt?.toISOString() ?? null,
    optionalContinuation:        session?.optionalContinuation ?? false,
  });

  // ── Phase 2B Part 7: Fire-and-forget AI Teacher durable evidence
  // Compatibility boundary for the existing student-payload contract test.

  // ── V2-R4A.3: SESSION_TIME_LIMIT — write revisit marker on active MicroNode ─
  // Fires after res.json when the required session ends while the learner had
  // already made at least one attempt on the current node.
  //
  // Rules:
  //   - Only fires on END_REQUIRED_SESSION (not STOP_LEVEL_AND_REVISIT etc.)
  //   - Only fires when nodeAttemptCount > 0 (learner worked on this node)
  //   - Writes revisitRequired=true, revisitReason="SESSION_TIME_LIMIT"
  //   - Idempotent: only writes if KN row exists AND revisitRequired is currently false
  //     (never overwrites REMEDIATION_EXHAUSTED or LOCAL_BUDGET_EXHAUSTED)
  //   - Does NOT write to future/unvisited nodes
  if (
    session && lessonId &&
    session.currentPhase >= 2 && session.currentNodeId &&
    _pedagogicalDecision?.metaAction === "END_REQUIRED_SESSION" &&
    session.nodeAttemptCount > 0
  ) {
    const _slt_session  = session;
    const _slt_userId   = req.userId!;
    (async () => {
      try {
        // C4 serializes this marker with Chat/Quiz ceiling projections. Target
        // confirmation wins; an existing remediation reason remains untouched.
        const projection = await projectLearnerCognitiveCeiling(
          _slt_userId,
          _slt_session.currentNodeId!,
          {
            revisitRequest: {
              reason: "SESSION_TIME_LIMIT",
              onlyIfUnset: true,
            },
          },
        );
        logger.info(
          {
            sessionId: _slt_session.id,
            lessonNodeId: _slt_session.currentNodeId,
            ceilingLevelId: projection.ceilingLevelId,
            reachedTarget: projection.reachedTarget,
          },
          "V2-R4A.3: SESSION_TIME_LIMIT processed by C4 projector",
        );
      } catch (err) {
        logger.error({ err, sessionId: _slt_session.id }, "V2-R4A.3: SESSION_TIME_LIMIT write failed");
      }
    })().catch(() => {});
  }
});

// ── Phase 2B Part 6 / V2-R2: POST /chat/help ─────────────────────────────────
// Progressive help endpoint.  Business logic delegated to executeHelpRequest()
// so it is shared with the inline text-based HELP intent path (V2-R2).
// Help levels 1-3 never reveal the final answer.  Level 4 requires explicit consent.
// Does NOT advance teaching stage or create evidence_events.
router.post("/chat/help", requireAuth, async (req: AuthRequest, res) => {
  const { lessonId, revealAnswer } = req.body as { lessonId?: number; revealAnswer?: boolean };
  if (!lessonId) { res.status(400).json({ error: "lessonId required" }); return; }

  const [sessionRow] = await db
    .select()
    .from(lessonSessionsTable)
    .where(and(eq(lessonSessionsTable.lessonId, lessonId), eq(lessonSessionsTable.userId, req.userId!)))
    .limit(1);
  if (!sessionRow) { res.status(404).json({ error: "No active session for this lesson" }); return; }
  if (sessionRow.status !== "active") { res.status(409).json({ error: "Session is not active" }); return; }
  if (sessionRow.currentPhase < 2) { res.status(409).json({ error: "Help only available in Teaching Phase" }); return; }
  if (!sessionRow.currentNodeId) { res.status(409).json({ error: "No current node" }); return; }

  const helpRes = await executeHelpRequest(
    {
      id:                    sessionRow.id,
      currentNodeId:         sessionRow.currentNodeId,
      activeTaskProvenance:  (sessionRow as any).activeTaskProvenance as string | null,
      activeHelpCount:       ((sessionRow as any).activeHelpCount ?? 0) as number,
      activeLessonExerciseId: ((sessionRow as any).activeLessonExerciseId ?? null) as number | null,
      activeCognitiveLevelId: ((sessionRow as any).activeCognitiveLevelId ?? null) as number | null,
      lastQuestionAsked:     sessionRow.lastQuestionAsked,
    },
    lessonId,
    req.userId!,
    revealAnswer ?? false
  );

  if (!helpRes.ok) {
    if (helpRes.errorCode === "NO_ACTIVE_TASK") {
      res.status(helpRes.statusHint).json({ error: helpRes.errorCode, message: helpRes.message });
      return;
    }
    if (helpRes.errorCode === "REVEAL_REQUIRES_CONFIRMATION") {
      res.status(helpRes.statusHint).json({
        error:     "REVEAL_REQUIRES_CONFIRMATION",
        helpLevel: 4,
        message:   "Arayin tesnel-u kerp hstatutyun kllini",
      });
      return;
    }
    res.status(helpRes.statusHint).json({ error: helpRes.errorCode });
    return;
  }

  res.json({
    success:        true,
    helpLevel:      helpRes.helpLevel,
    isAnswerReveal: helpRes.isAnswerReveal,
    hintContent:    helpRes.hintContent,
    helpEventId:    helpRes.helpEventId,
  });
});


// ── GET /chat/session-state ─────────────────────────────────────────────────
// Returns the current active-task state for a lesson session.
// Used by the frontend on mount/refresh to hydrate hasActiveTask + helpLevel
// without waiting for the first chat response.
router.get("/chat/session-state", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = req.query.lessonId ? parseInt(String(req.query.lessonId), 10) : 0;
  if (!lessonId || isNaN(lessonId)) {
    res.status(400).json({ error: "lessonId required" });
    return;
  }

  const [sessionRow] = await db
    .select()
    .from(lessonSessionsTable)
    .where(and(eq(lessonSessionsTable.lessonId, lessonId), eq(lessonSessionsTable.userId, req.userId!)))
    .limit(1);

  if (!sessionRow) {
    res.json({ hasActiveTask: false, activeHelpCount: 0, activeAssistanceLevel: "none" });
    return;
  }

  const provenance        = (sessionRow as any).activeTaskProvenance as string | null | undefined;
  const nodeTeachingStage = sessionRow.nodeTeachingStage ?? "THEORY";
  // Backward-compat: treat MICRO_CHECK/EXERCISE stage as active even if provenance is null
  // (sessions created before Phase 2B had null provenance).
  const hasActiveTask     = (provenance !== null && provenance !== undefined && provenance !== "")
                            || nodeTeachingStage === "MICRO_CHECK"
                            || nodeTeachingStage === "EXERCISE";

  // V2-R1: expose current node title + objective so the frontend can render
  // canonical teaching state without parsing chat message text.
  const _sessionNodeId = sessionRow.currentNodeId ?? null;
  const [_sessionNodeRow] = _sessionNodeId
    ? await db
        .select({ title: lessonNodesTable.title, objective: lessonNodesTable.childFriendlyExplanation })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.id, _sessionNodeId))
        .limit(1)
    : [];

  res.json({
    hasActiveTask,
    activeHelpCount:       (sessionRow as any).activeHelpCount       ?? 0,
    activeAssistanceLevel: (sessionRow as any).activeAssistanceLevel ?? "none",
    nodeTeachingStage,
    status:                sessionRow.status,
    currentPhase:          sessionRow.currentPhase,
    // V2-R1 canonical state additions
    currentNodeId:         _sessionNodeId,
    currentNodeTitle:      _sessionNodeRow?.title     ?? null,
    nodeObjective:         _sessionNodeRow?.objective  ?? null,
    introConfirmed:        (sessionRow as any).introConfirmed     ?? false,
    lastQuestionAsked:     sessionRow.lastQuestionAsked           ?? null,
  });
});

router.get("/chat/history", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = req.query.lessonId ? parseInt(String(req.query.lessonId), 10) : undefined;

  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(
      lessonId && !isNaN(lessonId)
        ? and(eq(chatMessagesTable.userId, req.userId!), eq(chatMessagesTable.lessonId, lessonId))
        : eq(chatMessagesTable.userId, req.userId!)
    )
    .orderBy(asc(chatMessagesTable.createdAt))
    .limit(50);

  res.json(
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    }))
  );
});

export default router;