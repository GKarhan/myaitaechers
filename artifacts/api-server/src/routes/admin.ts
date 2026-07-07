import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, teachersTable, classesTable, classStudentsTable, scheduleTable } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

// ─── STATS ───────────────────────────────────────────────────────────────────

router.get("/admin/stats", requireAdmin, async (_req, res) => {
  const [teacherCount] = await db.select({ count: count() }).from(teachersTable);
  const [classCount] = await db.select({ count: count() }).from(classesTable);
  const [studentCount] = await db.select({ count: count() }).from(usersTable).where(eq(usersTable.role, "student"));
  res.json({
    teachers: Number(teacherCount.count),
    classes: Number(classCount.count),
    students: Number(studentCount.count),
  });
});

// ─── TEACHERS ────────────────────────────────────────────────────────────────

router.get("/admin/teachers", requireAdmin, async (_req, res) => {
  const teachers = await db
    .select({
      id: teachersTable.id,
      userId: teachersTable.userId,
      subject: teachersTable.subject,
      email: teachersTable.email,
      fullName: usersTable.fullName,
      username: usersTable.username,
      createdAt: teachersTable.createdAt,
    })
    .from(teachersTable)
    .innerJoin(usersTable, eq(teachersTable.userId, usersTable.id));
  res.json(teachers);
});

router.post("/admin/teachers", requireAdmin, async (req, res) => {
  const { fullName, email, subject } = req.body as {
    fullName: string; email?: string; subject?: string;
  };
  if (!fullName) {
    res.status(400).json({ error: "Անուն Ազգանունը պարտադիր է" }); return;
  }
  const baseUsername = fullName.toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "") || "teacher";
  let username = baseUsername;
  let suffix = 1;
  while (true) {
    const existing = await db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
    if (existing.length === 0) break;
    username = `${baseUsername}${suffix++}`;
  }
  const tempPassword = Math.random().toString(36).slice(2, 10);
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const [user] = await db.insert(usersTable).values({ username, passwordHash, fullName, role: "teacher" }).returning();
  const [teacher] = await db.insert(teachersTable).values({ userId: user.id, subject: subject ?? "", school: "", email: email ?? null }).returning();
  res.status(201).json({ id: teacher.id, userId: user.id, username: user.username, fullName: user.fullName, subject: teacher.subject, email: teacher.email, createdAt: teacher.createdAt });
});

router.put("/admin/teachers/:id", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { subject, email, fullName } = req.body as { subject?: string; email?: string; fullName?: string };
  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.id, id)).limit(1);
  if (!teacher) { res.status(404).json({ error: "Ուսուցիչը չի գտնվել" }); return; }
  if (subject !== undefined || email !== undefined) {
    await db.update(teachersTable).set({ ...(subject !== undefined && { subject }), ...(email !== undefined && { email }) }).where(eq(teachersTable.id, id));
  }
  if (fullName) {
    await db.update(usersTable).set({ fullName }).where(eq(usersTable.id, teacher.userId));
  }
  res.json({ message: "Ուusucichy tarmacvec" });
});

router.post("/admin/teachers/:id/delete", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.id, id)).limit(1);
  if (!teacher) { res.status(404).json({ error: "Ուսուցիչը չի գտնվել" }); return; }
  await db.delete(usersTable).where(eq(usersTable.id, teacher.userId));
  res.json({ message: "Ուսուցիչը հաջողությամբ ջնջվեց" });
});

// ─── CLASSES ─────────────────────────────────────────────────────────────────

router.get("/admin/classes", requireAdmin, async (_req, res) => {
  const rows = await db
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

  // Attach student counts
  const counts = await db
    .select({ classId: classStudentsTable.classId, cnt: count() })
    .from(classStudentsTable)
    .groupBy(classStudentsTable.classId);

  const countMap = Object.fromEntries(counts.map((c) => [c.classId, Number(c.cnt)]));

  res.json(rows.map((r) => ({ ...r, studentCount: countMap[r.id] ?? 0 })));
});

router.post("/admin/classes", requireAdmin, async (req, res) => {
  const { name, grade, teacherId } = req.body as { name: string; grade?: string; teacherId: number };
  if (!name || !teacherId) { res.status(400).json({ error: "name, teacherId պարտադիր են" }); return; }
  const [cls] = await db.insert(classesTable).values({ name, grade: grade ?? "", teacherId }).returning();
  res.status(201).json({ ...cls, studentCount: 0 });
});

router.put("/admin/classes/:id", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { name, grade, teacherId } = req.body as { name?: string; grade?: string; teacherId?: number };
  const updated = await db.update(classesTable)
    .set({ ...(name && { name }), ...(grade !== undefined && { grade }), ...(teacherId && { teacherId }) })
    .where(eq(classesTable.id, id))
    .returning();
  if (updated.length === 0) { res.status(404).json({ error: "Դasarany չi gtнvel" }); return; }
  res.json({ message: "Դасараны ти tarmaцvец" });
});

router.post("/admin/classes/:id/delete", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const deleted = await db.delete(classesTable).where(eq(classesTable.id, id)).returning();
  if (deleted.length === 0) { res.status(404).json({ error: "Դасараны чи гтнвел" }); return; }
  res.json({ message: "Դасараны hajakaпес джnjvец" });
});

// ─── SCHEDULE ────────────────────────────────────────────────────────────────

router.get("/admin/schedule", requireAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id: scheduleTable.id,
      classId: scheduleTable.classId,
      className: classesTable.name,
      day: scheduleTable.day,
      time: scheduleTable.time,
      subject: scheduleTable.subject,
      createdAt: scheduleTable.createdAt,
    })
    .from(scheduleTable)
    .innerJoin(classesTable, eq(scheduleTable.classId, classesTable.id));
  res.json(rows);
});

router.post("/admin/schedule", requireAdmin, async (req, res) => {
  const { classId, day, time, subject } = req.body as { classId: number; day: string; time: string; subject: string };
  if (!classId || !day || !time || !subject) {
    res.status(400).json({ error: "classId, day, time, subject պарtаdіr єn" }); return;
  }
  const [row] = await db.insert(scheduleTable).values({ classId, day, time, subject }).returning();
  res.status(201).json(row);
});

router.put("/admin/schedule/:id", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { classId, day, time, subject } = req.body as { classId?: number; day?: string; time?: string; subject?: string };
  const updated = await db.update(scheduleTable)
    .set({ ...(classId && { classId }), ...(day && { day }), ...(time && { time }), ...(subject && { subject }) })
    .where(eq(scheduleTable.id, id))
    .returning();
  if (updated.length === 0) { res.status(404).json({ error: "Дас чи гтнвел" }); return; }
  res.json(updated[0]);
});

router.post("/admin/schedule/:id/delete", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const deleted = await db.delete(scheduleTable).where(eq(scheduleTable.id, id)).returning();
  if (deleted.length === 0) { res.status(404).json({ error: "Дас чи гтнвел" }); return; }
  res.json({ message: "Джnjvец" });
});

// ─── STUDENTS (by class) ─────────────────────────────────────────────────────

router.get("/admin/students", requireAdmin, async (req, res) => {
  const classId = req.query.classId ? parseInt(String(req.query.classId)) : null;

  if (classId) {
    const members = await db
      .select({
        id: usersTable.id,
        username: usersTable.username,
        fullName: usersTable.fullName,
        email: usersTable.email,
        age: usersTable.age,
        createdAt: usersTable.createdAt,
      })
      .from(classStudentsTable)
      .innerJoin(usersTable, eq(classStudentsTable.studentId, usersTable.id))
      .where(eq(classStudentsTable.classId, classId));
    res.json(members);
  } else {
    const students = await db
      .select({ id: usersTable.id, username: usersTable.username, fullName: usersTable.fullName, email: usersTable.email, age: usersTable.age, createdAt: usersTable.createdAt })
      .from(usersTable)
      .where(eq(usersTable.role, "student"));
    res.json(students);
  }
});

router.post("/admin/students", requireAdmin, async (req, res) => {
  const { fullName, email, age, classId } = req.body as {
    fullName: string; email?: string; age?: number; classId?: number;
  };
  if (!fullName) {
    res.status(400).json({ error: "fullName պարտա噍իր ե" }); return;
  }
  const base = email
    ? email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, ".")
    : fullName.toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "");
  let username = base || "student";
  let counter = 1;
  while ((await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username)).limit(1)).length > 0) {
    username = `${base}${counter++}`;
  }
  const passwordHash = await bcrypt.hash("student123", 10);
  const [user] = await db.insert(usersTable).values({
    username, passwordHash, fullName, role: "student",
    email: email ?? null,
    age: age ?? null,
  }).returning();
  if (classId) {
    await db.insert(classStudentsTable).values({ classId, studentId: user.id });
  }
  res.status(201).json({ id: user.id, username: user.username, fullName: user.fullName, email: user.email, age: user.age, createdAt: user.createdAt });
});

router.post("/admin/students/:id/delete", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.json({ message: "Ашакерты джnjvец" });
});

router.post("/admin/students/:id/remove-class", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  const { classId } = req.body as { classId: number };
  if (isNaN(id) || !classId) { res.status(400).json({ error: "Invalid params" }); return; }
  await db.delete(classStudentsTable).where(
    sql`${classStudentsTable.studentId} = ${id} AND ${classStudentsTable.classId} = ${classId}`
  );
  res.json({ message: "Ашакерты herацvец дасаранiц" });
});

export default router;
