import { Router } from "express";
import {
  db, chatMessagesTable, lessonsTable, lessonSessionsTable,
  lessonNodesTable, lessonExercisesTable,
  lessonNodeDependenciesTable, usersTable,
  evidenceEventsTable, knowledgeNodesTable,
  lessonNodeCognitiveLevelsTable, helpEventsTable,
} from "@workspace/db";
import { eq, and, asc, inArray, gte, or, isNull } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import {
  callAI, callAIStructured,
  type ChatMessage, type AIStructuredResponse, type ProgressIndicator,
} from "../services/ai";
import { getDueReviewTopics } from "../services/review-schedule";
import { logger } from "../lib/logger";
import { enforceVerbatimExercise, isExerciseDeliveryTurn, effectiveExerciseText } from "../lib/exercise-delivery";
import { updateTopicScoring } from "../services/scoring";

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
    activeAttemptSequence:  0,
    activeHelpCount:        0,
    activeAssistanceLevel:  "none",
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

  const userMessageAt = Date.now();
  let sessionId: number | null = null;
  let teachingMode = "TEACH";
  // Phase 2B: tracks whether this response has an active assessable task
  // (MICRO_CHECK or EXERCISE stage). Sent in res.json so frontend shows/hides Help button.
  let hasActiveTask = false;

  let lessonContext = "";
  let topicName = "";
  let _allNodeTitles: string[] = [];
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
    activeAttemptSequence: number;
    activeHelpCount: number;
    activeAssistanceLevel: string;
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
  };
  let currentNodeRecord: NodeRef | null = null;

  // FIX: hoisted to outer scope so the mastery-gate 0-exercise check below can see it.
  let classExercises: (typeof lessonExercisesTable.$inferSelect)[] = [];

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
          activeAttemptSequence:  (sessionRow as any).activeAttemptSequence  ?? 0,
          activeHelpCount:        (sessionRow as any).activeHelpCount        ?? 0,
          activeAssistanceLevel:  (sessionRow as any).activeAssistanceLevel  ?? "none",
        };
        sessionId = sessionRow.id;
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
          })
          .from(lessonNodesTable)
          .where(eq(lessonNodesTable.id, session.currentNodeId))
          .limit(1);
        currentNodeRecord = nodeRow ?? null;
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
    logger.info({ lessonId, sessionId: session.id }, "intro-gate: confirmed, proceeding to normal AI flow");
  }
  // ── End intro gate ────────────────────────────────────────────────────────────

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

  } catch (err) {
    logger.error(
      {
        event:     "ai_structured_fallback",
        userId:    req.userId,
        lessonId,
        sessionId: session?.id ?? null,
        firstError: err instanceof Error ? err.message : String(err),
      },
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
  if (session && isExerciseDeliveryTurn(session.currentPhase, session.nodeTeachingStage ?? "THEORY", classExercises.length)) {
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
    const wasEval     = status !== "NOT_APPLICABLE";

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
    if (!wasEval && (session?.nodeTeachingStage ?? "THEORY") === "MICRO_CHECK" &&
        aiResult.teaching_mode === "TRANSITION" &&
        aiResult.source_fidelity.exercise_id) {
      await db
        .update(lessonSessionsTable)
        .set({
          nodeTeachingStage:      "EXERCISE",
          activeLessonExerciseId: classExercises.length > 0 ? classExercises[0].id : null,
          activeTaskProvenance:   "source_exercise",
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

      if (aiResult?.is_micro_check) {
        const tmpl = aiResult.question_template ?? null;
        const currentTemplates = session?.askedQuestionTemplates ?? [];
        const newTemplates = tmpl && !currentTemplates.includes(tmpl)
          ? [...currentTemplates, tmpl]
          : currentTemplates;
        await db
          .update(lessonSessionsTable)
          .set({
            lastQuestionAsked: aiResult.student_message.slice(0, 500),
            askedQuestionTemplates: newTemplates,
          })
          .where(eq(lessonSessionsTable.id, session.id));
      }

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
          activeTaskUpdate.activeAttemptSequence  = 1;
          activeTaskUpdate.activeHelpCount        = 0;
          activeTaskUpdate.activeAssistanceLevel  = "none";
        } else if (newTeachingStage === "EXERCISE" && classExercises.length > 0) {
          activeTaskUpdate.activeLessonExerciseId = classExercises[0].id;
          activeTaskUpdate.activeTaskProvenance   = "source_exercise";
          activeTaskUpdate.activeAttemptSequence  = 1;
          activeTaskUpdate.activeHelpCount        = 0;
          activeTaskUpdate.activeAssistanceLevel  = "none";
        } else if (newTeachingStage === "VERIFIED") {
          activeTaskUpdate.activeLessonExerciseId = null;
          activeTaskUpdate.activeTaskProvenance   = null;
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

      // ── Mastery gate check ───────────────────────────────────────────────
      const stageBecomesVerified = newTeachingStage === "VERIFIED";
      const noExercisesEarlyComplete =
        classExercises.length === 0 &&
        (currentStage === "MICRO_CHECK") &&
        newAttemptCount >= 2 &&
        (quality === "MODERATE" || quality === "STRONG" || quality === "CONCLUSIVE") &&
        isCorrect;

      const modelSaysComplete = aiResult.node_decision.action === "COMPLETE_NODE";
      const hasExercisesOnThisNode = classExercises.length > 0;
      const codeGate = hasExercisesOnThisNode
        ? (newMasteryCount >= 2 && (quality === "STRONG" || quality === "CONCLUSIVE") && newConsecIncorrect < 2)
        : (newMasteryCount >= 2 && quality !== "NONE" && newConsecIncorrect < 2);
      const safetyCapHit = newAttemptCount > 6;

      if (safetyCapHit || stageBecomesVerified || noExercisesEarlyComplete || (modelSaysComplete && codeGate)) {
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

  res.json({
    response:       studentMessage,
    messageId:      assistantMsg.id,
    progressIndicator,
    teachingMode,
    hasActiveTask,          // Phase 2B: true when a MICRO_CHECK or EXERCISE task is active
    activeHelpCount:        session ? ((session as any).activeHelpCount ?? 0) : 0,
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
    // Only write evidence when there is an assessable answer with non-NONE quality
    if (evtWasEval && evtQuality !== "NONE") {
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
});

// ── Phase 2B Part 6: POST /chat/help ─────────────────────────────────────────
// Progressive help endpoint. Derives all task identity from server-side session.
// Help levels 1-3 never reveal the final answer. Level 4 requires explicit consent.
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

  const activeProvenance = (sessionRow as any).activeTaskProvenance as string | null;
  if (!activeProvenance) {
    res.status(409).json({ error: "NO_ACTIVE_TASK", message: "Ալ կա ակտiv խndlaban լini" });
    return;
  }

  const currentHelpCount = ((sessionRow as any).activeHelpCount ?? 0) as number;
  const activeLessonExId = ((sessionRow as any).activeLessonExerciseId ?? null) as number | null;
  const activeCogLevelId = ((sessionRow as any).activeCognitiveLevelId ?? null) as number | null;

  const nextHelpLevel = Math.min(currentHelpCount + 1, 4);

  if (nextHelpLevel === 4 && !revealAnswer) {
    res.status(409).json({
      error:     "REVEAL_REQUIRES_CONFIRMATION",
      helpLevel: 4,
      message:   "Arayin tesnel-u kerp hstatutyun kllini",
    });
    return;
  }

  let taskText: string | null = null;
  if (activeLessonExId) {
    const [exRow] = await db
      .select({ verbatim: lessonExercisesTable.exerciseTextVerbatim, edited: lessonExercisesTable.exerciseTextEdited })
      .from(lessonExercisesTable)
      .where(eq(lessonExercisesTable.id, activeLessonExId))
      .limit(1);
    taskText = exRow ? (exRow.edited || exRow.verbatim) : null;
  } else if (sessionRow.lastQuestionAsked) {
    taskText = sessionRow.lastQuestionAsked;
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
      "Դու AI ուսուցիչ ես։ Հայկական հուշ տուր։"
    );
  } catch (aiErr) {
    logger.warn({ aiErr, sessionId: sessionRow.id }, "help endpoint: AI hint failed");
    hintContent = "Փորձիր կրկին մտածել խնդրի մասին, կամ դիմիր ուսուցչին։";
  }

  const LEVEL_TO_ASSIST: Record<number, string> = {
    1: "light", 2: "moderate", 3: "guided", 4: "revealed",
  };

  const [helpEvent] = await db
    .insert(helpEventsTable)
    .values({
      userId:           req.userId!,
      lessonSessionId:  sessionRow.id,
      lessonNodeId:     sessionRow.currentNodeId,
      lessonExerciseId: activeLessonExId,
      quizQuestionId:   null,
      cognitiveLevelId: activeCogLevelId,
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
    .where(eq(lessonSessionsTable.id, sessionRow.id));

  res.json({
    success:        true,
    helpLevel:      nextHelpLevel,
    isAnswerReveal: nextHelpLevel === 4,
    hintContent,
    helpEventId:    helpEvent?.id ?? null,
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

  res.json({
    hasActiveTask,
    activeHelpCount:      (sessionRow as any).activeHelpCount      ?? 0,
    activeAssistanceLevel:(sessionRow as any).activeAssistanceLevel ?? "none",
    nodeTeachingStage,
    status:               sessionRow.status,
    currentPhase:         sessionRow.currentPhase,
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