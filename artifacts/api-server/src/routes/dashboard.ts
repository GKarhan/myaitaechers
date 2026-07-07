import { Router } from "express";
import {
  db,
  studentProgressTable,
  subjectsTable,
  lessonsTable,
  lessonSessionsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

const router = Router();

router.get("/dashboard", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const progressRows = await db
    .select()
    .from(studentProgressTable)
    .where(eq(studentProgressTable.userId, userId))
    .orderBy(studentProgressTable.createdAt);

  const completed = progressRows.filter((r) => r.status === "completed");
  const pending = progressRows.filter((r) => r.status === "pending");

  const averageScore =
    completed.length > 0
      ? completed.reduce((sum, r) => sum + r.score, 0) / completed.length
      : 0;

  const subjectRows = await db
    .select({
      id: subjectsTable.id,
      name: subjectsTable.name,
      totalLessons: sql<number>`count(distinct ${lessonsTable.id})`,
      completedLessons: sql<number>`count(distinct case when ${lessonSessionsTable.status} = 'completed' then ${lessonsTable.id} end)`,
    })
    .from(subjectsTable)
    .leftJoin(lessonsTable, eq(lessonsTable.subjectId, subjectsTable.id))
    .leftJoin(
      lessonSessionsTable,
      and(
        eq(lessonSessionsTable.lessonId, lessonsTable.id),
        eq(lessonSessionsTable.userId, userId)
      )
    )
    .groupBy(subjectsTable.id, subjectsTable.name)
    .orderBy(subjectsTable.id);

  const subjects = subjectRows.map((row, idx) => {
    const total = Number(row.totalLessons);
    const done = Number(row.completedLessons);
    return {
      id: row.id,
      subject: row.name,
      completedLessons: done,
      totalLessons: total,
      averageScore: 0,
      progressPercent: total > 0 ? Math.round((done / total) * 1000) / 10 : 0,
    };
  });

  const completedFromSessions = subjects.reduce(
    (sum, s) => sum + s.completedLessons,
    0
  );
  const totalFromSessions = subjects.reduce(
    (sum, s) => sum + s.totalLessons,
    0
  );
  const overallProgress =
    totalFromSessions > 0
      ? Math.round((completedFromSessions / totalFromSessions) * 1000) / 10
      : 0;

  const recentActivity = progressRows
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
      completedLessons: completedFromSessions,
      averageScore: Math.round(averageScore * 10) / 10,
      pendingHomework: pending.length,
      overallProgress,
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
