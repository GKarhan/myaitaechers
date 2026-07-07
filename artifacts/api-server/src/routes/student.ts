import { Router } from "express";
import { db, usersTable, teachersTable, classesTable, classStudentsTable, scheduleTable, homeworkTable, lessonsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

const router = Router();

// GET /api/student/schedule — student's weekly schedule via enrolled classes
router.get("/student/schedule", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const enrollments = await db
    .select({ classId: classStudentsTable.classId })
    .from(classStudentsTable)
    .where(eq(classStudentsTable.studentId, userId));

  if (enrollments.length === 0) { res.json([]); return; }

  const classIds = enrollments.map((e) => e.classId);

  const rows = await db
    .select({
      id: scheduleTable.id,
      classId: scheduleTable.classId,
      className: classesTable.name,
      grade: classesTable.grade,
      day: scheduleTable.day,
      time: scheduleTable.time,
      subject: scheduleTable.subject,
      teacherName: usersTable.fullName,
    })
    .from(scheduleTable)
    .innerJoin(classesTable, eq(scheduleTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .innerJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(inArray(scheduleTable.classId, classIds));

  res.json(rows);
});

// GET /api/student/teachers — student's teachers via enrolled classes
router.get("/student/teachers", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const enrollments = await db
    .select({ classId: classStudentsTable.classId })
    .from(classStudentsTable)
    .where(eq(classStudentsTable.studentId, userId));

  if (enrollments.length === 0) { res.json([]); return; }

  const classIds = enrollments.map((e) => e.classId);

  const rows = await db
    .select({
      teacherId: teachersTable.id,
      teacherName: usersTable.fullName,
      subject: teachersTable.subject,
      school: teachersTable.school,
      classId: classesTable.id,
      className: classesTable.name,
    })
    .from(classesTable)
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .innerJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(inArray(classesTable.id, classIds));

  res.json(rows);
});

// GET /api/student/homework-summary — pending/graded counts from homework table
router.get("/student/homework-summary", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const hw = await db
    .select({
      id: homeworkTable.id,
      lessonId: homeworkTable.lessonId,
      lessonTitle: lessonsTable.title,
      title: homeworkTable.title,
      task: homeworkTable.task,
      status: homeworkTable.status,
      score: homeworkTable.score,
      feedback: homeworkTable.feedback,
      answer: homeworkTable.answer,
      submittedAt: homeworkTable.submittedAt,
      createdAt: homeworkTable.createdAt,
    })
    .from(homeworkTable)
    .innerJoin(lessonsTable, eq(homeworkTable.lessonId, lessonsTable.id))
    .where(eq(homeworkTable.studentId, userId))
    .orderBy(homeworkTable.createdAt);

  const notSubmitted = hw.filter((h) => h.status === "not_submitted").length;
  const pending = hw.filter((h) => h.status === "pending").length;
  const graded = hw.filter((h) => h.status === "graded").length;
  const gradedItems = hw.filter((h) => h.score !== null);
  const avgScore = gradedItems.length > 0
    ? Math.round(gradedItems.reduce((s, h) => s + (h.score ?? 0), 0) / gradedItems.length)
    : null;

  res.json({ notSubmitted, pending, graded, avgScore, items: hw });
});

export default router;
