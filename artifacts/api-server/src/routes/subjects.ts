import { Router } from "express";
import { db, subjectsTable, studentProgressTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
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

  const rows = await db
    .select()
    .from(studentProgressTable)
    .where(
      and(
        eq(studentProgressTable.userId, req.userId!),
        eq(studentProgressTable.subject, subject.name)
      )
    )
    .orderBy(studentProgressTable.createdAt);

  const completed = rows.filter((r) => r.status === "completed");
  const averageScore =
    completed.length > 0
      ? Math.round(
          (completed.reduce((s, r) => s + r.score, 0) / completed.length) * 10
        ) / 10
      : 0;
  const progressPercent =
    rows.length > 0
      ? Math.round((completed.length / rows.length) * 1000) / 10
      : 0;

  res.json({
    id: subject.id,
    name: subject.name,
    grade: subject.grade,
    description: subject.description,
    progressPercent,
    completedLessons: completed.length,
    totalLessons: rows.length,
    averageScore,
    lessons: rows.map((r) => ({
      id: r.id,
      lesson: r.lesson,
      score: r.score,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
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

    const { lesson, score = 0, status = "pending" } = req.body as {
      lesson: string;
      score?: number;
      status?: string;
    };

    if (!lesson) {
      res.status(400).json({ error: "lesson is required" });
      return;
    }

    const existing = await db
      .select()
      .from(studentProgressTable)
      .where(
        and(
          eq(studentProgressTable.userId, req.userId!),
          eq(studentProgressTable.subject, subject.name),
          eq(studentProgressTable.lesson, lesson)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await db
        .update(studentProgressTable)
        .set({ score, status })
        .where(eq(studentProgressTable.id, existing[0].id))
        .returning();
      res.json({
        id: updated.id,
        subject: updated.subject,
        lesson: updated.lesson,
        score: updated.score,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
      });
    } else {
      const [created] = await db
        .insert(studentProgressTable)
        .values({
          userId: req.userId!,
          subject: subject.name,
          lesson,
          score,
          status,
        })
        .returning();
      res.json({
        id: created.id,
        subject: created.subject,
        lesson: created.lesson,
        score: created.score,
        status: created.status,
        createdAt: created.createdAt.toISOString(),
      });
    }
  }
);

export default router;
