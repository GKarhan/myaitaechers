import { Router } from "express";
import {
  db, chatMessagesTable, lessonsTable, lessonSessionsTable,
  evidenceEventsTable, knowledgeNodesTable, lessonNodesTable, lessonExercisesTable,
} from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import {
  callAI, callAIStructured,
  type ChatMessage, type AIStructuredResponse, type ProgressIndicator,
} from "../services/ai";
import { updateTopicScoring } from "../services/scoring";
import { getDueReviewTopics } from "../services/review-schedule";
import { logger } from "../lib/logger";

const router = Router();

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
  let progressIndicator: ProgressIndicator = {
    current_node_name: "",
    step: 0,
    total_steps: 0,
    completed_nodes: 0,
    total_nodes: 0,
  };

  type SessionRef = { id: number; currentPhase: number; currentNodeId: number | null; status: string };
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
        };
        sessionId = sessionRow.id;
      }

      const phase        = session?.currentPhase ?? 1;
      const subjectName  = (lesson as { subjectName?: string }).subjectName ?? "Subject";
      const coreProblem  = (lesson as { coreProblem?: string | null }).coreProblem ?? null;
      const coreIdea     = (lesson as { coreIdea?: string | null }).coreIdea ?? null;

      // All nodes for this lesson (for progress computation)
      const allNodes = await db
        .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
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

      lessonContext = [
        `LESSON: «${lesson.title}»`,
        `SUBJECT: ${subjectName}`,
        currentNodeRecord
          ? `CURRENT_NODE: «${currentNodeRecord.title}» (Bloom ${currentNodeRecord.targetBloomLevel}, ~${currentNodeRecord.estimatedMinutes} min)`
          : "",
        coreProblem ? `CORE_PROBLEM: ${coreProblem}` : "",
        coreIdea    ? `CORE_IDEA: ${coreIdea}`       : "",
        `PHASE: ${phase} | PROGRESS: node ${currentNodeSeq}/${totalNodes} | completed: ${completedNodes}/${totalNodes}`,
        currentNodeRecord?.theoryContent ? `NODE_THEORY:\n${currentNodeRecord.theoryContent}` : "",
        cfeBlock,
        examplesBlock,
        misconceptionBlock,
        exBlock,
        dueReviewsLine,
        ``,
        `=== PHASE ${phase} GUIDANCE ===`,
        buildPhaseGuidance(phase, topicName, subjectName),
      ].filter(Boolean).join("\n");

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

      // ── Mastery gate check ───────────────────────────────────────────────
      const modelSaysComplete = aiResult.node_decision.action === "COMPLETE_NODE";
      const codeGate =
        newMasteryCount >= 2 &&
        (quality === "STRONG" || quality === "CONCLUSIVE") &&
        newConsecIncorrect < 2;
      const safetyCapHit = newAttemptCount > 6;

      if (safetyCapHit || (modelSaysComplete && codeGate)) {
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
