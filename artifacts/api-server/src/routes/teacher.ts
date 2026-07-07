import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, teachersTable, classesTable, classStudentsTable, lessonsTable, homeworkTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireTeacher, type AuthRequest } from "../middlewares/auth";

const router = Router();

// Helper: get teacher record for current user
async function getTeacherForUser(userId: number) {
  const [teacher] = await db
    .select()
    .from(teachersTable)
    .where(eq(teachersTable.userId, userId))
    .limit(1);
  return teacher ?? null;
}

// GET /api/teacher/classes — my classes
router.get("/teacher/classes", requireTeacher, async (req: AuthRequest, res) => {
  const teacher = await getTeacherForUser(req.userId!);
  if (!teacher) { res.status(404).json({ error: "Teacher profile not found" }); return; }

  const classes = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.teacherId, teacher.id));

  res.json(classes);
});

// GET /api/teacher/classes/:classId/students
router.get("/teacher/classes/:classId/students", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }

  const members = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      fullName: usersTable.fullName,
      createdAt: usersTable.createdAt,
    })
    .from(classStudentsTable)
    .innerJoin(usersTable, eq(classStudentsTable.studentId, usersTable.id))
    .where(eq(classStudentsTable.classId, classId));

  res.json(members);
});

// POST /api/teacher/classes/:classId/students — add student to class
router.post("/teacher/classes/:classId/students", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }

  const { username, password, fullName } = req.body as {
    username: string;
    password: string;
    fullName: string;
  };

  if (!username || !password || !fullName) {
    res.status(400).json({ error: "username, password, fullName պարտադիր են" });
    return;
  }

  const existing = await db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
  if (existing.length > 0) {
    res.status(400).json({ error: "Այս օգտանունն արդեն գոյություն ունի" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({ username, passwordHash, fullName, role: "student" })
    .returning();

  await db.insert(classStudentsTable).values({ classId, studentId: user.id });

  res.status(201).json({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    createdAt: user.createdAt,
  });
});

// DELETE /api/teacher/classes/:classId/students/:studentId
router.post("/teacher/classes/:classId/students/:studentId/delete", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  const studentId = parseInt(String(req.params.studentId));
  if (isNaN(classId) || isNaN(studentId)) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(classStudentsTable).where(
    and(eq(classStudentsTable.classId, classId), eq(classStudentsTable.studentId, studentId))
  );

  res.json({ message: "Աշակերտը հեռացվեց դասարանից" });
});

// GET /api/teacher/lessons — my lessons
router.get("/teacher/lessons", requireTeacher, async (req: AuthRequest, res) => {
  const lessons = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.teacherId, req.userId!));

  res.json(lessons);
});

// POST /api/teacher/lessons — create lesson
router.post("/teacher/lessons", requireTeacher, async (req: AuthRequest, res) => {
  const { subjectId, classId, title, description, bloomLevel, content } = req.body as {
    subjectId: number;
    classId?: number;
    title: string;
    description?: string;
    bloomLevel?: number;
    content?: string;
  };

  if (!subjectId || !title) {
    res.status(400).json({ error: "subjectId, title պարտադիր են" });
    return;
  }

  const [lesson] = await db
    .insert(lessonsTable)
    .values({
      subjectId,
      title,
      description: description ?? "",
      bloomLevel: bloomLevel ?? 1,
      content: content ?? "",
      teacherId: req.userId!,
      classId: classId ?? null,
    })
    .returning();

  res.status(201).json(lesson);
});

// GET /api/teacher/classes/:classId/progress — student progress in class
router.get("/teacher/classes/:classId/progress", requireTeacher, async (req: AuthRequest, res) => {
  const classId = parseInt(String(req.params.classId));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid classId" }); return; }

  const members = await db
    .select({ studentId: classStudentsTable.studentId })
    .from(classStudentsTable)
    .where(eq(classStudentsTable.classId, classId));

  if (members.length === 0) { res.json([]); return; }

  const studentIds = members.map((m) => m.studentId);

  const students = await db
    .select({
      id: usersTable.id,
      fullName: usersTable.fullName,
      username: usersTable.username,
    })
    .from(usersTable)
    .where(inArray(usersTable.id, studentIds));

  res.json(students);
});

// GET /api/teacher/homework — all homework for teacher's lessons
router.get("/teacher/homework", requireTeacher, async (req: AuthRequest, res) => {
  const myLessons = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(eq(lessonsTable.teacherId, req.userId!));

  if (myLessons.length === 0) { res.json([]); return; }

  const lessonIds = myLessons.map((l) => l.id);

  const hw = await db
    .select()
    .from(homeworkTable)
    .where(inArray(homeworkTable.lessonId, lessonIds));

  res.json(hw);
});

export default router;
