import { Router } from "express";
import { db, usersTable, teachersTable, classesTable, classStudentsTable, scheduleTable, homeworkTable, lessonsTable, subjectsTable, coursesTable, lessonSessionsTable } from "@workspace/db";
import { eq, inArray, and, sql } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

const router = Router();

// PUT /api/student/profile — update own profile
router.put("/student/profile", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const { fullName, email, age, bio } = req.body as {
    fullName?: string; email?: string; age?: number; bio?: string;
  };
  const patch: Record<string, unknown> = {};
  if (fullName !== undefined) patch.fullName = fullName;
  if (email !== undefined) patch.email = email || null;
  if (age !== undefined) patch.age = age || null;
  if (bio !== undefined) patch.bio = bio || null;

  const [user] = await db.update(usersTable).set(patch).where(eq(usersTable.id, userId)).returning();
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  res.json({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    email: user.email ?? undefined,
    age: user.age ?? undefined,
    bio: user.bio ?? undefined,
    createdAt: user.createdAt.toISOString(),
  });
});

// GET /api/student/schedule — student's weekly schedule via enrolled classes
router.get("/student/schedule", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const enrollments = await db
    .select({ classId: classStudentsTable.classId })
    .from(classStudentsTable)
    .where(eq(classStudentsTable.studentId, userId));

  if (enrollments.length === 0) { res.json([]); return; }

  const classIds = enrollments.map((e) => e.classId);

  const rows = await db
    .select({
      id: scheduleTable.id,
      classId: scheduleTable.classId,
      className: classesTable.name,
      grade: classesTable.grade,
      day: scheduleTable.day,
      time: scheduleTable.time,
      subject: scheduleTable.subject,
      teacherName: usersTable.fullName,
    })
    .from(scheduleTable)
    .innerJoin(classesTable, eq(scheduleTable.classId, classesTable.id))
    .leftJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(inArray(scheduleTable.classId, classIds));

  res.json(rows);
});

// GET /api/student/teachers — student's teachers via enrolled classes
router.get("/student/teachers", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const enrollments = await db
    .select({ classId: classStudentsTable.classId })
    .from(classStudentsTable)
    .where(eq(classStudentsTable.studentId, userId));

  if (enrollments.length === 0) { res.json([]); return; }

  const classIds = enrollments.map((e) => e.classId);

  const rows = await db
    .select({
      teacherId: teachersTable.id,
      teacherName: usersTable.fullName,
      subjects: teachersTable.subjects,
      school: teachersTable.school,
      classId: classesTable.id,
      className: classesTable.name,
    })
    .from(classesTable)
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .innerJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(inArray(classesTable.id, classIds));

  res.json(rows);
});

// GET /api/student/today-lessons — today's schedule enriched with lesson content
router.get("/student/today-lessons", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentDay = now.getDate();
  const todayArm = now.toLocaleDateString("hy-AM", { weekday: "long" });
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "");

  const enrollments = await db
    .select({ classId: classStudentsTable.classId })
    .from(classStudentsTable)
    .where(eq(classStudentsTable.studentId, userId));

  if (enrollments.length === 0) { res.json([]); return; }

  const classIds = enrollments.map((e) => e.classId);

  const allSchedule = await db
    .select({
      id: scheduleTable.id,
      classId: scheduleTable.classId,
      className: classesTable.name,
      day: scheduleTable.day,
      time: scheduleTable.time,
      subject: scheduleTable.subject,
      teacherName: usersTable.fullName,
    })
    .from(scheduleTable)
    .innerJoin(classesTable, eq(scheduleTable.classId, classesTable.id))
    .leftJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .leftJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(inArray(scheduleTable.classId, classIds));

  const todayEntries = allSchedule.filter(
    (e) => normalize(e.day) === normalize(todayArm)
  );

  if (todayEntries.length === 0) { res.json([]); return; }

  const result = await Promise.all(
    todayEntries.map(async (entry) => {
      const [subject] = await db
        .select()
        .from(subjectsTable)
        .where(sql`lower(${subjectsTable.name}) = lower(${entry.subject})`)
        .limit(1);

      if (!subject) {
        return {
          scheduleId: entry.id, time: entry.time, day: entry.day,
          subject: entry.subject, teacherName: entry.teacherName, className: entry.className,
        };
      }

      const [lesson] = await db
        .select()
        .from(lessonsTable)
        .where(and(
          eq(lessonsTable.subjectId, subject.id),
          eq(lessonsTable.month, currentMonth),
          eq(lessonsTable.day, currentDay),
        ))
        .limit(1);

      return {
        scheduleId: entry.id, time: entry.time, day: entry.day,
        subject: entry.subject, teacherName: entry.teacherName, className: entry.className,
        lessonId: lesson?.id,
        lessonTitle: lesson?.title,
        lessonNumber: lesson?.lessonNumber,
      };
    })
  );

  res.json(result.sort((a, b) => a.time.localeCompare(b.time)));
});

// GET /api/student/homework-summary — pending/graded counts from homework table
router.get("/student/homework-summary", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;

  const hw = await db
    .select({
      id: homeworkTable.id,
      lessonId: homeworkTable.lessonId,
      lessonTitle: lessonsTable.title,
      subject: coursesTable.name,
      teacherName: usersTable.fullName,
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
    .innerJoin(lessonsTable, eq(homeworkTable.lessonId, lessonsTable.id))
    .innerJoin(coursesTable, eq(lessonsTable.courseId, coursesTable.id))
    .innerJoin(classesTable, eq(coursesTable.classId, classesTable.id))
    .innerJoin(teachersTable, eq(classesTable.teacherId, teachersTable.id))
    .innerJoin(usersTable, eq(teachersTable.userId, usersTable.id))
    .where(eq(homeworkTable.studentId, userId))
    .orderBy(homeworkTable.createdAt);

  const notSubmitted = hw.filter((h) => h.status === "not_submitted").length;
  const pending = hw.filter((h) => h.status === "pending").length;
  const graded = hw.filter((h) => h.status === "graded").length;
  const gradedItems = hw.filter((h) => h.score !== null);
  const avgScore = gradedItems.length > 0
    ? Math.round(gradedItems.reduce((s, h) => s + (h.score ?? 0), 0) / gradedItems.length)
    : null;

  res.json({ notSubmitted, pending, graded, avgScore, items: hw });
});


// GET /api/student/course-lessons?subject=name — get visible teacher lessons for student's class course
router.get("/student/course-lessons", requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const subject = req.query.subject as string | undefined;
  if (!subject) { res.status(400).json({ error: "subject query param required" }); return; }

  // Find student's enrolled classes
  const enrollments = await db
    .select({ classId: classStudentsTable.classId })
    .from(classStudentsTable)
    .where(eq(classStudentsTable.studentId, userId));

  if (enrollments.length === 0) { res.json([]); return; }

  const classIds = enrollments.map((e) => e.classId);

  // Find a course in one of the student's classes matching the subject name
  const courses = await db
    .select()
    .from(coursesTable)
    .where(inArray(coursesTable.classId, classIds));

  const matchingCourse = courses.find(
    (c) => c.name.trim().toLowerCase() === subject.trim().toLowerCase()
  );

  if (!matchingCourse) { res.json([]); return; }

  // Return non-draft lessons for this course with per-student session status
  const rows = await db
    .select({
      id: lessonsTable.id,
      courseId: lessonsTable.courseId,
      title: lessonsTable.title,
      lessonNumber: lessonsTable.lessonNumber,
      pagesFrom: lessonsTable.pagesFrom,
      pagesTo: lessonsTable.pagesTo,
      textbookAuthor: lessonsTable.textbookAuthor,
      textbookTitle: lessonsTable.textbookTitle,
      chapterTitle: lessonsTable.chapterTitle,
      paragraphNumber: lessonsTable.paragraphNumber,
      status: lessonsTable.status,
      assignedAt: lessonsTable.assignedAt,
      completedAt: lessonsTable.completedAt,
      mySessionStatus: lessonSessionsTable.status,
    })
    .from(lessonsTable)
    .leftJoin(
      lessonSessionsTable,
      and(
        eq(lessonSessionsTable.lessonId, lessonsTable.id),
        eq(lessonSessionsTable.userId, userId)
      )
    )
    .where(and(
      eq(lessonsTable.courseId, matchingCourse.id),
      sql`${lessonsTable.status} != 'draft'`
    ));
  const lessons = rows;

  // Sort: textbookTitle, chapterTitle, lessonNumber, paragraphNumber
  lessons.sort((a, b) => {
    const ta = (a.textbookTitle ?? "").localeCompare(b.textbookTitle ?? "", "hy");
    if (ta !== 0) return ta;
    const ca = (a.chapterTitle ?? "").localeCompare(b.chapterTitle ?? "", "hy");
    if (ca !== 0) return ca;
    const la = (a.lessonNumber ?? 9999) - (b.lessonNumber ?? 9999);
    if (la !== 0) return la;
    return (a.paragraphNumber ?? "").localeCompare(b.paragraphNumber ?? "");
  });

  res.json(lessons.map((l) => ({
    id: l.id,
    courseId: l.courseId,
    title: l.title,
    lessonNumber: l.lessonNumber,
    pagesFrom: l.pagesFrom,
    pagesTo: l.pagesTo,
    textbookAuthor: l.textbookAuthor,
    textbookTitle: l.textbookTitle,
    chapterTitle: l.chapterTitle,
    paragraphNumber: l.paragraphNumber,
    status: l.status,
    mySessionStatus: l.mySessionStatus ?? null,
    assignedAt: l.assignedAt,
    completedAt: l.completedAt,
  })));
});

export default router;
