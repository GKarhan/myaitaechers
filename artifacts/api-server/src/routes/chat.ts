import { Router } from "express";
import {
  db, chatMessagesTable, lessonsTable, lessonSessionsTable,
  lessonNodesTable, lessonExercisesTable,
  lessonNodeDependenciesTable, usersTable,
  evidenceEventsTable, knowledgeNodesTable,
  lessonNodeCognitiveLevelsTable, helpEventsTable,
  lessonNodeCognitiveTasksTable,
} from "@workspace/db";
import { eq, and, asc, inArray, gte, or, isNull, sql } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import {
  callAI, callAIStructured,
  type ChatMessage, type AIStructuredResponse, type ProgressIndicator,
} from "../services/ai";
import { getDueReviewTopics } from "../services/review-schedule";
import { logger } from "../lib/logger";
import { enforceVerbatimExercise, isExerciseDeliveryTurn, effectiveExerciseText } from "../lib/exercise-delivery";
import { updateTopicScoring } from "../services/scoring";
import { classifyIntent, type IntentContext, type IntentResult } from "../services/intentRouter.js";
import {
  decideNextPedagogicalAction,
  computeSessionBudgetExhausted,
  computeLocalNodeBudget,
  ACTIVE_INTERVAL_CAP_SECONDS,
  type CognitiveLevelRow,
  type LevelEvidenceSummary,
  type PedagogicalDecision,
} from "../services/pedagogicalDecisionEngine.js";

type ActiveObjectiveTaskPayload = {
  interactionType: "multiple_choice" | "true_false";
  options: Array<{ key: string; text: string }> | null;
  correctOption: string;
};

function objectivePayloadFromMicroCheck(
  response: AIStructuredResponse
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
  interactionType: ActiveObjectiveTaskPayload["interactionType"]
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

// ── V2-R2 shared help executor ────────────────────────────────────────────────
// Used by both the inline HELP intent path (text-based "oghni") and the
// dedicated POST /chat/help route.  Never writes evidence or advances stage.
type HelpRequestResult =
  | { ok: true; hintContent: string; helpLevel: number; newHelpCount: number; helpEventId: number | null; isAnswerReveal: boolean }
  | { ok: false; errorCode: string; statusHint: number; message?: string };

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

  const currentHelpCount = session.activeHelpCount ?? 0;
  const nextHelpLevel    = Math.min(currentHelpCount + 1, 4);

  if (nextHelpLevel === 4 && !revealAnswer) {
    return { ok: false, errorCode: "REVEAL_REQUIRES_CONFIRMATION", statusHint: 409 };
  }

  let taskText: string | null = null;
  if (session.activeLessonExerciseId) {
    const [exRow] = await db
      .select({ verbatim: lessonExercisesTable.exerciseTextVerbatim, edited: lessonExercisesTable.exerciseTextEdited })
      .from(lessonExercisesTable)
      .where(eq(lessonExercisesTable.id, session.activeLessonExerciseId))
      .limit(1);
    taskText = exRow ? (exRow.edited || exRow.verbatim) : null;
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

  const LEVEL_TO_ASSIST: Record<number, string> = {
    1: "light", 2: "moderate", 3: "guided", 4: "revealed",
  };

  const [helpEvent] = await db
    .insert(helpEventsTable)
    .values({
      userId,
      lessonSessionId:  session.id,
      lessonNodeId:     session.currentNodeId!,
      lessonExerciseId: session.activeLessonExerciseId,
      quizQuestionId:   null,
      cognitiveLevelId: session.activeCognitiveLevelId,
      helpLevel:        nextHelpLevel,
      isAnswerReveal:   nextHelpLevel === 4,
      hintContent,
    } as any)
    .returning({ id: helpEventsTable.id });

  await db
    .update(lessonSessionsTable)
    .set({
      activeHelpCount:       currentHelpCount + 1,
      activeAssistanceLevel: LEVEL_TO_ASSIST[nextHelpLevel] ?? "guided",
    } as any)
    .where(eq(lessonSessionsTable.id, session.id));

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
      return `TEACHING PHASE — strict TEACH → MICRO_CHECK cycle (P4 §11):
Step 1. Present ONE concept from APPROVED_EXPLANATION above (2-3 sentences, plain language).
Step 2. Immediately ask ONE MICRO_CHECK question about that concept (≤25 words).
Step 3. Wait for student answer → FEEDBACK (correct/guide) → next concept or exercise.
Step 4. After concepts are taught, present CLASS EXERCISES above (VERBATIM if exerciseTextVerbatim is non-empty).
Step 5. Do NOT present a new exercise until student demonstrates understanding of the current one.
NEVER give the answer directly — always hint and guide.

EXERCISE TRANSITION RULE (mandatory — never skip):
- If CLASS_EXERCISES appear in this context AND you have already asked 2 or more MICRO_CHECK questions on this node → you MUST present an exercise NOW using teaching_mode: "TRANSITION". Do NOT invent another MICRO_CHECK.
- Present the first unused CLASS_EXERCISE VERBATIM (copy exerciseTextVerbatim exactly). Ask the student to attempt it.
- Only move to the next exercise after the student has attempted the current one.

NO-EXERCISE COMPLETION RULE:
- If CLASS_EXERCISES is ABSENT from this context (the node has no exercises) AND you have already asked 2+ MICRO_CHECK questions showing the student understands → set node_decision.action = "COMPLETE_NODE" to advance. Do NOT keep inventing more questions.`;

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
  lessonId: number,
  currentNodeId: number,
  currentPhase: number,
  reviewNeeded: boolean
): Promise<{ newNodeId: number | null; newPhase: number; allNodesDone: boolean }> {
  const [currentNode] = await db
    .select({ sequence: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, currentNodeId))
    .limit(1);

  if (!currentNode) {
    return { newNodeId: null, newPhase: currentPhase, allNodesDone: true };
  }

  const [nextNode] = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(
      and(
        eq(lessonNodesTable.lessonId, lessonId),
        eq(lessonNodesTable.sequence, currentNode.sequence + 1)
      )
    )
    .limit(1);

  if (nextNode) {
    try {
      const criticalDeps = await db
        .select({ fromNodeId: lessonNodeDependenciesTable.fromNodeId })
        .from(lessonNodeDependenciesTable)
        .where(
          and(
            eq(lessonNodeDependenciesTable.lessonId, lessonId),
            eq(lessonNodeDependenciesTable.toNodeId, nextNode.id),
            eq(lessonNodeDependenciesTable.dependencyType, "REQUIRED")
          )
        );
      if (criticalDeps.length > 0) {
        const prereqIds = criticalDeps.map((d) => d.fromNodeId);
        const prereqNodes = await db
          .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
          .from(lessonNodesTable)
          .where(inArray(lessonNodesTable.id, prereqIds));
        const nextSeq = currentNode.sequence + 1;
        const unmet = prereqNodes.filter((p) => p.sequence >= nextSeq);
        if (unmet.length > 0) {
          logger.warn(
            { lessonId, nextNodeId: nextNode.id, unmetPrereqIds: unmet.map((u) => u.id) },
            "advanceNodeInSession: CRITICAL prerequisite(s) not completed before advancing — continuing anyway (defensive log)"
          );
        }
      }
    } catch (checkErr) {
      logger.warn({ checkErr }, "advanceNodeInSession: defensive prereq check failed — continuing");
    }
  }

  const allNodesDone = !nextNode;
  let newPhase = currentPhase;
  let newNodeId: number | null = nextNode?.id ?? null;

  if (allNodesDone && currentPhase === 2) {
    newPhase = 3;
    newNodeId = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const advanceSet: Record<string, unknown> = {
    currentNodeId: newNodeId,
    nodeStartedAt: newNodeId ? new Date() : null,
    nodeAttemptCount: 0,
    currentPhase: newPhase,
    lastQuestionAsked: null,
    nodeMasteryEvidenceCount: 0,
    nodeConsecutiveCorrect:   0,
    nodeConsecutiveIncorrect: 0,
    nodeLastEvidenceQuality:  reviewNeeded ? "WEAK" : null,
    nodeTeachingStage:        "THEORY",
    // Phase 2B: reset active task state when advancing to a new node
    activeLessonExerciseId: null,
    activeCognitiveLevelId: null,
    activeTaskProvenance:   null,
    activeObjectiveTaskPayload: null,
    activeAttemptSequence:  0,
    activeHelpCount:        0,
    activeAssistanceLevel:  "none",
    // V2-R3: reset remediation step on node advance
    remediationStep:        0,
  };
  await db
    .update(lessonSessionsTable)
    .set(advanceSet as any)
    .where(eq(lessonSessionsTable.id, sessionId));

  return { newNodeId, newPhase, allNodesDone };
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
    activeObjectiveTaskPayload: ActiveObjectiveTaskPayload | null;
    activeAttemptSequence: number;
    activeHelpCount: number;
    activeAssistanceLevel: string;
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
  };
  let currentNodeRecord: NodeRef | null = null;

  // FIX: hoisted to outer scope so the mastery-gate 0-exercise check below can see it.
  let classExercises: (typeof lessonExercisesTable.$inferSelect)[] = [];
  // V2-R3: hoisted so the wasEval block and fire-and-forget evidence block can both access them.
  let _pedagogicalDecision: PedagogicalDecision | null = null;
  let _cognitivePath: CognitiveLevelRow[] = [];
  let _activeCognitiveLevelRow: CognitiveLevelRow | null = null;
  let _nextNodeHasCriticalDep = false;

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
        const _sessActiveLevelId = session.activeCognitiveLevelId;

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

        _cognitivePath = cogRows as CognitiveLevelRow[];

        // Resolve active cognitive level row from session's stored id.
        // If not yet set but a path exists, lazily point at the first level.
        if (_sessActiveLevelId) {
          _activeCognitiveLevelRow = _cognitivePath.find(
            (r) => r.id === _sessActiveLevelId
          ) ?? null;
        } else if (_cognitivePath.length > 0) {
          _activeCognitiveLevelRow = _cognitivePath[0];
          await db
            .update(lessonSessionsTable)
            .set({ activeCognitiveLevelId: _cognitivePath[0].id } as any)
            .where(eq(lessonSessionsTable.id, _sessId));
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
        // Cognitive-level exercise filtering: if the active level has linked exercises,
        // restrict classExercises to only those. Backward-compatible: if no tasks are
        // linked to the active level (older lessons), the full node set is preserved.
        if (_activeCognitiveLevelRow && classExercises.length > 0) {
          const cogTasks = await db
            .select({ lessonExerciseId: lessonNodeCognitiveTasksTable.lessonExerciseId })
            .from(lessonNodeCognitiveTasksTable)
            .where(eq(lessonNodeCognitiveTasksTable.cognitiveLevelId, _activeCognitiveLevelRow.id));
          const linkedIds = new Set(cogTasks.map(t => t.lessonExerciseId).filter((id): id is number => id !== null));
          if (linkedIds.size > 0) {
            classExercises = classExercises.filter(e => linkedIds.has(e.id));
          }
        }
        logger.info({
          phase,
          currentNodeId: session?.currentNodeId,
          classExercisesCount: classExercises.length,
          exercises: classExercises.map(e => ({
            exerciseId: e.exerciseId,
            relatedNodeId: e.relatedNodeId,
            verbatim: e.exerciseTextVerbatim?.slice(0, 80),
          })),
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
            const eff = effectiveExerciseText(e.exerciseTextVerbatim, (e as any).exerciseTextEdited as string | null);
            return `[idx=${i}] [${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
              `  VERBATIM: ${eff.trim() || "(no verbatim text — present this exercise task using successCriteria below; do NOT substitute an AI-generated exercise)"}\n` +
              `  successCriteria: ${e.successCriteria ?? ""}`;
          }).join("\n")
        : phase === 2 && classExercises.length > 0
        ? `\nCLASS_EXERCISES (use verbatim when exerciseTextVerbatim is non-empty):\n` +
          classExercises.map((e) => {
            const eff = effectiveExerciseText(e.exerciseTextVerbatim, (e as any).exerciseTextEdited as string | null);
            return `[${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
              `  VERBATIM: ${eff.trim() || "(no verbatim text — present this exercise task using successCriteria below; do NOT substitute an AI-generated exercise)"}\n` +
              `  successCriteria: ${e.successCriteria ?? ""}`;
          }).join("\n")
        : "";

      const hwBlock = homeworkExercises.length > 0
        ? `\nHOMEWORK_TASKS (present verbatim, explain why each matters):\n` +
          homeworkExercises.map((e) => {
            const eff = effectiveExerciseText(e.exerciseTextVerbatim, (e as any).exerciseTextEdited as string | null);
            return `[${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
            `  VERBATIM: ${eff || "(no text — describe the task)"}\n` +
            `  successCriteria: ${e.successCriteria ?? ""}`;
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
            `(1) Present APPROVED_EXPLANATION in 2-3 plain sentences. ` +
            `(2) Immediately ask ONE MICRO_CHECK question (\u226425 words). ` +
            `teaching_mode: "TEACH" for the explanation, is_micro_check: true for the question.`
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
            const ex = classExercises[0];
            const effText = effectiveExerciseText(ex.exerciseTextVerbatim, (ex as any).exerciseTextEdited as string | null);
            const verbatim = effText.trim() ? effText : `[${ex.exerciseId}]`;
            return (
              `NODE_STAGE: MICRO_CHECK\n` +
              `DIRECTIVE — THIS TURN YOU MUST: Present this CLASS_EXERCISE VERBATIM using teaching_mode: "TRANSITION". ` +
              `Do NOT invent another MICRO_CHECK. Exercise: "${verbatim}"`
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

  await db.insert(chatMessagesTable).values({
    userId: req.userId!,
    lessonId: lessonId ?? null,
    role: "user",
    content: message,
  });

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
    const _activeQ  = session?.lastQuestionAsked;
    // "\u0540\u0561\u0580\u0581\u0568 \u0564\u0561\u057b\u0578\u0580\u0564 \u0562\u0561\u0581 \u0565" = "Hartsе dadjord bac e" (The question is still open)
    const taskReminder = _activeQ
      ? `\u0540\u0561\u0580\u056e\u0568 \u0564\u0561\u057b\u0578\u0580\u0564 \u0562\u0561\u0581 \u0565.` +
        ` \u053d\u0576\u0174\u0580\u0578\u0582\u0574 \u0565\u0574 \u057a\u0561\u057f\u0561\u057d\u056d\u0561\u0576\u0565\u056c:\n${_activeQ}`
      : "\u0540\u0561\u0580\u056e\u0568 \u0564\u0561\u057b\u0578\u0580\u0564 \u0562\u0561\u0581 \u0565. \u053d\u0576\u0564\u0580\u0578\u0582\u0574 \u0565\u0574 \u057a\u0561\u057f\u0561\u057d\u056d\u0561\u0576\u0565\u056c.";
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

  let aiResult: AIStructuredResponse | null = null;
  let studentMessage: string;
  let wasCorrect: boolean | null = null;

  try {
    aiResult = await callAIStructured(chatHistory, lessonContext);


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
    teachingMode = aiResult.teaching_mode;
    const st = aiResult.answer_evaluation.status;
    wasCorrect = st === "CORRECT" ? true : st === "INCORRECT" ? false : null;

    // ── V2-R2: Non-ANSWER gate ────────────────────────────────────────────────
    // CONFUSED / REPEAT / CLARIFY / OFF_TOPIC: AI still generates a pedagogical
    // response (redirect, hint, re-explanation), but we force answer_evaluation
    // to NOT_APPLICABLE so the downstream state machine never fires evidence
    // writes or attempt-counter increments.
    // OFF_TOPIC is included here to prevent attempt increment while still
    // allowing the existing Node Lock redirect response from the AI to fire.
    // When a task is open, also lock node_decision to CONTINUE_SAME_NODE so
    // the node cannot be advanced by the model's output.
    if (
      _intentResult.intent === "CONFUSED"  ||
      _intentResult.intent === "REPEAT"    ||
      _intentResult.intent === "CLARIFY"   ||
      _intentResult.intent === "OFF_TOPIC"
    ) {
      (aiResult.answer_evaluation as unknown as Record<string, string>).status          = "NOT_APPLICABLE";
      (aiResult.answer_evaluation as unknown as Record<string, string>).evidence_quality = "NONE";
      wasCorrect = null;
      if (_intentHasActiveTask) {
        (aiResult.node_decision as Record<string, string>).action = "CONTINUE_SAME_NODE";
      }
      logger.info(
        { sessionId: session?.id, intent: _intentResult.intent },
        "V2-R2: non-ANSWER intent — answer_evaluation forced NOT_APPLICABLE, no evidence/attempt"
      );
    }

    if (
      _intentResult.intent === "ANSWER" &&
      session?.activeTaskProvenance === "micro_check" &&
      session.activeObjectiveTaskPayload
    ) {
      const payload = session.activeObjectiveTaskPayload;
      const normalizedAnswer = normalizeObjectiveMicroCheckAnswer(
        message,
        payload.interactionType
      );
      const isObjectiveAnswerCorrect =
        normalizedAnswer === payload.correctOption;

      aiResult.answer_evaluation = {
        ...aiResult.answer_evaluation,
        status: isObjectiveAnswerCorrect ? "CORRECT" : "INCORRECT",
        // Objective MICRO_CHECK correctness is backend-owned. MODERATE is the
        // existing maximum evidence quality for an independent MICRO_CHECK.
        evidence_quality: isObjectiveAnswerCorrect ? "MODERATE" : "NONE",
        error_family: isObjectiveAnswerCorrect
          ? null
          : aiResult.answer_evaluation.error_family,
        error_stability: isObjectiveAnswerCorrect
          ? null
          : aiResult.answer_evaluation.error_stability,
        correct_parts: isObjectiveAnswerCorrect
          ? ["objective answer matched"]
          : [],
        incorrect_parts: isObjectiveAnswerCorrect
          ? []
          : ["objective answer did not match"],
      };
      logger.info(
        {
          sessionId: session.id,
          interactionType: payload.interactionType,
          normalizedAnswer,
          isObjectiveAnswerCorrect,
        },
        "Objective MICRO_CHECK correctness overridden deterministically"
      );
    }

    const finalStatus = aiResult.answer_evaluation.status;
    wasCorrect = finalStatus === "CORRECT"
      ? true
      : finalStatus === "INCORRECT"
        ? false
        : null;

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
  // Fires after BOTH the structured and unstructured (callAI fallback) paths.
  // When phase=2, nodeTeachingStage=MICRO_CHECK, and CLASS exercises exist,
  // the backend guarantees the exact exerciseTextVerbatim appears in the
  // final student-visible response — regardless of what the model returned.
  // Also advances stage MICRO_CHECK→EXERCISE (directly if aiResult is null,
  // via teaching_mode override if aiResult is non-null).
  // Does NOT change currentNodeId, mastery, attempt counters, or KB data.
  let _p11StudentMessageBeforeDelivery: string | null = null;
  let _p11TeachingModeBeforeDelivery: string | null = null;
  let _p11AiTeachingModeBeforeDelivery: AIStructuredResponse["teaching_mode"] | null = null;
  let _p11SourceExerciseIdBeforeDelivery: string | null = null;
  if (session && isExerciseDeliveryTurn(session.currentPhase, session.nodeTeachingStage ?? "THEORY", classExercises.length)) {
    _p11StudentMessageBeforeDelivery = studentMessage;
    _p11TeachingModeBeforeDelivery = teachingMode;
    _p11AiTeachingModeBeforeDelivery = aiResult?.teaching_mode ?? null;
    _p11SourceExerciseIdBeforeDelivery = aiResult?.source_fidelity?.exercise_id ?? null;
    const verbatimEx = effectiveExerciseText(classExercises[0].exerciseTextVerbatim, (classExercises[0] as any).exerciseTextEdited as string | null);
    const enforced = enforceVerbatimExercise(studentMessage, verbatimEx);
    if (enforced !== studentMessage) {
      logger.info(
        { sessionId: session.id, nodeId: session.currentNodeId, exerciseId: classExercises[0].exerciseId },
        "P11.1: backend injected verbatim exercise text (model omitted/paraphrased it)"
      );
      studentMessage = enforced;
    }
    // Always set teachingMode to TRANSITION for exercise delivery turns
    teachingMode = "TRANSITION";
    if (aiResult) {
      // Structured path: override aiResult so anticipatory MICRO_CHECK→EXERCISE advance fires below
      (aiResult as { teaching_mode: string }).teaching_mode = "TRANSITION";
      if (!aiResult.source_fidelity?.exercise_id) {
        (aiResult as unknown as { source_fidelity: { exercise_id: string | null } }).source_fidelity = {
          ...(aiResult.source_fidelity ?? {}),
          exercise_id: classExercises[0].exerciseId ?? null,
        };
      }
    } else if (session.nodeTeachingStage === "MICRO_CHECK") {
      // Fallback path (callAI): advance stage directly since aiResult stage-machine won't run
      // Phase 2B fix: also write active task identity fields.
      await db
        .update(lessonSessionsTable)
        .set({
          nodeTeachingStage:      "EXERCISE",
          activeLessonExerciseId: classExercises.length > 0 ? classExercises[0].id : null,
          activeTaskProvenance:   "source_exercise",
          activeObjectiveTaskPayload: null,
          activeAttemptSequence:  1,
          activeHelpCount:        0,
          activeAssistanceLevel:  "none",
        } as any)
        .where(eq(lessonSessionsTable.id, session.id));
      hasActiveTask = true;
      logger.info(
        { sessionId: session.id, nodeId: session.currentNodeId },
        "P11.1: direct stage advance MICRO_CHECK -> EXERCISE (callAI fallback path)"
      );
    }
  }

  if (aiResult && session?.currentNodeId && session.currentPhase >= 2 && lessonId) {
    const status      = aiResult.answer_evaluation.status;
    const quality     = aiResult.answer_evaluation.evidence_quality;
    const isCorrect   = status === "CORRECT" || status === "PARTIALLY_CORRECT";
    const isIncorrect = status === "INCORRECT";
    // "OFF_TOPIC" answer_evaluation status (returned when AI model itself flags
    // a scope mismatch) is also excluded from wasEval — defense-in-depth for
    // cases where Stage B returned ANSWER but the AI model's own evaluation
    // returns OFF_TOPIC.  Combined with the non-ANSWER gate above this ensures
    // zero attempt increments for all non-answer interactions.
    const wasEval     = status !== "NOT_APPLICABLE" && status !== "OFF_TOPIC";

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
    if (!wasEval && (session?.nodeTeachingStage ?? "THEORY") === "THEORY" && aiResult.is_micro_check) {
      await db
        .update(lessonSessionsTable)
        .set({
          nodeTeachingStage:      "MICRO_CHECK",
          activeLessonExerciseId: null,
          activeTaskProvenance:   "micro_check",
          activeObjectiveTaskPayload: objectivePayloadFromMicroCheck(aiResult),
          activeAttemptSequence:  1,
          activeHelpCount:        0,
          activeAssistanceLevel:  "none",
        } as any)
        .where(eq(lessonSessionsTable.id, session.id));
      hasActiveTask = true;
      logger.info(
        { sessionId: session.id, nodeId: session.currentNodeId },
        "teachingStage anticipatory advance: THEORY -> MICRO_CHECK"
      );
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
        (session?.nodeTeachingStage ?? "THEORY") === "MICRO_CHECK" &&
        aiResult.teaching_mode === "TRANSITION" &&
        aiResult.source_fidelity.exercise_id) {
      await db
        .update(lessonSessionsTable)
        .set({
          nodeTeachingStage:      "EXERCISE",
          activeLessonExerciseId: classExercises.length > 0 ? classExercises[0].id : null,
          activeTaskProvenance:   "source_exercise",
          activeObjectiveTaskPayload: null,
          activeAttemptSequence:  1,
          activeHelpCount:        0,
          activeAssistanceLevel:  "none",
        } as any)
        .where(eq(lessonSessionsTable.id, session.id));
      hasActiveTask = true;
      logger.info(
        { sessionId: session.id, nodeId: session.currentNodeId, exerciseId: aiResult.source_fidelity.exercise_id },
        "teachingStage anticipatory advance: MICRO_CHECK -> EXERCISE"
      );
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
      // Read per-node progress from session (relocated from lessonNodesTable)
      const prevMastery  = session.nodeMasteryEvidenceCount;
      const prevCC       = session.nodeConsecutiveCorrect;
      const prevCI       = session.nodeConsecutiveIncorrect;

      const newMasteryCount    = prevMastery + (quality !== "NONE" ? 1 : 0);
      const newConsecCorrect   = isCorrect   ? prevCC + 1 : isIncorrect ? 0 : prevCC;
      const newConsecIncorrect = isIncorrect ? prevCI + 1 : isCorrect   ? 0 : prevCI;
      const newAttemptCount    = session.nodeAttemptCount + 1;

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

      // ── Stage machine: compute and push newTeachingStage (spec-4) ──────────
      // currentStage now reads from the session (per-student), not the shared lesson_node row.
      const currentStage = session.nodeTeachingStage;
      let newTeachingStage: string | null = null;

      if (currentStage === "THEORY") {
        newTeachingStage = "MICRO_CHECK";
      } else if (currentStage === "MICRO_CHECK") {
        if (classExercises.length > 0) {
          newTeachingStage = "EXERCISE";
        }
      } else if (currentStage === "EXERCISE") {
        if ((quality === "STRONG" || quality === "CONCLUSIVE") && isCorrect) {
          newTeachingStage = "VERIFIED";
        }
      }

      if (newTeachingStage) {
        // Phase 2B: also update active task identity when stage transitions.
        // MICRO_CHECK → not tied to a specific exercise.
        // EXERCISE    → tied to classExercises[0] (the one being delivered verbatim).
        // VERIFIED/THEORY → clear active task (node completing or resetting).
        const activeTaskUpdate: Record<string, unknown> = { nodeTeachingStage: newTeachingStage };
        if (newTeachingStage === "MICRO_CHECK") {
          activeTaskUpdate.activeLessonExerciseId = null;
          activeTaskUpdate.activeTaskProvenance   = "micro_check";
          activeTaskUpdate.activeObjectiveTaskPayload = null;
          activeTaskUpdate.activeAttemptSequence  = 1;
          activeTaskUpdate.activeHelpCount        = 0;
          activeTaskUpdate.activeAssistanceLevel  = "none";
        } else if (newTeachingStage === "EXERCISE" && classExercises.length > 0) {
          activeTaskUpdate.activeLessonExerciseId = classExercises[0].id;
          activeTaskUpdate.activeTaskProvenance   = "source_exercise";
          activeTaskUpdate.activeObjectiveTaskPayload = null;
          activeTaskUpdate.activeAttemptSequence  = 1;
          activeTaskUpdate.activeHelpCount        = 0;
          activeTaskUpdate.activeAssistanceLevel  = "none";
        } else if (newTeachingStage === "VERIFIED") {
          activeTaskUpdate.activeLessonExerciseId = null;
          activeTaskUpdate.activeTaskProvenance   = null;
          activeTaskUpdate.activeObjectiveTaskPayload = null;
          activeTaskUpdate.activeAttemptSequence  = 0;
          activeTaskUpdate.activeHelpCount        = 0;
          activeTaskUpdate.activeAssistanceLevel  = "none";
        }
        await db
          .update(lessonSessionsTable)
          .set(activeTaskUpdate as any)
          .where(eq(lessonSessionsTable.id, session.id));
        // Update hasActiveTask to reflect the new stage
        hasActiveTask = newTeachingStage === "MICRO_CHECK" || newTeachingStage === "EXERCISE";
        logger.info({ sessionId: session.id, nodeId: session.currentNodeId, currentStage, newTeachingStage }, "teachingStage advanced");
      } else if (wasEval && session.activeTaskProvenance !== null) {
        // Same stage, same active task — increment attempt sequence
        await db
          .update(lessonSessionsTable)
          .set({ activeAttemptSequence: session.activeAttemptSequence + 1 } as any)
          .where(eq(lessonSessionsTable.id, session.id));
      }

      // ── V2-R3: Pedagogical Decision Engine ──────────────────────────────────
      // Query historical evidence for the current cognitive level then run the
      // pure decision function.  No DB writes inside the engine itself.
      {
        let _levelEvidenceSummary: LevelEvidenceSummary | null = null;
        if (_activeCognitiveLevelRow) {
          const QUAL_RANK: Record<string, number> = {
            NONE: 1, WEAK: 2, MODERATE: 3, STRONG: 4, CONCLUSIVE: 5,
          };
          const evRows = await db
            .select({
              wasCorrect:     (evidenceEventsTable as any).wasCorrect,
              helpCount:      (evidenceEventsTable as any).helpCount,
              assistanceLevel:(evidenceEventsTable as any).assistanceLevel,
              metadata:       evidenceEventsTable.metadata,
            })
            .from(evidenceEventsTable)
            .where(and(
              eq((evidenceEventsTable as any).lessonSessionId, session.id),
              eq((evidenceEventsTable as any).cognitiveLevel, _activeCognitiveLevelRow.cognitiveLevel),
              eq((evidenceEventsTable as any).wasCorrect, true),
            ));
          const indRows = evRows.filter((e: any) =>
            (e.helpCount ?? 0) <= 1 &&
            (e.assistanceLevel === "none" || e.assistanceLevel === "light") &&
            QUAL_RANK[(e.metadata as any)?.evidence_quality ?? "NONE"] >= 3
          );
          const bestQual = indRows.reduce<string | null>((best: string | null, e: any) => {
            const q: string | null = (e.metadata as any)?.evidence_quality ?? null;
            if (!q) return best;
            if (!best || QUAL_RANK[q] > QUAL_RANK[best]) return q;
            return best;
          }, null);
          _levelEvidenceSummary = {
            independentCorrectCount: indRows.length,
            totalCorrectCount:       evRows.length,
            bestQuality:             (bestQual as any) ?? null,
          };
        }

        // ── V2-R4A: Compute deterministic budget signals ─────────────────────
        // These are NEVER derived from AI output.
        // activeLearningSeconds is already post-increment (updated above).
        const _sessionBudgetExhausted = computeSessionBudgetExhausted(
          session.requiredSessionMinutes,
          session.activeLearningSeconds
        );
        const _localNodeBudgetExhausted = computeLocalNodeBudget(
          currentNodeRecord?.estimatedMinutes ?? 0,
          0 // V1: per-node active seconds not tracked yet
        );

        // V2-R4A.3: once the learner chose optional continuation the required
        // budget is already satisfied — do NOT let it repeatedly block teaching.
        const _effectiveSessionBudgetExhausted =
          _sessionBudgetExhausted && !session.optionalContinuation;

        _pedagogicalDecision = decideNextPedagogicalAction({
          lessonNodeId:    session.currentNodeId!,
          lessonId:        lessonId!,
          sessionId:       session.id,
          userId:          req.userId!,
          nodeTeachingStage:       session.nodeTeachingStage,
          remediationStep:         session.remediationStep,
          activeCognitiveLevelId:  session.activeCognitiveLevelId,
          activeCognitiveLevelRow: _activeCognitiveLevelRow,
          cognitivePath:           _cognitivePath,
          answerStatus:            aiResult.answer_evaluation.status,
          evidenceQuality:         aiResult.answer_evaluation.evidence_quality,
          errorFamily:             (aiResult.answer_evaluation as any).error_family ?? null,
          errorStability:          (aiResult.answer_evaluation as any).error_stability ?? null,
          activeHelpCount:         session.activeHelpCount,
          activeAssistanceLevel:   session.activeAssistanceLevel,
          activeAttemptSequence:   session.activeAttemptSequence,
          activeTaskProvenance:    session.activeTaskProvenance,
          levelEvidenceSummary:    _levelEvidenceSummary,
          nextNodeId:              null,
          nextNodeHasCriticalDependencyOnCurrentNode: _nextNodeHasCriticalDep,
          // V2-R4A / R4A.3
          sessionBudgetExhausted:      _effectiveSessionBudgetExhausted,
          localNodeBudgetExhausted:    _localNodeBudgetExhausted,
        });

        // Persist remediationStep + any cognitive-level advance to the session.
        // These writes happen synchronously (before res.json) so the next turn
        // reads the updated values immediately.
        const dUpdates: Record<string, unknown> = {
          remediationStep: _pedagogicalDecision.newRemediationStep,
        };
        if (_pedagogicalDecision.newActiveCognitiveLevelId !== null) {
          dUpdates.activeCognitiveLevelId = _pedagogicalDecision.newActiveCognitiveLevelId;
        }
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
      const stageBecomesVerified = newTeachingStage === "VERIFIED";
      const noExercisesEarlyComplete =
        classExercises.length === 0 &&
        (currentStage === "MICRO_CHECK") &&
        newAttemptCount >= 2 &&
        (quality === "MODERATE" || quality === "STRONG" || quality === "CONCLUSIVE") &&
        isCorrect;

      // V2-R3: Code owns COMPLETE_NODE — AI's suggestion is advisory/logged only.
      const modelSaysComplete = aiResult.node_decision.action === "COMPLETE_NODE"; // advisory
      const decisionSaysComplete = _pedagogicalDecision?.mayCompleteMicroNode ?? false;
      const hasExercisesOnThisNode = classExercises.length > 0;
      const codeGate = hasExercisesOnThisNode
        ? (newMasteryCount >= 2 && (quality === "STRONG" || quality === "CONCLUSIVE") && newConsecIncorrect < 2)
        : (newMasteryCount >= 2 && quality !== "NONE" && newConsecIncorrect < 2);
      const safetyCapHit = newAttemptCount > 6;
      const hasActiveCognitivePath =
        _cognitivePath.length > 0 && _activeCognitiveLevelRow !== null;

      // Cognitive Path progression owns completion whenever a confirmed path is
      // active.  The legacy stage/safety gates must not bypass an
      // ADVANCE_COGNITIVE_LEVEL decision and complete the MicroNode early.
      if (
        hasActiveCognitivePath &&
        _pedagogicalDecision?.metaAction === "ADVANCE_COGNITIVE_LEVEL"
      ) {
        await db
          .update(lessonSessionsTable)
          .set({
            nodeTeachingStage: "THEORY",
            activeLessonExerciseId: null,
            activeTaskProvenance: null,
            activeObjectiveTaskPayload: null,
            activeAttemptSequence: 0,
            activeHelpCount: 0,
            activeAssistanceLevel: "none",
          } as any)
          .where(eq(lessonSessionsTable.id, session.id));
        hasActiveTask = false;
        logger.info(
          {
            sessionId: session.id,
            nodeId: session.currentNodeId,
            nextCognitiveLevelId: _pedagogicalDecision.newActiveCognitiveLevelId,
          },
          "Cognitive Path advance: reset stage to THEORY without completing node"
        );
      }

      const legacyCompletionGate =
        !hasActiveCognitivePath &&
        (safetyCapHit || stageBecomesVerified || noExercisesEarlyComplete);
      const cognitiveCompletionGate =
        decisionSaysComplete && codeGate;

      if (legacyCompletionGate || cognitiveCompletionGate) {
        await db
          .update(lessonSessionsTable)
          .set({ askedQuestionTemplates: [] })
          .where(eq(lessonSessionsTable.id, session.id));

        await advanceNodeInSession(
          session.id,
          lessonId,
          session.currentNodeId,
          session.currentPhase,
          safetyCapHit
        );

        const [updSess] = await db
          .select({ currentNodeId: lessonSessionsTable.currentNodeId })
          .from(lessonSessionsTable)
          .where(eq(lessonSessionsTable.id, session.id))
          .limit(1);

        if (updSess) {
          const allNodes2 = await db
            .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence, title: lessonNodesTable.title })
            .from(lessonNodesTable)
            .where(eq(lessonNodesTable.lessonId, lessonId))
            .orderBy(asc(lessonNodesTable.sequence));

          const tn2 = allNodes2.length;
          const ne2 = allNodes2.find((n) => n.id === updSess.currentNodeId);
          const seq2 = ne2?.sequence ?? (tn2 + 1);
          const comp2 = updSess.currentNodeId != null ? seq2 - 1 : tn2;

          progressIndicator = {
            current_node_name: ne2?.title ?? topicName,
            step:            Math.min(seq2, Math.max(tn2, 1)),
            total_steps:     tn2,
            completed_nodes: comp2,
            total_nodes:     tn2,
          };
        }
      }

      // ── V2-R1.1: flag exercise delivery for auto-progression ─────────────────
      // After FEEDBACK advances MICRO_CHECK→EXERCISE (class exercises exist),
      // the exercise text must be delivered automatically — the learner must NOT need
      // to send any "ok" or "continue" to see the exercise.
      // Guard: mastery gate must NOT have fired (which would have advanced the node instead).
      if (
        newTeachingStage === "EXERCISE" &&
        classExercises.length > 0 &&
        !safetyCapHit &&
        !stageBecomesVerified &&
        !noExercisesEarlyComplete &&
        !(decisionSaysComplete && codeGate) &&
        _pedagogicalDecision?.metaAction !== "ADVANCE_COGNITIVE_LEVEL"
      ) {
        _v2r1AutoContinue = { type: "exercise" as const };
      }
    }

    // ── V2-R1: persist lastQuestionAsked on ANY turn where AI issues a micro-check ──
    // Fix: previously only written inside if (wasEval), so anticipatory THEORY→MICRO_CHECK
    // turns (wasEval=false) never wrote this field, causing the intro-repeat loop on the
    // following student turn (lastQuestionAsked=null → AI regenerated intro).
    if (aiResult?.is_micro_check === true) {
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
      const [firstNode] = await db
        .select({ id: lessonNodesTable.id })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.lessonId, lessonId))
        .orderBy(asc(lessonNodesTable.sequence))
        .limit(1);
      await db
        .update(lessonSessionsTable)
        .set({
          currentPhase: 2,
          reviewQuestionCount: newReviewCount,
          nodeAttemptCount: 0,
          askedQuestionTemplates: [],
          currentNodeId: firstNode?.id ?? null,
          nodeStartedAt: firstNode ? new Date() : null,
          phase1ConsecutiveCorrect: 0,   // reset on Phase 1 exit
          nodeTeachingStage: "THEORY",   // prepare for the first teaching node
        })
        .where(eq(lessonSessionsTable.id, session.id));
      logger.info(
        { lessonId, sessionId: session.id, reason: earlyExit ? "early_exit" : "cap", newPhase1CC },
        "P8: Phase 1 complete — auto-advanced to Phase 2"
      );
    } else {
      await db
        .update(lessonSessionsTable)
        .set({ reviewQuestionCount: newReviewCount, phase1ConsecutiveCorrect: newPhase1CC })
        .where(eq(lessonSessionsTable.id, session.id));
    }
  }

  const [assistantMsg] = await db
    .insert(chatMessagesTable)
    .values({ userId: req.userId!, lessonId: lessonId ?? null, role: "assistant", content: studentMessage })
    .returning();

  // ── V2-R1.1: Auto-progression — exercise delivery after FEEDBACK ──────────────
  // The FEEDBACK turn's stage machine already advanced MICRO_CHECK→EXERCISE and set
  // activeTaskProvenance="source_exercise" in the DB. The exercise text, however, has
  // NOT been shown yet. Persist it as a second assistant message now (before res.json)
  // so the history refetch renders FEEDBACK + exercise together, with no learner "ok".
  // Safety: _v2r1AutoContinue is set at most once per learner submission; mastery gate
  // guard ensures this never fires when the node is being completed simultaneously.
  if (_v2r1AutoContinue?.type === "exercise" && classExercises.length > 0 && lessonId && session) {
    const _ex  = classExercises[0];
    const _eff = effectiveExerciseText(
      _ex.exerciseTextVerbatim,
      (_ex as any).exerciseTextEdited as string | null
    );
    const _verb = _eff.trim() ? _eff.trim() : `[${_ex.exerciseId}]`;
    const _page = `(Էջ ${(_ex as any).sourcePage ?? "?"}, Վ. ${_ex.exerciseId})`;
    const _exContent = `${_verb}\n${_page}`;
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

  res.json({
    response:       studentMessage,
    messageId:      assistantMsg.id,
    progressIndicator,
    teachingMode,
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

  // ── Phase 2B Part 7: Fire-and-forget AI Teacher durable evidence ───────────
  // Writes an evidence_events row when the learner submits an assessable answer.
  // Fires AFTER res.json() so it never blocks the student-visible response.
  // MICRO_CHECK evidence is capped at MODERATE per spec.
  if (
    session && aiResult && lessonId &&
    session.currentPhase >= 2 && session.currentNodeId
  ) {
    const evtQuality  = aiResult.answer_evaluation.evidence_quality;
    const evtStatus   = aiResult.answer_evaluation.status;
    const evtWasEval  = evtStatus !== "NOT_APPLICABLE";
    const evtIsCorrect = evtStatus === "CORRECT" || evtStatus === "PARTIALLY_CORRECT";
    // Fire-and-forget block runs when:
    // 1. There is an assessable answer with non-NONE quality (evidence write), OR
    // 2. The decision engine has state to write to knowledge_nodes (levelConfirmed or revisitRequired)
    //    — this allows revisit_required to be set even when quality=NONE (wrong/no-quality answers).
    const _decisionHasKNState =
      !!(_pedagogicalDecision?.levelConfirmed || _pedagogicalDecision?.revisitRequired);
    if (evtWasEval && (evtQuality !== "NONE" || _decisionHasKNState)) {
      const _sessionSnap = session; // capture before async
      const _lessonId    = lessonId;
      const _userId      = req.userId!;
      (async () => {
        try {
          // Determine lesson subject for knowledge_nodes lookup
          const [lessonRow2] = await db
            .select({ subjectId: (lessonsTable as any).subjectId })
            .from(lessonsTable)
            .where(eq(lessonsTable.id, _lessonId))
            .limit(1);
          if (!lessonRow2?.subjectId) return;

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
            if (!nodeRow2) return;
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
          if (!topicId) return;

          // Resolve cognitive level text if activeCognitiveLevelId is set
          let cogLevelText: string | null = null;
          if (_sessionSnap.activeCognitiveLevelId) {
            const [cogRow] = await db
              .select({ cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel })
              .from(lessonNodeCognitiveLevelsTable)
              .where(eq(lessonNodeCognitiveLevelsTable.id, _sessionSnap.activeCognitiveLevelId))
              .limit(1);
            cogLevelText = cogRow?.cognitiveLevel ?? null;
          }

          // Cap evidence quality: MICRO_CHECK interactions cannot be STRONG/CONCLUSIVE
          const provenance = _sessionSnap.activeTaskProvenance;
          const cappedQuality =
            provenance === "micro_check" && (evtQuality === "STRONG" || evtQuality === "CONCLUSIVE")
              ? "MODERATE"
              : evtQuality;

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
            },
            cognitiveLevel:    cogLevelText,
            taskDifficulty:    null, // not available from AI micro-check
            assistanceLevel:   assistLvl !== "none" ? assistLvl : "none",
            // Phase 2B new fields:
            lessonExerciseId: _sessionSnap.activeLessonExerciseId,
            interactionType,
            attemptSequence:  _sessionSnap.activeAttemptSequence || 1,
            helpCount:        _sessionSnap.activeHelpCount,
          } as any);

          // ── V2-R3/R4A: Write demonstrated_cognitive_level / revisit_required / revisit_reason ──
          // Applied after the evidence row is written (not before) because the
          // evidence row is the source of truth; this is a write-through cache.
          //
          // Reset rules (Part 15):
          //   - levelConfirmed → clear revisitRequired + revisitReason
          //   - revisitRequired → set revisitReason from engine (typed: REMEDIATION_EXHAUSTED | LOCAL_BUDGET_EXHAUSTED)
          //   - END_REQUIRED_SESSION → revisitRequired=false, no reason written
          if (_pedagogicalDecision && topicId) {
            const knUpdate: Record<string, unknown> = {};
            if (_pedagogicalDecision.levelConfirmed && _pedagogicalDecision.confirmedLevel) {
              knUpdate.demonstratedCognitiveLevel = _pedagogicalDecision.confirmedLevel;
              knUpdate.revisitRequired = false; // confirmed level clears revisit flag
              knUpdate.revisitReason   = null;  // R4A: clear reason on confirmation
              knUpdate.updatedAt = new Date();
            }
            if (_pedagogicalDecision.revisitRequired) {
              knUpdate.revisitRequired = true;
              knUpdate.revisitReason   = _pedagogicalDecision.revisitReason ?? null;
              knUpdate.updatedAt = new Date();
            }
            if (Object.keys(knUpdate).length > 0) {
              await db
                .update(knowledgeNodesTable)
                .set(knUpdate as any)
                .where(eq(knowledgeNodesTable.id, topicId));
              logger.info({
                topicId,
                metaAction: _pedagogicalDecision.metaAction,
                demonstratedLevel: knUpdate.demonstratedCognitiveLevel ?? null,
                revisitRequired: knUpdate.revisitRequired ?? null,
                revisitReason:   knUpdate.revisitReason ?? null,
              }, "V2-R3/R4A: knowledge_nodes durable state updated");
            }
          }

          // Update knowledge scoring in background (no quizId — chat-sourced evidence)
          updateTopicScoring(topicId, _userId).catch((err) =>
            logger.error({ err, topicId }, "chat evidence: scoring failed")
          );
        } catch (err) {
          logger.error({ err, sessionId: _sessionSnap.id }, "Phase 2B evidence write failed");
        }
      })().catch(() => {});
    }
  }

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
    const _slt_lessonId = lessonId;
    const _slt_userId   = req.userId!;
    (async () => {
      try {
        const [lessonRow3] = await db
          .select({ subjectId: (lessonsTable as any).subjectId })
          .from(lessonsTable)
          .where(eq(lessonsTable.id, _slt_lessonId))
          .limit(1);
        if (!lessonRow3?.subjectId) return;

        const [existingKN3] = await db
          .select({
            id:             knowledgeNodesTable.id,
            revisitRequired: knowledgeNodesTable.revisitRequired,
          })
          .from(knowledgeNodesTable)
          .where(and(
            eq(knowledgeNodesTable.subjectId,   lessonRow3.subjectId),
            eq(knowledgeNodesTable.userId,       _slt_userId),
            eq(knowledgeNodesTable.lessonNodeId, _slt_session.currentNodeId!),
          ))
          .limit(1);

        // Only write if KN exists AND not already revisitRequired
        // (don't overwrite REMEDIATION_EXHAUSTED / LOCAL_BUDGET_EXHAUSTED).
        if (existingKN3 && !existingKN3.revisitRequired) {
          await db
            .update(knowledgeNodesTable)
            .set({
              revisitRequired: true,
              revisitReason:   "SESSION_TIME_LIMIT",
              updatedAt:       new Date(),
            } as any)
            .where(eq(knowledgeNodesTable.id, existingKN3.id));
          logger.info(
            { topicId: existingKN3.id, sessionId: _slt_session.id },
            "V2-R4A.3: SESSION_TIME_LIMIT revisit marker written"
          );
        }
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