import { Router } from "express";
import {
  db,
  subjectsTable,
  knowledgeNodesTable,
  lessonNodesTable,
  lessonsTable,
  coursesTable,
  teachersTable,
  classesTable,
  classStudentsTable,
  reviewScheduleTable,
} from "@workspace/db";
import { eq, and, inArray, isNotNull } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { getMasteryLevelFromScores } from "../lib/mastery";

const router = Router();

// ── GET /knowledge-tree/subjects ─────────────────────────────────────────────
// Subject-selection endpoint: returns all enrolled subjects with per-subject
// MicroNode counts broken down by the 4-state mastery model.
//
// MUST be registered BEFORE /:subjectId — otherwise Express matches the literal
// string "subjects" as the :subjectId integer param and returns a 400.
//
// Authoritative enrollment chain (KT-1.1 verdict):
//   class_students → courses → subjects
//
// Visibility contract (KT-1.2):
//   A. lesson.status = 'active'           (student-facing)
//   B. lesson_nodes.status = 'approved'   (teacher-approved content)
//   C. subject belongs to enrolled curriculum
//   knowledge_nodes row NOT required — absent KN → not_started (LEFT JOIN NULL)
router.get(
  "/knowledge-tree/subjects",
  requireAuth,
  async (req: AuthRequest, res) => {
    const targetUserId = req.userId!;

    // Step 1: Resolve all enrolled courses (all subjects) for this student.
    // Authoritative chain: class_students → courses → subjects.
    const enrolledCourses = await db
      .select({
        courseId:    coursesTable.id,          // serial PK — always number
        subjectId:   coursesTable.subjectId,   // nullable FK → filter nulls below
        subjectName: subjectsTable.name,
      })
      .from(coursesTable)
      .innerJoin(subjectsTable, and(
        isNotNull(coursesTable.subjectId),
        eq(coursesTable.subjectId, subjectsTable.id),
      ))
      .innerJoin(
        classStudentsTable,
        and(
          eq(coursesTable.classId,         classStudentsTable.classId),
          eq(classStudentsTable.studentId, targetUserId),
        )
      );

    if (enrolledCourses.length === 0) {
      res.json({ subjects: [] });
      return;
    }

    // Build subject metadata (deduplicate by subjectId; subjectId is non-null here
    // because the JOIN with subjectsTable + isNotNull filter guarantees it)
    type ValidCourse = { courseId: number; subjectId: number; subjectName: string };
    const validCourses = enrolledCourses.filter(
      (r): r is ValidCourse => r.subjectId != null
    );
    if (validCourses.length === 0) {
      res.json({ subjects: [] });
      return;
    }

    const subjectMeta = new Map<number, { subjectId: number; subjectName: string }>();
    for (const row of validCourses) {
      if (!subjectMeta.has(row.subjectId)) {
        subjectMeta.set(row.subjectId, { subjectId: row.subjectId, subjectName: row.subjectName });
      }
    }

    // Step 2: Fetch all visible MicroNodes across all enrolled subjects.
    // Visibility gate: active lesson + approved node (KT-1.2).
    // Use JOIN through classStudentsTable (avoids inArray with nullable lessons.courseId).
    // LEFT JOIN knowledge_nodes to get learner state (NULL → not_started).
    const nodes = await db
      .select({
        lessonNodeId:    lessonNodesTable.id,
        courseSubjectId: coursesTable.subjectId,   // number | null — guarded in loop
        masteryScore:    knowledgeNodesTable.masteryScore,
        confidenceScore: knowledgeNodesTable.confidenceScore,
        dueAt:           reviewScheduleTable.dueAt,
      })
      .from(lessonNodesTable)
      .innerJoin(lessonsTable,  eq(lessonNodesTable.lessonId,  lessonsTable.id))
      .innerJoin(coursesTable,  eq(lessonsTable.courseId,      coursesTable.id))
      .innerJoin(
        classStudentsTable,
        and(
          eq(coursesTable.classId,         classStudentsTable.classId),
          eq(classStudentsTable.studentId, targetUserId),
        )
      )
      .leftJoin(
        knowledgeNodesTable,
        and(
          eq(knowledgeNodesTable.lessonNodeId, lessonNodesTable.id),
          eq(knowledgeNodesTable.userId,       targetUserId),
          // coursesTable.subjectId is nullable; Drizzle LEFT JOIN condition handles NULL gracefully
          eq(knowledgeNodesTable.subjectId,    coursesTable.subjectId as unknown as number),
        )
      )
      .leftJoin(
        reviewScheduleTable,
        and(
          eq(reviewScheduleTable.topicId, knowledgeNodesTable.id),
          eq(reviewScheduleTable.userId,  targetUserId),
        )
      )
      .where(
        and(
          isNotNull(lessonsTable.courseId),        // exclude lessons not linked to a course
          eq(lessonsTable.status,     "active"),   // student-facing lessons only
          eq(lessonNodesTable.status, "approved"), // teacher-approved nodes only
        )
      );

    // Step 3: Aggregate counts per subject.
    const counts = new Map<number, {
      totalUnits:      number;
      masteredCount:   number;
      weakCount:       number;
      inProgressCount: number;
      notStartedCount: number;
    }>();
    for (const sid of subjectMeta.keys()) {
      counts.set(sid, { totalUnits: 0, masteredCount: 0, weakCount: 0, inProgressCount: 0, notStartedCount: 0 });
    }

    for (const node of nodes) {
      // Guard: skip if courseSubjectId is null (shouldn't happen given INNER JOINs above,
      // but coursesTable.subjectId is nullable in the schema)
      const sid = node.courseSubjectId;
      if (sid == null) continue;
      const c = counts.get(sid);
      if (!c) continue;

      const rawLevel = getMasteryLevelFromScores(node.masteryScore, node.confidenceScore, node.dueAt ?? null);
      // needs_review folds into mastered (same policy as per-subject KT endpoint)
      const level = rawLevel === "needs_review" ? "mastered" : rawLevel;

      c.totalUnits++;
      if      (level === "mastered")    c.masteredCount++;
      else if (level === "weak")        c.weakCount++;
      else if (level === "in_progress") c.inProgressCount++;
      else                              c.notStartedCount++;
    }

    // Step 4: Build response preserving enrollment order (deduped by subjectId).
    const seen = new Set<number>();
    const subjects = [];
    for (const row of validCourses) {
      if (seen.has(row.subjectId)) continue;
      seen.add(row.subjectId);
      const c = counts.get(row.subjectId)!;
      subjects.push({ subjectId: row.subjectId, subjectName: row.subjectName, ...c });
    }

    res.json({ subjects });
  }
);

// ── GET /knowledge-tree/:subjectId ───────────────────────────────────────────
// Per-subject Knowledge Tree for a single student (or teacher viewing a student).
//
// KT-1.2 visibility contract (fixes the Phase 1.11 "approved" gate bug):
//   lesson.status = 'active'  AND  lesson_nodes.status = 'approved'
//   knowledge_nodes row NOT required — absent KN synthesised as not_started.
router.get(
  "/knowledge-tree/:subjectId",
  requireAuth,
  async (req: AuthRequest, res) => {
    const subjectId = parseInt(String(req.params.subjectId), 10);
    if (isNaN(subjectId)) {
      res.status(400).json({ error: "Invalid subject id" });
      return;
    }

    // ── Optional teacher-view: ?studentId=X ─────────────────────────────────
    const rawStudentId = req.query.studentId as string | undefined;
    let targetUserId = req.userId!;

    if (rawStudentId) {
      const studentId = parseInt(rawStudentId, 10);
      if (isNaN(studentId)) {
        res.status(400).json({ error: "Invalid studentId" });
        return;
      }

      // Only teachers/admins may request another user's tree
      if (req.userRole !== "teacher" && req.userRole !== "admin") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      // Resolve teacher record
      const [teacher] = await db
        .select({ id: teachersTable.id })
        .from(teachersTable)
        .where(eq(teachersTable.userId, req.userId!))
        .limit(1);
      if (!teacher) {
        res.status(403).json({ error: "Teacher profile not found" });
        return;
      }

      // Verify student is in one of the teacher's classes
      const myClasses = await db
        .select({ id: classesTable.id })
        .from(classesTable)
        .where(eq(classesTable.teacherId, teacher.id));

      if (myClasses.length === 0) {
        res.status(403).json({ error: "Not authorized to view this student" });
        return;
      }

      const classIds = myClasses.map((c) => c.id);
      const [membership] = await db
        .select({ studentId: classStudentsTable.studentId })
        .from(classStudentsTable)
        .where(
          and(
            eq(classStudentsTable.studentId, studentId),
            inArray(classStudentsTable.classId, classIds)
          )
        )
        .limit(1);

      if (!membership) {
        res.status(403).json({ error: "Not authorized to view this student's tree" });
        return;
      }

      targetUserId = studentId;
    }

    // ── Fetch subject ────────────────────────────────────────────────────────
    const [subject] = await db
      .select()
      .from(subjectsTable)
      .where(eq(subjectsTable.id, subjectId))
      .limit(1);

    if (!subject) {
      res.status(404).json({ error: "Subject not found" });
      return;
    }

    // ── Fetch enrolled course IDs for this student + subject ─────────────────
    // Authoritative chain: class_students → courses → subjects.
    // Returns empty if student not enrolled.
    const enrolledCourses = await db
      .select({ courseId: coursesTable.id })
      .from(coursesTable)
      .innerJoin(
        classStudentsTable,
        and(
          eq(coursesTable.classId,           classStudentsTable.classId),
          eq(classStudentsTable.studentId,   targetUserId),
        )
      )
      .where(eq(coursesTable.subjectId, subjectId));

    if (enrolledCourses.length === 0) {
      res.json({ subjectId: subject.id, subjectName: subject.name, topics: [], recommendations: [] });
      return;
    }
    const courseIds = enrolledCourses.map((c) => c.courseId);

    // ── Fetch visible MicroNodes ─────────────────────────────────────────────
    // Architecture: drive from lesson_nodes (not knowledge_nodes) so that nodes
    // the student has never touched still appear as not_started.
    //
    // KT-1.2 visibility gate (replaces the broken Phase 1.11 "approved" gate):
    //   lesson.status = 'active'         — student-facing lessons only
    //   lesson_nodes.status = 'approved' — teacher-approved curriculum content only
    //   No knowledge_nodes row required  — absence = not_started via LEFT JOIN NULL.
    //
    // Uses JOIN through classStudentsTable to filter by enrollment, avoiding
    // inArray(lessons.courseId, ...) which has a nullable column type issue.
    const topics = await db
      .select({
        lessonNodeId:    lessonNodesTable.id,
        lessonNodeTitle: lessonNodesTable.title,
        knId:            knowledgeNodesTable.id,
        topicName:       knowledgeNodesTable.topicName,
        masteryScore:    knowledgeNodesTable.masteryScore,
        confidenceScore: knowledgeNodesTable.confidenceScore,
        status:          knowledgeNodesTable.status,
        dueAt:           reviewScheduleTable.dueAt,
      })
      .from(lessonNodesTable)
      .innerJoin(lessonsTable, eq(lessonNodesTable.lessonId, lessonsTable.id))
      .innerJoin(coursesTable, and(
        eq(lessonsTable.courseId, coursesTable.id),
        inArray(coursesTable.id, courseIds),         // filter by enrolled course IDs (PK — non-null)
        eq(coursesTable.subjectId, subjectId),        // scope to this subject
      ))
      .leftJoin(
        knowledgeNodesTable,
        and(
          eq(knowledgeNodesTable.lessonNodeId, lessonNodesTable.id),
          eq(knowledgeNodesTable.userId,       targetUserId),
          eq(knowledgeNodesTable.subjectId,    subjectId),
        )
      )
      .leftJoin(
        reviewScheduleTable,
        and(
          eq(reviewScheduleTable.topicId, knowledgeNodesTable.id),
          eq(reviewScheduleTable.userId,  targetUserId),
        )
      )
      // KT-1.2 gate: active lesson + approved node
      .where(
        and(
          eq(lessonsTable.status,     "active"),    // student-facing lessons
          eq(lessonNodesTable.status, "approved"),  // teacher-approved nodes only
        )
      )
      .orderBy(lessonNodesTable.id);

    const mappedTopics = topics.map((t) => {
      const rawLevel = getMasteryLevelFromScores(t.masteryScore, t.confidenceScore, t.dueAt ?? null);
      // needs_review folds into mastered — Knowledge Tree shows only 4 visible blocks:
      //   mastered (Գиtи) | weak (Масnakи γиtи) | in_progress (Чγиtи) | not_started (Деrrr чи ousumnasirel)
      const masteryLevel: "mastered" | "weak" | "in_progress" | "not_started" =
        rawLevel === "needs_review" ? "mastered" : rawLevel;
      return {
        id:              t.knId ?? t.lessonNodeId,
        topicName:       t.topicName ?? t.lessonNodeTitle,
        lessonNodeId:    t.lessonNodeId,
        score:           t.masteryScore ?? 0,
        confidenceScore: t.confidenceScore ?? null,
        status:          t.status ?? "not_started",
        masteryLevel,
      };
    });

    // ── Build AI recommendations ─────────────────────────────────────────────
    const recommendations: Array<{
      type: "start" | "review" | "repeat";
      message: string;
      topicName: string;
    }> = [];

    const notStarted  = mappedTopics.filter((t) => t.masteryLevel === "not_started");
    const inProgress  = mappedTopics.filter((t) => t.masteryLevel === "in_progress");
    const weak        = mappedTopics.filter((t) => t.masteryLevel === "weak");
    const mastered    = mappedTopics.filter((t) => t.masteryLevel === "mastered");

    if (notStarted.length > 0) {
      recommendations.push({
        type:      "start",
        message:   `Սկсеть «${notStarted[0].topicName}» թема`,
        topicName: notStarted[0].topicName,
      });
    }

    const toReview = [...weak, ...inProgress];
    if (toReview.length > 0) {
      const weakest = toReview.reduce((a, b) => (a.score < b.score ? a : b));
      recommendations.push({
        type:      "review",
        message:   `Կrknецте «${weakest.topicName}» — гnaatakne ${weakest.score}%`,
        topicName: weakest.topicName,
      });
    }

    if (mastered.length > 0) {
      recommendations.push({
        type:      "repeat",
        message:   `Կrknецте «${mastered[0].topicName}» — amrape'ndets giteliknere`,
        topicName: mastered[0].topicName,
      });
    }

    res.json({
      subjectId:       subject.id,
      subjectName:     subject.name,
      topics:          mappedTopics,
      recommendations,
    });
  }
);

export default router;
