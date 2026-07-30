import { Router } from "express";
import {
  db, chatMessagesTable, lessonsTable, lessonSessionsTable,
  evidenceEventsTable, knowledgeNodesTable, lessonNodesTable, lessonExercisesTable,
  lessonNodeDependenciesTable,
} from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";
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

// Transition-signal phrases (Armenian Unicode, never hand-typed)
const SCOPE_DRIFT_PHRASES = [
  "\u0570\u0561\u057b\u0578\u0580\u0564 \u0569\u0565\u0574\u0561",           // հaJordog thyemma (next topic)
  "\u0576\u0578\u0580 \u0564\u0561\u057d",                                     // nor das (new lesson)
  "\u0561\u0576\u0581\u0576\u0565\u0576\u0584",                               // ancnenk (let's move on)
  "\u0561\u057e\u0561\u0580\u057f\u0565\u0581\u056b\u0576\u0584 \u0564\u0561\u057d\u0568", // avartecink dasy (we finished the lesson)
];

// Canned redirect reply — hardcoded, never from the model
const REDIRECT_CANNED_PREFIX =
  "\u0540\u0561\u057d\u056f\u0561\u0576\u0578\u0582\u0574 \u0565\u0574, " +
  "\u0562\u0561\u0575\u0581 \u0561\u0580\u056b\u055b \u0576\u0561\u056d \u0561\u057e\u0561\u0580\u057f\u0565\u0576\u0584 " +
  "\u0568\u0576\u0569\u0561\u0581\u056b\u056f \u0570\u0561\u0580\u0581\u0568 \ud83d\ude0a";
// "Հaskanuk em, baits ari՛ nakhav avarthenk enthaciç hartsë 😊"

/**
 * Returns true if the AI's student_message contains a scope-drift phrase
 * (transition signal) that doesn't match any known node title.
 * This is a hard code-level guard — the model's response is discarded on hit.
 */
function validateNoScopeDrift(studentMessage: string, allNodeTitles: string[]): boolean {
  const lower = studentMessage.toLowerCase();
  const hasDriftPhrase = SCOPE_DRIFT_PHRASES.some((p) => lower.includes(p));
  if (!hasDriftPhrase) return false;
  // Allow if the message legitimately references a node title (e.g. TRANSITION to next node)
  const refersToKnownNode = allNodeTitles.some((t) => lower.includes(t.toLowerCase()));
  return !refersToKnownNode;
}

// ── Phase guidance (compact, replaces the old buildPhaseInstruction) ─────────

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
NEVER give the answer directly — always hint and guide.`;

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

// ── P0: Advance session to next node (or auto-advance phase when exhausted) ──

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

  // Reset mastery tracking on the completed node
  await db
    .update(lessonNodesTable)
    .set({
      masteryEvidenceCount: 0,
      consecutiveCorrect:   0,
      consecutiveIncorrect: 0,
      lastEvidenceQuality:  reviewNeeded ? "WEAK" : null,
    })
    .where(eq(lessonNodesTable.id, currentNodeId));

  // ── P4 Defensive check: verify CRITICAL prerequisites of nextNode are done ──
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
        // Check that all prerequisite nodes have sequence < nextNode.sequence
        // (i.e., they appear before the node we're advancing to)
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

  // Phase 2 → 3 auto-advance when the last node is done
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
    })
    .where(eq(lessonSessionsTable.id, sessionId));

  return { newNodeId, newPhase, allNodesDone };
}

// ── POST /chat ────────────────────────────────────────────────────────────────

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
  };
  let session: SessionRef | null = null;

  type NodeRef = {
    id: number; title: string; theoryContent: string | null;
    targetBloomLevel: number; estimatedMinutes: number;
    childFriendlyExplanation: string | null;
    basicExamples: unknown; realLifeExamples: unknown;
    commonMisconception: string | null; prerequisiteNodes: unknown;
  };
  let currentNodeRecord: NodeRef | null = null;

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
        };
        sessionId = sessionRow.id;
      }

      const phase        = session?.currentPhase ?? 1;
      const subjectName  = (lesson as { subjectName?: string }).subjectName ?? "Subject";
      const coreProblem  = (lesson as { coreProblem?: string | null }).coreProblem ?? null;
      const coreIdea     = (lesson as { coreIdea?: string | null }).coreIdea ?? null;

      // All nodes for this lesson (for progress computation + node-lock)
      const allNodes = await db
        .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence, title: lessonNodesTable.title })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.lessonId, lessonId))
        .orderBy(asc(lessonNodesTable.sequence));

      const totalNodes      = allNodes.length;
      const currentNodeEntry = allNodes.find((n) => n.id === session?.currentNodeId);
      const currentNodeSeq   = currentNodeEntry?.sequence ?? (totalNodes + 1);
      const completedNodes   = session?.currentNodeId != null ? currentNodeSeq - 1 : totalNodes;

      // Rich node data for the current node
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

      // Class exercises for the current node
      const classExercises = session?.currentNodeId
        ? await db
            .select()
            .from(lessonExercisesTable)
            .where(
              and(
                eq(lessonExercisesTable.relatedNodeId, session.currentNodeId),
                eq(lessonExercisesTable.assignment, "CLASS")
              )
            )
            .orderBy(asc(lessonExercisesTable.sequence))
        : [];

      // Phase 1: due review topics
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

      const examplesArr = toStrArr(currentNodeRecord?.basicExamples);
      const examplesBlock = examplesArr.length > 0
        ? `\nBASIC_EXAMPLES:\n${examplesArr.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
        : "";

      const misconceptionBlock = currentNodeRecord?.commonMisconception
        ? `\nKNOWN_MISCONCEPTION (design MICRO_CHECK distractors around this):\n${currentNodeRecord.commonMisconception}`
        : "";

      const exBlock = classExercises.length > 0
        ? `\nCLASS_EXERCISES (use verbatim when exerciseTextVerbatim is non-empty):\n` +
          classExercises.map((e) =>
            `[${e.exerciseId}] page=${e.sourcePage ?? "?"} difficulty=${e.difficultyLevel ?? "?"}\n` +
            `  VERBATIM: ${e.exerciseTextVerbatim || "(none — AI may invent)"}\n` +
            `  successCriteria: ${e.successCriteria ?? ""}`
          ).join("\n")
        : "";

      const allNodeTitles = allNodes.map((n) => n.title);
      _allNodeTitles = allNodeTitles; // expose to outer scope for scope-drift check

      // P7: ABSOLUTE RULE block — injected at top of context so model sees it first
      const absoluteRuleBlock = currentNodeRecord && allNodeTitles.length > 0
        ? [
            `╔══ ABSOLUTE NODE LOCK — NEVER VIOLATE ══╗`,
            `You are teaching EXCLUSIVELY node: «${currentNodeRecord.title}»`,
            `Lesson: «${lesson.title}»`,
            `ALLOWED_NODES (full list): ${allNodeTitles.map((t) => `«${t}»`).join(", ")}`,
            `FORBIDDEN: mention/suggest any topic NOT in ALLOWED_NODES`,
            `FORBIDDEN: declare lesson/node complete (backend decides mastery, not you)`,
            `FORBIDDEN: agree with student if they ask to skip/change topic — instead set redirect_needed:true and warmly redirect back to the current unanswered question`,
            `╚════════════════════════════════════════╝`,
          ].join("\n")
        : "";

      // P7: Phase 1 progress indicator (Part 5.1)
      const phase1AttemptCount = session?.nodeAttemptCount ?? 0;
      const PHASE1_CAP = 5;
      const phase1ProgressLine = phase === 1
        ? `PHASE_1_PROGRESS: question ${phase1AttemptCount + 1}/${PHASE1_CAP} (auto-advance to Phase 2 after cap)`
        : "";

      // P7: Question dedup — pass already-used templates for current node
      const usedTemplates = session?.askedQuestionTemplates ?? [];
      const usedTemplatesBlock = usedTemplates.length > 0
        ? `USED_QUESTION_TEMPLATES (do NOT repeat these for this node): ${usedTemplates.join(", ")}`
        : "";

      lessonContext = [
        absoluteRuleBlock,
        `LESSON: «${lesson.title}»`,
        `SUBJECT: ${subjectName}`,
        currentNodeRecord
          ? `CURRENT_NODE: «${currentNodeRecord.title}» (Bloom ${currentNodeRecord.targetBloomLevel}, ~${currentNodeRecord.estimatedMinutes} min)`
          : "",
        coreProblem ? `CORE_PROBLEM: ${coreProblem}` : "",
        coreIdea    ? `CORE_IDEA: ${coreIdea}`       : "",
        `PHASE: ${phase} | PROGRESS: node ${currentNodeSeq}/${totalNodes} | completed: ${completedNodes}/${totalNodes}`,
        phase1ProgressLine,
        currentNodeRecord?.theoryContent ? `NODE_THEORY:\n${currentNodeRecord.theoryContent}` : "",
        cfeBlock,
        examplesBlock,
        misconceptionBlock,
        exBlock,
        usedTemplatesBlock,
        dueReviewsLine,
        ``,
        `=== PHASE ${phase} GUIDANCE ===`,
        buildPhaseGuidance(phase, topicName, subjectName),
      ].filter(Boolean).join("\n");

      // Phase 1 progress indicator (Part 5.1) — show question X/N to frontend
      if (phase === 1) {
        progressIndicator = {
          current_node_name: topicName,
          step: Math.min(phase1AttemptCount + 1, PHASE1_CAP),
          total_steps: PHASE1_CAP,
          completed_nodes: 0,
          total_nodes: totalNodes,
        };
      }

      // Ensure a knowledge node row exists for scoring
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

  // ── Load history ──────────────────────────────────────────────────────────
  const history = await db
    .select()
    .from(chatMessagesTable)
    .where(
      lessonId
        ? and(eq(chatMessagesTable.userId, req.userId!), eq(chatMessagesTable.lessonId, lessonId))
        : eq(chatMessagesTable.userId, req.userId!)
    )
    .orderBy(asc(chatMessagesTable.createdAt))
    .limit(30);

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

  // ── Call AI (structured output with fallback) ─────────────────────────────
  let aiResult: AIStructuredResponse | null = null;
  let studentMessage: string;
  let wasCorrect: boolean | null = null;

  try {
    aiResult = await callAIStructured(chatHistory, lessonContext);

    // ── P7 Part 3.1: Hard code-level scope-drift validation ──────────────────
    // Extract the allNodeTitles that were built above (available in outer scope
    // via the allNodeTitles variable if lessonId was set; empty otherwise)
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
        // Send canned redirect + repeat last question; never change node/phase
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

    // ── P7 Part 3.3: Force CONTINUE_SAME_NODE if model flagged redirect ──────
    if (aiResult.redirect_needed) {
      // Override model's node_decision — student wasn't actually answering the question
      aiResult.node_decision = { action: "CONTINUE_SAME_NODE", reason: "redirect_needed: student tried to skip" };
      // Also nullify any mistakenly optimistic evidence
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
    logger.error({ err }, "callAIStructured failed — falling back to callAI");
    try {
      studentMessage = await callAI(chatHistory, lessonContext || undefined);
      // Legacy ###EVAL:### extraction for fallback path
      const evalMatch = studentMessage.match(/\s*###EVAL:(CORRECT|INCORRECT|NONE)###\s*$/);
      wasCorrect = evalMatch?.[1] === "CORRECT" ? true : evalMatch?.[1] === "INCORRECT" ? false : null;
      if (evalMatch) studentMessage = studentMessage.slice(0, evalMatch.index).trimEnd();
    } catch (err2) {
      logger.error({ err: err2 }, "callAI fallback also failed");
      res.status(503).json({ error: "AI service unavailable" });
      return;
    }
  }

  // ── P0: Update node tracking & check mastery gate ─────────────────────────
  if (aiResult && session?.currentNodeId && session.currentPhase >= 2 && lessonId) {
    const status      = aiResult.answer_evaluation.status;
    const quality     = aiResult.answer_evaluation.evidence_quality;
    const isCorrect   = status === "CORRECT" || status === "PARTIALLY_CORRECT";
    const isIncorrect = status === "INCORRECT";
    const wasEval     = status !== "NOT_APPLICABLE";

    if (wasEval) {
      // Read current node tracking values
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

      // Increment session nodeAttemptCount
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

      // ── P7 Part 3.2/4.1: track lastQuestionAsked + askedQuestionTemplates ──
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

      // ── Mastery gate check ───────────────────────────────────────────────
      const modelSaysComplete = aiResult.node_decision.action === "COMPLETE_NODE";
      const codeGate =
        newMasteryCount >= 2 &&
        (quality === "STRONG" || quality === "CONCLUSIVE") &&
        newConsecIncorrect < 2;
      const safetyCapHit = newAttemptCount > 6;

      if (safetyCapHit || (modelSaysComplete && codeGate)) {
        // Clear question templates when advancing to next node
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

        // Refresh progress indicator after node advancement
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

  // ── P7 Part 5.1: Phase 1 attempt tracking + auto-advance to Phase 2 ────────
  if (session && session.currentPhase === 1 && lessonId && aiResult) {
    const newP1Count = (session.nodeAttemptCount ?? 0) + 1;
    const PHASE1_CAP = 5;
    if (newP1Count >= PHASE1_CAP) {
      // Auto-advance Phase 1 → 2; assign currentNodeId to the first lesson node
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
          nodeAttemptCount: 0,
          askedQuestionTemplates: [],
          currentNodeId: firstNode?.id ?? null,
          nodeStartedAt: firstNode ? new Date() : null,
        })
        .where(eq(lessonSessionsTable.id, session.id));
      logger.info({ lessonId, sessionId: session.id }, "P7: Phase 1 cap reached — auto-advanced to Phase 2");
    } else {
      await db
        .update(lessonSessionsTable)
        .set({ nodeAttemptCount: newP1Count })
        .where(eq(lessonSessionsTable.id, session.id));
    }
  }

  // ── Record evidence event (fire-and-forget) ───────────────────────────────
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

  // ── Store assistant message ───────────────────────────────────────────────
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

// ── GET /chat/history ─────────────────────────────────────────────────────────

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
