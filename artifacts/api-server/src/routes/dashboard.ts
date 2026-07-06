import { Router } from "express";
import { db, studentProgressTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

const router = Router();

router.get("/dashboard", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const rows = await db
    .select()
    .from(studentProgressTable)
    .where(eq(studentProgressTable.userId, userId))
    .orderBy(studentProgressTable.createdAt);

  const completed = rows.filter((r) => r.status === "completed");
  const pending = rows.filter((r) => r.status === "pending");

  const averageScore =
    completed.length > 0
      ? completed.reduce((sum, r) => sum + r.score, 0) / completed.length
      : 0;

  const overallProgress =
    rows.length > 0 ? (completed.length / rows.length) * 100 : 0;

  const subjectMap = new Map<
    string,
    { completed: number; total: number; scores: number[] }
  >();

  for (const row of rows) {
    if (!subjectMap.has(row.subject)) {
      subjectMap.set(row.subject, { completed: 0, total: 0, scores: [] });
    }
    const entry = subjectMap.get(row.subject)!;
    entry.total++;
    if (row.status === "completed") {
      entry.completed++;
      entry.scores.push(row.score);
    }
  }

  let subjectId = 1;
  const subjects = Array.from(subjectMap.entries()).map(([subject, data]) => ({
    id: subjectId++,
    subject,
    completedLessons: data.completed,
    totalLessons: data.total,
    averageScore:
      data.scores.length > 0
        ? data.scores.reduce((a, b) => a + b, 0) / data.scores.length
        : 0,
    progressPercent: data.total > 0 ? (data.completed / data.total) * 100 : 0,
  }));

  const recentActivity = rows
    .slice(-3)
    .reverse()
    .map((r) => ({
      id: r.id,
      subject: r.subject,
      lesson: r.lesson,
      score: r.score,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));

  res.json({
    stats: {
      completedLessons: completed.length,
      averageScore: Math.round(averageScore * 10) / 10,
      pendingHomework: pending.length,
      overallProgress: Math.round(overallProgress * 10) / 10,
    },
    subjects,
    recentActivity,
  });
});

router.get("/dashboard/progress", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const rows = await db
    .select()
    .from(studentProgressTable)
    .where(eq(studentProgressTable.userId, userId));

  const subjectMap = new Map<
    string,
    { completed: number; total: number; scores: number[] }
  >();

  for (const row of rows) {
    if (!subjectMap.has(row.subject)) {
      subjectMap.set(row.subject, { completed: 0, total: 0, scores: [] });
    }
    const entry = subjectMap.get(row.subject)!;
    entry.total++;
    if (row.status === "completed") {
      entry.completed++;
      entry.scores.push(row.score);
    }
  }

  let id = 1;
  const result = Array.from(subjectMap.entries()).map(([subject, data]) => ({
    id: id++,
    subject,
    completedLessons: data.completed,
    totalLessons: data.total,
    averageScore:
      data.scores.length > 0
        ? Math.round(
            (data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10
          ) / 10
        : 0,
    progressPercent:
      data.total > 0
        ? Math.round((data.completed / data.total) * 1000) / 10
        : 0,
  }));

  res.json(result);
});

router.get(
  "/dashboard/recent-activity",
  requireAuth,
  async (req: AuthRequest, res) => {
    const userId = req.userId!;

    const rows = await db
      .select()
      .from(studentProgressTable)
      .where(eq(studentProgressTable.userId, userId))
      .orderBy(studentProgressTable.createdAt);

    const recent = rows.slice(-10).reverse().map((r) => ({
      id: r.id,
      subject: r.subject,
      lesson: r.lesson,
      score: r.score,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));

    res.json(recent);
  }
);

export default router;
