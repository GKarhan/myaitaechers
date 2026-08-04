import { Router } from "express";
import {
  db,
  subjectsTable,
  knowledgeNodesTable,
  lessonNodesTable,
  teachersTable,
  classesTable,
  classStudentsTable,
} from "@workspace/db";
import { eq, and, inArray, isNotNull } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

function getMasteryLevel(
  masteryScore: number | null,
  confidenceScore: number | null,
): "mastered" | "weak" | "in_progress" | "not_started" {
  // Never scored → not yet engaged with this topic
  if (masteryScore === null && confidenceScore === null) return "not_started";
  // Low confidence → still actively learning / uncertain
  if ((confidenceScore ?? 0) < 50) return "in_progress";
  // Sufficient confidence — evaluate mastery
  if ((masteryScore ?? 0) >= 80) return "mastered";
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

    // ── Fetch knowledge nodes for targetUser + subject ───────────────────────
    // INNER JOIN with lessonNodesTable to filter out orphaned nodes:
    //   • nodes with lessonNodeId IS NULL (source lesson was deleted, set-null fired)
    //   • nodes whose lessonNodeId references a lesson_node that no longer exists
    // This is a defensive second layer on top of the cascade-delete in the handler.
    const topics = await db
      .select({
        id:              knowledgeNodesTable.id,
        topicName:       knowledgeNodesTable.topicName,
        lessonNodeId:    knowledgeNodesTable.lessonNodeId,
        masteryScore:    knowledgeNodesTable.masteryScore,
        confidenceScore: knowledgeNodesTable.confidenceScore,
        status:          knowledgeNodesTable.status,
      })
      .from(knowledgeNodesTable)
      .innerJoin(
        lessonNodesTable,
        eq(knowledgeNodesTable.lessonNodeId, lessonNodesTable.id)
      )
      .where(
        and(
          eq(knowledgeNodesTable.subjectId, subjectId),
          eq(knowledgeNodesTable.userId, targetUserId),
          isNotNull(knowledgeNodesTable.lessonNodeId)
        )
      )
      .orderBy(knowledgeNodesTable.id);

    const mappedTopics = topics.map((t) => ({
      id:            t.id,
      topicName:     t.topicName,
      lessonNodeId:  t.lessonNodeId ?? null,
      score:         t.masteryScore ?? 0,
      confidenceScore: t.confidenceScore ?? null,
      status:        t.status,
      masteryLevel:  getMasteryLevel(t.masteryScore, t.confidenceScore),
    }));

    // ── Build AI recommendations ─────────────────────────────────────────────
    const recommendations: Array<{
      type: "start" | "review" | "repeat";
      message: string;
      topicName: string;
    }> = [];

    const notStarted = mappedTopics.filter((t) => t.masteryLevel === "not_started");
    const inProgress = mappedTopics.filter((t) => t.masteryLevel === "in_progress");
    const weak       = mappedTopics.filter((t) => t.masteryLevel === "weak");
    const mastered   = mappedTopics.filter((t) => t.masteryLevel === "mastered");

    if (notStarted.length > 0) {
      recommendations.push({
        type:      "start",
        message:   `Սկսեք «${notStarted[0].topicName}» թեմայից`,
        topicName: notStarted[0].topicName,
      });
    }

    // in_progress nodes are treated like weak for the "review" recommendation
    const toReview = weak.length > 0 ? weak : inProgress;
    if (toReview.length > 0) {
      const weakest = toReview.reduce((a, b) => (a.score < b.score ? a : b));
      recommendations.push({
        type:      "review",
        message:   `Կրկնեք «${weakest.topicName}» թեման — գնահատականը ${weakest.score}%`,
        topicName: weakest.topicName,
      });
    }

    if (mastered.length > 0) {
      recommendations.push({
        type:      "repeat",
        message:   `Կրկնեք «${mastered[0].topicName}» — ամրապնդեք գիտելիքը`,
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
