import { Router } from "express";
import {
  db,
  quizzesTable,
  quizQuestionsTable,
  quizAssignmentsTable,
  quizAttemptsTable,
  quizAnswersTable,
  quizLessonLinksTable,
  classStudentsTable,
  lessonNodesTable,
  lessonsTable,
  knowledgeNodesTable,
  evidenceEventsTable,
  lessonNodeCognitiveLevelsTable,
  usersTable,
  reviewScheduleTable,
  lessonNodeDependenciesTable,
} from "@workspace/db";
import { updateTopicScoring } from "../services/scoring";
import { eq, and, asc, inArray, desc, sql, count, ne } from "drizzle-orm";
import { requireAuth, requireTeacher, type AuthRequest } from "../middlewares/auth";
import { generateQuizQuestions } from "../services/quiz-generation";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Helper: wraps an async route handler so unhandled rejections are forwarded
// to Express's error-handler pipeline (next(err)) instead of crashing the
// process.  Express 4 does NOT catch async errors automatically.
// ---------------------------------------------------------------------------
import type { Request, Response, NextFunction } from "express";
type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
function asyncHandler(fn: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

import {
  getMasteryLevelFromScores,
  getPersonalizedNextAction,
  recommendationPriority,
  type MasteryLevel,
  type PersonalizedNextAction,
} from "../lib/mastery";

const router = Router();

// ── Shared helper: build per-question + node breakdown + recommendations ──────
// Used by both /my-result (student) and /results/:studentId (teacher view).
// Fetches lesson_nodes for explanation fallback and knowledge_nodes for current
// KT state. If KN row not yet written (fire-and-forget still in flight), falls
// back to a direct approximation from the quiz answers.
async function buildStudentResultAnalysis(
  attemptId: number,
  studentId: number,
) {
  // Per-question answers joined to question content
  const rawAnswers = await db
    .select({
      questionId:          quizQuestionsTable.id,
      questionText:        quizQuestionsTable.questionText,
      options:             quizQuestionsTable.options,
      correctOptionIndex:  quizQuestionsTable.correctOptionIndex,
      selectedOptionIndex: quizAnswersTable.selectedOptionIndex,
      isCorrect:           quizAnswersTable.isCorrect,
      sequence:            quizQuestionsTable.sequence,
      nodeId:              quizQuestionsTable.nodeId,
      optionExplanations:  quizQuestionsTable.optionExplanations,
    })
    .from(quizAnswersTable)
    .innerJoin(quizQuestionsTable, eq(quizQuestionsTable.id, quizAnswersTable.questionId))
    .where(eq(quizAnswersTable.attemptId, attemptId))
    .orderBy(asc(quizQuestionsTable.sequence));

  // Distinct nodeIds (skip nulls — questions without a node mapping)
  const nodeIds = [
    ...new Set(rawAnswers.map((a) => a.nodeId).filter((id): id is number => id !== null)),
  ];

  // lesson_nodes — for title + explanation fallback (spec priority #2)
  // Priority: childFriendlyExplanation → commonMisconception → null (no fabrication)
  const lessonNodeRows =
    nodeIds.length > 0
      ? await db
          .select({
            id:                       lessonNodesTable.id,
            title:                    lessonNodesTable.title,
            childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
            commonMisconception:      lessonNodesTable.commonMisconception,
          })
          .from(lessonNodesTable)
          .where(inArray(lessonNodesTable.id, nodeIds))
      : [];
  const lnMap = new Map(lessonNodeRows.map((n) => [n.id, n]));

  // knowledge_nodes + review_schedule — for current KT mastery state, needs_review
  // detection (dueAt), and provisional flag (isProvisional).
  const knRows =
    nodeIds.length > 0
      ? await db
          .select({
            id:              knowledgeNodesTable.id,
            lessonNodeId:    knowledgeNodesTable.lessonNodeId,
            masteryScore:    knowledgeNodesTable.masteryScore,
            confidenceScore: knowledgeNodesTable.confidenceScore,
            isProvisional:   knowledgeNodesTable.isProvisional,
            dueAt:           reviewScheduleTable.dueAt,
          })
          .from(knowledgeNodesTable)
          .leftJoin(
            reviewScheduleTable,
            and(
              eq(reviewScheduleTable.topicId, knowledgeNodesTable.id),
              eq(reviewScheduleTable.userId, studentId),
            ),
          )
          .where(
            and(
              eq(knowledgeNodesTable.userId, studentId),
              inArray(knowledgeNodesTable.lessonNodeId, nodeIds),
            ),
          )
      : [];
  const knMap = new Map(knRows.map((r) => [r.lessonNodeId!, r]));

  // Build enriched question list
  const questions = rawAnswers.map((a) => {
    const ln = a.nodeId != null ? lnMap.get(a.nodeId) : null;
    return {
      questionId:          a.questionId,
      questionText:        a.questionText,
      options:             a.options,
      correctOptionIndex:  a.correctOptionIndex,
      selectedOptionIndex: a.selectedOptionIndex,
      isCorrect:           a.isCorrect,
      sequence:            a.sequence,
      nodeId:              a.nodeId ?? null,
      nodeTitle:           ln?.title ?? null,
      // feedback: question-specific, option-specific (PART 3.5 Model C)
      // Primary source: quiz_questions.option_explanations[] (index-aligned with options[])
      //   whyCorrect = option_explanations[correctOptionIndex]
      //   whyWrong   = option_explanations[selectedOptionIndex]  (null when isCorrect=true)
      // No fallback to node-level fields — null means null, never fabricate.
      feedback: (() => {
        const expl = Array.isArray(a.optionExplanations) ? a.optionExplanations as (string | null)[] : null;
        const whyCorrect = expl?.[a.correctOptionIndex] ?? null;
        const whyWrong   = (!a.isCorrect && expl != null) ? (expl[a.selectedOptionIndex] ?? null) : null;
        return { whyCorrect, whyWrong };
      })(),
      errorState:          a.isCorrect ? ("correct" as const) : ("wrong" as const),
    };
  });

  // Per-node answer aggregation
  const nodeAgg = new Map<number, { total: number; correct: number; nodeTitle: string }>();
  for (const a of rawAnswers) {
    if (a.nodeId == null) continue;
    if (!nodeAgg.has(a.nodeId)) {
      const ln = lnMap.get(a.nodeId);
      nodeAgg.set(a.nodeId, { total: 0, correct: 0, nodeTitle: ln?.title ?? `Node ${a.nodeId}` });
    }
    const agg = nodeAgg.get(a.nodeId)!;
    agg.total++;
    if (a.isCorrect) agg.correct++;
  }

  // Node breakdown: KT state (incl. needs_review via dueAt) + provisional + personalized action
  const nodeBreakdown = [...nodeAgg.entries()].map(([nodeId, agg]) => {
    const kn = knMap.get(nodeId);
    let masteryScore: number | null;
    let confidenceScore: number | null;
    let masteryLevel: MasteryLevel;
    let isProvisional = true; // safe default when KN row not yet written

    if (kn) {
      masteryScore    = kn.masteryScore;
      confidenceScore = kn.confidenceScore;
      isProvisional   = kn.isProvisional;
      // Pass dueAt so mastered+overdue nodes surface as needs_review
      masteryLevel    = getMasteryLevelFromScores(masteryScore, confidenceScore, kn.dueAt ?? null);
    } else {
      // KN row not yet written — approximate from quiz answers (fire-and-forget race)
      const correctRate = agg.total > 0 ? agg.correct / agg.total : 0;
      if (correctRate === 0)       { masteryLevel = "in_progress"; masteryScore = 0;                             confidenceScore = 10; }
      else if (correctRate >= 0.8) { masteryLevel = "mastered";    masteryScore = Math.round(correctRate * 100); confidenceScore = 90; }
      else                         { masteryLevel = "weak";         masteryScore = Math.round(correctRate * 100); confidenceScore = 70; }
    }

    const percent    = agg.total > 0 ? Math.round((agg.correct / agg.total) * 100) : 0;
    const nextAction = getPersonalizedNextAction({ masteryLevel, masteryScore });

    return {
      nodeId,
      nodeTitle:       agg.nodeTitle,
      total:           agg.total,
      correct:         agg.correct,
      incorrect:       agg.total - agg.correct,
      percent,
      masteryLevel,
      masteryScore,
      confidenceScore: kn?.confidenceScore ?? confidenceScore,
      isProvisional,
      nextAction,
    };
  });

  // ── Transitive prerequisite blocking ────────────────────────────────────────
  // Fetch ALL dependency rows (tiny table — safe to load completely).
  const allDeps = await db
    .select({
      fromNodeId: lessonNodeDependenciesTable.fromNodeId,
      toNodeId:   lessonNodeDependenciesTable.toNodeId,
    })
    .from(lessonNodeDependenciesTable);

  // Reverse adjacency: dependent lessonNodeId → [prereq lessonNodeId, ...]
  const prereqsOf = new Map<number, number[]>();
  for (const dep of allDeps) {
    if (!prereqsOf.has(dep.toNodeId)) prereqsOf.set(dep.toNodeId, []);
    prereqsOf.get(dep.toNodeId)!.push(dep.fromNodeId);
  }

  // BFS to find ALL transitive prerequisites for each quiz node
  const nodeTransitivePrereqs = new Map<number, Set<number>>();
  for (const nodeId of nodeAgg.keys()) {
    const visited = new Set<number>();
    const queue: number[] = [...(prereqsOf.get(nodeId) ?? [])];
    while (queue.length > 0) {
      const p = queue.shift()!;
      if (visited.has(p)) continue;
      visited.add(p);
      for (const pp of prereqsOf.get(p) ?? []) {
        if (!visited.has(pp)) queue.push(pp);
      }
    }
    nodeTransitivePrereqs.set(nodeId, visited);
  }

  // Collect prereq nodeIds not present in the current quiz — fetch their KN state
  const externalPrereqIds = new Set<number>();
  for (const prereqs of nodeTransitivePrereqs.values()) {
    for (const p of prereqs) {
      if (!knMap.has(p)) externalPrereqIds.add(p);
    }
  }

  type ExtPrereqData = { masteryScore: number | null; confidenceScore: number | null; dueAt: Date | null };
  const externalPrereqMap = new Map<number, ExtPrereqData>();
  if (externalPrereqIds.size > 0) {
    const extRows = await db
      .select({
        lessonNodeId:    knowledgeNodesTable.lessonNodeId,
        masteryScore:    knowledgeNodesTable.masteryScore,
        confidenceScore: knowledgeNodesTable.confidenceScore,
        dueAt:           reviewScheduleTable.dueAt,
      })
      .from(knowledgeNodesTable)
      .leftJoin(
        reviewScheduleTable,
        and(
          eq(reviewScheduleTable.topicId, knowledgeNodesTable.id),
          eq(reviewScheduleTable.userId, studentId),
        ),
      )
      .where(
        and(
          eq(knowledgeNodesTable.userId, studentId),
          inArray(knowledgeNodesTable.lessonNodeId, [...externalPrereqIds]),
        ),
      );
    for (const r of extRows) {
      if (r.lessonNodeId != null)
        externalPrereqMap.set(r.lessonNodeId, {
          masteryScore:    r.masteryScore,
          confidenceScore: r.confidenceScore,
          dueAt:           r.dueAt ?? null,
        });
    }
  }

  // A prereq is "unblocking" only when its mastery level is exactly "mastered".
  // needs_review (overdue) also blocks — the student's retention is at risk.
  function isPrereqMastered(prereqNodeId: number): boolean {
    const knEntry = knMap.get(prereqNodeId);
    if (knEntry) {
      return getMasteryLevelFromScores(knEntry.masteryScore, knEntry.confidenceScore, knEntry.dueAt ?? null) === "mastered";
    }
    const ext = externalPrereqMap.get(prereqNodeId);
    if (ext) {
      return getMasteryLevelFromScores(ext.masteryScore, ext.confidenceScore, ext.dueAt) === "mastered";
    }
    return false; // Not found → treat as not_started → blocks the dependent
  }

  // Determine which unmastered prereqs are blocking each quiz node
  const blockingPrereqs = new Map<number, number[]>(); // nodeId → [unmastered prereq IDs]
  for (const nodeId of nodeAgg.keys()) {
    const prereqs = nodeTransitivePrereqs.get(nodeId) ?? new Set<number>();
    const blocking = [...prereqs].filter(p => !isPrereqMastered(p));
    blockingPrereqs.set(nodeId, blocking);
  }
  // ── End transitive prerequisite blocking ────────────────────────────────────

  // Recommendations: unblocked first (by urgency priority), then blocked (by urgency)
  const recommendations = [...nodeBreakdown]
    .sort((a, b) => {
      const aBlocked = (blockingPrereqs.get(a.nodeId)?.length ?? 0) > 0;
      const bBlocked = (blockingPrereqs.get(b.nodeId)?.length ?? 0) > 0;
      if (!aBlocked && bBlocked) return -1; // unblocked before blocked
      if (aBlocked && !bBlocked) return 1;
      // Within same group: priority then nodeId (deterministic tie-break)
      const pa = recommendationPriority(a.masteryLevel, a.masteryScore);
      const pb = recommendationPriority(b.masteryLevel, b.masteryScore);
      return pa !== pb ? pa - pb : a.nodeId - b.nodeId;
    })
    .map((n, i) => ({
      priority:            i + 1,
      nodeId:              n.nodeId,
      nodeTitle:           n.nodeTitle,
      masteryLevel:        n.masteryLevel,
      masteryScore:        n.masteryScore,
      confidenceScore:     n.confidenceScore,
      nextAction:          n.nextAction,
      isProvisional:       n.isProvisional,
      prerequisiteBlocked: (blockingPrereqs.get(n.nodeId)?.length ?? 0) > 0,
      blockedBy:           blockingPrereqs.get(n.nodeId) ?? [],
    }));

  return { questions, nodeBreakdown, recommendations };
}

// ── POST /api/quizzes ─────────────────────────────────────────────────────────
// Create a DRAFT quiz, generate questions from the given lesson nodes, persist,
// then set status = GENERATED. Returns the full quiz with questions.
router.post("/quizzes", requireTeacher, asyncHandler(async (req: AuthRequest, res) => {
  const {
    subjectId,
    classId,
    sourceBookId,
    lessonIds,   // array of lesson ids — route maps to nodeIds internally
    nodeIds: explicitNodeIds,
    quizType: requestedQuizType,
    questionCount = 10,
    difficultyMode = "MIXED",
    title,
  } = req.body as {
    subjectId?: number;
    classId?: number;
    sourceBookId?: number;
    lessonIds?: number[];
    nodeIds?: number[];
    quizType?: string;
    questionCount?: number;
    difficultyMode?: string;
    title?: string;
  };

  if (!subjectId) {
    res.status(400).json({ error: "subjectId is required" });
    return;
  }
  if (questionCount < 1 || questionCount > 50) {
    res.status(400).json({ error: "questionCount must be between 1 and 50" });
    return;
  }
  if (!["SIMPLE", "MEDIUM", "HARD", "MIXED"].includes(difficultyMode)) {
    res.status(400).json({ error: "Invalid difficultyMode" });
    return;
  }
  if (requestedQuizType !== undefined && !["lesson", "summary"].includes(requestedQuizType)) {
    res.status(400).json({ error: "quizType must be 'lesson' or 'summary'" });
    return;
  }

  // Resolve nodeIds from lessonIds if not provided explicitly
  let resolvedNodeIds: number[] = explicitNodeIds ?? [];
  if (resolvedNodeIds.length === 0 && lessonIds && lessonIds.length > 0) {
    const nodes = await db
      .select({ id: lessonNodesTable.id })
      .from(lessonNodesTable)
      .where(inArray(lessonNodesTable.lessonId, lessonIds));
    resolvedNodeIds = nodes.map((n) => n.id);
  }

  if (resolvedNodeIds.length === 0) {
    res.status(400).json({ error: "No nodes found — provide lessonIds or nodeIds" });
    return;
  }

  // Phase 1.9: resolve authoritative lesson IDs for the relationship table.
  // If lessonIds were provided explicitly, use them directly.
  // If only nodeIds were provided (single-lesson node-scoped case), derive lesson.
  let resolvedLessonIds: number[] = lessonIds ?? [];
  if (resolvedLessonIds.length === 0 && resolvedNodeIds.length > 0) {
    const lessonRows = await db
      .selectDistinct({ lessonId: lessonNodesTable.lessonId })
      .from(lessonNodesTable)
      .where(inArray(lessonNodesTable.id, resolvedNodeIds));
    resolvedLessonIds = lessonRows.map((r) => r.lessonId).filter((id): id is number => id !== null);
  }

  // Validate all lesson IDs exist and belong to this teacher's authorized scope.
  if (resolvedLessonIds.length > 0) {
    const existingLessons = await db
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(inArray(lessonsTable.id, resolvedLessonIds));
    if (existingLessons.length !== resolvedLessonIds.length) {
      res.status(400).json({ error: "One or more lesson IDs not found" });
      return;
    }
  }

  // Phase 1.10: type-specific validation (after all lesson/node resolution is done).
  if (requestedQuizType === "lesson") {
    if (resolvedLessonIds.length !== 1) {
      res.status(400).json({ error: "Lesson Test requires exactly one lesson" });
      return;
    }
    // All explicit nodeIds must belong to the single selected lesson
    if (explicitNodeIds && explicitNodeIds.length > 0) {
      const lessonId = resolvedLessonIds[0];
      const validNodes = await db
        .select({ id: lessonNodesTable.id })
        .from(lessonNodesTable)
        .where(and(inArray(lessonNodesTable.id, explicitNodeIds), eq(lessonNodesTable.lessonId, lessonId)));
      if (validNodes.length !== explicitNodeIds.length) {
        res.status(400).json({ error: "One or more nodeIds do not belong to the selected lesson" });
        return;
      }
    }
  } else if (requestedQuizType === "summary") {
    if (resolvedLessonIds.length < 2) {
      res.status(400).json({ error: "Summary Test requires at least 2 lessons" });
      return;
    }
    // Summary tests cover whole lessons — manual node selection is not allowed
    if (explicitNodeIds && explicitNodeIds.length > 0) {
      res.status(400).json({ error: "Summary Test does not support manual node selection" });
      return;
    }
  }

  // Use explicit quizType if provided; otherwise derive from lesson count.
  // Do NOT infer a conflicting type and silently override the teacher's explicit choice.
  const derivedQuizType: string | null =
    requestedQuizType ??
    (resolvedLessonIds.length === 1 ? "lesson"
    : resolvedLessonIds.length  >  1 ? "summary"
    : null); // no lesson linkage (edge case — book-only or free-form)

  // Create DRAFT quiz
  const quizTitle = title?.trim() || `Թեստ — ${new Date().toLocaleDateString("hy-AM")}`;
  const [quiz] = await db
    .insert(quizzesTable)
    .values({
      teacherId:    req.userId!,
      subjectId,
      classId:      classId ?? null,
      sourceBookId: sourceBookId ?? null,
      nodeIds:      resolvedNodeIds,
      title:        quizTitle,
      questionCount,
      difficultyMode,
      status:       "DRAFT",
      quizType:     derivedQuizType,
    })
    .returning();

  // Persist lesson relationships immediately so the lesson card can show this
  // quiz even before generation completes (avoids partial state on rollback too
  // because the quiz delete in the catch block cascades to links).
  if (resolvedLessonIds.length > 0) {
    await db
      .insert(quizLessonLinksTable)
      .values(resolvedLessonIds.map((lid) => ({ quizId: quiz.id, lessonId: lid })))
      .onConflictDoNothing(); // idempotent
  }

  try {
    // Generate questions via AI
    const generated = await generateQuizQuestions({
      nodeIds:       resolvedNodeIds,
      questionCount,
      difficultyMode: difficultyMode as "SIMPLE" | "MEDIUM" | "HARD" | "MIXED",
    });

    // Persist questions
    if (generated.length > 0) {
      await db.insert(quizQuestionsTable).values(
        generated.map((q, i) => ({
          quizId:              quiz.id,
          nodeId:              q.nodeId,
          questionText:        q.questionText,
          options:             q.options,
          correctOptionIndex:  q.correctOptionIndex,
          difficultyLevel:     q.difficultyLevel,
          sequence:            i + 1,
          optionExplanations:  (q.optionExplanations?.map(s => s ?? "") ?? null),
        }))
      );
    }

    // Mark GENERATED
    await db
      .update(quizzesTable)
      .set({ status: "GENERATED", updatedAt: new Date() })
      .where(eq(quizzesTable.id, quiz.id));

    // Return full quiz
    const questions = await db
      .select()
      .from(quizQuestionsTable)
      .where(eq(quizQuestionsTable.quizId, quiz.id))
      .orderBy(asc(quizQuestionsTable.sequence));

    res.status(201).json({
      id:             quiz.id,
      title:          quizTitle,
      subjectId:      quiz.subjectId,
      questionCount:  generated.length,
      difficultyMode: quiz.difficultyMode,
      status:         "GENERATED",
      questions:      questions.map((q) => ({
        id:                 q.id,
        nodeId:             q.nodeId,
        questionText:       q.questionText,
        options:            q.options,
        correctOptionIndex: q.correctOptionIndex,
        difficultyLevel:    q.difficultyLevel,
        sequence:           q.sequence,
      })),
    });
  } catch (err) {
    // Roll back the DRAFT record so the teacher can retry cleanly.
    // Guard the delete so that a secondary DB failure does NOT re-throw
    // (which would cause asyncHandler to call next(err) after headers were
    // potentially already sent, or produce a double-response).
    try {
      await db.delete(quizzesTable).where(eq(quizzesTable.id, quiz.id));
    } catch (deleteErr) {
      logger.error({ err: deleteErr, quizId: quiz.id }, "failed to rollback DRAFT quiz");
    }
    logger.error({ err, quizId: quiz.id }, "quiz generation failed — DRAFT deleted");
    if (!res.headersSent) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Quiz generation failed, please retry",
      });
    }
  }
}));

// ── GET /api/quizzes ──────────────────────────────────────────────────────────
// List quizzes for a subject (teacher-owned). Query: ?subjectId=X
// Returns [{ id, title, status, questionCount, classId, createdAt, sequenceNumber,
//            completedCount, totalAssigned, averageScorePercent }], newest first.
// sequenceNumber is stable: earliest-created quiz = 1, next = 2, …
router.get("/quizzes", requireTeacher, async (req: AuthRequest, res) => {
  const subjectId = parseInt(String(req.query.subjectId), 10);
  if (isNaN(subjectId)) {
    res.status(400).json({ error: "subjectId query param is required" });
    return;
  }

  // Fetch id-ASC so we can assign stable 1-based sequence numbers.
  const quizzes = await db
    .select({
      id:            quizzesTable.id,
      title:         quizzesTable.title,
      status:        quizzesTable.status,
      questionCount: quizzesTable.questionCount,
      classId:       quizzesTable.classId,
      createdAt:     quizzesTable.createdAt,
    })
    .from(quizzesTable)
    .where(and(
      eq(quizzesTable.subjectId, subjectId),
      eq(quizzesTable.teacherId, req.userId!)
    ))
    .orderBy(asc(quizzesTable.id));   // id ASC = creation order for ranking

  // Assign sequenceNumber (1-based, stable), then re-sort newest-first for display.
  const ranked = quizzes.map((q, i) => ({ ...q, sequenceNumber: i + 1 }));
  ranked.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  if (ranked.length === 0) {
    res.json([]);
    return;
  }

  const quizIds = ranked.map((q) => q.id);

  // Assignment stats: totalAssigned + completedCount per quizId
  const assignStats = await db
    .select({
      quizId:         quizAssignmentsTable.quizId,
      totalAssigned:  sql<number>`cast(count(*) as integer)`,
      completedCount: sql<number>`cast(count(*) filter (where ${quizAssignmentsTable.status} = 'COMPLETED') as integer)`,
    })
    .from(quizAssignmentsTable)
    .where(inArray(quizAssignmentsTable.quizId, quizIds))
    .groupBy(quizAssignmentsTable.quizId);

  // Average score per quizId (only for completed attempts)
  const scoreStats = await db
    .select({
      quizId:              quizAssignmentsTable.quizId,
      averageScorePercent: sql<number | null>`round(avg(${quizAttemptsTable.scorePercent}))`,
    })
    .from(quizAttemptsTable)
    .innerJoin(quizAssignmentsTable, eq(quizAssignmentsTable.id, quizAttemptsTable.quizAssignmentId))
    .where(inArray(quizAssignmentsTable.quizId, quizIds))
    .groupBy(quizAssignmentsTable.quizId);

  const assignMap = new Map(assignStats.map((s) => [s.quizId, s]));
  const scoreMap  = new Map(scoreStats.map((s) => [s.quizId, s]));

  res.json(ranked.map((q) => ({
    ...q,
    createdAt:           q.createdAt.toISOString(),
    totalAssigned:       assignMap.get(q.id)?.totalAssigned       ?? 0,
    completedCount:      assignMap.get(q.id)?.completedCount      ?? 0,
    averageScorePercent: scoreMap.get(q.id)?.averageScorePercent  ?? null,
  })));
});

// ── GET /api/quizzes/all ──────────────────────────────────────────────────────
// Teacher: every quiz created by this teacher, across all subjects/classes.
// Returns same shape as GET /quizzes but adds subjectId, className.
// MUST be declared before /quizzes/:id to avoid "all" matching as an id.
router.get("/quizzes/all", requireTeacher, async (req: AuthRequest, res) => {
  const { classesTable } = await import("@workspace/db");

  const quizzes = await db
    .select({
      id:            quizzesTable.id,
      title:         quizzesTable.title,
      status:        quizzesTable.status,
      questionCount: quizzesTable.questionCount,
      classId:       quizzesTable.classId,
      subjectId:     quizzesTable.subjectId,
      createdAt:     quizzesTable.createdAt,
      className:     classesTable.name,
    })
    .from(quizzesTable)
    .leftJoin(classesTable, eq(classesTable.id, quizzesTable.classId))
    .where(eq(quizzesTable.teacherId, req.userId!))
    .orderBy(asc(quizzesTable.id));

  const ranked = quizzes.map((q, i) => ({ ...q, sequenceNumber: i + 1 }));
  ranked.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  if (ranked.length === 0) { res.json([]); return; }

  const quizIds = ranked.map((q) => q.id);

  const assignStats = await db
    .select({
      quizId:         quizAssignmentsTable.quizId,
      totalAssigned:  sql<number>`cast(count(*) as integer)`,
      completedCount: sql<number>`cast(count(*) filter (where ${quizAssignmentsTable.status} = 'COMPLETED') as integer)`,
    })
    .from(quizAssignmentsTable)
    .where(inArray(quizAssignmentsTable.quizId, quizIds))
    .groupBy(quizAssignmentsTable.quizId);

  const scoreStats = await db
    .select({
      quizId:              quizAssignmentsTable.quizId,
      averageScorePercent: sql<number | null>`round(avg(${quizAttemptsTable.scorePercent}))`,
    })
    .from(quizAttemptsTable)
    .innerJoin(quizAssignmentsTable, eq(quizAssignmentsTable.id, quizAttemptsTable.quizAssignmentId))
    .where(inArray(quizAssignmentsTable.quizId, quizIds))
    .groupBy(quizAssignmentsTable.quizId);

  const assignMap = new Map(assignStats.map((s) => [s.quizId, s]));
  const scoreMap  = new Map(scoreStats.map((s) => [s.quizId, s]));

  res.json(ranked.map((q) => ({
    ...q,
    createdAt:           q.createdAt.toISOString(),
    totalAssigned:       assignMap.get(q.id)?.totalAssigned       ?? 0,
    completedCount:      assignMap.get(q.id)?.completedCount      ?? 0,
    averageScorePercent: scoreMap.get(q.id)?.averageScorePercent  ?? null,
  })));
});

// ── GET /api/quizzes/assigned ─────────────────────────────────────────────────
// Student: list all quiz assignments for the current user. Newest first.
// Now includes attempt data (totalCorrect, totalQuestions, scorePercent) for
// COMPLETED assignments via a LEFT JOIN on quiz_attempts.
// MUST be declared before /quizzes/:id to avoid "assigned" matching as an id.
router.get("/quizzes/assigned", requireAuth, async (req: AuthRequest, res) => {
  const rows = await db
    .select({
      assignmentId:   quizAssignmentsTable.id,
      quizId:         quizzesTable.id,
      title:          quizzesTable.title,
      subjectId:      quizzesTable.subjectId,
      status:         quizAssignmentsTable.status,
      assignedAt:     quizAssignmentsTable.assignedAt,
      dueAt:          quizAssignmentsTable.dueAt,
      totalCorrect:   quizAttemptsTable.totalCorrect,
      totalQuestions: quizAttemptsTable.totalQuestions,
      scorePercent:   quizAttemptsTable.scorePercent,
    })
    .from(quizAssignmentsTable)
    .innerJoin(quizzesTable, eq(quizzesTable.id, quizAssignmentsTable.quizId))
    .leftJoin(quizAttemptsTable, eq(quizAttemptsTable.quizAssignmentId, quizAssignmentsTable.id))
    .where(eq(quizAssignmentsTable.studentId, req.userId!))
    .orderBy(desc(quizAssignmentsTable.assignedAt));

  res.json(rows.map((r) => ({
    ...r,
    assignedAt:     r.assignedAt.toISOString(),
    dueAt:          r.dueAt?.toISOString() ?? null,
    totalCorrect:   r.totalCorrect   ?? null,
    totalQuestions: r.totalQuestions ?? null,
    scorePercent:   r.scorePercent   ?? null,
  })));
});

// ── GET /api/quizzes/:id/results ──────────────────────────────────────────────
// Teacher: per-student results for a quiz. Completed ones sorted worst-score-first;
// not-completed ones at the bottom.
router.get("/quizzes/:id/results", requireTeacher, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  // Verify ownership
  const [quiz] = await db
    .select({ id: quizzesTable.id })
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  const rows = await db
    .select({
      assignmentId:     quizAssignmentsTable.id,
      studentId:        usersTable.id,
      studentName:      usersTable.fullName,
      assignmentStatus: quizAssignmentsTable.status,
      totalCorrect:     quizAttemptsTable.totalCorrect,
      totalQuestions:   quizAttemptsTable.totalQuestions,
      scorePercent:     quizAttemptsTable.scorePercent,
      completedAt:      quizAttemptsTable.completedAt,
    })
    .from(quizAssignmentsTable)
    .innerJoin(usersTable,        eq(usersTable.id,        quizAssignmentsTable.studentId))
    .leftJoin(quizAttemptsTable,  eq(quizAttemptsTable.quizAssignmentId, quizAssignmentsTable.id))
    .where(eq(quizAssignmentsTable.quizId, quizId));

  // Sort: completed worst-score-first; non-completed at the bottom
  rows.sort((a, b) => {
    const aComp = a.assignmentStatus === "COMPLETED";
    const bComp = b.assignmentStatus === "COMPLETED";
    if (aComp && !bComp) return -1;
    if (!aComp && bComp) return 1;
    if (aComp && bComp) return (a.scorePercent ?? 100) - (b.scorePercent ?? 100);
    return 0;
  });

  res.json(rows.map((r) => ({
    assignmentId:   r.assignmentId,
    studentId:      r.studentId,
    studentName:    r.studentName,
    status:         r.assignmentStatus,
    totalCorrect:   r.totalCorrect   ?? null,
    totalQuestions: r.totalQuestions ?? null,
    scorePercent:   r.scorePercent   ?? null,
    completedAt:    r.completedAt?.toISOString() ?? null,
  })));
});

// ── GET /api/quizzes/:id/results/:studentId ───────────────────────────────────
// Teacher: full per-question result + node breakdown + recommendations for a student.
router.get("/quizzes/:id/results/:studentId", requireTeacher, async (req: AuthRequest, res) => {
  const quizId    = parseInt(String(req.params.id),        10);
  const studentId = parseInt(String(req.params.studentId), 10);
  if (isNaN(quizId) || isNaN(studentId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const [quiz] = await db
    .select({ id: quizzesTable.id })
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  const [assignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,     quizId),
      eq(quizAssignmentsTable.studentId,  studentId),
      eq(quizAssignmentsTable.status,     "COMPLETED")
    ))
    .limit(1);
  if (!assignment) {
    res.status(404).json({ error: "No completed attempt found for this student" }); return;
  }

  const [attempt] = await db
    .select()
    .from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.quizAssignmentId, assignment.id))
    .limit(1);
  if (!attempt) {
    res.status(404).json({ error: "Attempt record not found" }); return;
  }

  const { questions, nodeBreakdown, recommendations } =
    await buildStudentResultAnalysis(attempt.id, studentId);

  res.json({
    studentId,
    totalCorrect:   attempt.totalCorrect,
    totalQuestions: attempt.totalQuestions,
    scorePercent:   attempt.scorePercent,
    questions,
    nodeBreakdown,
    recommendations,
  });
});

// ── GET /api/quizzes/:id/my-result ────────────────────────────────────────────
// Student: full per-question result + node breakdown + personalized recommendations.
router.get("/quizzes/:id/my-result", requireAuth, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  // Get the LATEST completed assignment (supports re-release history)
  const [assignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    quizId),
      eq(quizAssignmentsTable.studentId, req.userId!),
      eq(quizAssignmentsTable.status,    "COMPLETED"),
    ))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);
  if (!assignment) {
    res.status(404).json({ error: "No completed attempt found for this quiz" });
    return;
  }

  const [attempt] = await db
    .select()
    .from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.quizAssignmentId, assignment.id))
    .limit(1);
  if (!attempt) {
    res.status(404).json({ error: "Attempt record not found" });
    return;
  }

  const { questions, nodeBreakdown, recommendations } =
    await buildStudentResultAnalysis(attempt.id, req.userId!);

  res.json({
    totalCorrect:   attempt.totalCorrect,
    totalQuestions: attempt.totalQuestions,
    scorePercent:   attempt.scorePercent,
    questions,
    nodeBreakdown,
    recommendations,
  });
});

// ── GET /api/quizzes/:id ──────────────────────────────────────────────────────
// Full quiz record + ordered questions. Teacher-only.
router.get("/quizzes/:id", requireTeacher, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);

  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, quizId))
    .orderBy(asc(quizQuestionsTable.sequence));

  // Phase 1.9: include quizType and linked lesson IDs
  const links = await db
    .select({ lessonId: quizLessonLinksTable.lessonId })
    .from(quizLessonLinksTable)
    .where(eq(quizLessonLinksTable.quizId, quizId));

  res.json({
    id:             quiz.id,
    title:          quiz.title,
    subjectId:      quiz.subjectId,
    classId:        quiz.classId,
    sourceBookId:   quiz.sourceBookId,
    nodeIds:        quiz.nodeIds,
    questionCount:  questions.length,
    difficultyMode: quiz.difficultyMode,
    status:         quiz.status,
    quizType:       quiz.quizType ?? null,
    lessonIds:      links.map((l) => l.lessonId),
    createdAt:      quiz.createdAt.toISOString(),
    questions:      questions.map((q) => ({
      id:                 q.id,
      nodeId:             q.nodeId,
      questionText:       q.questionText,
      options:            q.options,
      correctOptionIndex: q.correctOptionIndex,
      difficultyLevel:    q.difficultyLevel,
      sequence:           q.sequence,
    })),
  });
});

// ── PATCH /api/quizzes/:id/questions/:questionId ──────────────────────────────
// Edit a single question (teacher review/edit capability).
router.patch("/quizzes/:id/questions/:questionId", requireTeacher, async (req: AuthRequest, res) => {
  const quizId     = parseInt(String(req.params.id),         10);
  const questionId = parseInt(String(req.params.questionId), 10);
  if (isNaN(quizId) || isNaN(questionId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  // Verify quiz ownership
  const [quiz] = await db
    .select({ id: quizzesTable.id })
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  const {
    questionText,
    options,
    correctOptionIndex,
    difficultyLevel,
  } = req.body as {
    questionText?:       string;
    options?:            string[];
    correctOptionIndex?: number;
    difficultyLevel?:    string;
  };

  const patch: Record<string, unknown> = {};
  if (questionText       !== undefined) patch.questionText       = questionText.trim();
  if (options            !== undefined) {
    if (!Array.isArray(options) || options.length !== 4) {
      res.status(400).json({ error: "options must be an array of exactly 4 strings" }); return;
    }
    patch.options = options;
  }
  if (correctOptionIndex !== undefined) {
    if (correctOptionIndex < 0 || correctOptionIndex > 3) {
      res.status(400).json({ error: "correctOptionIndex must be 0-3" }); return;
    }
    patch.correctOptionIndex = correctOptionIndex;
  }
  if (difficultyLevel !== undefined) {
    if (!["LOW", "MEDIUM", "HIGH"].includes(difficultyLevel)) {
      res.status(400).json({ error: "Invalid difficultyLevel" }); return;
    }
    patch.difficultyLevel = difficultyLevel;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No fields to update" }); return;
  }

  const [updated] = await db
    .update(quizQuestionsTable)
    .set(patch)
    .where(and(
      eq(quizQuestionsTable.id,     questionId),
      eq(quizQuestionsTable.quizId, quizId)
    ))
    .returning();

  if (!updated) { res.status(404).json({ error: "Question not found" }); return; }

  // Bump quiz updatedAt
  await db
    .update(quizzesTable)
    .set({ updatedAt: new Date() })
    .where(eq(quizzesTable.id, quizId));

  res.json({
    id:                 updated.id,
    questionText:       updated.questionText,
    options:            updated.options,
    correctOptionIndex: updated.correctOptionIndex,
    difficultyLevel:    updated.difficultyLevel,
    sequence:           updated.sequence,
  });
});

// ── POST /api/quizzes/:id/assign ──────────────────────────────────────────────
// Assign quiz to all students in a class. Creates one quiz_assignment row per
// student. Sets quiz.classId and quiz.status = ASSIGNED.
router.post("/quizzes/:id/assign", requireTeacher, async (req: AuthRequest, res) => {
  const quizId  = parseInt(String(req.params.id), 10);
  const { classId, dueAt } = req.body as { classId?: number; dueAt?: string };

  if (isNaN(quizId))    { res.status(400).json({ error: "Invalid quiz id" }); return; }
  if (!classId)         { res.status(400).json({ error: "classId is required" }); return; }

  // Verify quiz ownership
  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  // Get all students in the class
  const members = await db
    .select({ studentId: classStudentsTable.studentId })
    .from(classStudentsTable)
    .where(eq(classStudentsTable.classId, classId));

  if (members.length === 0) {
    res.status(400).json({ error: "No students found in this class" }); return;
  }

  const dueDate = dueAt ? new Date(dueAt) : null;

  // Create one assignment per student.
  // Skip students who already have an ACTIVE (ASSIGNED or IN_PROGRESS) assignment —
  // they cannot hold two concurrent open assignments for the same quiz.
  // Students with a COMPLETED assignment DO get a new row (re-release cycle).
  const existingAssignments = await db
    .select({ studentId: quizAssignmentsTable.studentId, status: quizAssignmentsTable.status })
    .from(quizAssignmentsTable)
    .where(eq(quizAssignmentsTable.quizId, quizId));
  const alreadyActiveAssigned = new Set(
    existingAssignments.filter((a) => a.status !== "COMPLETED").map((a) => a.studentId)
  );

  const newMembers = members.filter((m) => !alreadyActiveAssigned.has(m.studentId));
  if (newMembers.length > 0) {
    await db.insert(quizAssignmentsTable).values(
      newMembers.map((m) => ({
        quizId,
        studentId: m.studentId,
        dueAt:     dueDate ?? undefined,
        status:    "ASSIGNED" as const,
      }))
    );
  }

  // Update quiz
  await db
    .update(quizzesTable)
    .set({ classId, status: "ASSIGNED", updatedAt: new Date() })
    .where(eq(quizzesTable.id, quizId));

  res.json({
    quizId,
    classId,
    assignedCount: newMembers.length,
    alreadyAssigned: alreadyActiveAssigned.size,
  });
});

// ── GET /api/quizzes/:id/take ─────────────────────────────────────────────────
// Student: get questions for a quiz they are assigned to.
// Strips correctOptionIndex. Sets assignment status to IN_PROGRESS.
router.get("/quizzes/:id/take", requireAuth, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  // Verify assignment — get the LATEST non-completed assignment for this student.
  // With re-release, a student may have multiple rows; we want the newest active one.
  const [assignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    quizId),
      eq(quizAssignmentsTable.studentId, req.userId!),
      ne(quizAssignmentsTable.status,    "COMPLETED"),
    ))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);

  if (!assignment) {
    res.status(403).json({ error: "No assignment found for this quiz" });
    return;
  }

  // Get questions WITHOUT correctOptionIndex
  const questions = await db
    .select({
      id:             quizQuestionsTable.id,
      questionText:   quizQuestionsTable.questionText,
      options:        quizQuestionsTable.options,
      difficultyLevel: quizQuestionsTable.difficultyLevel,
      sequence:       quizQuestionsTable.sequence,
    })
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, quizId))
    .orderBy(asc(quizQuestionsTable.sequence));

  // Advance status ASSIGNED → IN_PROGRESS
  if (assignment.status === "ASSIGNED") {
    await db
      .update(quizAssignmentsTable)
      .set({ status: "IN_PROGRESS" })
      .where(eq(quizAssignmentsTable.id, assignment.id));
  }

  res.json({
    assignmentId:     assignment.id,
    assignmentStatus: assignment.status === "ASSIGNED" ? "IN_PROGRESS" : assignment.status,
    questions,
  });
});

// ── POST /api/quizzes/:id/submit ──────────────────────────────────────────────
// Student: submit answers for a quiz. Returns score.
// Body: { answers: [{ questionId, selectedOptionIndex }] }
router.post("/quizzes/:id/submit", requireAuth, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  const { answers } = req.body as {
    answers: { questionId: number; selectedOptionIndex: number }[];
  };

  if (!Array.isArray(answers) || answers.length === 0) {
    res.status(400).json({ error: "answers array is required" });
    return;
  }

  // Verify assignment — get the LATEST non-completed assignment for this student.
  // With re-release, a student may have multiple rows; we target the newest active one.
  const [assignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    quizId),
      eq(quizAssignmentsTable.studentId, req.userId!),
      ne(quizAssignmentsTable.status,    "COMPLETED"),
    ))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);

  if (!assignment) {
    // Either no assignment at all, or all assignments are completed (quiz already done)
    res.status(403).json({ error: "No active assignment found for this quiz" });
    return;
  }

  // Get all questions for scoring
  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, quizId));

  const questionMap = new Map(questions.map((q) => [q.id, q]));

  let totalCorrect = 0;
  const answerRows = answers.map((a) => {
    const q        = questionMap.get(a.questionId);
    const isCorrect = q ? a.selectedOptionIndex === q.correctOptionIndex : false;
    if (isCorrect) totalCorrect++;
    return {
      questionId:          a.questionId,
      selectedOptionIndex: a.selectedOptionIndex,
      isCorrect,
      nodeId:              q?.nodeId ?? null,
    };
  });

  const totalQuestions = answers.length;
  const scorePercent   = totalQuestions > 0
    ? Math.round((totalCorrect / totalQuestions) * 100)
    : 0;

  // Insert attempt (one per assignment, enforced by unique constraint)
  const [attempt] = await db
    .insert(quizAttemptsTable)
    .values({
      quizAssignmentId: assignment.id,
      completedAt:      new Date(),
      totalCorrect,
      totalQuestions,
      scorePercent,
    })
    .returning();

  // Insert per-answer rows
  await db.insert(quizAnswersTable).values(
    answerRows.map((a) => ({
      attemptId:           attempt.id,
      questionId:          a.questionId,
      selectedOptionIndex: a.selectedOptionIndex,
      isCorrect:           a.isCorrect,
      nodeId:              a.nodeId,
    }))
  );

  // Mark assignment COMPLETED
  await db
    .update(quizAssignmentsTable)
    .set({ status: "COMPLETED" })
    .where(eq(quizAssignmentsTable.id, assignment.id));

  res.json({ totalCorrect, totalQuestions, scorePercent });

  // ── Fire-and-forget: write evidence_events per answer, update scoring ─────
  // Same non-blocking pattern as chat.ts. Any failure here is logged but must
  // never affect the student's score (already sent above).
  const _studentId   = req.userId!;
  const _answerRows  = answerRows;      // capture before request scope expires
  const _quizId      = quizId;
  const _questionMap = questionMap;     // Phase 2B: needed for cognitive fields
  (async () => {
    // 1. Fetch the quiz's subjectId (not available in the handler above)
    const [quizRow] = await db
      .select({ subjectId: quizzesTable.subjectId })
      .from(quizzesTable)
      .where(eq(quizzesTable.id, _quizId))
      .limit(1);
    if (!quizRow?.subjectId) return;
    const quizSubjectId = quizRow.subjectId;

    // Collect distinct nodeIds (skip null — some questions may lack a node)
    const distinctNodeIds = [
      ...new Set(
        _answerRows
          .map((a) => a.nodeId)
          .filter((id): id is number => id !== null)
      ),
    ];

    for (const nodeId of distinctNodeIds) {
      try {
        // 2. Fetch the lesson_nodes row to get title + targetBloomLevel
        const [lessonNode] = await db
          .select({
            title:            lessonNodesTable.title,
            targetBloomLevel: lessonNodesTable.targetBloomLevel,
          })
          .from(lessonNodesTable)
          .where(eq(lessonNodesTable.id, nodeId))
          .limit(1);
        if (!lessonNode) {
          logger.warn({ nodeId }, "quiz evidence: lesson_nodes row not found, skipping");
          continue;
        }

        // 3. Find-or-create knowledge_nodes using lessonNodeId as primary key
        //    (NOT topicName-only — lessonNodeId is the stable FK from Step 1)
        let topicId: number | null = null;
        const [existingKN] = await db
          .select({ id: knowledgeNodesTable.id })
          .from(knowledgeNodesTable)
          .where(
            and(
              eq(knowledgeNodesTable.subjectId,    quizSubjectId),
              eq(knowledgeNodesTable.userId,        _studentId),
              eq(knowledgeNodesTable.lessonNodeId,  nodeId),
            )
          )
          .limit(1);

        if (existingKN) {
          topicId = existingKN.id;
        } else {
          const [newKN] = await db
            .insert(knowledgeNodesTable)
            .values({
              subjectId:    quizSubjectId,
              userId:       _studentId,
              topicName:    lessonNode.title,
              lessonNodeId: nodeId,
              status:       "not_started",
              isProvisional: true,
              bloomLevel:   lessonNode.targetBloomLevel ?? 1,
            })
            .returning({ id: knowledgeNodesTable.id });
          topicId = newKN?.id ?? null;
        }
        if (!topicId) continue;

        // 4. Insert one evidence_events row per answer belonging to this nodeId
        //    Phase 2B: also populate cognitive identity fields from quiz_questions.
        const nodeAnswers = _answerRows.filter((a) => a.nodeId === nodeId);

        // Collect distinct cognitiveLevelIds from this batch so we can resolve
        // the cognitive_level text in one query.
        const cogLevelIds = [
          ...new Set(
            nodeAnswers
              .map((a) => (_questionMap.get(a.questionId) as any)?.cognitiveLevelId)
              .filter((id): id is number => typeof id === "number")
          ),
        ];
        const cogLevelRows = cogLevelIds.length > 0
          ? await db
              .select({ id: lessonNodeCognitiveLevelsTable.id, cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel })
              .from(lessonNodeCognitiveLevelsTable)
              .where(inArray(lessonNodeCognitiveLevelsTable.id, cogLevelIds))
          : [];
        const cogLevelMap = new Map(cogLevelRows.map((r) => [r.id, r.cognitiveLevel]));

        await db.insert(evidenceEventsTable).values(
          nodeAnswers.map((a) => {
            const q = _questionMap.get(a.questionId) as any;
            const cogLevelId: number | null = q?.cognitiveLevelId ?? null;
            const cogLevelText = cogLevelId ? (cogLevelMap.get(cogLevelId) ?? null) : null;
            return {
              userId:          _studentId,
              lessonSessionId: null,
              topicId,
              eventType:       "answer",
              wasCorrect:      a.isCorrect,
              responseTimeMs:  null,
              hintUsed:        false,
              metadata:        { source: "quiz", quizId: _quizId, questionId: a.questionId },
              // Phase 2A fields
              cognitiveLevel:  cogLevelText,
              taskDifficulty:  q?.difficultyLevel ?? null,
              assistanceLevel: "none",
              // Phase 2B new fields
              lessonExerciseId: q?.sourceExerciseId ?? null,
              interactionType:  q?.interactionType ?? "multiple_choice",
              attemptSequence:  1,
              helpCount:        0,
            };
          }) as any[]
        );

        // 5. Recompute mastery/confidence for this topic (fire-and-forget within
        //    fire-and-forget — matches the pattern in chat.ts exactly)
        updateTopicScoring(topicId, _studentId, { quizId: _quizId }).catch((err) =>
          logger.error({ err, topicId, userId: _studentId }, "quiz evidence: scoring failed")
        );

      } catch (err) {
        logger.error({ err, nodeId, quizId: _quizId }, "quiz evidence: per-node block failed");
      }
    }
  })().catch((err) =>
    logger.error({ err, quizId: _quizId }, "quiz evidence: fire-and-forget wrapper failed")
  );
});

// ── GET /api/quizzes/:id/analysis ────────────────────────────────────────────
// Teacher: class-level common-error analysis + per-student weak-node breakdown.
// Common error = same wrong option chosen by ≥50% of participants on a question.
// MUST be declared before /quizzes/:id (DELETE) to avoid route ambiguity.
router.get("/quizzes/:id/analysis", requireTeacher, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  // Verify ownership
  const [quiz] = await db
    .select({ id: quizzesTable.id })
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  // All completed assignments + their attempt IDs + student names
  const completedRows = await db
    .select({
      studentId:   quizAssignmentsTable.studentId,
      studentName: usersTable.fullName,
      attemptId:   quizAttemptsTable.id,
    })
    .from(quizAssignmentsTable)
    .innerJoin(usersTable,       eq(usersTable.id,       quizAssignmentsTable.studentId))
    .innerJoin(quizAttemptsTable, eq(quizAttemptsTable.quizAssignmentId, quizAssignmentsTable.id))
    .where(eq(quizAssignmentsTable.quizId, quizId));

  const participantCount = completedRows.length;
  if (participantCount === 0) {
    res.json({ quizId, participantCount: 0, commonErrors: [],
      teacherRecommendations: { classLevel: [], individual: [] } });
    return;
  }

  const attemptIds = completedRows.map((r) => r.attemptId);
  const studentIds = [...new Set(completedRows.map((r) => r.studentId))];
  const attemptToStudent = new Map(completedRows.map((r) => [r.attemptId, r.studentId]));
  const studentInfo      = new Map(completedRows.map((r) => [r.studentId, r.studentName]));

  // All answers for completed attempts
  const allAnswers = await db
    .select({
      attemptId:           quizAnswersTable.attemptId,
      questionId:          quizAnswersTable.questionId,
      nodeId:              quizAnswersTable.nodeId,
      selectedOptionIndex: quizAnswersTable.selectedOptionIndex,
      isCorrect:           quizAnswersTable.isCorrect,
    })
    .from(quizAnswersTable)
    .where(inArray(quizAnswersTable.attemptId, attemptIds));

  // All questions for this quiz
  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, quizId))
    .orderBy(asc(quizQuestionsTable.sequence));
  const questionMap = new Map(questions.map((q) => [q.id, q]));

  // Distinct nodeIds across questions + answers
  const nodeIds = [
    ...new Set([
      ...questions.map((q) => q.nodeId).filter((id): id is number => id !== null),
      ...allAnswers.map((a) => a.nodeId).filter((id): id is number => id !== null),
    ]),
  ];

  const lessonNodeRows = nodeIds.length > 0
    ? await db
        .select({ id: lessonNodesTable.id, title: lessonNodesTable.title,
                  commonMisconception: lessonNodesTable.commonMisconception })
        .from(lessonNodesTable)
        .where(inArray(lessonNodesTable.id, nodeIds))
    : [];
  const lnMap = new Map(lessonNodeRows.map((n) => [n.id, n]));

  const knRows = nodeIds.length > 0 && studentIds.length > 0
    ? await db
        .select({
          userId:         knowledgeNodesTable.userId,
          lessonNodeId:   knowledgeNodesTable.lessonNodeId,
          masteryScore:   knowledgeNodesTable.masteryScore,
          confidenceScore: knowledgeNodesTable.confidenceScore,
        })
        .from(knowledgeNodesTable)
        .where(and(
          inArray(knowledgeNodesTable.userId,        studentIds),
          inArray(knowledgeNodesTable.lessonNodeId,  nodeIds),
        ))
    : [];
  const knMap = new Map(knRows.map((r) => [`${r.userId}_${r.lessonNodeId}`, r]));

  // ── Common Error Detection ─────────────────────────────────────────────────
  // Group answers by questionId
  const answersByQuestion = new Map<number, {
    selectedOptionIndex: number; isCorrect: boolean;
  }[]>();
  for (const a of allAnswers) {
    if (!answersByQuestion.has(a.questionId)) answersByQuestion.set(a.questionId, []);
    answersByQuestion.get(a.questionId)!.push({
      selectedOptionIndex: a.selectedOptionIndex,
      isCorrect: a.isCorrect,
    });
  }

  type CommonError = {
    questionId: number; questionText: string;
    nodeId: number | null; nodeTitle: string | null;
    wrongOptionIndex: number; wrongOptionText: string;
    wrongCount: number; wrongPercent: number;
    correctOptionIndex: number; correctOptionText: string;
    misconception: string | null;
  };
  const commonErrors: CommonError[] = [];

  for (const [questionId, ans] of answersByQuestion) {
    const q = questionMap.get(questionId);
    if (!q) continue;
    const participants = ans.length;
    // Tally wrong-option counts
    const wrongTally = new Map<number, number>();
    for (const a of ans) {
      if (!a.isCorrect) wrongTally.set(a.selectedOptionIndex, (wrongTally.get(a.selectedOptionIndex) ?? 0) + 1);
    }
    // Find dominant wrong option ≥50%
    let bestOpt = -1, bestCount = 0;
    for (const [opt, count] of wrongTally) {
      if (count > bestCount) { bestOpt = opt; bestCount = count; }
    }
    if (bestOpt >= 0 && (bestCount / participants) * 100 >= 50) {
      const opts = q.options as string[];
      const ln   = q.nodeId != null ? lnMap.get(q.nodeId) : null;
      commonErrors.push({
        questionId,
        questionText:       q.questionText,
        nodeId:             q.nodeId ?? null,
        nodeTitle:          ln?.title ?? null,
        wrongOptionIndex:   bestOpt,
        wrongOptionText:    opts[bestOpt] ?? "",
        wrongCount:         bestCount,
        wrongPercent:       Math.round((bestCount / participants) * 100),
        correctOptionIndex: q.correctOptionIndex,
        correctOptionText:  opts[q.correctOptionIndex] ?? "",
        misconception:      ln?.commonMisconception ?? null,
      });
    }
  }

  // ── Per-Student Weak Node Breakdown ───────────────────────────────────────
  // Aggregate (studentId, nodeId) → correct/total counts from answers
  const perStudentNode = new Map<string, { studentId: number; nodeId: number; correct: number; total: number }>();
  for (const a of allAnswers) {
    if (a.nodeId == null) continue;
    const sid = attemptToStudent.get(a.attemptId);
    if (sid == null) continue;
    const key = `${sid}_${a.nodeId}`;
    if (!perStudentNode.has(key)) perStudentNode.set(key, { studentId: sid, nodeId: a.nodeId, correct: 0, total: 0 });
    const agg = perStudentNode.get(key)!;
    agg.total++;
    if (a.isCorrect) agg.correct++;
  }

  const individualMap = new Map<number, { studentId: number; studentName: string; weakNodes: {
    nodeId: number; nodeTitle: string; masteryLevel: MasteryLevel;
    masteryScore: number | null; nextAction: PersonalizedNextAction;
  }[] }>();

  for (const agg of perStudentNode.values()) {
    const kn = knMap.get(`${agg.studentId}_${agg.nodeId}`);
    const ln = lnMap.get(agg.nodeId);
    let masteryLevel: MasteryLevel;
    let masteryScore: number | null;

    if (kn) {
      masteryScore  = kn.masteryScore;
      masteryLevel  = getMasteryLevelFromScores(kn.masteryScore, kn.confidenceScore);
    } else {
      const rate = agg.total > 0 ? agg.correct / agg.total : 0;
      if (rate === 0)      { masteryLevel = "in_progress"; masteryScore = 0; }
      else if (rate >= 0.8){ masteryLevel = "mastered";    masteryScore = Math.round(rate * 100); }
      else                 { masteryLevel = "weak";         masteryScore = Math.round(rate * 100); }
    }

    if (masteryLevel === "mastered") continue; // only surface nodes needing attention

    if (!individualMap.has(agg.studentId)) {
      individualMap.set(agg.studentId, {
        studentId:   agg.studentId,
        studentName: studentInfo.get(agg.studentId) ?? `Student ${agg.studentId}`,
        weakNodes:   [],
      });
    }
    individualMap.get(agg.studentId)!.weakNodes.push({
      nodeId:       agg.nodeId,
      nodeTitle:    ln?.title ?? `Node ${agg.nodeId}`,
      masteryLevel,
      masteryScore,
      nextAction:   getPersonalizedNextAction({ masteryLevel, masteryScore }),
    });
  }

  // Sort each student's nodes by priority
  const individual = [...individualMap.values()].map((s) => ({
    ...s,
    weakNodes: s.weakNodes.sort((a, b) =>
      recommendationPriority(a.masteryLevel, a.masteryScore) -
      recommendationPriority(b.masteryLevel, b.masteryScore)
    ),
  })).sort((a, b) => a.studentName.localeCompare(b.studentName));

  // Class-level: max error % per node across common errors
  const classLevelMap = new Map<number, { nodeTitle: string; commonErrorPercent: number }>();
  for (const ce of commonErrors) {
    if (ce.nodeId == null) continue;
    const prev = classLevelMap.get(ce.nodeId);
    if (!prev || ce.wrongPercent > prev.commonErrorPercent) {
      classLevelMap.set(ce.nodeId, { nodeTitle: ce.nodeTitle ?? `Node ${ce.nodeId}`, commonErrorPercent: ce.wrongPercent });
    }
  }
  const classLevel = [...classLevelMap.entries()]
    .map(([nodeId, v]) => ({ nodeId, nodeTitle: v.nodeTitle, commonErrorPercent: v.commonErrorPercent }))
    .sort((a, b) => b.commonErrorPercent - a.commonErrorPercent);

  res.json({
    quizId,
    participantCount,
    commonErrors,
    teacherRecommendations: { classLevel, individual },
  });
});

// ── DELETE /api/quizzes/:id ───────────────────────────────────────────────────
// Remove a teacher-owned quiz. The schema already cascades to quiz_questions,
// quiz_assignments, quiz_attempts, and quiz_answers automatically.
// ── POST /api/quizzes/:id/lessons/:lessonId — link a quiz to a lesson ─────────
// Idempotent (duplicate→ 200 with no DB change).
// Teacher must own the quiz; lesson must exist.
router.post("/quizzes/:id/lessons/:lessonId", requireTeacher, async (req: AuthRequest, res) => {
  const quizId   = parseInt(String(req.params.id),       10);
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(quizId) || isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid quiz id or lesson id" }); return;
  }

  const [quiz] = await db
    .select({ id: quizzesTable.id, quizType: quizzesTable.quizType })
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  // Verify lesson exists
  const [lesson] = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);
  if (!lesson) { res.status(400).json({ error: "Lesson not found" }); return; }

  // Check existing links to enforce Lesson Test constraint (≤1 lesson for type='lesson')
  if (quiz.quizType === "lesson") {
    const existingLinks = await db
      .select({ lessonId: quizLessonLinksTable.lessonId })
      .from(quizLessonLinksTable)
      .where(eq(quizLessonLinksTable.quizId, quizId));
    const alreadyLinked = existingLinks.some((l) => l.lessonId === lessonId);
    if (!alreadyLinked && existingLinks.length >= 1) {
      res.status(400).json({ error: "Lesson Test can only be linked to exactly one lesson" }); return;
    }
  }

  await db
    .insert(quizLessonLinksTable)
    .values({ quizId, lessonId })
    .onConflictDoNothing();

  res.json({ quizId, lessonId, linked: true });
});

// ── DELETE /api/quizzes/:id/lessons/:lessonId — unlink quiz from a lesson ─────
// Removes the relationship row only — quiz record is preserved.
router.delete("/quizzes/:id/lessons/:lessonId", requireTeacher, async (req: AuthRequest, res) => {
  const quizId   = parseInt(String(req.params.id),       10);
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(quizId) || isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid quiz id or lesson id" }); return;
  }

  const [quiz] = await db
    .select({ id: quizzesTable.id })
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  await db
    .delete(quizLessonLinksTable)
    .where(and(
      eq(quizLessonLinksTable.quizId,   quizId),
      eq(quizLessonLinksTable.lessonId, lessonId),
    ));

  res.json({ quizId, lessonId, unlinked: true });
});

// ── DELETE /api/quizzes/:id ───────────────────────────────────────────────────
router.delete("/quizzes/:id", requireTeacher, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  const [quiz] = await db
    .select({ id: quizzesTable.id, teacherId: quizzesTable.teacherId })
    .from(quizzesTable)
    .where(eq(quizzesTable.id, quizId))
    .limit(1);

  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }
  if (quiz.teacherId !== req.userId) {
    res.status(403).json({ error: "Not your quiz" }); return;
  }

  await db.delete(quizzesTable).where(eq(quizzesTable.id, quizId));
  res.status(204).send();
});

export default router;
