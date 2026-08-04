import { Router } from "express";
import {
  db,
  quizzesTable,
  quizQuestionsTable,
  quizAssignmentsTable,
  quizAttemptsTable,
  quizAnswersTable,
  classStudentsTable,
  lessonNodesTable,
  usersTable,
} from "@workspace/db";
import { eq, and, asc, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, requireTeacher, type AuthRequest } from "../middlewares/auth";
import { generateQuizQuestions } from "../services/quiz-generation";
import { logger } from "../lib/logger";

const router = Router();

// ── POST /api/quizzes ─────────────────────────────────────────────────────────
// Create a DRAFT quiz, generate questions from the given lesson nodes, persist,
// then set status = GENERATED. Returns the full quiz with questions.
router.post("/quizzes", requireTeacher, async (req: AuthRequest, res) => {
  const {
    subjectId,
    classId,
    sourceBookId,
    lessonIds,   // array of lesson ids — route maps to nodeIds internally
    nodeIds: explicitNodeIds,
    questionCount = 10,
    difficultyMode = "MIXED",
    title,
  } = req.body as {
    subjectId?: number;
    classId?: number;
    sourceBookId?: number;
    lessonIds?: number[];
    nodeIds?: number[];
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
    })
    .returning();

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
          quizId:             quiz.id,
          nodeId:             q.nodeId,
          questionText:       q.questionText,
          options:            q.options,
          correctOptionIndex: q.correctOptionIndex,
          difficultyLevel:    q.difficultyLevel,
          sequence:           i + 1,
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
    // Roll back the DRAFT record so the teacher can retry cleanly
    await db.delete(quizzesTable).where(eq(quizzesTable.id, quiz.id));
    logger.error({ err, quizId: quiz.id }, "quiz generation failed — DRAFT deleted");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Quiz generation failed, please retry",
    });
  }
});

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
// Teacher: full per-question result for a specific student's completed attempt.
// Same shape as /my-result but scoped to the given studentId.
router.get("/quizzes/:id/results/:studentId", requireTeacher, async (req: AuthRequest, res) => {
  const quizId    = parseInt(String(req.params.id),        10);
  const studentId = parseInt(String(req.params.studentId), 10);
  if (isNaN(quizId) || isNaN(studentId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  // Verify teacher owns this quiz
  const [quiz] = await db
    .select({ id: quizzesTable.id })
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.teacherId, req.userId!)))
    .limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  // Find the student's completed assignment
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

  const answers = await db
    .select({
      questionId:          quizQuestionsTable.id,
      questionText:        quizQuestionsTable.questionText,
      options:             quizQuestionsTable.options,
      correctOptionIndex:  quizQuestionsTable.correctOptionIndex,
      selectedOptionIndex: quizAnswersTable.selectedOptionIndex,
      isCorrect:           quizAnswersTable.isCorrect,
      sequence:            quizQuestionsTable.sequence,
    })
    .from(quizAnswersTable)
    .innerJoin(quizQuestionsTable, eq(quizQuestionsTable.id, quizAnswersTable.questionId))
    .where(eq(quizAnswersTable.attemptId, attempt.id))
    .orderBy(asc(quizQuestionsTable.sequence));

  res.json({
    studentId,
    totalCorrect:   attempt.totalCorrect,
    totalQuestions: attempt.totalQuestions,
    scorePercent:   attempt.scorePercent,
    questions:      answers.map((a) => ({
      questionId:          a.questionId,
      questionText:        a.questionText,
      options:             a.options,
      correctOptionIndex:  a.correctOptionIndex,
      selectedOptionIndex: a.selectedOptionIndex,
      isCorrect:           a.isCorrect,
      sequence:            a.sequence,
    })),
  });
});

// ── GET /api/quizzes/:id/my-result ────────────────────────────────────────────
// Student: full per-question result for their completed attempt on a quiz.
router.get("/quizzes/:id/my-result", requireAuth, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  // Find the student's completed assignment
  const [assignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    quizId),
      eq(quizAssignmentsTable.studentId, req.userId!),
      eq(quizAssignmentsTable.status,    "COMPLETED")
    ))
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

  // Per-question detail: join quiz_answers + quiz_questions
  const answers = await db
    .select({
      questionId:          quizQuestionsTable.id,
      questionText:        quizQuestionsTable.questionText,
      options:             quizQuestionsTable.options,
      correctOptionIndex:  quizQuestionsTable.correctOptionIndex,
      selectedOptionIndex: quizAnswersTable.selectedOptionIndex,
      isCorrect:           quizAnswersTable.isCorrect,
      sequence:            quizQuestionsTable.sequence,
    })
    .from(quizAnswersTable)
    .innerJoin(quizQuestionsTable, eq(quizQuestionsTable.id, quizAnswersTable.questionId))
    .where(eq(quizAnswersTable.attemptId, attempt.id))
    .orderBy(asc(quizQuestionsTable.sequence));

  res.json({
    totalCorrect:   attempt.totalCorrect,
    totalQuestions: attempt.totalQuestions,
    scorePercent:   attempt.scorePercent,
    questions:      answers.map((a) => ({
      questionId:          a.questionId,
      questionText:        a.questionText,
      options:             a.options,
      correctOptionIndex:  a.correctOptionIndex,
      selectedOptionIndex: a.selectedOptionIndex,
      isCorrect:           a.isCorrect,
      sequence:            a.sequence,
    })),
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

  // Create one assignment per student (skip if already exists for this quiz+student)
  const existingAssignments = await db
    .select({ studentId: quizAssignmentsTable.studentId })
    .from(quizAssignmentsTable)
    .where(eq(quizAssignmentsTable.quizId, quizId));
  const alreadyAssigned = new Set(existingAssignments.map((a) => a.studentId));

  const newMembers = members.filter((m) => !alreadyAssigned.has(m.studentId));
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
    alreadyAssigned: alreadyAssigned.size,
  });
});

// ── GET /api/quizzes/:id/take ─────────────────────────────────────────────────
// Student: get questions for a quiz they are assigned to.
// Strips correctOptionIndex. Sets assignment status to IN_PROGRESS.
router.get("/quizzes/:id/take", requireAuth, async (req: AuthRequest, res) => {
  const quizId = parseInt(String(req.params.id), 10);
  if (isNaN(quizId)) { res.status(400).json({ error: "Invalid quiz id" }); return; }

  // Verify assignment
  const [assignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    quizId),
      eq(quizAssignmentsTable.studentId, req.userId!)
    ))
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

  // Verify assignment belongs to req.userId
  const [assignment] = await db
    .select()
    .from(quizAssignmentsTable)
    .where(and(
      eq(quizAssignmentsTable.quizId,    quizId),
      eq(quizAssignmentsTable.studentId, req.userId!)
    ))
    .limit(1);

  if (!assignment) {
    res.status(403).json({ error: "No assignment found for this quiz" });
    return;
  }
  if (assignment.status === "COMPLETED") {
    res.status(409).json({ error: "Quiz already completed" });
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
});

// ── DELETE /api/quizzes/:id ───────────────────────────────────────────────────
// Remove a teacher-owned quiz. The schema already cascades to quiz_questions,
// quiz_assignments, quiz_attempts, and quiz_answers automatically.
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
