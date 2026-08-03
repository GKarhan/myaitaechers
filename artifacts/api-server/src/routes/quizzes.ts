import { Router } from "express";
import {
  db,
  quizzesTable,
  quizQuestionsTable,
  quizAssignmentsTable,
  classStudentsTable,
  lessonNodesTable,
} from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";
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
    sourceBookId,
    lessonIds,   // array of lesson ids — route maps to nodeIds internally
    nodeIds: explicitNodeIds,
    questionCount = 10,
    difficultyMode = "MIXED",
    title,
  } = req.body as {
    subjectId?: number;
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

export default router;
