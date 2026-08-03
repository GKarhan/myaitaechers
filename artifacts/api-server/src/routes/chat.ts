import { Router } from "express";
import {
  db, chatMessagesTable, lessonsTable, lessonSessionsTable,
  evidenceEventsTable, knowledgeNodesTable, lessonNodesTable, lessonExercisesTable,
  lessonNodeDependenciesTable, usersTable,
} from "@workspace/db";
import { eq, and, asc, inArray, gte } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import {
  callAI, callAIStructured,
  type ChatMessage, type AIStructuredResponse, type ProgressIndicator,
} from "../services/ai";
import { updateTopicScoring } from "../services/scoring";
import { getDueReviewTopics } from "../services/review-schedule";
import { logger } from "../lib/logger";

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
      return `DEEP STUDY PHASE — apply concepts to complex scenarios:
Use REAL_LIFE_EXAMPLES (if provided above) to frame exercises in real-world context.
Present CLASS EXERCISES (higher difficulty levels preferred).
Challenge the student with Bloom level 3-4 tasks (Apply, Analyze).
Socratic method: ask questions that lead the student to discover answers themselves.`;

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

  await db
    .update(lessonNodesTable)
    .set({
      masteryEvidenceCount: 0,
      consecutiveCorrect:   0,
      consecutiveIncorrect: 0,
      lastEvidenceQuality:  reviewNeeded ? "WEAK" : null,
      teachingStage:        "THEORY",   // reset for next session
    })
    .where(eq(lessonNodesTable.id, currentNodeId));

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

  await db
    .update(lessonSessionsTable)
    .set({
      currentNodeId: newNodeId,
      nodeStartedAt: newNodeId ? new Date() : null,
      nodeAttemptCount: 0,
      currentPhase: newPhase,
      lastQuestionAsked: null,
    })
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
  let topicId: number | null = null;
  let teachingMode = "TEACH";

  let lessonContext = "";
  let topicName = "";
  let _allNodeTitles: string[] = [];
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
    const [lesson] = await db
      .select()
      .from(lessonsTable)
      .where(eq(lessonsTable.id, lessonId))
      .limit(1);

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
      const studentName = studentRow?.fullName ?? null;

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
            eq(lessonExercisesTable.assignment, "CLASS")
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
      } else if (phase === 3 && allNodeIds.length > 0) {
        classExercises = await db
          .select()
          .from(lessonExercisesTable)
          .where(and(
            inArray(lessonExercisesTable.relatedNodeId, allNodeIds),
            eq(lessonExercisesTable.assignment, "CLASS")
          ))
          .orderBy(asc(lessonExercisesTable.sequence));
      }

      let homeworkExercises: (typeof lessonExercisesTable.$inferSelect)[] = [];
      if (phase === 4) {
        homeworkExercises = await db
          .select()
          .from(lessonExercisesTable)
          .where(and(
            eq(lessonExercisesTable.lessonId, lessonId),
            eq(lessonExercisesTable.assignment, "HOMEWORK")
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
        ? `\nDEEP_DIVE_EXERCISES (all lesson exercises, start presenting from index ${deepDiveIdx}):\n` +
          classExercises.map((e, i) =>
            `[idx=${i}] [${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
            `  VERBATIM: ${e.exerciseTextVerbatim || "(none — AI may invent)"}\n` +
            `  successCriteria: ${e.successCriteria ?? ""}`
          ).join("\n")
        : phase === 2 && classExercises.length > 0
        ? `\nCLASS_EXERCISES (use verbatim when exerciseTextVerbatim is non-empty):\n` +
          classExercises.map((e) =>
            `[${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
            `  VERBATIM: ${e.exerciseTextVerbatim || "(none — AI may invent)"}\n` +
            `  successCriteria: ${e.successCriteria ?? ""}`
          ).join("\n")
        : "";

      const hwBlock = homeworkExercises.length > 0
        ? `\nHOMEWORK_TASKS (present verbatim, explain why each matters):\n` +
          homeworkExercises.map((e) =>
            `[${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
            `  VERBATIM: ${e.exerciseTextVerbatim || "(no text — describe the task)"}\n` +
            `  successCriteria: ${e.successCriteria ?? ""}`
          ).join("\n")
        : "";

      const allNodeTitles = allNodes.map((n) => n.title);
      _allNodeTitles = allNodeTitles;

      const absoluteRuleBlock = currentNodeRecord && allNodeTitles.length > 0
        ? [
            `╔══ ABSOLUTE NODE LOCK — NEVER VIOLATE ══╗`,
            `You are teaching EXCLUSIVELY node: «${currentNodeRecord.title}»`,
            `Lesson: «${lesson.title}»`,
            `CURRENT_NODE:     «${currentNodeRecord.title}»`,
            completedNodeTitles.length > 0
              ? `COMPLETED_NODES:  ${completedNodeTitles.map((t) => `«${t}»`).join(", ")}  ← finished; do not reteach`
              : `COMPLETED_NODES:  (none)`,
            futureNodeTitles.length > 0
              ? `FUTURE_NODES:     ${futureNodeTitles.map((t) => `«${t}»`).join(", ")}  ← not yet started; do not teach`
              : `FUTURE_NODES:     (none)`,
            `FORBIDDEN: reteach any COMPLETED_NODE`,
            `FORBIDDEN: jump ahead to any FUTURE_NODE`,
            `FORBIDDEN: declare lesson/node complete (backend decides mastery, not you)`,
            `FORBIDDEN: agree with student if they ask to skip/change topic — instead set redirect_needed:true and warmly redirect back`,
            `╚════════════════════════════════════════╝`,
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
      const teachingStage = phase === 2 ? (currentNodeRecord?.teachingStage ?? "THEORY") : "THEORY";
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
            const verbatim = ex.exerciseTextVerbatim?.trim() ? ex.exerciseTextVerbatim : `[${ex.exerciseId}]`;
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
        const stage = currentNodeRecord.teachingStage ?? "THEORY";
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
        currentNodeRecord ? `node_stage=${currentNodeRecord.teachingStage ?? "THEORY"}` : null,
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

      try {
        const [existingKN] = await db
          .select()
          .from(knowledgeNodesTable)
          .where(and(
            eq(knowledgeNodesTable.subjectId, lesson.subjectId),
            eq(knowledgeNodesTable.userId, req.userId!),
            eq(knowledgeNodesTable.topicName, topicName),
          ))
          .limit(1);

        if (existingKN) {
          topicId = existingKN.id;
        } else {
          const [newKN] = await db
            .insert(knowledgeNodesTable)
            .values({
              subjectId: lesson.subjectId,
              userId: req.userId!,
              topicName,
              status: "not_started",
              isProvisional: true,
              bloomLevel: currentNodeRecord?.targetBloomLevel ?? 1,
            })
            .returning({ id: knowledgeNodesTable.id });
          topicId = newKN?.id ?? null;
        }
      } catch (err) {
        logger.error({ err }, "knowledge_nodes lookup/create failed");
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
    logger.error({ err }, "callAIStructured failed twice — falling back to callAI");
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

  if (aiResult && session?.currentNodeId && session.currentPhase >= 2 && lessonId) {
    const status      = aiResult.answer_evaluation.status;
    const quality     = aiResult.answer_evaluation.evidence_quality;
    const isCorrect   = status === "CORRECT" || status === "PARTIALLY_CORRECT";
    const isIncorrect = status === "INCORRECT";
    const wasEval     = status !== "NOT_APPLICABLE";
    // ── Anticipatory THEORY→MICRO_CHECK stage advance ─────────────────────
    // Fixes: on the very first turn of a node, the AI delivers THEORY +
    // asks the first MICRO_CHECK in one turn. Since the student hasn't
    // answered anything yet, status=NOT_APPLICABLE (wasEval=false), so the
    // stage-machine block below never runs and teachingStage stays "THEORY".
    // On the NEXT turn (student's actual answer), the directive would then
    // wrongly say "give THEORY again" instead of "evaluate the answer".
    // This block pushes the stage forward immediately, independent of wasEval.
    if (!wasEval && currentNodeRecord?.teachingStage === "THEORY" && aiResult.is_micro_check) {
      await db
        .update(lessonNodesTable)
        .set({ teachingStage: "MICRO_CHECK" })
        .where(eq(lessonNodesTable.id, session.currentNodeId));
      logger.info(
        { nodeId: session.currentNodeId },
        "teachingStage anticipatory advance: THEORY -> MICRO_CHECK"
      );
    }

    // ── Anticipatory MICRO_CHECK→EXERCISE stage advance ───────────────────
    // When the AI presents a class exercise (teaching_mode=TRANSITION with a
    // filled exercise_id) before the student has answered anything (wasEval=false),
    // push the stage forward immediately so the NEXT turn directive correctly
    // says "evaluate the answer" instead of "present the exercise again".
    if (!wasEval && currentNodeRecord?.teachingStage === "MICRO_CHECK" &&
        aiResult.teaching_mode === "TRANSITION" &&
        aiResult.source_fidelity.exercise_id) {
      await db
        .update(lessonNodesTable)
        .set({ teachingStage: "EXERCISE" })
        .where(eq(lessonNodesTable.id, session.currentNodeId));
      logger.info(
        { nodeId: session.currentNodeId, exerciseId: aiResult.source_fidelity.exercise_id },
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
      const [nodeStats] = await db
        .select({
          masteryEvidenceCount: lessonNodesTable.masteryEvidenceCount,
          consecutiveCorrect:   lessonNodesTable.consecutiveCorrect,
          consecutiveIncorrect: lessonNodesTable.consecutiveIncorrect,
        })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.id, session.currentNodeId))
        .limit(1);

      const prevMastery  = nodeStats?.masteryEvidenceCount ?? 0;
      const prevCC       = nodeStats?.consecutiveCorrect   ?? 0;
      const prevCI       = nodeStats?.consecutiveIncorrect ?? 0;

      const newMasteryCount    = prevMastery + (quality !== "NONE" ? 1 : 0);
      const newConsecCorrect   = isCorrect   ? prevCC + 1 : isIncorrect ? 0 : prevCC;
      const newConsecIncorrect = isIncorrect ? prevCI + 1 : isCorrect   ? 0 : prevCI;

      await db
        .update(lessonNodesTable)
        .set({
          masteryEvidenceCount: newMasteryCount,
          lastEvidenceQuality:  quality,
          consecutiveCorrect:   newConsecCorrect,
          consecutiveIncorrect: newConsecIncorrect,
        })
        .where(eq(lessonNodesTable.id, session.currentNodeId));

      const [sessionStats] = await db
        .select({ nodeAttemptCount: lessonSessionsTable.nodeAttemptCount })
        .from(lessonSessionsTable)
        .where(eq(lessonSessionsTable.id, session.id))
        .limit(1);

      const newAttemptCount = (sessionStats?.nodeAttemptCount ?? 0) + 1;

      await db
        .update(lessonSessionsTable)
        .set({ nodeAttemptCount: newAttemptCount })
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
      const currentStage = currentNodeRecord?.teachingStage ?? "THEORY";
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
        await db
          .update(lessonNodesTable)
          .set({ teachingStage: newTeachingStage })
          .where(eq(lessonNodesTable.id, session.currentNodeId));
        logger.info({ nodeId: session.currentNodeId, currentStage, newTeachingStage }, "teachingStage advanced");
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

    let earlyExit = false;
    if (newReviewCount > 3 && wasCorrect === true) {
      const [prevEvent] = await db
        .select({ wasCorrect: evidenceEventsTable.wasCorrect })
        .from(evidenceEventsTable)
        .where(eq(evidenceEventsTable.lessonSessionId, session.id))
        .orderBy(asc(evidenceEventsTable.id))
        .offset(Math.max(0, newReviewCount - 2))
        .limit(1);
      earlyExit = prevEvent?.wasCorrect === true;
    }

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
        })
        .where(eq(lessonSessionsTable.id, session.id));
      logger.info(
        { lessonId, sessionId: session.id, reason: earlyExit ? "early_exit" : "cap" },
        "P8: Phase 1 complete — auto-advanced to Phase 2"
      );
    } else {
      await db
        .update(lessonSessionsTable)
        .set({ reviewQuestionCount: newReviewCount })
        .where(eq(lessonSessionsTable.id, session.id));
    }
  }

  db.insert(evidenceEventsTable)
    .values({
      userId: req.userId!,
      lessonSessionId: sessionId,
      topicId,
      eventType: "answer",
      wasCorrect,
      responseTimeMs,
      hintUsed: false,
      metadata: {},
    })
    .then(() => {
      if (topicId !== null) {
        updateTopicScoring(topicId, req.userId!).catch((err: unknown) =>
          logger.error({ err }, "scoring engine update failed")
        );
      }
    })
    .catch((err: unknown) => logger.error({ err }, "evidence event insert failed"));

  const [assistantMsg] = await db
    .insert(chatMessagesTable)
    .values({ userId: req.userId!, lessonId: lessonId ?? null, role: "assistant", content: studentMessage })
    .returning();

  res.json({
    response: studentMessage,
    messageId: assistantMsg.id,
    progressIndicator,
    teachingMode,
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