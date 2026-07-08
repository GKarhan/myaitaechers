import { Router } from "express";
import { db, subjectsTable, lessonsTable, lessonSessionsTable, booksTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

const router = Router();

router.get("/subjects", requireAuth, async (req: AuthRequest, res) => {
  const subjects = await db.select().from(subjectsTable).orderBy(subjectsTable.id);
  res.json(
    subjects.map((s) => ({
      id: s.id,
      name: s.name,
      grade: s.grade,
      description: s.description,
    }))
  );
});

router.get("/subjects/:subjectId", requireAuth, async (req: AuthRequest, res) => {
  const subjectId = parseInt(String(req.params.subjectId), 10);
  if (isNaN(subjectId)) {
    res.status(400).json({ error: "Invalid subject id" });
    return;
  }

  const [subject] = await db
    .select()
    .from(subjectsTable)
    .where(eq(subjectsTable.id, subjectId))
    .limit(1);

  if (!subject) {
    res.status(404).json({ error: "Subject not found" });
    return;
  }

  const lessons = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.subjectId, subjectId))
    .orderBy(lessonsTable.lessonNumber);

  const lessonIds = lessons.map((l) => l.id);
  const sessions =
    lessonIds.length > 0
      ? await db
          .select()
          .from(lessonSessionsTable)
          .where(
            and(
              eq(lessonSessionsTable.userId, req.userId!),
              inArray(lessonSessionsTable.lessonId, lessonIds)
            )
          )
      : [];

  const sessionMap = new Map(sessions.map((s) => [s.lessonId, s]));

  const lessonList = lessons.map((l) => {
    const session = sessionMap.get(l.id);
    const status = session
      ? session.status === "completed"
        ? "completed"
        : "pending"
      : "not_started";
    return {
      id: l.id,
      lesson: l.title,
      lessonNumber: l.lessonNumber ?? null,
      status,
      score: 0,
    };
  });

  const completed = lessonList.filter((l) => l.status === "completed").length;
  const total = lessonList.length;
  const progressPercent =
    total > 0 ? Math.round((completed / total) * 1000) / 10 : 0;

  const [book] = await db
    .select()
    .from(booksTable)
    .where(eq(booksTable.subjectId, subjectId))
    .limit(1);

  res.json({
    id: subject.id,
    name: subject.name,
    grade: subject.grade,
    description: subject.description,
    progressPercent,
    completedLessons: completed,
    totalLessons: total,
    averageScore: 0,
    lessons: lessonList,
    book: book
      ? {
          id: book.id,
          name: book.name,
          fileSize: book.fileSize,
          mimeType: book.mimeType,
          uploadedAt: book.uploadedAt.toISOString(),
        }
      : null,
  });
});

router.post(
  "/subjects/:subjectId/start-lesson",
  requireAuth,
  async (req: AuthRequest, res) => {
    const subjectId = parseInt(String(req.params.subjectId), 10);
    if (isNaN(subjectId)) {
      res.status(400).json({ error: "Invalid subject id" });
      return;
    }

    const [subject] = await db
      .select()
      .from(subjectsTable)
      .where(eq(subjectsTable.id, subjectId))
      .limit(1);

    if (!subject) {
      res.status(404).json({ error: "Subject not found" });
      return;
    }

    const { lessonId } = req.body as { lessonId?: number };
    if (!lessonId) {
      res.status(400).json({ error: "lessonId is required" });
      return;
    }

    const [existing] = await db
      .select()
      .from(lessonSessionsTable)
      .where(
        and(
          eq(lessonSessionsTable.userId, req.userId!),
          eq(lessonSessionsTable.lessonId, lessonId)
        )
      )
      .limit(1);

    if (existing) {
      res.json({ id: existing.id, lessonId: existing.lessonId, status: existing.status });
      return;
    }

    const [created] = await db
      .insert(lessonSessionsTable)
      .values({ userId: req.userId!, lessonId, currentPhase: 1, status: "active" })
      .returning();

    res.json({ id: created.id, lessonId: created.lessonId, status: created.status });
  }
);

export default router;
