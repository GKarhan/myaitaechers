import { Router } from "express";
import { db, subjectsTable, lessonsTable, lessonSessionsTable, booksTable, resourcesTable, coursesTable } from "@workspace/db";
import { eq, and, inArray, desc, isNotNull } from "drizzle-orm";
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
      masteryScore: session?.masteryScore ?? null,
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

  // Fall back to textbook resources uploaded by teachers
  let resourceBook: { id: number; title: string; fileSize: number | null; fileName: string | null; fileUrl: string | null; createdAt: Date } | null = null;
  if (!book) {
    const matchingCourses = await db
      .select({ id: coursesTable.id })
      .from(coursesTable)
      .where(eq(coursesTable.name, subject.name));

    if (matchingCourses.length > 0) {
      const courseIds = matchingCourses.map((c) => c.id);
      const [res2] = await db
        .select()
        .from(resourcesTable)
        .where(
          and(
            inArray(resourcesTable.courseId, courseIds),
            isNotNull(resourcesTable.fileUrl)
          )
        )
        .orderBy(desc(resourcesTable.createdAt))
        .limit(1);
      if (res2) resourceBook = res2;
    }
  }

  const averageScore =
    sessions.length > 0
      ? Math.round(
          sessions.reduce((acc, s) => acc + (s.masteryScore ?? 0), 0) / sessions.length
        )
      : 0;

  const bookData = book
    ? {
        id: book.id,
        name: book.name,
        fileUrl: book.filePath,
        fileSize: book.fileSize,
        mimeType: book.mimeType,
        uploadedAt: book.uploadedAt.toISOString(),
      }
    : resourceBook
    ? {
        id: resourceBook.id,
        name: resourceBook.title,
        fileUrl: resourceBook.fileUrl,
        fileSize: resourceBook.fileSize,
        mimeType: "application/pdf",
        uploadedAt: resourceBook.createdAt.toISOString(),
      }
    : null;

  res.json({
    id: subject.id,
    name: subject.name,
    grade: subject.grade,
    description: subject.description,
    progressPercent,
    completedLessons: completed,
    totalLessons: total,
    averageScore,
    lessons: lessonList,
    book: bookData,
  });
});

export default router;
