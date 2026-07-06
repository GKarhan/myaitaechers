import { Router } from "express";
import { db, homeworkTable, lessonsTable, subjectsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";

const router = Router();

const LEVEL_LABELS: Record<string, string> = {
  weak: "Թույլ",
  medium: "Միջին",
  strong: "Ուժեղ",
};

function homeworkItem(
  hw: typeof homeworkTable.$inferSelect,
  lesson: { title: string },
  subject: { name: string }
) {
  return {
    id: hw.id,
    lessonId: hw.lessonId,
    lessonTitle: lesson.title,
    subjectName: subject.name,
    title: hw.title,
    task: hw.task,
    level: hw.level,
    status: hw.status,
    score: hw.score ?? null,
    submittedAt: hw.submittedAt?.toISOString() ?? null,
    gradedAt: hw.gradedAt?.toISOString() ?? null,
    createdAt: hw.createdAt.toISOString(),
  };
}

function homeworkDetail(
  hw: typeof homeworkTable.$inferSelect,
  lesson: { title: string },
  subject: { name: string }
) {
  return {
    ...homeworkItem(hw, lesson, subject),
    answer: hw.answer ?? null,
    fileUrl: hw.fileUrl ?? null,
    feedback: hw.feedback ?? null,
  };
}

router.get("/homework", requireAuth, async (req: AuthRequest, res) => {
  const rows = await db
    .select({
      hw: homeworkTable,
      lessonTitle: lessonsTable.title,
      subjectName: subjectsTable.name,
    })
    .from(homeworkTable)
    .innerJoin(lessonsTable, eq(homeworkTable.lessonId, lessonsTable.id))
    .innerJoin(subjectsTable, eq(lessonsTable.subjectId, subjectsTable.id))
    .where(eq(homeworkTable.studentId, req.userId!))
    .orderBy(homeworkTable.createdAt);

  res.json(
    rows.map((r) =>
      homeworkItem(r.hw, { title: r.lessonTitle }, { name: r.subjectName })
    )
  );
});

router.get("/homework/:homeworkId", requireAuth, async (req: AuthRequest, res) => {
  const homeworkId = parseInt(String(req.params.homeworkId), 10);
  if (isNaN(homeworkId)) {
    res.status(400).json({ error: "Invalid homework id" });
    return;
  }

  const [row] = await db
    .select({
      hw: homeworkTable,
      lessonTitle: lessonsTable.title,
      subjectName: subjectsTable.name,
    })
    .from(homeworkTable)
    .innerJoin(lessonsTable, eq(homeworkTable.lessonId, lessonsTable.id))
    .innerJoin(subjectsTable, eq(lessonsTable.subjectId, subjectsTable.id))
    .where(
      and(
        eq(homeworkTable.id, homeworkId),
        eq(homeworkTable.studentId, req.userId!)
      )
    )
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Homework not found" });
    return;
  }

  res.json(homeworkDetail(row.hw, { title: row.lessonTitle }, { name: row.subjectName }));
});

router.post("/homework/:homeworkId/submit", requireAuth, async (req: AuthRequest, res) => {
  const homeworkId = parseInt(String(req.params.homeworkId), 10);
  if (isNaN(homeworkId)) {
    res.status(400).json({ error: "Invalid homework id" });
    return;
  }

  const { answer } = req.body as { answer?: string };
  if (!answer || !answer.trim()) {
    res.status(400).json({ error: "Answer is required" });
    return;
  }

  const [row] = await db
    .select({
      hw: homeworkTable,
      lessonTitle: lessonsTable.title,
      subjectName: subjectsTable.name,
    })
    .from(homeworkTable)
    .innerJoin(lessonsTable, eq(homeworkTable.lessonId, lessonsTable.id))
    .innerJoin(subjectsTable, eq(lessonsTable.subjectId, subjectsTable.id))
    .where(
      and(
        eq(homeworkTable.id, homeworkId),
        eq(homeworkTable.studentId, req.userId!)
      )
    )
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Homework not found" });
    return;
  }

  if (row.hw.status !== "not_submitted") {
    res.status(400).json({ error: "Homework has already been submitted" });
    return;
  }

  const [updated] = await db
    .update(homeworkTable)
    .set({
      answer: answer.trim(),
      status: "pending",
      submittedAt: new Date(),
    })
    .where(eq(homeworkTable.id, homeworkId))
    .returning();

  res.json(homeworkDetail(updated, { title: row.lessonTitle }, { name: row.subjectName }));
});

router.post("/homework/:homeworkId/grade", requireAuth, async (req: AuthRequest, res) => {
  const homeworkId = parseInt(String(req.params.homeworkId), 10);
  if (isNaN(homeworkId)) {
    res.status(400).json({ error: "Invalid homework id" });
    return;
  }

  const { score, feedback } = req.body as { score?: number; feedback?: string };
  if (score === undefined || score === null || isNaN(Number(score))) {
    res.status(400).json({ error: "score (0-100) is required" });
    return;
  }
  const numScore = Math.min(100, Math.max(0, Number(score)));

  const [row] = await db
    .select({
      hw: homeworkTable,
      lessonTitle: lessonsTable.title,
      subjectName: subjectsTable.name,
    })
    .from(homeworkTable)
    .innerJoin(lessonsTable, eq(homeworkTable.lessonId, lessonsTable.id))
    .innerJoin(subjectsTable, eq(lessonsTable.subjectId, subjectsTable.id))
    .where(eq(homeworkTable.id, homeworkId))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Homework not found" });
    return;
  }

  if (row.hw.status === "not_submitted") {
    res.status(400).json({ error: "Cannot grade homework that has not been submitted" });
    return;
  }

  const [updated] = await db
    .update(homeworkTable)
    .set({
      score: numScore,
      feedback: feedback?.trim() ?? null,
      status: "graded",
      gradedAt: new Date(),
    })
    .where(eq(homeworkTable.id, homeworkId))
    .returning();

  res.json(homeworkDetail(updated, { title: row.lessonTitle }, { name: row.subjectName }));
});

router.post("/homework/:homeworkId/ai-grade-suggest", requireAuth, async (req: AuthRequest, res) => {
  const homeworkId = parseInt(String(req.params.homeworkId), 10);
  if (isNaN(homeworkId)) {
    res.status(400).json({ error: "Invalid homework id" });
    return;
  }

  const [row] = await db
    .select({
      hw: homeworkTable,
      lessonTitle: lessonsTable.title,
      subjectName: subjectsTable.name,
    })
    .from(homeworkTable)
    .innerJoin(lessonsTable, eq(homeworkTable.lessonId, lessonsTable.id))
    .innerJoin(subjectsTable, eq(lessonsTable.subjectId, subjectsTable.id))
    .where(eq(homeworkTable.id, homeworkId))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Homework not found" });
    return;
  }

  if (!row.hw.answer) {
    res.status(400).json({ error: "Homework has not been submitted yet" });
    return;
  }

  const levelLabel = LEVEL_LABELS[row.hw.level] ?? row.hw.level;

  try {
    const completion = await openrouter.chat.completions.create({
      model: "deepseek/deepseek-chat-v3-0324",
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content: `Դու myaiteacher-ի AI գնահատող ուսուցիչն ես։
Քո խնդիրն է գնահատել աշակերտի տնային աշխատանքը։
Պատասխանիր ԲԱՑԱՌԱՊԵՍ վավեր JSON-ով — ոչ մի բացատրություն, ոչ markdown:
{ "score": <0-100 ամբողջ թիվ>, "feedback": "<հայերեն մեկնաբանություն 1-3 նախ.>" }`,
        },
        {
          role: "user",
          content: `Դաս: ${row.lessonTitle} (${row.subjectName})
Մակարդակ: ${levelLabel}
Հանձնարարություն: ${row.hw.task}
Աշակերտի պատասխանը: ${row.hw.answer}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    let parsed: { score: number; feedback: string };
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch?.[0] ?? raw);
    } catch {
      logger.error({ raw }, "AI grade suggest: failed to parse JSON");
      res.status(500).json({ error: "AI returned invalid response" });
      return;
    }

    res.json({
      score: Math.min(100, Math.max(0, Math.round(Number(parsed.score)))),
      feedback: String(parsed.feedback),
    });
  } catch (err) {
    logger.error({ err }, "AI grade suggest error");
    res.status(500).json({ error: "AI grading failed" });
  }
});

export default router;
