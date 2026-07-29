import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, teachersTable, classesTable, classStudentsTable, scheduleTable, subjectsTable } from "@workspace/db";
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
      subjects: teachersTable.subjects,
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
  const { fullName, email, subjects } = req.body as {
    fullName: string; email?: string; subjects?: string[];
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
  const [teacher] = await db.insert(teachersTable).values({ userId: user.id, subjects: subjects ?? [], school: "", email: email ?? null }).returning();
  res.status(201).json({ id: teacher.id, userId: user.id, username: user.username, fullName: user.fullName, subjects: teacher.subjects, email: teacher.email, createdAt: teacher.createdAt });
});

router.put("/admin/teachers/:id", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { subjects, email, fullName } = req.body as { subjects?: string[]; email?: string; fullName?: string };
  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.id, id)).limit(1);
  if (!teacher) { res.status(404).json({ error: "Ուսուցիչը չի գտնվել" }); return; }
  if (subjects !== undefined || email !== undefined) {
    await db.update(teachersTable).set({ ...(subjects !== undefined && { subjects }), ...(email !== undefined && { email }) }).where(eq(teachersTable.id, id));
  }
  if (fullName) {
    await db.update(usersTable).set({ fullName }).where(eq(usersTable.id, teacher.userId));
  }
  res.json({ message: "Ուսուցիչը թարմացվեց" });
});

router.post("/admin/teachers/:id/delete", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.id, id)).limit(1);
  if (!teacher) { res.status(404).json({ error: "Ուսուցիչը չի գտնվել" }); return; }
  const [user] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, teacher.userId)).limit(1);
  if (user?.username === "teacher1") { res.status(403).json({ error: "Demo հաշիվը հնարավոր չէ ջնջել" }); return; }
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

router.get("/admin/classes/:id/detail", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [cls] = await db
    .select({
      id: classesTable.id,
      name: classesTable.name,
      grade: classesTable.grade,
      teacherId: classesTable.teacherId,
      teacherUserId: teachersTable.userId,
      teacherFullName: usersTable.fullName,
      teacherEmail: usersTable.email,
      teacherSubjects: teachersTable.subjects,
    })
    .from(classesTable)
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .innerJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(eq(classesTable.id, id))
    .limit(1);

  if (!cls) { res.status(404).json({ error: "Դасarany чi гтnvel" }); return; }

  const studentRows = await db
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
    .where(eq(classStudentsTable.classId, id));

  res.json({
    id: cls.id,
    name: cls.name,
    grade: cls.grade,
    teacher: {
      id: cls.teacherId,
      fullName: cls.teacherFullName,
      email: cls.teacherEmail,
      subjects: cls.teacherSubjects,
    },
    students: studentRows,
  });
});

router.post("/admin/classes/:id/delete", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const deleted = await db.delete(classesTable).where(eq(classesTable.id, id)).returning();
  if (deleted.length === 0) { res.status(404).json({ error: "Դасараны чи гтнвел" }); return; }
  res.json({ message: "Դасараны hajakaпес джnjvец" });
});

router.post("/admin/classes/:id/add-student", requireAdmin, async (req, res) => {
  const classId = parseInt(String(req.params.id));
  if (isNaN(classId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { studentId } = req.body as { studentId: number };
  if (!studentId) { res.status(400).json({ error: "studentId պարտադիր է" }); return; }
  await db.insert(classStudentsTable).values({ classId, studentId }).onConflictDoNothing();
  res.json({ message: "Աшакертy avaelajrecvec дасаranin" });
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
      startTime: scheduleTable.startTime,
      endTime: scheduleTable.endTime,
      subject: scheduleTable.subject,
      createdAt: scheduleTable.createdAt,
      teacherName: usersTable.fullName,
    })
    .from(scheduleTable)
    .innerJoin(classesTable, eq(scheduleTable.classId, classesTable.id))
    .leftJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .orderBy(scheduleTable.day, scheduleTable.startTime);
  res.json(rows);
});

router.post("/admin/schedule", requireAdmin, async (req, res) => {
  const { classId, day, startTime, endTime, subject } = req.body as {
    classId: number; day: string; startTime: string; endTime: string; subject: string;
  };
  if (!classId || !day || !startTime || !endTime || !subject) {
    res.status(400).json({ error: "classId, day, startTime, endTime, subject պարտադիր են" }); return;
  }
  const [row] = await db.insert(scheduleTable).values({ classId, day, time: startTime, startTime, endTime, subject }).returning();
  res.status(201).json(row);
});

router.put("/admin/schedule/:id", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { classId, day, startTime, endTime, subject } = req.body as {
    classId?: number; day?: string; startTime?: string; endTime?: string; subject?: string;
  };
  const updated = await db.update(scheduleTable)
    .set({
      ...(classId && { classId }),
      ...(day && { day }),
      ...(startTime && { time: startTime, startTime }),
      ...(endTime && { endTime }),
      ...(subject && { subject }),
    })
    .where(eq(scheduleTable.id, id))
    .returning();
  if (updated.length === 0) { res.status(404).json({ error: "Դասը չի գտնվել" }); return; }
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
  const [user] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (user?.username === "student1") { res.status(403).json({ error: "Demo հաշիվը հնարավոր չէ ջնջել" }); return; }
  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.json({ message: "Աշակերտը ջնջվեց" });
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

// ─── SUBJECTS ─────────────────────────────────────────────────────────────────

router.post("/admin/subjects", requireAdmin, async (req, res) => {
  const { name, grade, description } = req.body as { name?: string; grade?: string; description?: string };
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Առarqay anunы партadир э" }); return;
  }
  const existing = await db.select().from(subjectsTable).where(eq(subjectsTable.name, name.trim())).limit(1);
  if (existing.length > 0) {
    res.status(400).json({ error: "Այս անunov ararka ardеn kaи" }); return;
  }
  const [subject] = await db.insert(subjectsTable).values({
    name: name.trim(),
    grade: grade?.trim() || "9-րդ դasaran",
    description: description?.trim() || "",
  }).returning();
  res.status(201).json({ id: subject.id, name: subject.name, grade: subject.grade, description: subject.description });
});

router.post("/admin/subjects/:id/delete", requireAdmin, async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [subject] = await db.select().from(subjectsTable).where(eq(subjectsTable.id, id)).limit(1);
  if (!subject) { res.status(404).json({ error: "Ararkaan chi gtnyel" }); return; }
  await db.delete(subjectsTable).where(eq(subjectsTable.id, id));
  res.json({ message: "Ararkan հаjoghuthyamb djnjvec" });
});

export default router;
