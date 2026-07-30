import { Router } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "path";
import fs from "fs";
import { db, usersTable, teachersTable, classesTable, classStudentsTable, lessonsTable, homeworkTable, scheduleTable, classDocumentsTable, coursesTable, resourcesTable, lessonSessionsTable } from "@workspace/db";
import { eq, and, inArray, avg, count } from "drizzle-orm";
import { requireTeacher, requireAuth, type AuthRequest } from "../middlewares/auth";

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

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
  const { subjectId, classId, courseId, title, description, bloomLevel, content, lessonNumber, pagesFrom, pagesTo, month, day, textbookAuthor, textbookTitle, chapterTitle, paragraphNumber, textbookResourceId, lessonGoal, lessonOutcomes } = req.body as {
    subjectId?: number; classId?: number; courseId?: number; title: string; description?: string; bloomLevel?: number; content?: string;
    lessonNumber?: number; pagesFrom?: number; pagesTo?: number; month?: number; day?: number;
    textbookAuthor?: string; textbookTitle?: string; chapterTitle?: string; paragraphNumber?: string;
    textbookResourceId?: number; lessonGoal?: string; lessonOutcomes?: string[];
  };
  if (!title) { res.status(400).json({ error: "title partadir e" }); return; }
  let resolvedSubjectId = subjectId;
  if (!resolvedSubjectId) {
    const { subjectsTable } = await import("@workspace/db");
    const [s] = await db.select().from(subjectsTable).limit(1);
    resolvedSubjectId = s?.id;
  }
  const [lesson] = await db.insert(lessonsTable).values({
    subjectId: resolvedSubjectId, title,
    description: description ?? "", bloomLevel: bloomLevel ?? 1, content: content ?? "",
    teacherId: req.userId!, classId: classId ?? null,
    courseId: courseId ?? null,
    lessonNumber: lessonNumber ?? null, pagesFrom: pagesFrom ?? null, pagesTo: pagesTo ?? null,
    month: month ?? null, day: day ?? null,
    textbookAuthor: textbookAuthor ?? null, textbookTitle: textbookTitle ?? null,
    chapterTitle: chapterTitle ?? null, paragraphNumber: paragraphNumber ?? null,
    textbookResourceId: textbookResourceId ?? null,
    ...(lessonGoal !== undefined && { lessonGoal }),
    ...(lessonOutcomes !== undefined && { lessonOutcomes }),
    status: "draft",
  }).returning();
  res.status(201).json(lesson);
});

router.put("/teacher/lessons/:id", requireTeacher, async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { title, description, bloomLevel, content, lessonNumber, pagesFrom, pagesTo, month, day, textbookAuthor, textbookTitle, chapterTitle, paragraphNumber, textbookResourceId, lessonGoal, lessonOutcomes } = req.body as {
    title?: string; description?: string; bloomLevel?: number; content?: string;
    lessonNumber?: number; pagesFrom?: number; pagesTo?: number; month?: number; day?: number;
    textbookAuthor?: string; textbookTitle?: string; chapterTitle?: string; paragraphNumber?: string;
    textbookResourceId?: number | null; lessonGoal?: string; lessonOutcomes?: string[];
  };
  const updated = await db.update(lessonsTable)
    .set({
      ...(title && { title }),
      ...(description !== undefined && { description }),
      ...(bloomLevel && { bloomLevel }),
      ...(content !== undefined && { content }),
      ...(lessonNumber !== undefined && { lessonNumber }),
      ...(pagesFrom !== undefined && { pagesFrom }),
      ...(pagesTo !== undefined && { pagesTo }),
      ...(month !== undefined && { month }),
      ...(day !== undefined && { day }),
      ...(textbookAuthor !== undefined && { textbookAuthor }),
      ...(textbookTitle !== undefined && { textbookTitle }),
      ...(chapterTitle !== undefined && { chapterTitle }),
      ...(paragraphNumber !== undefined && { paragraphNumber }),
      ...(textbookResourceId !== undefined && { textbookResourceId }),
      ...(lessonGoal !== undefined && { lessonGoal }),
      ...(lessonOutcomes !== undefined && { lessonOutcomes }),
    })
    .where(and(eq(lessonsTable.id, id), eq(lessonsTable.teacherId, req.userId!)))
    .returning();
  if (updated.length === 0) { res.status(404).json({ error: "Das chi gtnvel" }); return; }
  res.json(updated[0]);
});

router.post("/teacher/lessons/:id/delete", requireTeacher, async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(lessonsTable).where(and(eq(lessonsTable.id, id), eq(lessonsTable.teacherId, req.userId!)));
  res.json({ message: "Das djnjvec" });
});

router.put("/teacher/lessons/:id/status", requireTeacher, async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { status } = req.body as { status: string };
  if (!["assigned", "active", "completed"].includes(status)) {
    res.status(400).json({ error: "Invalid status" }); return;
  }

  const [lesson] = await db.select().from(lessonsTable).where(and(eq(lessonsTable.id, id), eq(lessonsTable.teacherId, req.userId!))).limit(1);
  if (!lesson) { res.status(404).json({ error: "Das chi gtnvel" }); return; }

  const patch: Record<string, unknown> = { status };
  if (status === "assigned" && !lesson.assignedAt) {
    patch.assignedAt = new Date();
  }
  if (status === "active") {
    // When activating, deactivate any other active lesson in the same course
    if (lesson.courseId) {
      await db.update(lessonsTable)
        .set({ status: "assigned" })
        .where(and(eq(lessonsTable.courseId, lesson.courseId), eq(lessonsTable.status, "active")));
    }
    if (!lesson.assignedAt) patch.assignedAt = new Date();
  }
  if (status === "completed") {
    patch.completedAt = new Date();
  }

  const [updated] = await db.update(lessonsTable).set(patch).where(eq(lessonsTable.id, id)).returning();
  res.json(updated);
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

// ─── COURSES ──────────────────────────────────────────────────────────────────

router.get("/teacher/classes/:classId/courses", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }
  const courses = await db.select().from(coursesTable).where(eq(coursesTable.classId, classId));
  const withCounts = await Promise.all(courses.map(async (c) => {
    const [{ value }] = await db.select({ value: count() }).from(lessonsTable).where(eq(lessonsTable.courseId, c.id));
    return { ...c, lessonCount: Number(value) };
  }));
  res.json(withCounts);
});

router.post("/teacher/classes/:classId/courses", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }
  const { name, description, subjectId } = req.body as { name: string; description?: string; subjectId?: number };
  if (!name) { res.status(400).json({ error: "name partadir e" }); return; }
  if (!subjectId) { res.status(400).json({ error: "subjectId is required" }); return; }
  const [course] = await db.insert(coursesTable).values({
    classId, teacherId: req.userId!, name, description: description ?? "",
    subjectId,
  }).returning();
  res.status(201).json({ ...course, lessonCount: 0 });
});

router.get("/teacher/courses/:courseId", requireTeacher, async (req: AuthRequest, res) => {
  const courseId = parseInt(String(req.params.courseId));
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }
  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, courseId)).limit(1);
  if (!course) { res.status(404).json({ error: "Chi gtnvel" }); return; }
  res.json(course);
});

router.post("/teacher/courses/:courseId/delete", requireTeacher, async (req: AuthRequest, res) => {
  const courseId = parseInt(String(req.params.courseId));
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  res.json({ message: "Njujy djnjvec" });
});

// ─── RESOURCES ────────────────────────────────────────────────────────────────

router.get("/teacher/courses/:courseId/resources", requireTeacher, async (req: AuthRequest, res) => {
  const courseId = parseInt(String(req.params.courseId));
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }
  const resources = await db.select().from(resourcesTable).where(eq(resourcesTable.courseId, courseId));
  res.json(resources);
});

router.post("/teacher/courses/:courseId/resources", requireTeacher, upload.single("file"), async (req: AuthRequest, res) => {
  const courseId = parseInt(String(req.params.courseId));
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }
  const { type, title, description, author } = req.body as { type: string; title: string; description?: string; author?: string };
  if (!type || !title) { res.status(400).json({ error: "type, title partadir en" }); return; }
  const file = req.file;
  const [resource] = await db.insert(resourcesTable).values({
    courseId, teacherId: req.userId!, type, title,
    description: description ?? "",
    author: author || null,
    fileName: file?.originalname ?? null,
    fileUrl: file ? `/api/teacher/documents/files/${file.filename}` : null,
    fileSize: file?.size ?? null,
  }).returning();
  res.status(201).json(resource);
});

router.post("/teacher/courses/:courseId/resources/:resourceId/delete", requireTeacher, async (req: AuthRequest, res) => {
  const courseId = parseInt(String(req.params.courseId));
  const resourceId = parseInt(String(req.params.resourceId));
  if (isNaN(courseId) || isNaN(resourceId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [resource] = await db.select().from(resourcesTable).where(eq(resourcesTable.id, resourceId)).limit(1);
  if (resource?.fileUrl) {
    const fname = resource.fileUrl.split("/").pop();
    if (fname) { try { fs.unlinkSync(path.join(uploadsDir, fname)); } catch { /* ignore */ } }
  }
  await db.delete(resourcesTable).where(and(eq(resourcesTable.id, resourceId), eq(resourcesTable.courseId, courseId)));
  res.json({ message: "Njujy djnjvec" });
});

// ─── COURSE LESSONS ───────────────────────────────────────────────────────────

router.get("/teacher/courses/:courseId/lessons", requireTeacher, async (req: AuthRequest, res) => {
  const courseId = parseInt(String(req.params.courseId));
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }
  const lessons = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, courseId));
  res.json(lessons);
});

router.post("/teacher/courses/:courseId/lessons", requireTeacher, async (req: AuthRequest, res) => {
  const courseId = parseInt(String(req.params.courseId));
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }
  const { title, description, bloomLevel, content, lessonNumber, pagesFrom, pagesTo, textbookAuthor, textbookTitle, chapterTitle, paragraphNumber, textbookResourceId, lessonGoal, lessonOutcomes } = req.body as {
    title: string; description?: string; bloomLevel?: number; content?: string;
    lessonNumber?: number; pagesFrom?: number; pagesTo?: number;
    textbookAuthor?: string; textbookTitle?: string; chapterTitle?: string; paragraphNumber?: string;
    textbookResourceId?: number; lessonGoal?: string; lessonOutcomes?: string[];
  };
  if (!title) { res.status(400).json({ error: "title partadir e" }); return; }

  // Always derive subjectId from the course — never trust the request body
  const [parentCourse] = await db.select({ subjectId: coursesTable.subjectId }).from(coursesTable).where(eq(coursesTable.id, courseId)).limit(1);
  if (!parentCourse) { res.status(404).json({ error: "Course not found" }); return; }
  if (!parentCourse.subjectId) {
    res.status(400).json({
      error: "This Course is not linked to a Subject. Please re-link via the admin panel.",
    });
    return;
  }

  const [lesson] = await db.insert(lessonsTable).values({
    subjectId: parentCourse.subjectId, title,
    description: description ?? "", bloomLevel: bloomLevel ?? 1, content: content ?? "",
    teacherId: req.userId!, courseId,
    lessonNumber: lessonNumber ?? null, pagesFrom: pagesFrom ?? null, pagesTo: pagesTo ?? null,
    textbookAuthor: textbookAuthor ?? null, textbookTitle: textbookTitle ?? null,
    chapterTitle: chapterTitle ?? null, paragraphNumber: paragraphNumber ?? null,
    textbookResourceId: textbookResourceId ?? null,
    ...(lessonGoal !== undefined && { lessonGoal }),
    ...(lessonOutcomes !== undefined && { lessonOutcomes }),
    status: "draft",
  }).returning();
  res.status(201).json(lesson);
});

router.get("/teacher/courses/:courseId/lessons-progress", requireTeacher, async (req: AuthRequest, res) => {
  const courseId = parseInt(String(req.params.courseId));
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }

  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, courseId)).limit(1);
  if (!course) { res.status(404).json({ error: "Course not found" }); return; }

  const lessons = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.courseId, courseId));

  if (lessons.length === 0) { res.json({ students: [], lessons: [] }); return; }

  const members = await db
    .select({ id: usersTable.id, fullName: usersTable.fullName, username: usersTable.username })
    .from(classStudentsTable)
    .innerJoin(usersTable, eq(classStudentsTable.studentId, usersTable.id))
    .where(eq(classStudentsTable.classId, course.classId));

  if (members.length === 0) {
    res.json({ students: [], lessons: lessons.map((l) => ({ id: l.id, title: l.title, lessonNumber: l.lessonNumber, month: l.month, day: l.day, pagesFrom: l.pagesFrom, pagesTo: l.pagesTo, results: [] })) });
    return;
  }

  const lessonIds = lessons.map((l) => l.id);
  const studentIds = members.map((m) => m.id);

  const sessions = await db
    .select()
    .from(lessonSessionsTable)
    .where(and(inArray(lessonSessionsTable.lessonId, lessonIds), inArray(lessonSessionsTable.userId, studentIds)));

  const sessionMap = new Map<string, typeof sessions[0]>();
  sessions.forEach((s) => sessionMap.set(`${s.lessonId}:${s.userId}`, s));

  res.json({
    students: members,
    lessons: lessons
      .sort((a, b) => ((a.lessonNumber ?? 9999) - (b.lessonNumber ?? 9999)))
      .map((l) => ({
        id: l.id,
        title: l.title,
        lessonNumber: l.lessonNumber,
        month: l.month,
        day: l.day,
        pagesFrom: l.pagesFrom,
        pagesTo: l.pagesTo,
        results: members.map((s) => {
          const sess = sessionMap.get(`${l.id}:${s.id}`);
          return {
            studentId: s.id,
            status: sess ? sess.status : "not_started",
            masteryScore: sess?.masteryScore ?? null,
            currentPhase: sess?.currentPhase ?? 0,
            completedAt: sess?.completedAt ?? null,
          };
        }),
      })),
  });
});

// ─── CLASS DOCUMENTS ──────────────────────────────────────────────────────────

router.get("/teacher/classes/:classId/documents", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }
  const docs = await db.select().from(classDocumentsTable).where(eq(classDocumentsTable.classId, classId));
  res.json(docs);
});

router.post("/teacher/classes/:classId/documents", requireTeacher, upload.single("file"), async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }
  const { type, title, description } = req.body as { type: string; title: string; description?: string };
  if (!type || !title) { res.status(400).json({ error: "type, title partadir en" }); return; }
  const file = req.file;
  const [doc] = await db.insert(classDocumentsTable).values({
    classId, teacherId: req.userId!, type, title,
    description: description ?? "",
    fileName: file?.originalname ?? null,
    fileUrl: file ? `/api/teacher/documents/files/${file.filename}` : null,
    fileSize: file?.size ?? null,
  }).returning();
  res.status(201).json(doc);
});

router.post("/teacher/classes/:classId/documents/:docId/delete", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  const docId = parseInt(String(req.params.docId));
  if (isNaN(classId) || isNaN(docId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [doc] = await db.select().from(classDocumentsTable).where(eq(classDocumentsTable.id, docId)).limit(1);
  if (doc?.fileUrl) {
    const fname = doc.fileUrl.split("/").pop();
    if (fname) { try { fs.unlinkSync(path.join(uploadsDir, fname)); } catch { /* ignore */ } }
  }
  await db.delete(classDocumentsTable).where(and(eq(classDocumentsTable.id, docId), eq(classDocumentsTable.classId, classId)));
  res.json({ message: "Njujy djnjvec" });
});

router.get("/teacher/documents/files/:filename", requireAuth, async (req: AuthRequest, res) => {
  const filename = String(req.params.filename).replace(/\.\./g, "");
  const filePath = path.join(uploadsDir, filename);
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: "File not found" }); return; }
  res.sendFile(filePath);
});

// ─── PROFILE ──────────────────────────────────────────────────────────────────

router.get("/teacher/profile", requireTeacher, async (req: AuthRequest, res) => {
  const teacher = await getTeacherForUser(req.userId!);
  if (!teacher) { res.status(404).json({ error: "Teacher not found" }); return; }
  const [userRow] = await db
    .select({ id: usersTable.id, fullName: usersTable.fullName, username: usersTable.username, email: usersTable.email, createdAt: usersTable.createdAt })
    .from(usersTable)
    .where(eq(usersTable.id, req.userId!))
    .limit(1);
  if (!userRow) { res.status(404).json({ error: "User not found" }); return; }
  res.json({
    id: teacher.id,
    userId: teacher.userId,
    fullName: userRow.fullName,
    username: userRow.username,
    email: teacher.email ?? userRow.email ?? null,
    subjects: teacher.subjects,
    school: teacher.school,
    createdAt: teacher.createdAt,
  });
});

export default router;
