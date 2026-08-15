import { Router } from "express";
import {
  db,
  subjectsTable,
  knowledgeNodesTable,
  lessonNodesTable,
  lessonTopicsTable,
  lessonsTable,
  coursesTable,
  teachersTable,
  classesTable,
  classStudentsTable,
  reviewScheduleTable,
} from "@workspace/db";
import { eq, and, inArray, isNotNull } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { getMasteryLevelFromScores, aggregateKnowledgeCoverage } from "../lib/mastery";

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

    // Step 3: Collect per-subject node lists for coverage aggregation (KT-1.4A).
    // Only masteryLevel is needed — coverage does not average scores.
    type NodeLevel = { masteryLevel: "mastered" | "weak" | "in_progress" | "not_started" };
    const subjectNodes = new Map<number, NodeLevel[]>();
    for (const sid of subjectMeta.keys()) {
      subjectNodes.set(sid, []);
    }

    for (const node of nodes) {
      const sid = node.courseSubjectId;
      if (sid == null) continue;
      const list = subjectNodes.get(sid);
      if (!list) continue;

      const rawLevel = getMasteryLevelFromScores(node.masteryScore, node.confidenceScore, node.dueAt ?? null);
      // needs_review folds into mastered (same 4-state policy as per-subject KT endpoint)
      const masteryLevel = (rawLevel === "needs_review" ? "mastered" : rawLevel) as NodeLevel["masteryLevel"];

      list.push({ masteryLevel });
    }

    // Step 4: Build response preserving enrollment order (deduped by subjectId).
    const seen = new Set<number>();
    const subjects = [];
    for (const row of validCourses) {
      if (seen.has(row.subjectId)) continue;
      seen.add(row.subjectId);
      const coverage = aggregateKnowledgeCoverage(subjectNodes.get(row.subjectId) ?? []);
      subjects.push({ subjectId: row.subjectId, subjectName: row.subjectName, ...coverage });
    }

    res.json({ subjects });
  }
);

// ── GET /knowledge-tree/:subjectId ───────────────────────────────────────────
// KT-1.3: Per-subject hierarchical Knowledge Tree.
//
// Response shape:
//   { subjectId, subjectName, lessons: [{ lessonId, lessonTitle, lessonNumber,
//     topics: [{ topicId, topicTitle, topicSequence, nodes: [...] }],
//     ungroupedNodes: [...] }], recommendations: [...] }
//
// Hierarchy: Subject → Lesson → Topic → MicroNode
// Ordering:  lessons by (lessonNumber NULLS LAST, lessonId)
//            topics by (topic.sequence, topic.id)
//            nodes by (node.sequence, node.id)
//
// Visibility contract (KT-1.2, preserved):
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
      res.json({ subjectId: subject.id, subjectName: subject.name, lessons: [], recommendations: [] });
      return;
    }
    const courseIds = enrolledCourses.map((c) => c.courseId);

    // ── Step 1: Fetch all visible MicroNodes with lesson + mastery info ───────
    // Drives from lesson_nodes so nodes with no knowledge_nodes row appear
    // as not_started (LEFT JOIN NULL).
    const nodeRows = await db
      .select({
        lessonId:        lessonsTable.id,
        lessonTitle:     lessonsTable.title,
        lessonNumber:    lessonsTable.lessonNumber,
        lessonNodeId:    lessonNodesTable.id,
        nodeTitle:       lessonNodesTable.title,
        nodeSequence:    lessonNodesTable.sequence,
        topicId:         lessonNodesTable.topicId,       // nullable — null means ungrouped
        masteryScore:    knowledgeNodesTable.masteryScore,
        confidenceScore: knowledgeNodesTable.confidenceScore,
        dueAt:           reviewScheduleTable.dueAt,
      })
      .from(lessonNodesTable)
      .innerJoin(lessonsTable, eq(lessonNodesTable.lessonId, lessonsTable.id))
      .innerJoin(coursesTable, and(
        eq(lessonsTable.courseId, coursesTable.id),
        inArray(coursesTable.id, courseIds),
        eq(coursesTable.subjectId, subjectId),
      ))
      .leftJoin(knowledgeNodesTable, and(
        eq(knowledgeNodesTable.lessonNodeId, lessonNodesTable.id),
        eq(knowledgeNodesTable.userId,       targetUserId),
        eq(knowledgeNodesTable.subjectId,    subjectId),
      ))
      .leftJoin(reviewScheduleTable, and(
        eq(reviewScheduleTable.topicId, knowledgeNodesTable.id),
        eq(reviewScheduleTable.userId,  targetUserId),
      ))
      .where(and(
        eq(lessonsTable.status,     "active"),
        eq(lessonNodesTable.status, "approved"),
      ));

    // ── Step 2: Fetch lesson_topics for all involved lessons ─────────────────
    const lessonIds = [...new Set(nodeRows.map(r => r.lessonId))];
    const topicRows = lessonIds.length > 0
      ? await db
          .select()
          .from(lessonTopicsTable)
          .where(inArray(lessonTopicsTable.lessonId, lessonIds))
      : [];

    // ── Step 3: Build hierarchical structure in-memory ────────────────────────

    type MasteryLevel4 = "mastered" | "weak" | "in_progress" | "not_started";

    interface MicroNode {
      lessonNodeId: number;
      title: string;
      sequence: number;
      masteryScore: number;       // pre-normalised: 0 for not_started
      confidenceScore: number | null;
      masteryLevel: MasteryLevel4;
    }

    // Process each flat row → typed MicroNode
    const processedNodes = nodeRows.map((row) => {
      const rawLevel = getMasteryLevelFromScores(
        row.masteryScore, row.confidenceScore, row.dueAt ?? null
      );
      const masteryLevel: MasteryLevel4 =
        rawLevel === "needs_review" ? "mastered" : rawLevel;
      return {
        lessonId:  row.lessonId,
        topicId:   row.topicId ?? null,
        lessonNodeId: row.lessonNodeId,
        title:     row.nodeTitle,
        sequence:  row.nodeSequence,
        masteryScore:    row.masteryScore    ?? 0,
        confidenceScore: row.confidenceScore ?? null,
        masteryLevel,
        // lesson meta — kept for lesson map below
        lessonTitle:  row.lessonTitle,
        lessonNumber: row.lessonNumber,
      };
    });

    // De-duplicate lessons (same lesson can appear multiple times if it has
    // multiple enrolled courses — rare but possible)
    const lessonMeta = new Map<number, { lessonTitle: string; lessonNumber: number | null }>();
    for (const n of processedNodes) {
      if (!lessonMeta.has(n.lessonId)) {
        lessonMeta.set(n.lessonId, { lessonTitle: n.lessonTitle, lessonNumber: n.lessonNumber });
      }
    }

    // Build topic map: topicId → topic record
    const topicMap = new Map(topicRows.map(t => [t.id, t]));

    // Group nodes: lessonId → (topicId | "ungrouped") → MicroNode[]
    const lessonBuckets = new Map<number, Map<number | "ungrouped", MicroNode[]>>();
    for (const node of processedNodes) {
      if (!lessonBuckets.has(node.lessonId)) {
        lessonBuckets.set(node.lessonId, new Map());
      }
      const lb = lessonBuckets.get(node.lessonId)!;
      const key: number | "ungrouped" = node.topicId ?? "ungrouped";
      if (!lb.has(key)) lb.set(key, []);
      lb.get(key)!.push({
        lessonNodeId: node.lessonNodeId,
        title:        node.title,
        sequence:     node.sequence,
        masteryScore: node.masteryScore,
        confidenceScore: node.confidenceScore,
        masteryLevel: node.masteryLevel,
      });
    }

    // Sort nodes within each bucket: sequence ASC, lessonNodeId ASC (stable tiebreak)
    for (const topicBuckets of lessonBuckets.values()) {
      for (const nodes of topicBuckets.values()) {
        nodes.sort((a, b) => a.sequence - b.sequence || a.lessonNodeId - b.lessonNodeId);
      }
    }

    // Sort lessons: lessonNumber ASC (NULLS LAST), lessonId ASC
    const sortedLessonIds = [...lessonMeta.keys()].sort((a, b) => {
      const numA = lessonMeta.get(a)!.lessonNumber;
      const numB = lessonMeta.get(b)!.lessonNumber;
      if (numA !== null && numB !== null) return numA - numB;
      if (numA === null && numB !== null) return 1;   // null sorts last
      if (numA !== null && numB === null) return -1;
      return a - b;  // both null → sort by id
    });

    // Build lessons array with KT-1.4A coverage aggregation at topic, lesson level
    const lessons = sortedLessonIds.map((lessonId) => {
      const meta    = lessonMeta.get(lessonId)!;
      const buckets = lessonBuckets.get(lessonId) ?? new Map();

      // Topics: all lesson_topics for this lesson, sorted by sequence then id
      const lessonTopicsForLesson = topicRows
        .filter(t => t.lessonId === lessonId)
        .sort((a, b) => a.sequence - b.sequence || a.id - b.id);

      const topics = lessonTopicsForLesson
        .map(topic => {
          const nodes = buckets.get(topic.id) ?? [];
          return {
            topicId:       topic.id,
            topicTitle:    topic.title,
            topicSequence: topic.sequence,
            nodes,
            // KT-1.4A: authoritative topic-level coverage aggregation
            ...aggregateKnowledgeCoverage(nodes),
          };
        })
        .filter(t => t.nodes.length > 0);  // omit topics with zero approved nodes

      // Ungrouped nodes (topicId = null)
      const ungroupedNodes = buckets.get("ungrouped") ?? [];

      // All child MicroNodes for this lesson
      const allLessonNodes = [
        ...topics.flatMap(t => t.nodes),
        ...ungroupedNodes,
      ];

      return {
        lessonId,
        lessonTitle:  meta.lessonTitle,
        lessonNumber: meta.lessonNumber,
        topics,
        ungroupedNodes,
        // KT-1.4A: coverage for "Առanc khmbi" (ungrouped) display group
        ungroupedCoverage: aggregateKnowledgeCoverage(ungroupedNodes),
        // KT-1.4A: lesson-level coverage (topics + ungrouped)
        ...aggregateKnowledgeCoverage(allLessonNodes),
      };
    });

    // ── AI recommendations (from flat node list, same logic as KT-1.2) ───────
    const flatNodes = processedNodes;

    const recommendations: Array<{
      type: "start" | "review" | "repeat";
      message: string;
      topicName: string;
    }> = [];

    const notStarted = flatNodes.filter(n => n.masteryLevel === "not_started");
    const inProgress = flatNodes.filter(n => n.masteryLevel === "in_progress");
    const weak       = flatNodes.filter(n => n.masteryLevel === "weak");
    const mastered   = flatNodes.filter(n => n.masteryLevel === "mastered");

    if (notStarted.length > 0) {
      recommendations.push({
        type:      "start",
        message:   `Սկսել «${notStarted[0].title}» թեման`,
        topicName: notStarted[0].title,
      });
    }

    const toReview = [...weak, ...inProgress];
    if (toReview.length > 0) {
      const weakest = toReview.reduce((a, b) => (a.masteryScore < b.masteryScore ? a : b));
      recommendations.push({
        type:      "review",
        message:   `Կրկնել «${weakest.title}» — գնահատականը ${weakest.masteryScore}%`,
        topicName: weakest.title,
      });
    }

    if (mastered.length > 0) {
      recommendations.push({
        type:      "repeat",
        message:   `Կրկնել «${mastered[0].title}» — ամրապնդել գիտելիքները`,
        topicName: mastered[0].title,
      });
    }

    // ── Deduplicate safety (T24) ─────────────────────────────────────────────
    // Check for duplicate lessonNodeIds (shouldn't happen, but log if present)
    const allNodeIds = processedNodes.map(n => n.lessonNodeId);
    const uniqueNodeIds = new Set(allNodeIds);
    if (uniqueNodeIds.size !== allNodeIds.length) {
      console.warn(`[KT-1.3] Duplicate lessonNodeIds detected for subjectId=${subjectId}`);
    }

    // KT-1.4A: subject-level coverage aggregation from all visible atomic MicroNodes
    const subjectCoverage = aggregateKnowledgeCoverage(processedNodes);

    res.json({
      subjectId:   subject.id,
      subjectName: subject.name,
      ...subjectCoverage,
      lessons,
      recommendations,
    });
  }
);

export default router;
