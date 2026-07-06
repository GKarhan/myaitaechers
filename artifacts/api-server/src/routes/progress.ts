import { Router } from "express";
import {
  db,
  lessonsTable,
  lessonSessionsTable,
  subjectsTable,
  knowledgeTopicsTable,
  homeworkTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";

const router = Router();

function masteryLevel(pct: number): "mastered" | "review" | "not_started" {
  if (pct >= 80) return "mastered";
  if (pct >= 50) return "review";
  return "not_started";
}

router.get("/progress", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const allSubjects = await db.select().from(subjectsTable).orderBy(subjectsTable.id);
  const allLessons = await db.select().from(lessonsTable).orderBy(lessonsTable.id);
  const sessions = await db
    .select()
    .from(lessonSessionsTable)
    .where(eq(lessonSessionsTable.userId, userId));
  const homeworks = await db
    .select()
    .from(homeworkTable)
    .where(eq(homeworkTable.studentId, userId));

  const sessionMap = new Map(sessions.map((s) => [s.lessonId, s]));
  const hwByLesson = new Map<number, typeof homeworks[0][]>();
  for (const hw of homeworks) {
    if (!hwByLesson.has(hw.lessonId)) hwByLesson.set(hw.lessonId, []);
    hwByLesson.get(hw.lessonId)!.push(hw);
  }

  let totalCompleted = 0;
  let totalActive = 0;
  const scoreList: number[] = [];
  let lastActivityDate: Date | null = null;

  const subjectItems = allSubjects.map((subj) => {
    const subjLessons = allLessons.filter((l) => l.subjectId === subj.id);
    let completed = 0;
    const subjScores: number[] = [];

    for (const lesson of subjLessons) {
      const sess = sessionMap.get(lesson.id);
      if (sess?.status === "completed") {
        completed++;
        const hwArr = hwByLesson.get(lesson.id) ?? [];
        const gradedHw = hwArr.find((h) => h.status === "graded" && h.score !== null);
        if (gradedHw?.score != null) subjScores.push(gradedHw.score);
        if (sess.completedAt && (!lastActivityDate || sess.completedAt > lastActivityDate))
          lastActivityDate = sess.completedAt;
      } else if (sess?.status === "active") {
        totalActive++;
        if (sess.startedAt && (!lastActivityDate || sess.startedAt > lastActivityDate))
          lastActivityDate = sess.startedAt;
      }
    }

    totalCompleted += completed;
    scoreList.push(...subjScores);

    const total = subjLessons.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const avg =
      subjScores.length > 0
        ? Math.round(subjScores.reduce((a, b) => a + b, 0) / subjScores.length)
        : 0;

    return {
      id: subj.id,
      name: subj.name,
      grade: subj.grade,
      progressPercent: pct,
      completedLessons: completed,
      totalLessons: total,
      averageScore: avg,
      masteryLevel: masteryLevel(pct),
    };
  });

  const totalLessons = allLessons.length;
  const overallPercent =
    totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0;
  const averageScore =
    scoreList.length > 0
      ? Math.round(scoreList.reduce((a, b) => a + b, 0) / scoreList.length)
      : 0;
  const masteredSubjects = subjectItems.filter((s) => s.masteryLevel === "mastered");
  const masteryPercent =
    subjectItems.length > 0
      ? Math.round((masteredSubjects.length / subjectItems.length) * 100)
      : 0;

  res.json({
    overallPercent,
    averageScore,
    masteryPercent,
    completedLessons: totalCompleted,
    activeLessons: totalActive,
    totalLessons,
    lastActivity: (lastActivityDate as Date | null)?.toISOString() ?? null,
    subjects: subjectItems,
  });
});

router.get("/progress/subject/:subjectId", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
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
    .orderBy(lessonsTable.id);

  const sessions = await db
    .select()
    .from(lessonSessionsTable)
    .where(eq(lessonSessionsTable.userId, userId));

  const homeworks = await db
    .select()
    .from(homeworkTable)
    .where(eq(homeworkTable.studentId, userId));

  const topics = await db
    .select()
    .from(knowledgeTopicsTable)
    .where(
      and(
        eq(knowledgeTopicsTable.subjectId, subjectId),
        eq(knowledgeTopicsTable.userId, userId)
      )
    );

  const sessionMap = new Map(sessions.map((s) => [s.lessonId, s]));
  const hwByLesson = new Map<number, typeof homeworks[0][]>();
  for (const hw of homeworks) {
    if (!hwByLesson.has(hw.lessonId)) hwByLesson.set(hw.lessonId, []);
    hwByLesson.get(hw.lessonId)!.push(hw);
  }

  const lessonItems = lessons.map((lesson) => {
    const sess = sessionMap.get(lesson.id);
    const hwArr = hwByLesson.get(lesson.id) ?? [];
    const gradedHw = hwArr.find((h) => h.status === "graded" && h.score !== null);
    const pendingHw = hwArr.find((h) => h.status === "pending");
    const status = sess?.status ?? "not_started";
    const score = gradedHw?.score ?? null;

    return {
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      bloomLevel: lesson.bloomLevel,
      status,
      currentPhase: sess?.currentPhase ?? 0,
      score,
      hasHomework: hwArr.length > 0,
      homeworkStatus: hwArr.length > 0
        ? (gradedHw ? "graded" : pendingHw ? "pending" : "not_submitted")
        : null,
      startedAt: sess?.startedAt?.toISOString() ?? null,
      completedAt: sess?.completedAt?.toISOString() ?? null,
    };
  });

  const completed = lessonItems.filter((l) => l.status === "completed").length;
  const progressPercent =
    lessons.length > 0 ? Math.round((completed / lessons.length) * 100) : 0;
  const scores = lessonItems.filter((l) => l.score !== null).map((l) => l.score as number);
  const averageScore =
    scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  const topicItems = topics.map((t) => ({
    id: t.id,
    topicName: t.topicName,
    score: t.score,
    status: t.status,
    masteryLevel: masteryLevel(t.score),
  }));

  res.json({
    id: subject.id,
    name: subject.name,
    grade: subject.grade,
    description: subject.description,
    progressPercent,
    completedLessons: completed,
    totalLessons: lessons.length,
    averageScore,
    masteryLevel: masteryLevel(progressPercent),
    lessons: lessonItems,
    topics: topicItems,
  });
});

router.get("/progress/recommendations", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const allSubjects = await db.select().from(subjectsTable).orderBy(subjectsTable.id);
  const allLessons = await db.select().from(lessonsTable).orderBy(lessonsTable.id);
  const sessions = await db
    .select()
    .from(lessonSessionsTable)
    .where(eq(lessonSessionsTable.userId, userId));

  const sessionMap = new Map(sessions.map((s) => [s.lessonId, s]));

  const subjectSummary = allSubjects.map((subj) => {
    const subjLessons = allLessons.filter((l) => l.subjectId === subj.id);
    const completed = subjLessons.filter(
      (l) => sessionMap.get(l.id)?.status === "completed"
    ).length;
    const active = subjLessons.filter(
      (l) => sessionMap.get(l.id)?.status === "active"
    ).length;
    const pct =
      subjLessons.length > 0 ? Math.round((completed / subjLessons.length) * 100) : 0;
    return { name: subj.name, pct, completed, total: subjLessons.length, active };
  });

  const summaryText = subjectSummary
    .map(
      (s) =>
        `${s.name}: ${s.pct}% (${s.completed}/${s.total} դաս ավարտված, ${s.active} ակտիվ)`
    )
    .join("\n");

  try {
    const completion = await openrouter.chat.completions.create({
      model: "deepseek/deepseek-chat-v3-0324",
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content: `Դու myaiteacher-ի AI ուսուցչական խորհրդատուն ես։ Վերլուծիր ուսանողի առաջընթացը և տուր 3-5 կոնկրետ, կարճ, հայերեն խորհուրդ։
Պատասխանիր ԲԱՑԱՌԱՊԵՍ վավեր JSON-ով.
{
  "recommendations": [
    { "type": "start"|"review"|"ready"|"improve", "subjectName": "...", "message": "հայերեն 1 նախ." }
  ]
}`,
        },
        {
          role: "user",
          content: `Ուսանողի առաջընթացը.\n${summaryText}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    let parsed: { recommendations: { type: string; subjectName: string; message: string }[] };
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch?.[0] ?? raw);
    } catch {
      logger.error({ raw }, "Progress recommendations: failed to parse JSON");
      res.status(500).json({ error: "AI returned invalid response" });
      return;
    }

    res.json({ recommendations: parsed.recommendations ?? [] });
  } catch (err) {
    logger.error({ err }, "Progress recommendations error");
    res.status(500).json({ error: "AI recommendations failed" });
  }
});

export default router;
