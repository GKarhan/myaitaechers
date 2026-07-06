import { Router } from "express";
import { db, lessonsTable, lessonSessionsTable, subjectsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

const BLOOM_LEVELS = [
  { level: 1, name: "Հիշել", color: "#14B8A6", description: "Փաստերի և հիմնական հասկացությունների վերհիշում" },
  { level: 2, name: "Հասկանալ", color: "#6366F1", description: "Գաղափարների և հասկացությունների բացատրություն" },
  { level: 3, name: "Կիրառել", color: "#6366F1", description: "Գիտելիքների կիրառում նոր իրավիճակներում" },
  { level: 4, name: "Վերլուծել", color: "#F59E0B", description: "Կապերի ու ձևերի հայտնաբերում" },
  { level: 5, name: "Գնահատել", color: "#EF4444", description: "Արդարացում և պաշտպանություն" },
  { level: 6, name: "Ստեղծել", color: "#EF4444", description: "Նոր ստեղծագործական արտադրանք" },
];

const LESSON_PHASES = [
  { phase: 1, title: "Կրկնություն", duration: "5 րոպե", description: "Նախկին գիտելիքների ակտիվացում", activities: ["Հարցուպատասխան", "Ուղղորդված հիշողություն"] },
  { phase: 2, title: "Հիմնական գաղափարներ", duration: "8–10 րոպե", description: "Դասի հիմնական թեմաների ներկայացում", activities: ["Բացատրություն", "Դիագրամ", "Օրինակներ"] },
  { phase: 3, title: "Երկրորդական գաղափարներ", duration: "7–8 րոպե", description: "Ավելի խոր կապեր ու մանրամասներ", activities: ["Համեմատություն", "Կապ նախկինի հետ"] },
  { phase: 4, title: "Գործնական կիրառություն", duration: "8–10 րոպե", description: "Գիտելիքի կիրառում իրական խնդիրների", activities: ["Վարժություններ", "Խնդիրների լուծում"] },
  { phase: 5, title: "Ստեղծագործական աշխատանք", duration: "8–10 րոպե", description: "Ստեղծագործական մտածողության զարգացում", activities: ["Ստեղծել", "Ձևավորել", "Գծել"] },
  { phase: 6, title: "Միկրո նախագիծ", duration: "10–12 րոպե", description: "Փոքր ծրագրի իրականացում", activities: ["Նախագիծ", "Ներկայացում"] },
  { phase: 7, title: "Ամփոփում", duration: "5 րոպե", description: "Ամփոփում եւ ամրապնդում", activities: ["Ամփոփ հարցեր", "Կարևոր կետեր"] },
  { phase: 8, title: "Տնային աշխատանք", duration: "3 մակարդակ", description: "Հոմ ուսուցում 3 մակարդակով", activities: ["Հիմնական", "Ընդլայնված", "Ստեղծագործական"] },
];

const router = Router();

router.get("/lessons/:lessonId", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson id" });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  const [subject] = await db
    .select()
    .from(subjectsTable)
    .where(eq(subjectsTable.id, lesson.subjectId))
    .limit(1);

  const [session] = await db
    .select()
    .from(lessonSessionsTable)
    .where(
      and(
        eq(lessonSessionsTable.lessonId, lessonId),
        eq(lessonSessionsTable.userId, req.userId!)
      )
    )
    .limit(1);

  res.json({
    id: lesson.id,
    subjectId: lesson.subjectId,
    subjectName: subject?.name ?? "",
    title: lesson.title,
    description: lesson.description,
    bloomLevel: lesson.bloomLevel,
    bloomLevels: BLOOM_LEVELS,
    phases: LESSON_PHASES,
    currentSession: session
      ? {
          id: session.id,
          lessonId: session.lessonId,
          currentPhase: session.currentPhase,
          status: session.status,
          startedAt: session.startedAt.toISOString(),
          completedAt: session.completedAt?.toISOString() ?? null,
        }
      : null,
  });
});

router.post("/lessons/start", requireAuth, async (req: AuthRequest, res) => {
  const { lessonId } = req.body as { lessonId: number };
  if (!lessonId) {
    res.status(400).json({ error: "lessonId is required" });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  const existing = await db
    .select()
    .from(lessonSessionsTable)
    .where(
      and(
        eq(lessonSessionsTable.lessonId, lessonId),
        eq(lessonSessionsTable.userId, req.userId!)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const s = existing[0];
    res.status(201).json({
      id: s.id,
      lessonId: s.lessonId,
      currentPhase: s.currentPhase,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      completedAt: s.completedAt?.toISOString() ?? null,
    });
    return;
  }

  const [session] = await db
    .insert(lessonSessionsTable)
    .values({ userId: req.userId!, lessonId, currentPhase: 1, status: "active" })
    .returning();

  res.status(201).json({
    id: session.id,
    lessonId: session.lessonId,
    currentPhase: session.currentPhase,
    status: session.status,
    startedAt: session.startedAt.toISOString(),
    completedAt: null,
  });
});

router.post("/lessons/:lessonId/advance-phase", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);

  const [session] = await db
    .select()
    .from(lessonSessionsTable)
    .where(
      and(
        eq(lessonSessionsTable.lessonId, lessonId),
        eq(lessonSessionsTable.userId, req.userId!)
      )
    )
    .limit(1);

  if (!session) {
    res.status(404).json({ error: "No active session for this lesson" });
    return;
  }

  const nextPhase = session.currentPhase >= 8 ? 8 : session.currentPhase + 1;
  const isComplete = nextPhase === 8 && session.currentPhase === 8;

  const [updated] = await db
    .update(lessonSessionsTable)
    .set({
      currentPhase: nextPhase,
      status: isComplete ? "completed" : "active",
      completedAt: isComplete ? new Date() : null,
    })
    .where(eq(lessonSessionsTable.id, session.id))
    .returning();

  res.json({
    id: updated.id,
    lessonId: updated.lessonId,
    currentPhase: updated.currentPhase,
    status: updated.status,
    startedAt: updated.startedAt.toISOString(),
    completedAt: updated.completedAt?.toISOString() ?? null,
  });
});

export default router;
