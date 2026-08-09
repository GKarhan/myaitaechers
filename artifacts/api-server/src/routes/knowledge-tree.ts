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

// ── Before change (for reference) ───────────────────────────────────────────
// function getMasteryLevel(
//   masteryScore: number | null,
//   confidenceScore: number | null,
// ): "mastered" | "weak" | "in_progress" | "not_started" {
//   if (masteryScore === null && confidenceScore === null) return "not_started";
//   if ((confidenceScore ?? 0) < 50) return "in_progress";
//   if ((masteryScore ?? 0) >= 80) return "mastered";
//   return "weak";
// }
// ── After change ─────────────────────────────────────────────────────────────
// Added `dueAt` parameter. If the node would otherwise be "mastered" AND it
// has a review_schedule row with dueAt in the past, return "needs_review"
// instead. Every other branch is identical to the original.
function getMasteryLevel(
  masteryScore: number | null,
  confidenceScore: number | null,
  dueAt: Date | null,
): "mastered" | "needs_review" | "weak" | "in_progress" | "not_started" {
  // Never scored → not yet engaged with this topic
  if (masteryScore === null && confidenceScore === null) return "not_started";
  // Low confidence → still actively learning / uncertain
  if ((confidenceScore ?? 0) < 50) return "in_progress";
  // Sufficient confidence — evaluate mastery
  if ((masteryScore ?? 0) >= 80) {
    // Overdue for spaced-repetition review → demote from mastered to needs_review
    if (dueAt !== null && dueAt <= new Date()) return "needs_review";
    return "mastered";
  }
  return "weak"; // masteryScore 0–79 with confidence ≥ 50
}

const router = Router();

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

      // Resolve teacher record (same pattern as teacher.ts routes)
      const [teacher] = await db
        .select({ id: teachersTable.id })
        .from(teachersTable)
        .where(eq(teachersTable.userId, req.userId!))
        .limit(1);
      if (!teacher) {
        res.status(403).json({ error: "Teacher profile not found" });
        return;
      }

      // Fetch teacher's classes, then verify the student is in one of them
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

    // ── Fetch all lesson nodes for this student's enrolled courses ───────────
    // Architecture: drive from lesson_nodes (not knowledge_nodes) so that nodes
    // the student has never touched still appear as "Դеррр чи ousumnasirel"
    // (not_started with NULL scores).
    //
    // Step 1: resolve the set of courseIds this student is enrolled in for this
    //         subject — avoids fan-out duplicates from the join below.
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

    // Step 2: all lesson_nodes for those courses, LEFT JOIN to knowledge_nodes.
    //   • Untouched nodes → knowledge_nodes row is NULL → mastery/conf NULL
    //   • Touched nodes   → scores from the knowledge_nodes row
    //   • review_schedule LEFT JOIN → brings dueAt for spaced-rep (internal only)
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
      .where(inArray(lessonsTable.courseId, courseIds))
      .orderBy(lessonNodesTable.id);

    const mappedTopics = topics.map((t) => {
      const rawLevel = getMasteryLevel(t.masteryScore, t.confidenceScore, t.dueAt ?? null);
      // needs_review folds into mastered — Knowledge Tree shows only 4 visible blocks:
      //   mastered (Գиtи) | weak (Мasnak'i giti) | in_progress (Чгиtи) | not_started (Дерр чи)
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
        message:   `Սկսեք «${notStarted[0].topicName}» թեմայից`,
        topicName: notStarted[0].topicName,
      });
    }

    // Weakest node among weak or in_progress (Чгиtи / Мasnak'i giti) → suggest review
    const toReview = [...weak, ...inProgress];
    if (toReview.length > 0) {
      const weakest = toReview.reduce((a, b) => (a.score < b.score ? a : b));
      recommendations.push({
        type:      "review",
        message:   `Կрկнець «${weakest.topicName}» թеман — գнахатаканը ${weakest.score}%`,
        topicName: weakest.topicName,
      });
    }

    if (mastered.length > 0) {
      recommendations.push({
        type:      "repeat",
        message:   `Կрկнець «${mastered[0].topicName}» — амрапндець гителиkы`,
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
