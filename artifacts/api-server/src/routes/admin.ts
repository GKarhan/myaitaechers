import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, teachersTable, classesTable, classStudentsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { requireAdmin, type AuthRequest } from "../middlewares/auth";

const router = Router();

// GET /api/admin/stats
router.get("/admin/stats", requireAdmin, async (_req, res) => {
  const [teacherCount] = await db.select({ count: count() }).from(teachersTable);
  const [classCount] = await db.select({ count: count() }).from(classesTable);
  const [studentCount] = await db
    .select({ count: count() })
    .from(usersTable)
    .where(eq(usersTable.role, "student"));

  res.json({
    teachers: Number(teacherCount.count),
    classes: Number(classCount.count),
    students: Number(studentCount.count),
  });
});

// GET /api/admin/teachers
router.get("/admin/teachers", requireAdmin, async (_req, res) => {
  const teachers = await db
    .select({
      id: teachersTable.id,
      userId: teachersTable.userId,
      subject: teachersTable.subject,
      school: teachersTable.school,
      fullName: usersTable.fullName,
      username: usersTable.username,
      createdAt: teachersTable.createdAt,
    })
    .from(teachersTable)
    .innerJoin(usersTable, eq(teachersTable.userId, usersTable.id));

  res.json(teachers);
});

// POST /api/admin/teachers
router.post("/admin/teachers", requireAdmin, async (req, res) => {
  const { username, password, fullName, subject, school } = req.body as {
    username: string;
    password: string;
    fullName: string;
    subject?: string;
    school?: string;
  };

  if (!username || !password || !fullName) {
    res.status(400).json({ error: "username, password, fullName պարտադիր են" });
    return;
  }

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (existing.length > 0) {
    res.status(400).json({ error: "Այս օգտանունն արդեն գոյություն ունի" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const [user] = await db
    .insert(usersTable)
    .values({ username, passwordHash, fullName, role: "teacher" })
    .returning();

  const [teacher] = await db
    .insert(teachersTable)
    .values({ userId: user.id, subject: subject ?? "", school: school ?? "" })
    .returning();

  res.status(201).json({
    id: teacher.id,
    userId: user.id,
    username: user.username,
    fullName: user.fullName,
    subject: teacher.subject,
    school: teacher.school,
    createdAt: teacher.createdAt,
  });
});

// DELETE /api/admin/teachers/:id
router.post("/admin/teachers/:id/delete", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [teacher] = await db
    .select()
    .from(teachersTable)
    .where(eq(teachersTable.id, id))
    .limit(1);

  if (!teacher) {
    res.status(404).json({ error: "Ուսուցիչը չի գտնվել" });
    return;
  }

  await db.delete(usersTable).where(eq(usersTable.id, teacher.userId));

  res.json({ message: "Ուսուցիչը հաջողությամբ ջնջվեց" });
});

// GET /api/admin/classes
router.get("/admin/classes", requireAdmin, async (_req, res) => {
  const classes = await db
    .select({
      id: classesTable.id,
      name: classesTable.name,
      grade: classesTable.grade,
      teacherId: classesTable.teacherId,
      teacherName: usersTable.fullName,
      createdAt: classesTable.createdAt,
    })
    .from(classesTable)
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .innerJoin(usersTable, eq(teachersTable.userId, usersTable.id));

  res.json(classes);
});

// POST /api/admin/classes
router.post("/admin/classes", requireAdmin, async (req, res) => {
  const { name, grade, teacherId } = req.body as {
    name: string;
    grade?: string;
    teacherId: number;
  };

  if (!name || !teacherId) {
    res.status(400).json({ error: "name, teacherId պարտադիր են" });
    return;
  }

  const [cls] = await db
    .insert(classesTable)
    .values({ name, grade: grade ?? "", teacherId })
    .returning();

  res.status(201).json(cls);
});

// DELETE /api/admin/classes/:id
router.post("/admin/classes/:id/delete", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const deleted = await db.delete(classesTable).where(eq(classesTable.id, id)).returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "Դասարանը չի գտնվել" });
    return;
  }

  res.json({ message: "Դասարանը հաջողությամբ ջնջվեց" });
});

// GET /api/admin/students
router.get("/admin/students", requireAdmin, async (_req, res) => {
  const students = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      fullName: usersTable.fullName,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.role, "student"));

  res.json(students);
});

// PUT /api/admin/teachers/:id
router.put("/admin/teachers/:id", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { subject, school, fullName } = req.body as { subject?: string; school?: string; fullName?: string };

  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.id, id)).limit(1);
  if (!teacher) { res.status(404).json({ error: "Ուսուցիչը չի գտնվել" }); return; }

  if (subject !== undefined || school !== undefined) {
    await db.update(teachersTable)
      .set({ ...(subject !== undefined && { subject }), ...(school !== undefined && { school }) })
      .where(eq(teachersTable.id, id));
  }
  if (fullName) {
    await db.update(usersTable).set({ fullName }).where(eq(usersTable.id, teacher.userId));
  }

  res.json({ message: "Ուսուցիչը թարմացվեց" });
});

export default router;
