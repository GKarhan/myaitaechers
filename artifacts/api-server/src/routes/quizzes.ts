import { getQuizLearningProgress } from "../services/quiz-learning-progress.js";
import { filterAutomaticAssessmentScope } from "../services/quiz-session.js";
import { normalizeQuestionText } from "../services/quiz-question-quality.js";
import { resolveKnowledgeTreeStates } from "../services/knowledge-tree-state.js";
import { parseAssessmentConfig, resolveQuizGenerationMode, allocateNodeQuestions, aggregateAssessments } from "../services/node-assessment-policy.js";
import { Router } from "express";
import {
  db,
  quizzesTable,
  quizQuestionsTable,
  quizAssignmentsTable,
  quizAttemptsTable,
  quizAttemptQuestionsTable,
  quizAnswersTable,
  quizSessionsTable,
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
  lessonExercisesTable,
  quizGenerationJobsTable,
  coursesTable,
} from "@workspace/db";
import { updateTopicScoring } from "../services/scoring";
import { eq, and, asc, inArray, desc, sql, count, ne, isNull, isNotNull } from "drizzle-orm";
import { requireAuth, requireStudent, requireTeacher, type AuthRequest } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { assessAcceptedCognitivePath } from "../lib/cognitive-path-grounding.js";
import { classifyQualifyingEvidence } from "../lib/evidence-contract.js";
import { projectLearnerCognitiveCeiling } from "../services/learner-cognitive-ceiling.js";
import {
  parseRetestStrategy,
  resolveRetestEligibleNodes,
  RetestAuthorityError,
} from "../services/quiz-retest-authority.js";
import {
  createOrReuseQuizGenerationJob,
  normalizeQuizGenerationRequest,
  IdempotencyKeyReusedError,
  scheduleQuizGenerationJob,
} from "../services/quiz-generation-jobs.js";
import {
  createQuizFromNodeScope,
  QuizCanonicalTargetChangedError,
  QuizCanonicalTargetError,
} from "../services/quiz-creation.js";
import { QuizQuestionQualityError } from "../services/quiz-question-quality.js";
import {
  getOrCreateActiveAttempt,
  ensureQuizSession,
  presentAttemptQuestion,
  resolveQuizSessionProjection,
  scorePresentedAnswer,
} from "../services/quiz-session.js";
import {
  collapseToLatestCompletedAttempt,
  getLatestCompletedQuizScoreStats,
  summarizePracticeProgress,
} from "../services/quiz-reporting.js";

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

const COGNITIVE_LEVEL_LABELS: Record<string, string> = {
  remember: "Հիշել",
  understand: "Հասկանալ",
  apply: "Կիրառել",
  analyze: "Վերլուծել",
  evaluate: "Գնահատել",
  create: "Ստեղծել",
};

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
      nodeId:              sql<number | null>`coalesce(${quizAttemptQuestionsTable.nodeId}, ${quizAnswersTable.nodeId}, ${quizQuestionsTable.nodeId})`,
      optionExplanations:  quizQuestionsTable.optionExplanations,
      solutionExplanation: quizQuestionsTable.solutionExplanation,
      snapshotQuestionText: quizAttemptQuestionsTable.questionText,
      snapshotOptions: quizAttemptQuestionsTable.options,
      snapshotCorrectOptionIndex: quizAttemptQuestionsTable.correctOptionIndex,
      snapshotOptionExplanations: quizAttemptQuestionsTable.optionExplanations,
      snapshotSolutionExplanation: quizAttemptQuestionsTable.solutionExplanation,
      snapshotOptionOrder: quizAttemptQuestionsTable.optionOrder,
      selectedPresentationIndex: quizAnswersTable.selectedPresentationIndex,
      snapshotSequence: quizAttemptQuestionsTable.sequence,
    })
    .from(quizAnswersTable)
    .innerJoin(quizQuestionsTable, eq(quizQuestionsTable.id, quizAnswersTable.questionId))
    .leftJoin(
      quizAttemptQuestionsTable,
      and(
        eq(quizAttemptQuestionsTable.attemptId, attemptId),
        eq(quizAttemptQuestionsTable.questionId, quizAnswersTable.questionId),
      ),
    )
    .where(eq(quizAnswersTable.attemptId, attemptId))
    .orderBy(asc(quizQuestionsTable.sequence));

  const [attemptScope] = await db.select({config:quizzesTable.assessmentConfig,nodeIds:quizzesTable.nodeIds})
    .from(quizAttemptsTable).innerJoin(quizAssignmentsTable,eq(quizAssignmentsTable.id,quizAttemptsTable.quizAssignmentId))
    .innerJoin(quizzesTable,eq(quizzesTable.id,quizAssignmentsTable.quizId)).where(eq(quizAttemptsTable.id,attemptId)).limit(1);
  const fullNodeScope = parseAssessmentConfig(attemptScope?.config) && Array.isArray(attemptScope?.nodeIds)
    ? (attemptScope.nodeIds as number[]).filter(id=>Number.isInteger(id)&&id>0) : [];
  // Question review is attempt-specific; the independent node summary covers the root quiz.
  const nodeIds = [
    ...new Set([...fullNodeScope,...rawAnswers.map((a) => a.nodeId).filter((id): id is number => id !== null)]),
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
  const canonicalStates = await resolveKnowledgeTreeStates(studentId,nodeIds);

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
    const canonicalOptions = Array.isArray(a.snapshotOptions)
      ? a.snapshotOptions as string[]
      : Array.isArray(a.options) ? a.options as string[] : [];
    const optionOrder = Array.isArray(a.snapshotOptionOrder)
      ? a.snapshotOptionOrder as number[]
      : canonicalOptions.map((_, index) => index);
    const canonicalCorrect = a.snapshotCorrectOptionIndex ?? a.correctOptionIndex;
    const correctPresentationIndex = optionOrder.indexOf(canonicalCorrect);
    const selectedPresentationIndex = a.selectedPresentationIndex
      ?? optionOrder.indexOf(a.selectedOptionIndex);
    const explanations = a.snapshotOptionExplanations ?? a.optionExplanations;
    return {
      questionId:          a.questionId,
      questionText:        a.snapshotQuestionText ?? a.questionText,
      options:             optionOrder.map((index) => canonicalOptions[index]),
      correctOptionIndex:  correctPresentationIndex,
      selectedOptionIndex: selectedPresentationIndex,
      isCorrect:           a.isCorrect,
      sequence:            a.snapshotSequence ?? a.sequence,
      nodeId:              a.nodeId ?? null,
      nodeTitle:           ln?.title ?? null,
      // feedback: question-specific, option-specific (PART 3.5 Model C)
      // Primary source: quiz_questions.option_explanations[] (index-aligned with options[])
      //   whyCorrect = option_explanations[correctOptionIndex]
      //   whyWrong   = option_explanations[selectedOptionIndex]  (null when isCorrect=true)
      // No fallback to node-level fields — null means null, never fabricate.
      feedback: (() => {
        const expl = Array.isArray(explanations) ? explanations as (string | null)[] : null;
        const whyCorrect = expl?.[canonicalCorrect] ?? null;
        const whyWrong   = (!a.isCorrect && expl != null) ? (expl[a.selectedOptionIndex] ?? null) : null;
        return {
          whyCorrect,
          whyWrong,
          solutionExplanation: a.snapshotSolutionExplanation ?? a.solutionExplanation ?? null,
        };
      })(),
      errorState:          a.isCorrect ? ("correct" as const) : ("wrong" as const),
    };
  });

  // Per-node answer aggregation
  const nodeAgg = new Map<number, { total: number; correct: number; nodeTitle: string }>(fullNodeScope.map(id=>[id,{total:0,correct:0,nodeTitle:lnMap.get(id)?.title??`Node ${id}`} ]));
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

    const assessment = canonicalStates.get(nodeId)?.assessment;
    if (assessment && assessment.attempted > 0) {
      masteryScore = assessment.percent;
      masteryLevel = assessment.status === "SUCCESS" ? (kn?.dueAt && kn.dueAt < new Date() ? "needs_review" : "mastered")
        : assessment.correct ? "weak" : "in_progress";
      isProvisional = assessment.certainty !== "HIGH";
    }
    const percent    = agg.total > 0 ? Math.round((agg.correct / agg.total) * 100) : 0;
    const nextAction = getPersonalizedNextAction({ masteryLevel, masteryScore });

    return {
      nodeId,
      nodeTitle:       agg.nodeTitle,
      total:           agg.total,
      correct:         agg.correct,
      incorrect:       agg.total - agg.correct,
      percent: canonicalStates.get(nodeId)?.assessment?.percent ?? percent,
      masteryLevel,
      masteryScore,
      confidenceScore: kn?.confidenceScore ?? confidenceScore,
      isProvisional,
      assessment: canonicalStates.get(nodeId)?.assessment ?? null,
      knowledgeState: canonicalStates.get(nodeId)?.knowledgeState,
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
// Validate quiz generation. Idempotency-aware clients enqueue durable work;
// legacy clients retain the synchronous response until frontend polling lands.
router.post("/quizzes", requireTeacher, asyncHandler(async (req: AuthRequest, res) => {
  const {
    subjectId,
    classId,
    sourceBookId,
    lessonIds,   // array of lesson ids — route maps to nodeIds internally
    nodeIds: explicitNodeIds,
    quizType: requestedQuizType,
    assessmentConfig: requestedAssessmentConfig,
    generationMode: requestedGenerationMode,
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
    assessmentConfig?: unknown;
    generationMode?: "canonical" | "standard";
    questionCount?: number;
    difficultyMode?: string;
    title?: string;
  };

  const assessmentConfig = requestedAssessmentConfig == null ? undefined : parseAssessmentConfig(requestedAssessmentConfig);
  if (requestedAssessmentConfig != null && !assessmentConfig) { res.status(400).json({error:"INVALID_ASSESSMENT_CONFIG"}); return; }
  const generationMode=resolveQuizGenerationMode(requestedGenerationMode,assessmentConfig);
  if (!generationMode) {
    res.status(400).json({ error: "Invalid quiz generation mode" });
    return;
  }
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
  resolvedNodeIds = [...new Set(resolvedNodeIds)];
  if (assessmentConfig) {
    try { allocateNodeQuestions(resolvedNodeIds, questionCount); }
    catch { res.status(400).json({error:"QUESTION_COUNT_OUTSIDE_NODE_RANGE",min:resolvedNodeIds.length,max:Math.min(50,resolvedNodeIds.length*3)});return; }
  }

  resolvedNodeIds = [...new Set(resolvedNodeIds)];

  // Phase 1.9: resolve authoritative lesson IDs for the relationship table.
  // If lessonIds were provided explicitly, use them directly.
  // If only nodeIds were provided (single-lesson node-scoped case), derive lesson.
  let resolvedLessonIds: number[] = [...new Set(lessonIds ?? [])];
  if (resolvedLessonIds.length === 0 && resolvedNodeIds.length > 0) {
    const lessonRows = await db
      .selectDistinct({ lessonId: lessonNodesTable.lessonId })
      .from(lessonNodesTable)
      .where(inArray(lessonNodesTable.id, resolvedNodeIds));
    resolvedLessonIds = lessonRows.map((r) => r.lessonId).filter((id): id is number => id !== null);
  }

  // Validate all lesson IDs exist and belong to this teacher's authorized scope.
  let hasUnauthorizedLesson = false;
  if (resolvedLessonIds.length > 0) {
    const existingLessons = await db
      .select({
        id: lessonsTable.id,
        teacherId: lessonsTable.teacherId,
        courseTeacherId: coursesTable.teacherId,
        subjectId: lessonsTable.subjectId,
      })
      .from(lessonsTable)
      .leftJoin(coursesTable, eq(coursesTable.id, lessonsTable.courseId))
      .where(inArray(lessonsTable.id, resolvedLessonIds));
    if (existingLessons.length !== resolvedLessonIds.length) {
      res.status(400).json({ error: "One or more lesson IDs not found" });
      return;
    }
    hasUnauthorizedLesson =
      req.userRole !== "admin" &&
      existingLessons.some((lesson) =>
        lesson.teacherId !== req.userId && lesson.courseTeacherId !== req.userId
      );
    if (existingLessons.some((lesson) => lesson.subjectId !== subjectId)) {
      res.status(400).json({ error: "One or more lessons do not belong to the selected subject" });
      return;
    }
  }

  // Validate every resolved node independently. This closes the mixed-scope
  // case where a caller supplies an authorized lessonId with foreign nodeIds.
  const authoritativeNodes = await db
    .select({
      id: lessonNodesTable.id,
      lessonId: lessonNodesTable.lessonId,
    })
    .from(lessonNodesTable)
    .where(inArray(lessonNodesTable.id, resolvedNodeIds));
  if (authoritativeNodes.length !== resolvedNodeIds.length) {
    res.status(400).json({ error: "One or more node IDs not found" });
    return;
  }
  if (
    resolvedLessonIds.length > 0 &&
    authoritativeNodes.some((node) => !resolvedLessonIds.includes(node.lessonId))
  ) {
    res.status(400).json({ error: "One or more nodeIds do not belong to the selected lesson scope" });
    return;
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

  if (hasUnauthorizedLesson) {
    res.status(403).json({ error: "One or more lessons are outside the teacher's scope" });
    return;
  }

  // Use explicit quizType if provided; otherwise derive from lesson count.
  // Do NOT infer a conflicting type and silently override the teacher's explicit choice.
  const derivedQuizType: string | null =
    requestedQuizType ??
    (resolvedLessonIds.length === 1 ? "lesson"
    : resolvedLessonIds.length  >  1 ? "summary"
    : null); // no lesson linkage (edge case — book-only or free-form)

  const quizTitle = title?.trim() || `Թեստ — ${new Date().toLocaleDateString("hy-AM")}`;

  const rawIdempotencyKey = req.header("Idempotency-Key");
  const idempotencyKey = Array.isArray(rawIdempotencyKey)
    ? rawIdempotencyKey[0]?.trim()
    : rawIdempotencyKey?.trim();
  if (!idempotencyKey) {
    // Temporary compatibility path for the existing teacher dashboard. New
    // clients opt into durable async generation by sending Idempotency-Key.
    // Remove this branch only when every creation client polls generation jobs.
    try {
      const created = await createQuizFromNodeScope({
        assessmentConfig: assessmentConfig ?? undefined,
        teacherId: req.userId!,
        subjectId,
        classId,
        sourceBookId,
        lessonIds: resolvedLessonIds,
        nodeIds: resolvedNodeIds,
        title: quizTitle,
        questionCount,
        difficultyMode: difficultyMode as "SIMPLE" | "MEDIUM" | "HARD" | "MIXED",
        quizType: derivedQuizType,
        allowEmptyQuestions: true,
        generationPurpose: generationMode === "standard" ? "standard" : "normal",
      });

      res.status(201).json({
        id: created.quiz.id,
        title: quizTitle,
        subjectId: created.quiz.subjectId,
        questionCount: created.generated.length,
        difficultyMode: created.quiz.difficultyMode,
        status: "GENERATED",
        questions: created.questions.map((question) => ({
          id: question.id,
          nodeId: question.nodeId,
          questionText: question.questionText,
          options: question.options,
          correctOptionIndex: question.correctOptionIndex,
          difficultyLevel: question.difficultyLevel,
          sequence: question.sequence,
        })),
      });
    } catch (err) {
      logger.error({ err }, "legacy synchronous quiz generation failed");
      if (!res.headersSent) {
        if (err instanceof QuizCanonicalTargetError) {
          res.status(409).json({
            error: err.code,
            nodeId: err.nodeId,
            resolverReason: err.resolverReason,
          });
          return;
        }
        if (err instanceof QuizCanonicalTargetChangedError) {
          res.status(409).json({
            error: err.code,
            nodeId: err.nodeId,
            generatedCognitiveLevelId: err.generatedCognitiveLevelId,
            currentCognitiveLevelId: err.currentCognitiveLevelId,
          });
          return;
        }
        if (err instanceof QuizQuestionQualityError) {
          res.status(422).json({
            error: err.code,
            nodeId: err.nodeId,
            reasonCodes: err.reasonCodes,
          });
          return;
        }
        res.status(500).json({
          error: err instanceof Error ? err.message : "Quiz generation failed, please retry",
        });
      }
    }
    return;
  }

  const snapshot = normalizeQuizGenerationRequest({
    assessmentConfig: assessmentConfig ?? undefined,
    generationMode,
    subjectId,
    classId,
    sourceBookId,
    lessonIds: resolvedLessonIds,
    nodeIds: resolvedNodeIds,
    title: quizTitle,
    questionCount,
    difficultyMode: difficultyMode as "SIMPLE" | "MEDIUM" | "HARD" | "MIXED",
    quizType: derivedQuizType,
  });

  try {
    const result = await createOrReuseQuizGenerationJob({
      teacherId: req.userId!,
      idempotencyKey,
      snapshot,
    });
    scheduleQuizGenerationJob(result.job.id);
    res.status(202).json({
      jobId: result.job.id,
      status: result.job.status,
    });
  } catch (err) {
    if (err instanceof IdempotencyKeyReusedError) {
      res.status(409).json({ error: err.code });
      return;
    }
    logger.error({ err }, "quiz generation failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Quiz generation job could not be created" });
    }
  }
}));

// ── GET /api/quizzes/generation-jobs/:jobId ───────────────────────────────────
// Deliberately returns only the teacher-safe job projection.
router.get("/quizzes/generation-jobs/:jobId", requireTeacher, asyncHandler(async (req: AuthRequest, res) => {
  const jobId = Number.parseInt(String(req.params.jobId), 10);
  if (!Number.isInteger(jobId) || jobId < 1) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  const [job] = await db
    .select({
      id: quizGenerationJobsTable.id,
      status: quizGenerationJobsTable.status,
      progress: quizGenerationJobsTable.progress,
      quizId: quizGenerationJobsTable.quizId,
      errorCode: quizGenerationJobsTable.errorCode,
      errorDetails: quizGenerationJobsTable.errorDetails,
    })
    .from(quizGenerationJobsTable)
    .where(and(
      eq(quizGenerationJobsTable.id, jobId),
      eq(quizGenerationJobsTable.teacherId, req.userId!),
    ))
    .limit(1);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress ?? null,
    quizId: job.quizId ?? null,
    errorCode: job.errorCode ?? null,
    errorDetails: job.errorDetails ?? null,
  });
}));

// ── POST /api/quizzes/retests ──────────────────────────────────────────────────
// T3.1 retired child-quiz retests. Kept as a bounded compatibility response so
// older clients cannot create a second quiz/assignment or mastery system.
router.post("/quizzes/retests", requireStudent, asyncHandler(async (req: AuthRequest, res) => {
  res.status(410).json({
    error: "CONTINUOUS_SESSION_REQUIRED",
    message: "Վերափորձը շարունակվում է նույն թեստի «Արդյունքներ» էջից։",
  });
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
  const scoreStats = await getLatestCompletedQuizScoreStats(quizIds);

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

  const scoreStats = await getLatestCompletedQuizScoreStats(quizIds);

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
      attemptSequence: quizAttemptsTable.attemptSequence,
      completedAt: quizAttemptsTable.completedAt,
      sessionId: quizSessionsTable.id,
      sessionStatus: quizSessionsTable.status,
      retestSourceAttemptId: quizzesTable.retestSourceAttemptId,
      assessmentConfig: quizzesTable.assessmentConfig,
    })
    .from(quizAssignmentsTable)
    .innerJoin(quizzesTable, eq(quizzesTable.id, quizAssignmentsTable.quizId))
    .leftJoin(quizAttemptsTable, eq(quizAttemptsTable.quizAssignmentId, quizAssignmentsTable.id))
    .leftJoin(
      quizSessionsTable,
      eq(quizSessionsTable.rootAssignmentId, quizAssignmentsTable.id),
    )
    .where(eq(quizAssignmentsTable.studentId, req.userId!))
    .orderBy(desc(quizAssignmentsTable.assignedAt));

  const latestByAssignment = new Map<number, typeof rows[number]>();
  for (const row of rows) {
    if (row.retestSourceAttemptId !== null) continue;
    const current = latestByAssignment.get(row.assignmentId);
    if (!current || (row.attemptSequence ?? 0) > (current.attemptSequence ?? 0)) {
      latestByAssignment.set(row.assignmentId, row);
    }
  }
  const payload = await Promise.all([...latestByAssignment.values()].map(async (r) => {
    const adoptedSession = r.sessionId === null && r.status === "COMPLETED"
      ? await ensureQuizSession({
          rootQuizId: r.quizId,
          rootAssignmentId: r.assignmentId,
          learnerId: req.userId!,
        })
      : null;
    const sessionId = r.sessionId ?? adoptedSession?.id ?? null;
    const sessionStatus = r.sessionStatus ?? adoptedSession?.status ?? null;
    const learningProgress = await getQuizLearningProgress(r.quizId,req.userId!);
    const educational=parseAssessmentConfig(r.assessmentConfig)?.purpose==="LEARNING";
    const learningFlow=educational && (sessionStatus==="ACTIVE" || learningProgress.learningFlow.lastFinal) ? learningProgress.learningFlow : null;
    const hasActiveAttempt = r.completedAt===null && r.attemptSequence!==null;
    const sessionState = sessionId
      ? await resolveQuizSessionProjection(r.quizId, req.userId!)
      : null;
    return {
      assignmentId: r.assignmentId,
      quizId: r.quizId,
      title: r.title,
      subjectId: r.subjectId,
      status: r.status,
      assignedAt: r.assignedAt.toISOString(),
      dueAt: r.dueAt?.toISOString() ?? null,
      totalCorrect: learningProgress.history.length?learningProgress.current.correct:null,
      totalQuestions: learningProgress.history.length?learningProgress.current.total:null,
      scorePercent: learningProgress.history.length?learningProgress.current.percent:null,
      learningProgress, hasActiveAttempt, learningFlow,
      learningComplete:learningFlow?learningFlow.completed:undefined,
      practiceComplete: learningProgress.history.length>0 && learningProgress.remainingQuestionIds.length===0,
      sessionId,
      sessionStatus,
      sessionState,
      canContinue: sessionStatus === "ACTIVE" && (hasActiveAttempt || (learningFlow?!learningFlow.completed:learningProgress.remainingQuestionIds.length>0)),
    };
  }));
  res.json(payload);
});

// ── GET /api/quizzes/attempts/:attemptId/retest-eligibility ───────────────────
// Student: resolve bounded retest eligibility from the current canonical C5
// state of nodes in a completed, learner-owned attempt.
router.get(
  "/quizzes/attempts/:attemptId/retest-eligibility",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const attemptId = parseInt(String(req.params.attemptId), 10);
    if (isNaN(attemptId) || attemptId <= 0) {
      res.status(400).json({ error: "Invalid attempt id" });
      return;
    }

    const strategy = parseRetestStrategy(req.query.strategy);
    if (!strategy) {
      res.status(400).json({
        error: "strategy must be PARTIAL_AND_NOT_KNOWN or NOT_KNOWN_ONLY",
      });
      return;
    }

    try {
      const result = await resolveRetestEligibleNodes({
        learnerId: req.userId!,
        completedAttemptId: attemptId,
        strategy,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof RetestAuthorityError) {
        if (error.code === "RETEST_STRATEGY_INVALID") {
          res.status(400).json({
            error: "strategy must be PARTIAL_AND_NOT_KNOWN or NOT_KNOWN_ONLY",
          });
          return;
        }
        if (error.code === "RETEST_ATTEMPT_NOT_OWNED") {
          res.status(403).json({ error: "Retest attempt access denied" });
          return;
        }
        if (error.code === "RETEST_ATTEMPT_INCOMPLETE") {
          res.status(409).json({ error: "Retest requires a completed attempt" });
          return;
        }
        res.status(404).json({ error: "Completed attempt not found" });
        return;
      }
      throw error;
    }
  }),
);

// ── GET /api/quizzes/:id/results ──────────────────────────────────────────────
// Teacher: per-student results for a quiz. Completed ones sorted worst-score-first;
// not-completed ones at the bottom.
router.get("/quizzes/:id/results", requireTeacher, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  // Verify ownership
  const [quiz] = await db
    .select({ id: quizzesTable.id, assessmentConfig:quizzesTable.assessmentConfig })
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  const rows = await db
    .select({
      assignmentId:     quizAssignmentsTable.id,
      attemptId:        quizAttemptsTable.id,
      studentId:        usersTable.id,
      studentName:      usersTable.fullName,
      assignmentStatus: quizAssignmentsTable.status,
      totalCorrect:     quizAttemptsTable.totalCorrect,
      totalQuestions:   quizAttemptsTable.totalQuestions,
      scorePercent:     quizAttemptsTable.scorePercent,
      completedAt:      quizAttemptsTable.completedAt,
      attemptSequence:  quizAttemptsTable.attemptSequence,
    })
    .from(quizAssignmentsTable)
    .innerJoin(usersTable,        eq(usersTable.id,        quizAssignmentsTable.studentId))
    .leftJoin(
      quizAttemptsTable,
      and(
        eq(quizAttemptsTable.quizAssignmentId, quizAssignmentsTable.id),
        isNotNull(quizAttemptsTable.completedAt),
      ),
    )
    .where(eq(quizAssignmentsTable.quizId, quizId));

  const completedIds = rows.filter(r => r.completedAt !== null && r.attemptId !== null).map(r => r.attemptId!);
  const answers = completedIds.length ? await db.select({
    attemptId: quizAnswersTable.attemptId,
    questionId: quizAnswersTable.questionId,
    isCorrect: quizAnswersTable.isCorrect,
  }).from(quizAnswersTable).where(inArray(quizAnswersTable.attemptId, completedIds)) : [];
  const answersByAttempt = new Map<number, typeof answers>();
  for (const answer of answers) {
    const group = answersByAttempt.get(answer.attemptId) ?? [];
    group.push(answer);
    answersByAttempt.set(answer.attemptId, group);
  }
  const latestRows = collapseToLatestCompletedAttempt(rows).map(row => {
    if (!row.completedAt) return row;
    const progress = summarizePracticeProgress(rows
      .filter(r => r.assignmentId === row.assignmentId && r.completedAt !== null && r.attemptId !== null)
      .map(r => ({ attemptId: r.attemptId!, attemptSequence: r.attemptSequence ?? 1,
        questions: answersByAttempt.get(r.attemptId!) ?? [] })));
    return { ...row, totalCorrect: progress.totalCorrect, totalQuestions: progress.totalQuestions,
      scorePercent: progress.scorePercent };
  });
  // Sort: completed worst-score-first; non-completed at the bottom
  latestRows.sort((a, b) => {
    const aComp = a.completedAt !== null;
    const bComp = b.completedAt !== null;
    if (aComp && !bComp) return -1;
    if (!aComp && bComp) return 1;
    if (aComp && bComp) return (a.scorePercent ?? 100) - (b.scorePercent ?? 100);
    return 0;
  });

  res.json(latestRows.map((r) => ({
    assignmentId:   r.assignmentId,
    studentId:      r.studentId,
    studentName:    r.studentName,
    status:         r.completedAt !== null ? "COMPLETED" : r.assignmentStatus,
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
    .select({ id: quizzesTable.id, assessmentConfig:quizzesTable.assessmentConfig,classId:quizzesTable.classId,subjectId:quizzesTable.subjectId,nodeIds:quizzesTable.nodeIds })
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
    .where(and(
      eq(quizAttemptsTable.quizAssignmentId, assignment.id),
      isNotNull(quizAttemptsTable.completedAt),
    ))
    .orderBy(desc(quizAttemptsTable.attemptSequence))
    .limit(1);
  if (!attempt) {
    res.status(404).json({ error: "Attempt record not found" }); return;
  }

  // Teacher view shows every completed practice round, not just the last
  // one-question retry. Preserve the original first-round score separately.
  const completedAttempts = await db.select()
    .from(quizAttemptsTable)
    .where(and(
      eq(quizAttemptsTable.quizAssignmentId, assignment.id),
      isNotNull(quizAttemptsTable.completedAt),
    ))
    .orderBy(asc(quizAttemptsTable.attemptSequence));
  const histories = await Promise.all(completedAttempts.map(async (round) => ({
    round,
    analysis: await buildStudentResultAnalysis(round.id, studentId),
  })));
  const initial = histories[0]?.round ?? attempt;
  const questions = histories.flatMap(({ round, analysis }) =>
    analysis.questions.map((q) => ({
      ...q,
      // A question may reappear in multiple rounds: use unique UI key.
      questionId: round.id * 1_000_000 + q.questionId,
      questionText: `Փորձ ${round.attemptSequence} · ${q.questionText}`,
      attemptSequence: round.attemptSequence,
      sourceQuestionId: q.questionId,
    })),
  );
  const progress = summarizePracticeProgress(histories.map(({ round, analysis }) => ({
    attemptId: round.id,
    attemptSequence: round.attemptSequence,
    questions: analysis.questions,
  })));
  // Preserve every original node and take its latest attempted result.
  const nodeMap = new Map<number, typeof histories[number]["analysis"]["nodeBreakdown"][number]>();
  for (const { analysis } of histories) {
    for (const node of analysis.nodeBreakdown) nodeMap.set(node.nodeId, node);
  }
  const nodeBreakdown = [...nodeMap.values()].map(node => {
    const answers = progress.latestQuestions.filter(q => q.nodeId === node.nodeId);
    const correct = answers.filter(q => q.isCorrect).length;
    return { ...node, total: answers.length, correct, incorrect: answers.length - correct,
      percent: node.assessment?.percent ?? (answers.length ? Math.round(correct / answers.length * 100) : 0) };
  });
  const recommendations = histories.at(-1)?.analysis.recommendations ?? [];
  res.json({
    overviewQuestions: progress.latestQuestions,
    creationContext: {classId:quiz.classId,subjectId:quiz.subjectId,nodeIds:quiz.nodeIds,
      lessonIds:(await db.select({id:quizLessonLinksTable.lessonId}).from(quizLessonLinksTable).where(eq(quizLessonLinksTable.quizId,quizId))).map(l=>l.id)},
    learningProgress: await getQuizLearningProgress(quizId,studentId),
    studentId,
    totalCorrect: progress.totalCorrect,
    totalQuestions: progress.totalQuestions,
    scorePercent: progress.scorePercent,
    initialScorePercent: initial.scorePercent,
    assessmentConfig:quiz.assessmentConfig,
    practiceScorePercent: progress.scorePercent,
    practiceTotalCorrect: progress.totalCorrect,
    practiceTotalQuestions: progress.totalQuestions,
    ...(aggregateAssessments(nodeBreakdown) ?? {}),
    questions,
    nodeBreakdown,
    recommendations,
    attemptHistory: progress.attempts,
  });
});

// New independent evidence after practice. Scope and author are server-owned.
// Replaced by the teacher's explicit create -> review -> assign workflow.
router.post("/quizzes/:id/reconfirm", requireTeacher, (_req,res)=>{
  res.status(410).json({error:"USE_QUIZ_CREATION_FORM"});
});
router.get("/quizzes/assessment-jobs/:jobId", requireStudent, asyncHandler(async(req:AuthRequest,res)=>{
  const [job]=await db.select().from(quizGenerationJobsTable).where(eq(quizGenerationJobsTable.id,Number(req.params.jobId))).limit(1);
  if(!job||(job.requestSnapshot as any)?.studentId!==req.userId!){res.status(404).json({error:"JOB_NOT_FOUND"});return;}
  res.json({jobId:job.id,status:job.status,quizId:job.quizId,errorCode:job.errorCode});
}));

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
    ))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);
  if (!assignment) {
    res.status(404).json({ error: "No completed attempt found for this quiz" });
    return;
  }

  const session = await ensureQuizSession({
    rootQuizId: quizId,
    rootAssignmentId: assignment.id,
    learnerId: req.userId!,
  });
  const requestedAttemptId = Number(req.query.attemptId);
  const attemptWhere = session
    ? and(
        eq(quizAttemptsTable.quizSessionId, session.id),
        requestedAttemptId > 0
          ? and(eq(quizAttemptsTable.id, requestedAttemptId), isNotNull(quizAttemptsTable.completedAt))
          : isNotNull(quizAttemptsTable.completedAt),
      )
    : eq(quizAttemptsTable.quizAssignmentId, assignment.id);
  const [attempt] = await db
    .select()
    .from(quizAttemptsTable)
    .where(attemptWhere)
    .orderBy(desc(quizAttemptsTable.attemptSequence), desc(quizAttemptsTable.completedAt))
    .limit(1);
  if (!attempt) {
    res.status(404).json({ error: "Attempt record not found" });
    return;
  }

  const { questions, nodeBreakdown, recommendations } =
    await buildStudentResultAnalysis(attempt.id, req.userId!);
  const attemptHistory = session
    ? await db.select({
        attemptId: quizAttemptsTable.id,
        attemptSequence: quizAttemptsTable.attemptSequence,
        totalCorrect: quizAttemptsTable.totalCorrect,
        totalQuestions: quizAttemptsTable.totalQuestions,
        scorePercent: quizAttemptsTable.scorePercent,
        completedAt: quizAttemptsTable.completedAt,
      }).from(quizAttemptsTable).where(and(
        eq(quizAttemptsTable.quizSessionId, session.id),
        isNotNull(quizAttemptsTable.completedAt),
      )).orderBy(desc(quizAttemptsTable.attemptSequence))
    : [];
  const sessionState = session
    ? await resolveQuizSessionProjection(quizId, req.userId!)
    : null;

  const overviewMap=new Map<number, typeof questions[number]>();
  const completedIds=attemptHistory.length? [...attemptHistory].reverse().map(a=>a.attemptId):[attempt.id];
  for(const completedId of completedIds){
    const analysis=completedId===attempt.id?{questions}:await buildStudentResultAnalysis(completedId,req.userId!);
    for(const q of analysis.questions)overviewMap.set(q.questionId,q);
  }
  const overviewQuestions=[...overviewMap.values()].sort((a,b)=>a.sequence-b.sequence);
  res.json({
    overviewQuestions,
    learningProgress: await getQuizLearningProgress(quizId,req.userId!),
    attemptId:       attempt.id,
    totalCorrect:   attempt.totalCorrect,
    totalQuestions: attempt.totalQuestions,
    scorePercent:   attempt.scorePercent,
    practiceScorePercent: attempt.scorePercent,
    practiceTotalCorrect: attempt.totalCorrect,
    practiceTotalQuestions: attempt.totalQuestions,
    ...(aggregateAssessments(nodeBreakdown) ?? {}),
    questions,
    nodeBreakdown,
    recommendations,
    session: session ? {
      id: session.id,
      status: session.status,
      ...sessionState,
    } : null,
    assessmentConfig: (await db.select({config:quizzesTable.assessmentConfig}).from(quizzesTable).where(eq(quizzesTable.id,quizId)).limit(1))[0]?.config ?? null,
    attempts: attemptHistory.map((item) => ({
      ...item,
      completedAt: item.completedAt?.toISOString() ?? null,
    })),
  });
});

router.post("/quizzes/:id/session/finish", requireAuth, asyncHandler(async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }
  const [assignment] = await db.select({ id: quizAssignmentsTable.id })
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId, quizId),
      eq(quizAssignmentsTable.studentId, req.userId!),
    ))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);
  if (!assignment) { res.status(404).json({ error: "Quiz assignment not found" }); return; }
  const [existingSession]=await db.select({status:quizSessionsTable.status}).from(quizSessionsTable)
    .where(eq(quizSessionsTable.rootAssignmentId,assignment.id)).limit(1);
  if(existingSession?.status==="FINISHED"){res.json({finished:true});return;}
  const [quiz]=await db.select({config:quizzesTable.assessmentConfig}).from(quizzesTable).where(eq(quizzesTable.id,quizId)).limit(1);
  if(parseAssessmentConfig(quiz?.config)?.purpose==="LEARNING" && !(await getQuizLearningProgress(quizId,req.userId!)).learningFlow.completed){
    res.status(409).json({error:"COMPLETE_FINAL_CHECK_FIRST"});return;
  }
  const [session] = await db.update(quizSessionsTable).set({
    status: "FINISHED",
    completedAt: new Date(),
  }).where(eq(
    quizSessionsTable.rootAssignmentId,
    assignment.id,
  )).returning({ id: quizSessionsTable.id });
  if (!session) { res.status(404).json({ error: "Quiz session not found" }); return; }
  res.json({ finished: true });
}));

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
    .select({
      id:                 quizQuestionsTable.id,
      nodeId:             quizQuestionsTable.nodeId,
      nodeTitle:          lessonNodesTable.title,
      questionText:       quizQuestionsTable.questionText,
      options:             quizQuestionsTable.options,
      correctOptionIndex: quizQuestionsTable.correctOptionIndex,
      optionExplanations: quizQuestionsTable.optionExplanations,
      solutionExplanation: quizQuestionsTable.solutionExplanation,
      difficultyLevel:    quizQuestionsTable.difficultyLevel,
      sequence:           quizQuestionsTable.sequence,
      cognitiveLevelId:   quizQuestionsTable.cognitiveLevelId,
      cognitiveLevel:     lessonNodeCognitiveLevelsTable.cognitiveLevel,
    })
    .from(quizQuestionsTable)
    .leftJoin(lessonNodesTable, eq(lessonNodesTable.id, quizQuestionsTable.nodeId))
    .leftJoin(
      lessonNodeCognitiveLevelsTable,
      eq(lessonNodeCognitiveLevelsTable.id, quizQuestionsTable.cognitiveLevelId),
    )
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
       nodeTitle:          q.nodeTitle ?? null,
      questionText:       q.questionText,
      options:            q.options,
      correctOptionIndex: q.correctOptionIndex,
      optionExplanations: q.optionExplanations,
      solutionExplanation: q.solutionExplanation,
      difficultyLevel:    q.difficultyLevel,
      sequence:           q.sequence,
       cognitiveLevelId:   q.cognitiveLevelId ?? null,
       cognitiveLevel:     q.cognitiveLevel ?? null,
       cognitiveLevelLabel: q.cognitiveLevel
         ? COGNITIVE_LEVEL_LABELS[q.cognitiveLevel] ?? null
         : null,
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
    .select({ id: quizzesTable.id, assessmentConfig:quizzesTable.assessmentConfig })
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
// Student: open the continuous session rooted in the original assignment.
router.get("/quizzes/:id/take", requireAuth, asyncHandler(async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  const [assignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    quizId),
      eq(quizAssignmentsTable.studentId, req.userId!),
    ))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);

  if (!assignment) {
    res.status(403).json({ error: "No assignment found for this quiz" });
    return;
  }

  const [takeQuiz] = await db.select({config:quizzesTable.assessmentConfig}).from(quizzesTable).where(eq(quizzesTable.id,quizId)).limit(1);
  const config = parseAssessmentConfig(takeQuiz?.config);
  const opened = await getOrCreateActiveAttempt({
    rootQuizId: quizId,
    assignmentId: assignment.id,
    learnerId: req.userId!,
  });
  if (!opened.attempt || opened.snapshots.length === 0) {
    const projection = await resolveQuizSessionProjection(quizId, req.userId!);
    res.status(409).json({
      error: opened.session.status === "ACTIVE" ? "SESSION_HAS_NO_LEARNING_SCOPE" : "SESSION_FINISHED",
      sessionState: projection,
    });
    return;
  }

  const educationalProgress=config?.purpose==="LEARNING"?await getQuizLearningProgress(quizId,req.userId!):null;
  const learningPhase=educationalProgress?.learningFlow.nextPhase??null;
  const deferredFinal=learningPhase==="FINAL";
  const effectiveConfig = config && opened.attempt.attemptSequence>1 ? {...config,purpose:"LEARNING" as const} : config;
  const finalizedAnswers = await db
    .select()
    .from(quizAnswersTable)
    .where(eq(quizAnswersTable.attemptId, opened.attempt.id));
  const finalizedAnswerMap = new Map(finalizedAnswers.map((answer) => [answer.questionId, answer]));

  let reviewCards:Array<{questionId:number;questionText:string;correctAnswer:string|null;selectedAnswer:string|null;whyWrong:string|null;explanation:string|null}>=[];
  if(learningPhase==="PRACTICE" && finalizedAnswers.length===0){
    const previous=await db.select({questionId:quizAnswersTable.questionId,selectedOptionIndex:quizAnswersTable.selectedOptionIndex})
      .from(quizAnswersTable).innerJoin(quizAttemptsTable,eq(quizAttemptsTable.id,quizAnswersTable.attemptId))
      .where(and(eq(quizAttemptsTable.quizSessionId,opened.session.id),isNotNull(quizAttemptsTable.completedAt)))
      .orderBy(asc(quizAttemptsTable.attemptSequence),asc(quizAnswersTable.id));
    const latest=new Map(previous.map(a=>[a.questionId,a]));
    reviewCards=opened.snapshots.map(snapshot=>{
      const options=snapshot.options as string[];
      const wrong=latest.get(snapshot.questionId)?.selectedOptionIndex;
      return {questionId:snapshot.questionId,questionText:snapshot.questionText,
        correctAnswer:options[snapshot.correctOptionIndex]??null,
        selectedAnswer:wrong===undefined?null:options[wrong]??null,
        whyWrong:wrong===undefined?null:snapshot.optionExplanations?.[wrong]??null,
        explanation:snapshot.solutionExplanation??snapshot.optionExplanations?.[snapshot.correctOptionIndex]??null};
    });
  }
  res.json({
    assessmentConfig: effectiveConfig,
    learningPhase, reviewCards,
    assignmentId:     assignment.id,
    assignmentStatus: "IN_PROGRESS",
    sessionId: opened.session.id,
    attemptId: opened.attempt.id,
    attemptSequence: opened.attempt.attemptSequence,
    questions: opened.snapshots.map(presentAttemptQuestion),
    finalizedAnswers: opened.snapshots.flatMap((snapshot) => {
      const answer = finalizedAnswerMap.get(snapshot.questionId);
      if (!answer) return [];
      const selectedPresentationIndex = answer.selectedPresentationIndex
        ?? (Array.isArray(snapshot.optionOrder)
          ? (snapshot.optionOrder as number[]).indexOf(answer.selectedOptionIndex)
          : answer.selectedOptionIndex);
      const scored = scorePresentedAnswer(snapshot, selectedPresentationIndex);
      if (!scored) return [];
      const options = Array.isArray(snapshot.options) ? snapshot.options as string[] : [];
      const order = Array.isArray(snapshot.optionOrder)
        ? snapshot.optionOrder as number[]
        : options.map((_, index) => index);
      const presentedOptions = order.map((index) => options[index]);
      return [{
        ...((effectiveConfig?.purpose === "CHECK" || deferredFinal) ? { deferred:true } : {}),
        questionId: snapshot.questionId,
        selectedOptionIndex: scored.selectedPresentationIndex,
        isCorrect: (effectiveConfig?.purpose === "CHECK" || deferredFinal) ? null : scored.isCorrect,
        correctOptionIndex: (effectiveConfig?.purpose === "CHECK" || deferredFinal) ? null : scored.correctPresentationIndex,
        selectedAnswer: presentedOptions[scored.selectedPresentationIndex] ?? null,
        correctAnswer: (effectiveConfig?.purpose === "CHECK" || deferredFinal) ? null : presentedOptions[scored.correctPresentationIndex] ?? null,
        feedback: (effectiveConfig?.purpose === "CHECK" || deferredFinal) ? {whyCorrect:null,whyWrong:null,solutionExplanation:null} : scored.feedback,
      }];
    }),
  });
}));

// Immediate feedback is scored only against the immutable attempt snapshot.
router.post("/quizzes/:id/attempts/:attemptId/feedback", requireAuth, asyncHandler(async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  const attemptId = parseInt(String(req.params.attemptId), 10);
  const questionId = Number(req.body?.questionId);
  const selectedPresentationIndex = Number(req.body?.selectedOptionIndex);
  if (![quizId, attemptId, questionId, selectedPresentationIndex].every(Number.isInteger)) {
    res.status(400).json({ error: "Invalid feedback request" });
    return;
  }

  const [feedbackQuiz] = await db.select({config:quizzesTable.assessmentConfig}).from(quizzesTable).where(eq(quizzesTable.id,quizId)).limit(1);
  const feedbackConfig=parseAssessmentConfig(feedbackQuiz?.config);
  const configuredCheck = feedbackConfig?.purpose === "CHECK";
  const deferredFinal=feedbackConfig?.purpose==="LEARNING" && (await getQuizLearningProgress(quizId,req.userId!)).learningFlow.nextPhase==="FINAL";
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM quiz_attempts WHERE id = ${attemptId} FOR UPDATE`);
    const [access] = await tx.select({
      completedAt: quizAttemptsTable.completedAt,
      attemptSequence: quizAttemptsTable.attemptSequence,
    }).from(quizAttemptsTable)
      .innerJoin(quizSessionsTable, eq(quizSessionsTable.id, quizAttemptsTable.quizSessionId))
      .where(and(
        eq(quizAttemptsTable.id, attemptId),
        eq(quizSessionsTable.rootQuizId, quizId),
        eq(quizSessionsTable.studentId, req.userId!),
      )).limit(1);
    if (!access) return { status: 403, body: { error: "Attempt access denied" } };
    if (access.completedAt) return { status: 409, body: { error: "Attempt already completed" } };
    const checkOnly=deferredFinal || (configuredCheck && access.attemptSequence===1);

    const [snapshot] = await tx.select().from(quizAttemptQuestionsTable).where(and(
      eq(quizAttemptQuestionsTable.attemptId, attemptId),
      eq(quizAttemptQuestionsTable.questionId, questionId),
    )).limit(1);
    if (!snapshot) return { status: 404, body: { error: "Question not in this attempt" } };

    const options = Array.isArray(snapshot.options) ? snapshot.options as string[] : [];
    const order = Array.isArray(snapshot.optionOrder)
      ? snapshot.optionOrder as number[]
      : options.map((_, index) => index);
    const requestedScore = scorePresentedAnswer(snapshot, selectedPresentationIndex);
    if (!requestedScore) return { status: 400, body: { error: "Invalid option index" } };

    const [existing] = await tx.select().from(quizAnswersTable).where(and(
      eq(quizAnswersTable.attemptId, attemptId),
      eq(quizAnswersTable.questionId, questionId),
    )).limit(1);
    const existingPresentationIndex = existing
      ? existing.selectedPresentationIndex ?? order.indexOf(existing.selectedOptionIndex)
      : null;
    if (existing && existingPresentationIndex !== selectedPresentationIndex) {
      return { status: 409, body: { error: "Finalized answer cannot be changed" } };
    }
    if (!existing) {
      await tx.insert(quizAnswersTable).values({
        attemptId,
        questionId,
        selectedOptionIndex: requestedScore.canonicalSelectedOptionIndex,
        selectedPresentationIndex: requestedScore.selectedPresentationIndex,
        isCorrect: requestedScore.isCorrect,
        nodeId: snapshot.nodeId,
      });
    }

    const [persisted] = existing
      ? [existing]
      : await tx.select().from(quizAnswersTable).where(and(
          eq(quizAnswersTable.attemptId, attemptId),
          eq(quizAnswersTable.questionId, questionId),
        )).limit(1);
    if (!persisted) return { status: 503, body: { error: "Answer could not be finalized" } };
    const persistedPresentationIndex = persisted.selectedPresentationIndex
      ?? order.indexOf(persisted.selectedOptionIndex);
    const persistedScore = scorePresentedAnswer(snapshot, persistedPresentationIndex);
    if (!persistedScore) return { status: 409, body: { error: "Finalized answer is invalid" } };

    const presentedOptions = order.map((index) => options[index]);
    return {
      status: 200,
      body: {
        deferred: checkOnly,
        isCorrect: checkOnly ? null : persisted.isCorrect,
        selectedOptionIndex: persistedPresentationIndex,
        correctOptionIndex: checkOnly ? null : persistedScore.correctPresentationIndex,
        selectedAnswer: presentedOptions[persistedPresentationIndex] ?? null,
        correctAnswer: checkOnly ? null : presentedOptions[persistedScore.correctPresentationIndex] ?? null,
        feedback: checkOnly ? {whyCorrect:null,whyWrong:null,solutionExplanation:null} : persistedScore.feedback,
      },
    };
  });
  res.status(outcome.status).json(outcome.body);
}));

// ── POST /api/quizzes/:id/submit ──────────────────────────────────────────────
// Student: submit answers for a quiz. Returns score.
// Body: { answers: [{ questionId, selectedOptionIndex }] }
router.post("/quizzes/:id/submit", requireAuth, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  const { answers, attemptId: requestedAttemptId } = req.body as {
    answers: { questionId: number; selectedOptionIndex: number }[];
    attemptId?: number;
  };

  if (!Array.isArray(answers) || answers.length === 0) {
    res.status(400).json({ error: "answers array is required" });
    return;
  }

  const [assignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    quizId),
      eq(quizAssignmentsTable.studentId, req.userId!),
    ))
    .orderBy(desc(quizAssignmentsTable.assignedAt))
    .limit(1);

  if (!assignment) {
    res.status(403).json({ error: "No assignment found for this quiz" });
    return;
  }

  const attemptQuery = db.select({
    id: quizAttemptsTable.id,
    attemptSequence: quizAttemptsTable.attemptSequence,
    completedAt: quizAttemptsTable.completedAt,
    quizSessionId: quizAttemptsTable.quizSessionId,
  }).from(quizAttemptsTable)
    .innerJoin(quizSessionsTable, eq(quizSessionsTable.id, quizAttemptsTable.quizSessionId))
    .where(and(
      requestedAttemptId
        ? eq(quizAttemptsTable.id, requestedAttemptId)
        : isNull(quizAttemptsTable.completedAt),
      eq(quizAttemptsTable.quizAssignmentId, assignment.id),
      eq(quizSessionsTable.rootQuizId, quizId),
      eq(quizSessionsTable.studentId, req.userId!),
    ))
    .orderBy(desc(quizAttemptsTable.attemptSequence))
    .limit(1);
  const [attempt] = await attemptQuery;
  if (!attempt) {
    res.status(409).json({ error: "No active attempt found" });
    return;
  }
  if (attempt.completedAt) {
    res.status(409).json({ error: "Attempt already completed" });
    return;
  }

  const snapshots = await db.select().from(quizAttemptQuestionsTable)
    .where(eq(quizAttemptQuestionsTable.attemptId, attempt.id))
    .orderBy(asc(quizAttemptQuestionsTable.sequence));
  const snapshotMap = new Map(snapshots.map((snapshot) => [snapshot.questionId, snapshot]));
  const existingAnswers = await db.select().from(quizAnswersTable)
    .where(eq(quizAnswersTable.attemptId, attempt.id));
  const existingAnswerMap = new Map(existingAnswers.map((answer) => [answer.questionId, answer]));
  if (
    answers.length !== snapshots.length ||
    new Set(answers.map((answer) => answer.questionId)).size !== snapshots.length ||
    answers.some((answer) => !snapshotMap.has(answer.questionId))
  ) {
    res.status(400).json({ error: "Every attempt question must be answered exactly once" });
    return;
  }

  // Canonical content remains the evidence source; presentation indices are
  // mapped through the immutable attempt snapshot before scoring.
  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(inArray(quizQuestionsTable.id, snapshots.map((snapshot) => snapshot.questionId)));

  const currentQuestionMap = new Map(questions.map((q) => [q.id, q]));
  const questionMap = new Map(snapshots.map((snapshot) => {
    const current = currentQuestionMap.get(snapshot.questionId)!;
    return [snapshot.questionId, {
      ...current,
      id: snapshot.questionId,
      nodeId: snapshot.nodeId,
      sourceExerciseId: snapshot.sourceExerciseId,
      cognitiveLevelId: snapshot.cognitiveLevelId,
      difficultyLevel: snapshot.difficultyLevel,
      interactionType: snapshot.interactionType,
    }] as const;
  }));

  let finalizedAnswerConflict = false;
  const answerRows = answers.map((a) => {
    const q = questionMap.get(a.questionId);
    const snapshot = snapshotMap.get(a.questionId)!;
    const existingAnswer = existingAnswerMap.get(a.questionId);
    if (existingAnswer) {
      const storedPresentationIndex = existingAnswer.selectedPresentationIndex
        ?? (Array.isArray(snapshot.optionOrder)
          ? (snapshot.optionOrder as number[]).indexOf(existingAnswer.selectedOptionIndex)
          : existingAnswer.selectedOptionIndex);
      if (storedPresentationIndex !== a.selectedOptionIndex) {
        finalizedAnswerConflict = true;
      }
      return {
        questionId: a.questionId,
        selectedOptionIndex: existingAnswer.selectedOptionIndex,
        selectedPresentationIndex: storedPresentationIndex,
        isCorrect: existingAnswer.isCorrect,
        nodeId: existingAnswer.nodeId ?? snapshot.nodeId ?? q?.nodeId ?? null,
        alreadyPersisted: true,
      };
    }
    const scored = scorePresentedAnswer(snapshot, a.selectedOptionIndex);
    const canonicalSelected = scored?.canonicalSelectedOptionIndex ?? -1;
    const isCorrect = scored?.isCorrect === true;
    return {
      questionId:          a.questionId,
      selectedOptionIndex: canonicalSelected,
      selectedPresentationIndex: a.selectedOptionIndex,
      isCorrect,
      nodeId:              snapshot.nodeId ?? q?.nodeId ?? null,
      alreadyPersisted: false,
    };
  });

  if (finalizedAnswerConflict) {
    res.status(409).json({ error: "Finalized answer cannot be changed" });
    return;
  }
  if (answerRows.some((answer) => answer.selectedOptionIndex < 0)) {
    res.status(400).json({ error: "Invalid option index" });
    return;
  }

  const totalCorrect = answerRows.filter((answer) => answer.isCorrect).length;
  const totalQuestions = snapshots.length;
  const scorePercent   = totalQuestions > 0
    ? Math.round((totalCorrect / totalQuestions) * 100)
    : 0;

  // ── C3: awaited canonical evidence persistence ───────────────────────────
  // A quiz score is not reported as recorded Cognitive-Level evidence until
  // its immutable evidence rows have been written. Existing null-annotated
  // questions stay usable, but are explicitly unqualified.
  const studentId = req.userId!;
  const scoredTopicIds: number[] = [];
  let assessmentV1 = false;
  const nodeIds = [...new Set(answerRows
    .map((answer) => answer.nodeId)
    .filter((id): id is number => id !== null))];
  try {
    await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM quiz_attempts WHERE id = ${attempt.id} FOR UPDATE`);
    const [lockedAttempt] = await tx
      .select({ completedAt: quizAttemptsTable.completedAt })
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.id, attempt.id))
      .limit(1);
    if (!lockedAttempt || lockedAttempt.completedAt) {
      throw new Error("QUIZ_ATTEMPT_ALREADY_COMPLETED");
    }
    const lockedAnswers = await tx
      .select()
      .from(quizAnswersTable)
      .where(eq(quizAnswersTable.attemptId, attempt.id));
    for (const lockedAnswer of lockedAnswers) {
      const answer = answerRows.find((candidate) => candidate.questionId === lockedAnswer.questionId);
      const snapshot = snapshotMap.get(lockedAnswer.questionId);
      if (!answer || !snapshot) throw new Error("FINALIZED_ANSWER_CONFLICT");
      const storedPresentationIndex = lockedAnswer.selectedPresentationIndex
        ?? (Array.isArray(snapshot.optionOrder)
          ? (snapshot.optionOrder as number[]).indexOf(lockedAnswer.selectedOptionIndex)
          : lockedAnswer.selectedOptionIndex);
      if (storedPresentationIndex !== answer.selectedPresentationIndex) {
        throw new Error("FINALIZED_ANSWER_CONFLICT");
      }
      answer.alreadyPersisted = true;
    }

    const [quizRow] = await tx
      .select({ subjectId: quizzesTable.subjectId, assessmentConfig: quizzesTable.assessmentConfig })
      .from(quizzesTable)
      .where(eq(quizzesTable.id, quizId))
      .limit(1);
    if (!quizRow?.subjectId) throw new Error("quiz evidence requires subject");

    const nodes = nodeIds.length > 0
      ? await tx
          .select({
            id: lessonNodesTable.id,
            title: lessonNodesTable.title,
            targetBloomLevel: lessonNodesTable.targetBloomLevel,
            theoryContent: lessonNodesTable.theoryContent,
            learningObjective: lessonNodesTable.learningObjective,
            cogPathStatus: lessonNodesTable.cogPathStatus,
          })
          .from(lessonNodesTable)
          .where(inArray(lessonNodesTable.id, nodeIds))
      : [];
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const levels = nodeIds.length > 0
      ? await tx
          .select()
          .from(lessonNodeCognitiveLevelsTable)
          .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeIds))
          .orderBy(
            asc(lessonNodeCognitiveLevelsTable.lessonNodeId),
            asc(lessonNodeCognitiveLevelsTable.sequence),
            asc(lessonNodeCognitiveLevelsTable.id),
          )
      : [];
    const levelMap = new Map(levels.map((level) => [level.id, level]));
    const levelsByNode = new Map<number, typeof levels>();
    for (const level of levels) {
      const current = levelsByNode.get(level.lessonNodeId) ?? [];
      current.push(level);
      levelsByNode.set(level.lessonNodeId, current);
    }
    const acceptedNodeIds = new Set(nodes
      .filter((node) => assessAcceptedCognitivePath({
        cogPathStatus: node.cogPathStatus,
        theoryContent: node.theoryContent,
        learningObjective: node.learningObjective,
        levels: levelsByNode.get(node.id) ?? [],
      }).accepted)
      .map((node) => node.id));

    const sourceExerciseIds = [...new Set([...questionMap.values()]
      .map((question) => question.sourceExerciseId)
      .filter((id): id is number => id !== null))];
    const sourceExercises = sourceExerciseIds.length > 0
      ? await tx
          .select({
            id: lessonExercisesTable.id,
            relatedNodeId: lessonExercisesTable.relatedNodeId,
          })
          .from(lessonExercisesTable)
          .where(inArray(lessonExercisesTable.id, sourceExerciseIds))
      : [];
    const sourceExerciseMap = new Map(sourceExercises.map((exercise) => [exercise.id, exercise]));

    const config = parseAssessmentConfig(quizRow.assessmentConfig);
    assessmentV1 = !!config;
    const prior = config ? await tx.select({questionId:quizAnswersTable.questionId, questionText:quizQuestionsTable.questionText, nodeId:quizQuestionsTable.nodeId})
      .from(quizAnswersTable).innerJoin(quizQuestionsTable,eq(quizQuestionsTable.id,quizAnswersTable.questionId)).innerJoin(quizAttemptsTable,eq(quizAttemptsTable.id,quizAnswersTable.attemptId))
      .innerJoin(quizAssignmentsTable,eq(quizAssignmentsTable.id,quizAttemptsTable.quizAssignmentId))
      .where(and(eq(quizAssignmentsTable.studentId,studentId),ne(quizAttemptsTable.id,attempt.id),
        inArray(quizQuestionsTable.nodeId,nodeIds))) : [];
    const exposed = new Set(prior.map(row=>row.questionId));
    const exposedFamilies = new Set(prior.map(row=>`${row.nodeId}:${normalizeQuestionText(row.questionText)}`));
    for (const question of questionMap.values()) {
      if (exposedFamilies.has(`${question.nodeId}:${normalizeQuestionText(question.questionText)}`)) exposed.add(question.id);
    }
    for (const answer of answerRows) {
      const question = questionMap.get(answer.questionId);
      const node = answer.nodeId === null ? null : nodeMap.get(answer.nodeId) ?? null;
      if (!question || !node || answer.nodeId === null) continue;

      let topicId: number | null = null;
      const [existingKN] = await tx
        .select({ id: knowledgeNodesTable.id })
        .from(knowledgeNodesTable)
        .where(and(
          eq(knowledgeNodesTable.subjectId, quizRow.subjectId),
          eq(knowledgeNodesTable.userId, studentId),
          eq(knowledgeNodesTable.lessonNodeId, answer.nodeId),
        ))
        .limit(1);
      if (existingKN) {
        topicId = existingKN.id;
      } else {
        const [newKN] = await tx
          .insert(knowledgeNodesTable)
          .values({
            subjectId: quizRow.subjectId,
            userId: studentId,
            topicName: node.title,
            lessonNodeId: answer.nodeId,
            status: "not_started",
            isProvisional: true,
            bloomLevel: node.targetBloomLevel ?? 1,
          })
          .returning({ id: knowledgeNodesTable.id });
        topicId = newKN?.id ?? null;
      }
      if (!topicId) throw new Error("quiz evidence could not create knowledge node");
      if (!scoredTopicIds.includes(topicId)) scoredTopicIds.push(topicId);

      const cognitiveLevelId = question.cognitiveLevelId ?? null;
      const cognitiveLevel = cognitiveLevelId === null
        ? null
        : levelMap.get(cognitiveLevelId) ?? null;
      const sourceExercise = question.sourceExerciseId === null
        ? null
        : sourceExerciseMap.get(question.sourceExerciseId) ?? null;
      const qualificationStatus = config && exposed.has(question.id) ? "unqualified" : classifyQualifyingEvidence({
        lessonNodeId: answer.nodeId,
        cognitiveLevelId,
        taskSource: "quiz_question",
        taskReference: `quiz_question:${question.id}`,
        levelBelongsToNode: cognitiveLevel?.lessonNodeId === answer.nodeId,
        acceptedPath: acceptedNodeIds.has(answer.nodeId),
        taskValidForLevel: sourceExercise === null ||
          sourceExercise.relatedNodeId === answer.nodeId,
        authoritativeResult: true,
      });

      await tx.insert(evidenceEventsTable).values({
        userId: studentId,
        lessonSessionId: null,
        topicId,
        eventType: "answer",
        wasCorrect: answer.isCorrect,
        responseTimeMs: null,
        hintUsed: false,
        metadata: {
          source: "quiz",
          ...(config ? { assessmentVersion:config.version, assessmentPurpose:config.purpose,
            assessmentCycle:`quiz:${quizId}:attempt:${attempt.id}`,
            independentAssessment:!exposed.has(question.id), answerPreviouslyExposed:exposed.has(question.id),
            assessmentFamily:normalizeQuestionText(question.questionText) } : {}),
          quizId,
          questionId: question.id,
          qualification_status: qualificationStatus,
        },
        cognitiveLevel: cognitiveLevel?.cognitiveLevel ?? null,
        taskDifficulty: question.difficultyLevel,
        assistanceLevel: "none",
        lessonExerciseId: question.sourceExerciseId,
        interactionType: question.interactionType ?? "multiple_choice",
        attemptSequence: attempt.attemptSequence,
        helpCount: 0,
        lessonNodeId: answer.nodeId,
        cognitiveLevelId,
        quizQuestionId: question.id,
        quizAttemptId: attempt.id,
        taskSource: "quiz_question",
        taskReference: `quiz_question:${question.id}`,
        qualificationStatus,
        evidenceQuality: "MODERATE",
      } as any);
    }

    const pendingAnswerRows = answerRows.filter((answer) => !answer.alreadyPersisted);
    if (pendingAnswerRows.length > 0) {
      await tx.insert(quizAnswersTable).values(
        pendingAnswerRows.map((answer) => ({
        attemptId: attempt.id,
        questionId: answer.questionId,
        selectedOptionIndex: answer.selectedOptionIndex,
        selectedPresentationIndex: answer.selectedPresentationIndex,
        isCorrect: answer.isCorrect,
        nodeId: answer.nodeId,
        })),
      );
    }

    const [completedAttempt] = await tx
      .update(quizAttemptsTable)
      .set({
        completedAt: new Date(),
        totalCorrect,
        totalQuestions,
        scorePercent,
      })
      .where(and(
        eq(quizAttemptsTable.id, attempt.id),
        isNull(quizAttemptsTable.completedAt),
      ))
      .returning({ id: quizAttemptsTable.id });
    if (!completedAttempt) {
      throw new Error("QUIZ_ATTEMPT_ALREADY_COMPLETED");
    }

    await tx
      .update(quizAssignmentsTable)
      .set({ status: "COMPLETED" })
      .where(eq(quizAssignmentsTable.id, assignment.id));
    });
  } catch (err) {
    if (err instanceof Error && err.message === "FINALIZED_ANSWER_CONFLICT") {
      res.status(409).json({ error: "Finalized answer cannot be changed" });
      return;
    }
    if (err instanceof Error && err.message === "QUIZ_ATTEMPT_ALREADY_COMPLETED") {
      res.status(409).json({ error: "Attempt already completed" });
      return;
    }
    logger.error({ err, quizId, attemptId: attempt.id }, "quiz canonical evidence write failed");
    res.status(503).json({
      error: "EVIDENCE_PERSISTENCE_FAILED",
      message: "Թեստի արդյունքը չի հաջողվել վստահելիորեն գրանցել։ Խնդրում ենք կրկին փորձել։",
    });
    return;
  }

  // C4 is a projection derived from the now-durable C3 evidence. It runs only
  // after commit, so no completed attempt can exist without its answer/evidence
  // set; projection can be safely retried from those immutable rows.
  for (const nodeId of nodeIds) {
    try {
      const projection = await projectLearnerCognitiveCeiling(studentId, nodeId);
      logger.info({
        userId: studentId,
        lessonNodeId: nodeId,
        ceilingLevelId: projection.ceilingLevelId,
        ceilingLevel: projection.ceilingLevel,
        reachedTarget: projection.reachedTarget,
      }, "C4: learner cognitive ceiling projected from quiz evidence");
    } catch (err) {
      logger.error({ err, userId: studentId, lessonNodeId: nodeId }, "C4: quiz evidence projection failed");
    }
  }

  // Commit supporting scores before returning: the client invalidates the tree
  // immediately on success and must not fetch the previous scores.
  await Promise.all(scoredTopicIds.map(topicId =>
    updateTopicScoring(topicId, studentId, { quizId, assessmentV1 }),
  ));

  const sessionState = await resolveQuizSessionProjection(quizId, studentId);
  res.json({
    attemptId: attempt.id,
    attemptSequence: attempt.attemptSequence,
    totalCorrect,
    totalQuestions,
    scorePercent,
    sessionState,
  });
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
    .select({ id: quizzesTable.id, assessmentConfig:quizzesTable.assessmentConfig })
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  // All completed assignments + their attempt IDs + student names
  const completedRows = await db
    .select({
      assignmentId: quizAssignmentsTable.id,
      studentId:   quizAssignmentsTable.studentId,
      studentName: usersTable.fullName,
      attemptId:   quizAttemptsTable.id,
      attemptSequence: quizAttemptsTable.attemptSequence,
      completedAt: quizAttemptsTable.completedAt,
    })
    .from(quizAssignmentsTable)
    .innerJoin(usersTable,       eq(usersTable.id,       quizAssignmentsTable.studentId))
    .innerJoin(quizAttemptsTable, eq(quizAttemptsTable.quizAssignmentId, quizAssignmentsTable.id))
    .where(and(
      eq(quizAssignmentsTable.quizId, quizId),
      isNotNull(quizAttemptsTable.completedAt),
    ));

  const latestCompletedRows = collapseToLatestCompletedAttempt(completedRows);
  const participantCount = latestCompletedRows.length;
  if (participantCount === 0) {
    res.json({ quizId, participantCount: 0, commonErrors: [],
      teacherRecommendations: { classLevel: [], individual: [] } });
    return;
  }

  const attemptIds = latestCompletedRows.map((r) => r.attemptId);
  const studentIds = [...new Set(latestCompletedRows.map((r) => r.studentId))];
  const attemptToStudent = new Map(latestCompletedRows.map((r) => [r.attemptId, r.studentId]));
  const studentInfo      = new Map(latestCompletedRows.map((r) => [r.studentId, r.studentName]));

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
    .select({ id: quizzesTable.id, assessmentConfig:quizzesTable.assessmentConfig })
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
