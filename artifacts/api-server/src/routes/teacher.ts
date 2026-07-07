import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, teachersTable, classesTable, classStudentsTable, lessonsTable, homeworkTable, scheduleTable } from "@workspace/db";
import { eq, and, inArray, avg, count } from "drizzle-orm";
import { requireTeacher, type AuthRequest } from "../middlewares/auth";

const router = Router();

async function getTeacherForUser(userId: number) {
  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.userId, userId)).limit(1);
  return teacher ?? null;
}

// ─── SCHEDULE ────────────────────────────────────────────────────────────────

router.get("/teacher/schedule", requireTeacher, async (req: AuthRequest, res) => {
  const teacher = await getTeacherForUser(req.userId!);
  if (!teacher) { res.status(404).json({ error: "Teacher not found" }); return; }

  const myClasses = await db.select({ id: classesTable.id }).from(classesTable).where(eq(classesTable.teacherId, teacher.id));
  if (myClasses.length === 0) { res.json([]); return; }

  const classIds = myClasses.map((c) => c.id);
  const rows = await db
    .select({ id: scheduleTable.id, classId: scheduleTable.classId, className: classesTable.name, day: scheduleTable.day, time: scheduleTable.time, subject: scheduleTable.subject })
    .from(scheduleTable)
    .innerJoin(classesTable, eq(scheduleTable.classId, classesTable.id))
    .where(inArray(scheduleTable.classId, classIds));

  res.json(rows);
});

// ─── CLASSES ─────────────────────────────────────────────────────────────────

router.get("/teacher/classes", requireTeacher, async (req: AuthRequest, res) => {
  const teacher = await getTeacherForUser(req.userId!);
  if (!teacher) { res.status(404).json({ error: "Teacher not found" }); return; }

  const classes = await db.select().from(classesTable).where(eq(classesTable.teacherId, teacher.id));

  // Attach student counts
  if (classes.length === 0) { res.json([]); return; }
  const classIds = classes.map((c) => c.id);
  const counts = await db.select({ classId: classStudentsTable.classId, cnt: count() }).from(classStudentsTable).where(inArray(classStudentsTable.classId, classIds)).groupBy(classStudentsTable.classId);
  const countMap = Object.fromEntries(counts.map((c) => [c.classId, Number(c.cnt)]));

  res.json(classes.map((c) => ({ ...c, studentCount: countMap[c.id] ?? 0 })));
});

// ─── STUDENTS ────────────────────────────────────────────────────────────────

router.get("/teacher/classes/:classId/students", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }

  const members = await db
    .select({ id: usersTable.id, username: usersTable.username, fullName: usersTable.fullName, email: usersTable.email, age: usersTable.age, createdAt: usersTable.createdAt })
    .from(classStudentsTable)
    .innerJoin(usersTable, eq(classStudentsTable.studentId, usersTable.id))
    .where(eq(classStudentsTable.classId, classId));

  res.json(members);
});

router.post("/teacher/classes/:classId/students", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }
  const { fullName, email, age } = req.body as { fullName: string; email?: string; age?: number };
  if (!fullName) { res.status(400).json({ error: "fullName պարтадіr e" }); return; }
  const base = email
    ? email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, ".")
    : fullName.toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "");
  let username = base || "student";
  let counter = 1;
  while ((await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username)).limit(1)).length > 0) {
    username = `${base}${counter++}`;
  }
  const passwordHash = await bcrypt.hash("student123", 10);
  const [user] = await db.insert(usersTable).values({ username, passwordHash, fullName, role: "student", email: email ?? null, age: age ?? null }).returning();
  await db.insert(classStudentsTable).values({ classId, studentId: user.id });
  res.status(201).json({ id: user.id, username: user.username, fullName: user.fullName, email: user.email, age: user.age, createdAt: user.createdAt });
});

router.post("/teacher/classes/:classId/students/:studentId/delete", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  const studentId = parseInt(String(req.params.studentId));
  if (isNaN(classId) || isNaN(studentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(classStudentsTable).where(and(eq(classStudentsTable.classId, classId), eq(classStudentsTable.studentId, studentId)));
  res.json({ message: "Ашакерты heracvec dasaranits" });
});

router.get("/teacher/students/:studentId", requireTeacher, async (req: AuthRequest, res) => {
  const studentId = parseInt(String(req.params.studentId));
  if (isNaN(studentId)) { res.status(400).json({ error: "Invalid studentId" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, studentId)).limit(1);
  if (!user) { res.status(404).json({ error: "Student not found" }); return; }
  const hw = await db.select().from(homeworkTable).where(eq(homeworkTable.studentId, studentId));
  const gradedHw = hw.filter((h) => h.score !== null);
  const avgScore = gradedHw.length > 0 ? Math.round(gradedHw.reduce((sum, h) => sum + (h.score ?? 0), 0) / gradedHw.length) : null;
  res.json({ id: user.id, username: user.username, fullName: user.fullName, createdAt: user.createdAt, homework: hw, avgScore });
});

// ─── LESSONS ─────────────────────────────────────────────────────────────────

router.get("/teacher/classes/:classId/lessons", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }
  const rows = await db.select().from(lessonsTable).where(eq(lessonsTable.classId, classId));
  res.json(rows);
});

router.get("/teacher/lessons", requireTeacher, async (req: AuthRequest, res) => {
  const lessons = await db.select().from(lessonsTable).where(eq(lessonsTable.teacherId, req.userId!));
  res.json(lessons);
});

router.post("/teacher/lessons", requireTeacher, async (req: AuthRequest, res) => {
  const { subjectId, classId, title, description, bloomLevel, content } = req.body as {
    subjectId: number; classId?: number; title: string; description?: string; bloomLevel?: number; content?: string;
  };
  if (!subjectId || !title) { res.status(400).json({ error: "subjectId, title парtаdir en" }); return; }
  const [lesson] = await db.insert(lessonsTable).values({ subjectId, title, description: description ?? "", bloomLevel: bloomLevel ?? 1, content: content ?? "", teacherId: req.userId!, classId: classId ?? null }).returning();
  res.status(201).json(lesson);
});

router.put("/teacher/lessons/:id", requireTeacher, async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { title, description, bloomLevel, content } = req.body as { title?: string; description?: string; bloomLevel?: number; content?: string };
  const updated = await db.update(lessonsTable)
    .set({ ...(title && { title }), ...(description !== undefined && { description }), ...(bloomLevel && { bloomLevel }), ...(content !== undefined && { content }) })
    .where(and(eq(lessonsTable.id, id), eq(lessonsTable.teacherId, req.userId!)))
    .returning();
  if (updated.length === 0) { res.status(404).json({ error: "Das chi gtнvel" }); return; }
  res.json(updated[0]);
});

router.post("/teacher/lessons/:id/delete", requireTeacher, async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(lessonsTable).where(and(eq(lessonsTable.id, id), eq(lessonsTable.teacherId, req.userId!)));
  res.json({ message: "Das djnjvec" });
});

// ─── AI LESSON GENERATION ─────────────────────────────────────────────────────

router.post("/teacher/lessons/generate", requireTeacher, async (req: AuthRequest, res) => {
  const { classId, subject, totalLessons = 10 } = req.body as { classId: number; subject: string; totalLessons?: number };
  if (!classId || !subject) { res.status(400).json({ error: "classId, subject пarтаdir en" }); return; }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "AI API key not configured" }); return; }

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "You are an Armenian school teacher assistant. Generate lesson plan titles in Armenian language. Respond with JSON only.",
          },
          {
            role: "user",
            content: `Generate ${totalLessons} lesson titles for the subject "${subject}" for Armenian school students. Return JSON array: [{"title": "...", "description": "...", "bloomLevel": 1-6}]. Bloom levels: 1=Remember, 2=Understand, 3=Apply, 4=Analyze, 5=Evaluate, 6=Create. Use Armenian language for titles and descriptions.`,
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(502).json({ error: "AI service error", detail: errText });
      return;
    }

    const aiData = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = aiData.choices[0]?.message?.content ?? "{}";
    let parsed: { lessons?: Array<{ title: string; description: string; bloomLevel: number }> } = {};
    try { parsed = JSON.parse(content); } catch { parsed = { lessons: [] }; }

    const lessonsArr = parsed.lessons ?? [];

    // Find subjectId or use 1 as fallback
    const { subjectsTable } = await import("@workspace/db");
    const [subjectRow] = await db.select().from(subjectsTable).limit(1);
    const subjectId = subjectRow?.id ?? 1;

    const created = [];
    for (const l of lessonsArr.slice(0, totalLessons)) {
      const [row] = await db.insert(lessonsTable).values({
        subjectId,
        title: l.title,
        description: l.description,
        bloomLevel: l.bloomLevel ?? 1,
        content: "",
        teacherId: req.userId!,
        classId,
      }).returning();
      created.push(row);
    }

    res.status(201).json({ generated: created.length, lessons: created });
  } catch (err: unknown) {
    res.status(500).json({ error: "AI generation failed" });
  }
});

// ─── HOMEWORK ────────────────────────────────────────────────────────────────

router.get("/teacher/classes/:classId/homework", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }

  const classLessons = await db.select({ id: lessonsTable.id, title: lessonsTable.title }).from(lessonsTable).where(and(eq(lessonsTable.classId, classId), eq(lessonsTable.teacherId, req.userId!)));
  if (classLessons.length === 0) { res.json([]); return; }

  const lessonIds = classLessons.map((l) => l.id);
  const hw = await db
    .select({
      id: homeworkTable.id,
      lessonId: homeworkTable.lessonId,
      lessonTitle: lessonsTable.title,
      studentId: homeworkTable.studentId,
      studentName: usersTable.fullName,
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
    .innerJoin(usersTable, eq(homeworkTable.studentId, usersTable.id))
    .innerJoin(lessonsTable, eq(homeworkTable.lessonId, lessonsTable.id))
    .where(inArray(homeworkTable.lessonId, lessonIds));

  res.json(hw);
});

router.get("/teacher/homework", requireTeacher, async (req: AuthRequest, res) => {
  const myLessons = await db.select({ id: lessonsTable.id }).from(lessonsTable).where(eq(lessonsTable.teacherId, req.userId!));
  if (myLessons.length === 0) { res.json([]); return; }
  const lessonIds = myLessons.map((l) => l.id);
  const hw = await db
    .select({
      id: homeworkTable.id,
      lessonId: homeworkTable.lessonId,
      lessonTitle: lessonsTable.title,
      studentId: homeworkTable.studentId,
      studentName: usersTable.fullName,
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
    .innerJoin(usersTable, eq(homeworkTable.studentId, usersTable.id))
    .innerJoin(lessonsTable, eq(homeworkTable.lessonId, lessonsTable.id))
    .where(inArray(homeworkTable.lessonId, lessonIds));
  res.json(hw);
});

router.post("/teacher/homework", requireTeacher, async (req: AuthRequest, res) => {
  const { lessonId, classId, title, task } = req.body as { lessonId: number; classId: number; title: string; task: string };
  if (!lessonId || !classId || !title || !task) { res.status(400).json({ error: "lessonId, classId, title, task парtаdir en" }); return; }

  // Get all students in class
  const members = await db.select({ studentId: classStudentsTable.studentId }).from(classStudentsTable).where(eq(classStudentsTable.classId, classId));
  if (members.length === 0) { res.status(400).json({ error: "Dasaranum ashakert chka" }); return; }

  const rows = await db.insert(homeworkTable).values(
    members.map((m) => ({ lessonId, studentId: m.studentId, title, task, level: "medium" as const }))
  ).returning();

  res.status(201).json({ assigned: rows.length, homework: rows });
});

router.post("/teacher/homework/:id/grade", requireTeacher, async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { score, feedback } = req.body as { score: number; feedback?: string };
  if (score === undefined || score === null) { res.status(400).json({ error: "score парtаdir e" }); return; }
  const updated = await db.update(homeworkTable)
    .set({ score, feedback: feedback ?? "", status: "graded", gradedAt: new Date() })
    .where(eq(homeworkTable.id, id))
    .returning();
  if (updated.length === 0) { res.status(404).json({ error: "Homework chi gtнvel" }); return; }
  res.json(updated[0]);
});

// ─── PROGRESS ────────────────────────────────────────────────────────────────

router.get("/teacher/classes/:classId/progress", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }

  const members = await db.select({ studentId: classStudentsTable.studentId }).from(classStudentsTable).where(eq(classStudentsTable.classId, classId));
  if (members.length === 0) { res.json([]); return; }

  const studentIds = members.map((m) => m.studentId);
  const students = await db.select({ id: usersTable.id, fullName: usersTable.fullName, username: usersTable.username }).from(usersTable).where(inArray(usersTable.id, studentIds));

  const allHw = await db.select().from(homeworkTable).where(inArray(homeworkTable.studentId, studentIds));
  const hwByStudent: Record<number, typeof allHw> = {};
  allHw.forEach((h) => { if (!hwByStudent[h.studentId]) hwByStudent[h.studentId] = []; hwByStudent[h.studentId].push(h); });

  res.json(students.map((s) => {
    const hw = hwByStudent[s.id] ?? [];
    const graded = hw.filter((h) => h.score !== null);
    const avg = graded.length > 0 ? Math.round(graded.reduce((sum, h) => sum + (h.score ?? 0), 0) / graded.length) : null;
    return { ...s, homeworkCount: hw.length, avgScore: avg };
  }));
});

export default router;
