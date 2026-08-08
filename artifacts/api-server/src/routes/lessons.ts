import { logger } from "../lib/logger";
import { updateStudentProfile } from "../services/student-profile";
import { Router, type Response } from "express";
import { db, lessonsTable, lessonSessionsTable, subjectsTable, knowledgeNodesTable, lessonNodesTable, lessonTopicsTable, resourcesTable, lessonExercisesTable, lessonNodeDependenciesTable, evidenceEventsTable, coursesTable, classStudentsTable, mappingJobsTable, mappingImportLogTable, mappingReviewItemsTable } from "@workspace/db";
import { parseMappingText } from "../mapping/mapTextParser.js";
import { validateParsedMapping } from "../mapping/mapTextValidator.js";
import { insertParsedMapping } from "../mapping/mapTextInserter.js";
import { createHash } from "crypto";
import { eq, and, asc, desc, max, inArray, count } from "drizzle-orm";
import { requireAuth, requireTeacher, type AuthRequest } from "../middlewares/auth";
import { extractPdfPageRange, resolveUploadedFilePath, isGarbledText, rasterizePdfPages, extractBlocksWithAI, extractBlocksWithVision, runPass2Pipeline, generatePhase2Content, isWeakSource, type Pass1Result, type Phase2Input, type Phase2LinkedExercise } from "../services/lesson-mapping";
import { callAIP6 } from "../services/ai";
import { getDueReviewTopics } from "../services/review-schedule";

const router = Router();

router.post("/lessons", requireAuth, async (req: AuthRequest, res) => {
  const { subjectId, title, description, bloomLevel } = req.body as {
    subjectId?: number;
    title?: string;
    description?: string;
    bloomLevel?: number;
  };

  if (!subjectId || !title?.trim()) {
    res.status(400).json({ error: "subjectId and title are required" });
    return;
  }

  const [subject] = await db
    .select()
    .from(subjectsTable)
    .where(eq(subjectsTable.id, subjectId))
    .limit(1);

  if (!subject) {
    res.status(400).json({ error: "Subject not found" });
    return;
  }

  const [lesson] = await db
    .insert(lessonsTable)
    .values({
      subjectId,
      title: title.trim(),
      description: description?.trim() ?? "",
      bloomLevel: bloomLevel ?? 1,
    })
    .returning();

  res.status(201).json({
    id: lesson.id,
    subjectId: lesson.subjectId,
    title: lesson.title,
    description: lesson.description,
    bloomLevel: lesson.bloomLevel,
    createdAt: lesson.createdAt.toISOString(),
  });
});

router.post("/lessons/:lessonId/delete", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson id" });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Explicitly delete knowledge_nodes whose lessonNodeId maps to this lesson's nodes
  // (belt-and-suspenders on top of the DB-level cascade)
  const lessonNodeIds = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId));
  if (lessonNodeIds.length > 0) {
    await db
      .delete(knowledgeNodesTable)
      .where(inArray(knowledgeNodesTable.lessonNodeId, lessonNodeIds.map(n => n.id)));
  }

  await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId));
  res.json({ message: "Lesson deleted" });
});

router.get("/lessons/:lessonId", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson id" });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  const [subject] = await db
    .select()
    .from(subjectsTable)
    .where(eq(subjectsTable.id, lesson.subjectId))
    .limit(1);

  const [session] = await db
    .select()
    .from(lessonSessionsTable)
    .where(
      and(
        eq(lessonSessionsTable.lessonId, lessonId),
        eq(lessonSessionsTable.userId, req.userId!)
      )
    )
    .limit(1);

  res.json({
    id: lesson.id,
    subjectId: lesson.subjectId,
    subjectName: subject?.name ?? "",
    title: lesson.title,
    description: lesson.description,
    bloomLevel: lesson.bloomLevel,
    content: lesson.content ?? null,
    currentSession: session
      ? {
          id: session.id,
          lessonId: session.lessonId,
          currentPhase: session.currentPhase,
          status: session.status,
          masteryScore: session.masteryScore ?? null,
          currentNodeId: session.currentNodeId ?? null,
          nodeStartedAt: session.nodeStartedAt?.toISOString() ?? null,
          startedAt: session.startedAt.toISOString(),
          completedAt: session.completedAt?.toISOString() ?? null,
        }
      : null,
  });
});

// Start or resume a lesson session
router.post("/lessons/start", requireAuth, async (req: AuthRequest, res) => {
  const { lessonId } = req.body as { lessonId: number };
  if (!lessonId) {
    res.status(400).json({ error: "lessonId is required" });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  const existing = await db
    .select()
    .from(lessonSessionsTable)
    .where(
      and(
        eq(lessonSessionsTable.lessonId, lessonId),
        eq(lessonSessionsTable.userId, req.userId!)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    let s = existing[0];

    // ── Stale-phase correction ────────────────────────────────────────────
    // A session may have been created with currentPhase=1 (REVIEW) because
    // review_schedule had entries but evidence_events was empty (stale data).
    // Detect that case now and correct it before returning.
    const [dueTopicsReuse, priorEvidenceReuse] = await Promise.all([
      getDueReviewTopics(req.userId!),
      db
        .select({ id: evidenceEventsTable.id })
        .from(evidenceEventsTable)
        .where(eq(evidenceEventsTable.userId, req.userId!))
        .limit(1),
    ]);
    const prevExistsReuse = priorEvidenceReuse.length > 0;
    const shouldCorrect   = s.currentPhase === 1 && !prevExistsReuse;

    if (shouldCorrect) {
      // Find first node so we can restore a clean teaching start
      const [firstNodeReuse] = await db
        .select({ id: lessonNodesTable.id })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.lessonId, lessonId))
        .orderBy(asc(lessonNodesTable.sequence))
        .limit(1);

      const correctedPhase = (dueTopicsReuse.length > 0 && prevExistsReuse) ? 1 : 2;
      await db
        .update(lessonSessionsTable)
        .set({
          currentPhase:    correctedPhase,
          nodeAttemptCount: 0,
          currentNodeId:   firstNodeReuse?.id ?? s.currentNodeId,
          nodeStartedAt:   firstNodeReuse ? new Date() : s.nodeStartedAt,
        })
        .where(eq(lessonSessionsTable.id, s.id));

      // Reload corrected row
      const [corrected] = await db
        .select()
        .from(lessonSessionsTable)
        .where(eq(lessonSessionsTable.id, s.id))
        .limit(1);
      s = corrected;

      logger.info(
        {
          sessionId:            s.id,
          existingSession:      true,
          previousLessonExists: prevExistsReuse,
          reviewTargetsCount:   dueTopicsReuse.length,
          selectedPhase:        correctedPhase,
          corrected:            true,
          lessonId,
          userId:               req.userId!,
        },
        "lessons/start: existing session phase corrected (was REVIEW, no evidence)"
      );
    } else {
      logger.info(
        {
          sessionId:            s.id,
          existingSession:      true,
          previousLessonExists: prevExistsReuse,
          reviewTargetsCount:   dueTopicsReuse.length,
          selectedPhase:        s.currentPhase,
          corrected:            false,
          lessonId,
          userId:               req.userId!,
        },
        "lessons/start: returning existing session"
      );
    }

    res.status(201).json({
      id: s.id,
      lessonId: s.lessonId,
      currentPhase: s.currentPhase,
      status: s.status,
      masteryScore: s.masteryScore ?? null,
      currentNodeId: s.currentNodeId ?? null,
      nodeStartedAt: s.nodeStartedAt?.toISOString() ?? null,
      startedAt: s.startedAt.toISOString(),
      completedAt: s.completedAt?.toISOString() ?? null,
    });
    return;
  }

  // If this lesson has been broken into nodes, start on the first one.
  // Lessons without nodes yet behave exactly as before (currentNodeId stays null).
  const [firstNode] = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence))
    .limit(1);

  // ── Phase selection: skip Phase 1 (Review) if no due review targets exist ──
  // Phase 1 only has value when there is prior lesson evidence to review.
  // A brand-new student or a student with no due topics goes straight to
  // Phase 2 (Teaching) on the first node.
  const [dueTopics, priorEvidence] = await Promise.all([
    getDueReviewTopics(req.userId!),
    db
      .select({ id: evidenceEventsTable.id })
      .from(evidenceEventsTable)
      .where(eq(evidenceEventsTable.userId, req.userId!))
      .limit(1),
  ]);

  const reviewTargetsCount   = dueTopics.length;
  const previousLessonExists = priorEvidence.length > 0;
  const selectedInitialPhase =
    (reviewTargetsCount > 0 && previousLessonExists)
      ? 1
      : 2;

  const now = new Date();

  const [session] = await db
    .insert(lessonSessionsTable)
    .values({
      userId: req.userId!,
      lessonId,
      currentPhase: selectedInitialPhase,
      status: "active",
      currentNodeId: firstNode?.id ?? null,
      nodeStartedAt: firstNode ? now : null,
    })
    .returning();

  logger.info(
    {
      sessionId:            session.id,
      existingSession:      false,
      previousLessonExists,
      reviewTargetsCount,
      selectedPhase:        selectedInitialPhase,
      firstNodeId:          firstNode?.id ?? null,
      lessonId,
      userId:               req.userId!,
    },
    "lessons/start: new session created"
  );

  res.status(201).json({
    id: session.id,
    lessonId: session.lessonId,
    currentPhase: session.currentPhase,
    status: session.status,
    masteryScore: null,
    currentNodeId: session.currentNodeId ?? null,
    nodeStartedAt: session.nodeStartedAt?.toISOString() ?? null,
    startedAt: session.startedAt.toISOString(),
    completedAt: null,
  });
});

// Minimum mastery required on the CURRENT topic before the student is
// allowed to advance to the next phase — this is the code-level enforcement
// of the P4 "Golden Rule" (MICRO_CHECK before moving forward), which until
// now only existed as a text instruction to the AI, not as an actual check.
const MASTERY_ADVANCE_THRESHOLD = 80;

// Advance phase (max 4) — optional masteryScore saved on completion
router.post("/lessons/:lessonId/advance-phase", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const { masteryScore } = req.body as { masteryScore?: number };

  const [session] = await db
    .select()
    .from(lessonSessionsTable)
    .where(
      and(
        eq(lessonSessionsTable.lessonId, lessonId),
        eq(lessonSessionsTable.userId, req.userId!)
      )
    )
    .limit(1);

  if (!session) {
    res.status(404).json({ error: "No active session for this lesson" });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Which topic name gates advancement: the CURRENT node's title if this
  // lesson has nodes, otherwise the lesson's own title (old behavior).
  let topicName = lesson.title;
  if (session.currentNodeId) {
    const [node] = await db
      .select({ title: lessonNodesTable.title })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.id, session.currentNodeId))
      .limit(1);
    if (node) topicName = node.title;
  }

  const [node] = await db
    .select({ masteryScore: knowledgeNodesTable.masteryScore })
    .from(knowledgeNodesTable)
    .where(
      and(
        eq(knowledgeNodesTable.subjectId, lesson.subjectId),
        eq(knowledgeNodesTable.userId, req.userId!),
        eq(knowledgeNodesTable.topicName, topicName)
      )
    )
    .limit(1);

  const currentMastery = node?.masteryScore ?? null;

  // 4 phases total; phase 4 → completed
  const isComplete = session.currentPhase >= 4;
  const nextPhase = isComplete ? 4 : session.currentPhase + 1;

  if (
    !isComplete &&
    (currentMastery === null || currentMastery < MASTERY_ADVANCE_THRESHOLD)
  ) {
    res.status(409).json({
      error:
        "Այս թեման դեռ բավարար չափով յուրացված չէ, շարունակիր հարցերին պատասխանել, նախքան հաջորդ փուլին անցնելը",
      currentMastery,
      requiredMastery: MASTERY_ADVANCE_THRESHOLD,
    });
    return;
  }

  const [updated] = await db
    .update(lessonSessionsTable)
    .set({
      currentPhase: nextPhase,
      status: isComplete ? "completed" : "active",
      masteryScore:
        masteryScore !== undefined && masteryScore !== null
          ? masteryScore
          : session.masteryScore ?? null,
      completedAt: isComplete ? new Date() : null,
    })
    .where(eq(lessonSessionsTable.id, session.id))
    .returning();

  if (isComplete) {
    updateStudentProfile(req.userId!).catch((err: unknown) =>
      logger.error({ err }, "student profile update failed")
    );
  }

  res.json({
    id: updated.id,
    lessonId: updated.lessonId,
    currentPhase: updated.currentPhase,
    status: updated.status,
    masteryScore: updated.masteryScore ?? null,
    currentNodeId: updated.currentNodeId ?? null,
    nodeStartedAt: updated.nodeStartedAt?.toISOString() ?? null,
    startedAt: updated.startedAt.toISOString(),
    completedAt: updated.completedAt?.toISOString() ?? null,
  });
});

// Advance from the current lesson node to the next one (within phases 2/3).
// Same mastery gate as advance-phase, but scoped to the CURRENT NODE's
// topic, not the whole lesson. When there is no next node, currentNodeId
// is cleared — that's the signal the node queue for this lesson is
// exhausted and it's time to move to the next macro-phase.
router.post("/lessons/:lessonId/advance-node", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);

  const [session] = await db
    .select()
    .from(lessonSessionsTable)
    .where(
      and(
        eq(lessonSessionsTable.lessonId, lessonId),
        eq(lessonSessionsTable.userId, req.userId!)
      )
    )
    .limit(1);

  if (!session) {
    res.status(404).json({ error: "No active session for this lesson" });
    return;
  }

  if (!session.currentNodeId) {
    res.status(400).json({ error: "This session has no active node" });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  const [currentNode] = await db
    .select()
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, session.currentNodeId))
    .limit(1);

  if (!currentNode) {
    res.status(404).json({ error: "Current node not found" });
    return;
  }

  const [knowledgeNode] = await db
    .select({ masteryScore: knowledgeNodesTable.masteryScore })
    .from(knowledgeNodesTable)
    .where(
      and(
        eq(knowledgeNodesTable.subjectId, lesson.subjectId),
        eq(knowledgeNodesTable.userId, req.userId!),
        eq(knowledgeNodesTable.topicName, currentNode.title)
      )
    )
    .limit(1);

  const currentMastery = knowledgeNode?.masteryScore ?? null;

  if (currentMastery === null || currentMastery < MASTERY_ADVANCE_THRESHOLD) {
    res.status(409).json({
      error:
        "Այս թեման դեռ բավարար չափով յուրացված չէ, շարունակիր հարցերին պատասխանել, նախքան հաջորդ ենթաթեմային անցնելը",
      currentMastery,
      requiredMastery: MASTERY_ADVANCE_THRESHOLD,
    });
    return;
  }

  const [nextNode] = await db
    .select()
    .from(lessonNodesTable)
    .where(
      and(
        eq(lessonNodesTable.lessonId, lessonId),
        eq(lessonNodesTable.sequence, currentNode.sequence + 1)
      )
    )
    .limit(1);

  const now = new Date();

  const [updated] = await db
    .update(lessonSessionsTable)
    .set({
      currentNodeId: nextNode?.id ?? null,
      nodeStartedAt: nextNode ? now : null,
    })
    .where(eq(lessonSessionsTable.id, session.id))
    .returning();

  res.json({
    currentNodeId: updated.currentNodeId ?? null,
    nodeStartedAt: updated.nodeStartedAt?.toISOString() ?? null,
    nodeTitle: nextNode?.title ?? null,
    sequence: nextNode?.sequence ?? null,
    estimatedMinutes: nextNode?.estimatedMinutes ?? null,
    done: !nextNode, // true = no more nodes queued for this lesson right now
  });
});

// ── LESSON NODES CRUD ────────────────────────────────────────────────────────

// GET /lessons/:lessonId/nodes — list all nodes for this lesson, ordered by sequence
router.get("/lessons/:lessonId/nodes", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson id" });
    return;
  }

  const nodes = await db
    .select()
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence));

  res.json(
    nodes.map((n) => ({
      id: n.id,
      lessonId: n.lessonId,
      topicId: n.topicId ?? null,
      sequence: n.sequence,
      title: n.title,
      theoryContent: n.theoryContent ?? null,
      targetBloomLevel: n.targetBloomLevel ?? null,
      estimatedMinutes: n.estimatedMinutes ?? null,
      verbatimTheoryAnchor: n.verbatimTheoryAnchor ?? null,
      commonMisconception: n.commonMisconception ?? null,
      childFriendlyExplanation: n.childFriendlyExplanation ?? null,
      basicExamples: Array.isArray(n.basicExamples) ? n.basicExamples : [],
      // Authoring provenance fields — used by teacher dashboard for badging
      status: n.status ?? "draft",
      contentSourceType: n.contentSourceType ?? "textbook",
      createdBy: n.createdBy ?? "ai",
    }))
  );
});

// POST /lessons/:lessonId/nodes — create a new node (sequence auto-assigned)
router.post("/lessons/:lessonId/nodes", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson id" });
    return;
  }

  const { title, theoryContent, targetBloomLevel, estimatedMinutes } = req.body as {
    title?: string;
    theoryContent?: string;
    targetBloomLevel?: number;
    estimatedMinutes?: number;
  };

  if (!title?.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const [maxRow] = await db
    .select({ maxSeq: max(lessonNodesTable.sequence) })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId));

  const nextSeq = (maxRow?.maxSeq ?? 0) + 1;

  const [node] = await db
    .insert(lessonNodesTable)
    .values({
      lessonId,
      sequence: nextSeq,
      title: title.trim(),
      theoryContent: theoryContent?.trim() ?? null,
      targetBloomLevel: targetBloomLevel ?? 1,
      estimatedMinutes: estimatedMinutes ?? 5,
    })
    .returning();

  res.status(201).json({
    id: node.id,
    lessonId: node.lessonId,
    sequence: node.sequence,
    title: node.title,
    theoryContent: node.theoryContent ?? null,
    targetBloomLevel: node.targetBloomLevel ?? null,
    estimatedMinutes: node.estimatedMinutes ?? null,
  });
});

// POST /lessons/:lessonId/nodes/:nodeId/update — partial update
router.post("/lessons/:lessonId/nodes/:nodeId/update", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId = parseInt(String(req.params.nodeId), 10);
  if (isNaN(lessonId) || isNaN(nodeId)) {
    res.status(400).json({ error: "Invalid lesson id or node id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(lessonNodesTable)
    .where(and(eq(lessonNodesTable.id, nodeId), eq(lessonNodesTable.lessonId, lessonId)))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Node not found" });
    return;
  }

  const { title, theoryContent, targetBloomLevel, estimatedMinutes, verbatimTheoryAnchor, commonMisconception, childFriendlyExplanation, basicExamples } = req.body as {
    title?: string;
    theoryContent?: string;
    targetBloomLevel?: number;
    estimatedMinutes?: number;
    verbatimTheoryAnchor?: string;
    commonMisconception?: string;
    childFriendlyExplanation?: string;
    basicExamples?: string[];
  };

  const patch: Partial<typeof existing> = {};
  if (title !== undefined) patch.title = title.trim();
  if (theoryContent !== undefined) patch.theoryContent = theoryContent.trim() || null;
  if (targetBloomLevel !== undefined) patch.targetBloomLevel = targetBloomLevel;
  if (estimatedMinutes !== undefined) patch.estimatedMinutes = estimatedMinutes;
  if (verbatimTheoryAnchor !== undefined) patch.verbatimTheoryAnchor = verbatimTheoryAnchor.trim() || null;
  if (commonMisconception !== undefined) patch.commonMisconception = commonMisconception.trim() || null;
  if (childFriendlyExplanation !== undefined) patch.childFriendlyExplanation = childFriendlyExplanation.trim() || null;
  if (basicExamples !== undefined) patch.basicExamples = Array.isArray(basicExamples) ? basicExamples : [];

  const [updated] = await db
    .update(lessonNodesTable)
    .set(patch)
    .where(eq(lessonNodesTable.id, nodeId))
    .returning();

  res.json({
    id: updated.id,
    lessonId: updated.lessonId,
    sequence: updated.sequence,
    title: updated.title,
    theoryContent: updated.theoryContent ?? null,
    targetBloomLevel: updated.targetBloomLevel ?? null,
    estimatedMinutes: updated.estimatedMinutes ?? null,
    verbatimTheoryAnchor: updated.verbatimTheoryAnchor ?? null,
    commonMisconception: updated.commonMisconception ?? null,
    childFriendlyExplanation: updated.childFriendlyExplanation ?? null,
    basicExamples: Array.isArray(updated.basicExamples) ? updated.basicExamples : [],
  });
});

// POST /lessons/:lessonId/nodes/:nodeId/delete — delete a node
// lesson_sessions.currentNodeId has onDelete: "set null" so no manual cleanup needed
router.post("/lessons/:lessonId/nodes/:nodeId/delete", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId = parseInt(String(req.params.nodeId), 10);
  if (isNaN(lessonId) || isNaN(nodeId)) {
    res.status(400).json({ error: "Invalid lesson id or node id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(lessonNodesTable)
    .where(and(eq(lessonNodesTable.id, nodeId), eq(lessonNodesTable.lessonId, lessonId)))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Node not found" });
    return;
  }

  await db.delete(lessonNodesTable).where(eq(lessonNodesTable.id, nodeId));
  res.json({ message: "Node deleted" });
});

// DELETE /lessons/:lessonId/mapping — delete entire lesson mapping (nodes, topics, exercises, deps)
// Lesson row itself is NOT deleted — only the mapping data.
router.delete("/lessons/:lessonId/mapping", requireTeacher, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson id" });
    return;
  }

  const [lesson] = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Single transaction — deletion order respects FK constraints:
  //   1. lesson_node_dependencies  (FK → lesson_nodes CASCADE — must precede nodes)
  //   2. lesson_exercises          (FK → lesson_nodes SET NULL — delete before nodes to avoid orphan rows)
  //   3. mapping_review_items      (FK → lessons CASCADE)
  //   4. mapping_import_log        (FK → lessons CASCADE)
  //   5. lesson_nodes              (FK → lesson_topics SET NULL — must precede topics)
  //   6. lesson_topics             (FK → lessons CASCADE)
  //
  // lesson row is preserved — only mapping data is cleared.
  const deleted = await db.transaction(async (tx) => {
    const deps = await tx
      .delete(lessonNodeDependenciesTable)
      .where(eq(lessonNodeDependenciesTable.lessonId, lessonId))
      .returning({ id: lessonNodeDependenciesTable.id });

    const exercises = await tx
      .delete(lessonExercisesTable)
      .where(eq(lessonExercisesTable.lessonId, lessonId))
      .returning({ id: lessonExercisesTable.id });

    const reviewItems = await tx
      .delete(mappingReviewItemsTable)
      .where(eq(mappingReviewItemsTable.lessonId, lessonId))
      .returning({ id: mappingReviewItemsTable.id });

    const importLog = await tx
      .delete(mappingImportLogTable)
      .where(eq(mappingImportLogTable.lessonId, lessonId))
      .returning({ id: mappingImportLogTable.id });

    const nodes = await tx
      .delete(lessonNodesTable)
      .where(eq(lessonNodesTable.lessonId, lessonId))
      .returning({ id: lessonNodesTable.id });

    const topics = await tx
      .delete(lessonTopicsTable)
      .where(eq(lessonTopicsTable.lessonId, lessonId))
      .returning({ id: lessonTopicsTable.id });

    return {
      topics:       topics.length,
      nodes:        nodes.length,
      exercises:    exercises.length,
      dependencies: deps.length,
      reviewItems:  reviewItems.length,
      importLog:    importLog.length,
    };
  });

  logger.info({ lessonId, deleted }, "lesson mapping deleted");
  res.json({ message: "Mapping deleted", deleted });
});

// ── LESSON EXERCISES CRUD ─────────────────────────────────────────────────────

// GET /lessons/:lessonId/exercises — list all exercises for this lesson
router.get("/lessons/:lessonId/exercises", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const exercises = await db
    .select()
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, lessonId))
    .orderBy(asc(lessonExercisesTable.sequence));

  res.json(exercises.map((e) => ({
    id: e.id,
    lessonId: e.lessonId,
    exerciseId: e.exerciseId,
    sequence: e.sequence,
    sourcePage: e.sourcePage ?? null,
    exerciseTextVerbatim: e.exerciseTextVerbatim,
    exercisePurpose: e.exercisePurpose ?? null,
    relatedNodeId: e.relatedNodeId ?? null,
    successCriteria: e.successCriteria ?? null,
    difficultyLevel: e.difficultyLevel ?? null,
    assignment: e.assignment ?? null,
  })));
});

// POST /lessons/:lessonId/exercises — create a new exercise
router.post("/lessons/:lessonId/exercises", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const { exerciseTextVerbatim, relatedNodeId, sourcePage, successCriteria, difficultyLevel, assignment, exercisePurpose } = req.body as {
    exerciseTextVerbatim?: string;
    relatedNodeId?: number | null;
    sourcePage?: string;
    successCriteria?: string;
    difficultyLevel?: string;
    assignment?: string;
    exercisePurpose?: string;
  };

  if (!exerciseTextVerbatim?.trim()) {
    res.status(400).json({ error: "exerciseTextVerbatim is required" });
    return;
  }

  const [maxRow] = await db
    .select({ maxSeq: max(lessonExercisesTable.sequence) })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, lessonId));

  const nextSeq = (maxRow?.maxSeq ?? 0) + 1;
  const exerciseId = `EX-${lessonId}-${nextSeq}`;

  const [ex] = await db
    .insert(lessonExercisesTable)
    .values({
      lessonId,
      exerciseId,
      sequence: nextSeq,
      exerciseTextVerbatim: exerciseTextVerbatim.trim(),
      relatedNodeId: relatedNodeId ?? null,
      sourcePage: sourcePage ?? null,
      successCriteria: successCriteria ?? null,
      difficultyLevel: difficultyLevel ?? "MEDIUM",
      assignment: assignment ?? "CLASS",
      exercisePurpose: exercisePurpose ?? "INDEPENDENT_PRACTICE",
    })
    .returning();

  res.status(201).json({
    id: ex.id,
    lessonId: ex.lessonId,
    exerciseId: ex.exerciseId,
    sequence: ex.sequence,
    sourcePage: ex.sourcePage ?? null,
    exerciseTextVerbatim: ex.exerciseTextVerbatim,
    exercisePurpose: ex.exercisePurpose ?? null,
    relatedNodeId: ex.relatedNodeId ?? null,
    successCriteria: ex.successCriteria ?? null,
    difficultyLevel: ex.difficultyLevel ?? null,
    assignment: ex.assignment ?? null,
  });
});

// POST /lessons/:lessonId/exercises/:exerciseId/update — partial update
router.post("/lessons/:lessonId/exercises/:exerciseId/update", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const exerciseId = parseInt(String(req.params.exerciseId), 10);
  if (isNaN(lessonId) || isNaN(exerciseId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db
    .select()
    .from(lessonExercisesTable)
    .where(and(eq(lessonExercisesTable.id, exerciseId), eq(lessonExercisesTable.lessonId, lessonId)))
    .limit(1);

  if (!existing) { res.status(404).json({ error: "Exercise not found" }); return; }

  const { exerciseTextVerbatim, relatedNodeId, sourcePage, successCriteria, difficultyLevel, assignment, exercisePurpose } = req.body as {
    exerciseTextVerbatim?: string;
    relatedNodeId?: number | null;
    sourcePage?: string;
    successCriteria?: string;
    difficultyLevel?: string;
    assignment?: string;
    exercisePurpose?: string;
  };

  const patch: Partial<typeof existing> = {};
  if (exerciseTextVerbatim !== undefined) patch.exerciseTextVerbatim = exerciseTextVerbatim.trim();
  if (relatedNodeId !== undefined) patch.relatedNodeId = relatedNodeId;
  if (sourcePage !== undefined) patch.sourcePage = sourcePage;
  if (successCriteria !== undefined) patch.successCriteria = successCriteria.trim() || null;
  if (difficultyLevel !== undefined) patch.difficultyLevel = difficultyLevel;
  if (assignment !== undefined) patch.assignment = assignment;
  if (exercisePurpose !== undefined) patch.exercisePurpose = exercisePurpose;

  const [updated] = await db
    .update(lessonExercisesTable)
    .set(patch)
    .where(eq(lessonExercisesTable.id, exerciseId))
    .returning();

  res.json({
    id: updated.id,
    lessonId: updated.lessonId,
    exerciseId: updated.exerciseId,
    sequence: updated.sequence,
    sourcePage: updated.sourcePage ?? null,
    exerciseTextVerbatim: updated.exerciseTextVerbatim,
    exercisePurpose: updated.exercisePurpose ?? null,
    relatedNodeId: updated.relatedNodeId ?? null,
    successCriteria: updated.successCriteria ?? null,
    difficultyLevel: updated.difficultyLevel ?? null,
    assignment: updated.assignment ?? null,
  });
});

// POST /lessons/:lessonId/exercises/:exerciseId/delete
router.post("/lessons/:lessonId/exercises/:exerciseId/delete", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const exerciseId = parseInt(String(req.params.exerciseId), 10);
  if (isNaN(lessonId) || isNaN(exerciseId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db
    .select()
    .from(lessonExercisesTable)
    .where(and(eq(lessonExercisesTable.id, exerciseId), eq(lessonExercisesTable.lessonId, lessonId)))
    .limit(1);

  if (!existing) { res.status(404).json({ error: "Exercise not found" }); return; }

  await db.delete(lessonExercisesTable).where(eq(lessonExercisesTable.id, exerciseId));
  res.json({ message: "Exercise deleted" });
});

// ── TOPICS & MAPPING REPORT ───────────────────────────────────────────────────

// GET /lessons/:lessonId/topics — ordered list of topics for the lesson
router.get("/lessons/:lessonId/topics", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const topics = await db
    .select()
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId))
    .orderBy(asc(lessonTopicsTable.sequence));

  res.json(topics.map((t) => ({
    id:          t.id,
    lessonId:    t.lessonId,
    sequence:    t.sequence,
    title:       t.title,
    description: t.description ?? null,
  })));
});

// GET /lessons/:lessonId/mapping-report — quality report from the last /map run
//   If stored metadata exists (from a fresh /map run), returns it directly.
//   Otherwise computes a best-effort report from current DB state.
router.get("/lessons/:lessonId/mapping-report", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  // Stored at /map time → return immediately (exact pass1 count + coverage available)
  if (lesson.mappingMetadata) {
    res.json(lesson.mappingMetadata);
    return;
  }

  // Compute from current DB state (historical lessons mapped before this report was added)
  const topicsResult = await db.select().from(lessonTopicsTable).where(eq(lessonTopicsTable.lessonId, lessonId));
  const nodes        = await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId));
  const exercises    = await db.select().from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, lessonId));

  const nodesWithContent = nodes.filter((n) => n.theoryContent && n.theoryContent.length >= 20);
  const reviewItems = nodes
    .filter((n) => !n.theoryContent || n.theoryContent.length < 20 || !n.learningObjective)
    .map((n) => ({
      nodeId:    n.id,
      nodeTitle: n.title,
      reason:    !n.learningObjective ? "Missing learning objective" : "Missing or very short theory content",
    }));

  res.json({
    lessonId,
    lessonTitle:  lesson.title,
    pagesFrom:    lesson.pagesFrom  ?? null,
    pagesTo:      lesson.pagesTo    ?? null,
    generatedAt:  new Date().toISOString(),
    counts: {
      pass1BlocksExtracted: null,    // only available when stored at /map time
      topicsCreated:        topicsResult.length,
      microNodesCreated:    nodes.length,
      exercisesCreated:     exercises.length,
      unmappedBlocks:       null,    // only available when stored at /map time
    },
    content: {
      aiGeneratedFields:        nodes.length * 2,   // title + learningObjective per MicroNode
      textbookSourcedExercises: exercises.filter((e) => e.sourceType === "textbook").length,
      textbookSourcedNodes:     nodesWithContent.length,
    },
    quality: {
      coveragePercent:          null,               // requires pass1BlocksExtracted
      overallConfidencePercent: nodes.length > 0
        ? Math.round((nodesWithContent.length / nodes.length) * 100) : 0,
      teacherReviewRequired:    reviewItems.length,
      reviewItems,
    },
  });
});

// ── LESSON MAPPING (Pass 1 + Pass 2) ──────────────────────────────────────────

// POST /lessons/:lessonId/map — full two-pass pipeline:
//   Pass 1: vision extraction of verbatim content blocks from the textbook PDF.
//   Pass 2: two-step AI pipeline that groups blocks into topics, then organises
//           each topic into MicroNodes with exercises. Results are stored as:
//             lesson_topics   (one row per topic)
//             lesson_nodes    (one row per MicroNode, FK → topic)
//             lesson_exercises (one row per exercise, FK → MicroNode)
//
//   Old functions extractBlocksWithAI / extractBlocksWithVision are preserved
//   below for reference but are no longer called from this route.
router.post("/lessons/:lessonId/map", requireTeacher, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson id" });
    return;
  }

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  if (!lesson.textbookResourceId) {
    res.status(400).json({
      error: "Այս դասին կապված դասագրքի ֆայլ չկա, ընտրիր այն դասը խմբագրելիս",
    });
    return;
  }

  if (!lesson.pagesFrom || !lesson.pagesTo) {
    res.status(400).json({
      error: "Այս դասին սահմանված չեն էջերի սկիզբն ու ավարտը",
    });
    return;
  }

  const [resource] = await db
    .select()
    .from(resourcesTable)
    .where(eq(resourcesTable.id, lesson.textbookResourceId))
    .limit(1);

  if (!resource?.fileUrl) {
    res.status(400).json({ error: "Կապված դասագրքի ֆայլը չի գտնվել" });
    return;
  }

  const [subject] = await db
    .select()
    .from(subjectsTable)
    .where(eq(subjectsTable.id, lesson.subjectId))
    .limit(1);

  // ── Create background job and respond immediately ─────────────────────────
  // All slow work (AI calls, DB writes) runs inside setImmediate so the HTTP
  // connection is released without waiting 5+ minutes.
  const [job] = await db
    .insert(mappingJobsTable)
    .values({ lessonId, jobType: "map", status: "pending" })
    .returning();

  res.json({ jobId: job.id, status: "pending" as const });

  // ── Process asynchronously after HTTP response is sent ────────────────────
  setImmediate(async () => {
  try {
    await db.update(mappingJobsTable)
      .set({ status: "running", progress: "Pass 1: Extracting content blocks from PDF...", updatedAt: new Date() })
      .where(eq(mappingJobsTable.id, job.id));

    const filePath  = resolveUploadedFilePath(resource.fileUrl!);
    const lessonText = await extractPdfPageRange(filePath, lesson.pagesFrom, lesson.pagesTo);

    const baseInput = {
      subjectName:   subject?.name ?? "",
      lessonTitle:   lesson.title,
      chapterTitle:  lesson.chapterTitle  ?? null,
      textbookTitle: lesson.textbookTitle ?? null,
      textbookAuthor: lesson.textbookAuthor ?? null,
      pagesFrom:     lesson.pagesFrom,
      pagesTo:       lesson.pagesTo,
      teacherGoal:   lesson.lessonGoal ?? null,
      teacherOutcomes: Array.isArray(lesson.lessonOutcomes)
        ? (lesson.lessonOutcomes as string[])
        : null,
    };

    // ── Pass 1: Pure verbatim block extraction (in-memory, no DB write yet) ──
    let pass1: Pass1Result;
    if (isGarbledText(lessonText)) {
      logger.info(
        { lessonId, pagesFrom: lesson.pagesFrom, pagesTo: lesson.pagesTo },
        "lesson mapping: garbled text — using vision-based Pass 1"
      );
      const pageImages = await rasterizePdfPages(filePath, lesson.pagesFrom, lesson.pagesTo);
      logger.info({ lessonId, pageCount: pageImages.length }, "lesson mapping: rasterised pages");
      pass1 = await extractBlocksWithVision(baseInput, pageImages);
    } else {
      pass1 = await extractBlocksWithAI({ ...baseInput, lessonText });
    }
    logger.info({ lessonId, blockCount: pass1.blocks.length }, "lesson mapping Pass 1 complete");
    await db.update(mappingJobsTable)
      .set({ progress: `Pass 2: Organising ${pass1.blocks.length} blocks into topics and MicroNodes...`, updatedAt: new Date() })
      .where(eq(mappingJobsTable.id, job.id)).catch(() => {});

    // ── Pass 2: Topic grouping + MicroNode organisation (in-memory) ───────────
    const pass2 = await runPass2Pipeline(pass1.blocks, {
      lessonTitle: lesson.title,
      pagesFrom:   lesson.pagesFrom,
      pagesTo:     lesson.pagesTo,
    });

    await db.update(mappingJobsTable)
      .set({ progress: "Saving results to database...", updatedAt: new Date() })
      .where(eq(mappingJobsTable.id, job.id)).catch(() => {});

    // ── Clear ALL prior mapping data for this lesson ───────────────────────
    // Order matters: FK constraints → delete nodes before topics.
    await db.delete(lessonNodeDependenciesTable).where(
      eq(lessonNodeDependenciesTable.lessonId, lessonId)
    );
    await db.delete(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, lessonId));
    await db.delete(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId));
    await db.delete(lessonTopicsTable).where(eq(lessonTopicsTable.lessonId, lessonId));

    // ── Store Pass 2 results ──────────────────────────────────────────────
    let totalNodes = 0;
    let totalExercises = 0;
    let exerciseCounter = 0;
    let nodesWithFullContent = 0;
    const reviewItems: { nodeId: number; nodeTitle: string; reason: string }[] = [];

    const topicRows: { id: number; sequence: number; title: string }[] = [];
    const nodeRows:  { id: number; topicId: number; title: string; sequence: number }[] = [];

    for (const topic of pass2.topics) {
      // 1. Insert the topic
      const [insertedTopic] = await db
        .insert(lessonTopicsTable)
        .values({
          lessonId,
          title:    topic.title,
          sequence: topic.sequence,
        })
        .returning();

      topicRows.push({ id: insertedTopic.id, sequence: topic.sequence, title: topic.title });
      let mnSeq = 0;

      for (const mn of topic.microNodes) {
        mnSeq += 1;

        // Combine source-block texts as theoryContent / verbatimTheoryAnchor
        const sourceBlocks = mn.sourceBlockIndices.map((i) => pass1.blocks[i]).filter(Boolean);
        const theoryContent = sourceBlocks
          .map((b) => b.sourceText.trim())
          .filter(Boolean)
          .join("\n\n");
        const firstSourcePage = sourceBlocks.find((b) => b.sourcePage)?.sourcePage ?? null;

        // 2. Insert the MicroNode
        const [insertedNode] = await db
          .insert(lessonNodesTable)
          .values({
            lessonId,
            topicId:           insertedTopic.id,
            sequence:          mnSeq,
            title:             mn.title,
            learningObjective: mn.learningObjective || null,
            microNodeType:     mn.microNodeType,
            theoryContent:     theoryContent || null,
            verbatimTheoryAnchor: theoryContent || null,
            sourcePage:        firstSourcePage,
            status:            "draft" as const,
            createdBy:         "ai"   as const,
            targetBloomLevel:  1,
            estimatedMinutes:  5,
          })
          .returning();

        nodeRows.push({
          id:       insertedNode.id,
          topicId:  insertedTopic.id,
          title:    mn.title,
          sequence: mnSeq,
        });
        totalNodes += 1;
        const hasContent = (theoryContent || "").length >= 20;
        if (hasContent) nodesWithFullContent++;
        if (!hasContent || !mn.learningObjective) {
          reviewItems.push({
            nodeId:    insertedNode.id,
            nodeTitle: mn.title,
            reason:    !mn.learningObjective
              ? "Missing learning objective"
              : "Missing or very short theory content",
          });
        }

        // 3. Insert exercises linked to this MicroNode
        for (const ex of mn.exercises) {
          const block = pass1.blocks[ex.blockIndex];
          if (!block) continue;
          exerciseCounter += 1;

          await db.insert(lessonExercisesTable).values({
            lessonId,
            exerciseId:          `EX-${lessonId}-${exerciseCounter}`,
            exerciseTextVerbatim: block.sourceText.trim(),
            sourcePage:          block.sourcePage ? String(block.sourcePage) : null,
            relatedNodeId:       insertedNode.id,
            sequence:            exerciseCounter,
            sourceType:          "textbook" as const,
            status:              "draft"    as const,
          });
          totalExercises += 1;
        }
      }
    }

    // ── Build, store, and return the structured mapping report ────────────────
    const coveragePercent = pass1.blocks.length > 0
      ? Math.round(((pass1.blocks.length - pass2.unmappedBlockIndices.length) / pass1.blocks.length) * 100)
      : 100;

    // ── Review items for pages that failed extraction entirely ───────────────
    // These are pages where Pass 1 could not parse the AI's response even after
    // retry + 1-page fallback.  We surface them as review items rather than
    // throwing — so the teacher knows which pages need a manual re-run, and
    // NO error string ever leaks into a node or exercise title.
    for (const skipped of (pass1.skippedPageRanges ?? [])) {
      reviewItems.push({
        nodeId:    null as unknown as number,
        nodeTitle: `Pages ${skipped.from}–${skipped.to}`,
        reason:    skipped.reason,
      });
    }

    // ── Review flags for coverage gaps ──────────────────────────────────────
    // Informational: any blocks the AI explicitly excluded as headers.
    if (pass2.unmappedBlockIndices.length > 0) {
      reviewItems.push({
        nodeId:    null as unknown as number,
        nodeTitle: "—",
        reason:    `${pass2.unmappedBlockIndices.length} block(s) explicitly excluded as headers by pipeline — verify no real exercises or definitions were skipped`,
      });
    }
    // High-severity: coverage below 90% indicates a potentially serious gap.
    if (coveragePercent < 90) {
      reviewItems.push({
        nodeId:    null as unknown as number,
        nodeTitle: "—",
        reason:    `Coverage is only ${coveragePercent}% — ${pass1.blocks.length - (pass1.blocks.length - pass2.unmappedBlockIndices.length)} of ${pass1.blocks.length} blocks were not placed in any MicroNode. Significant content may be missing.`,
      });
    }

    const mappingReport = {
      lessonId,
      lessonTitle:  lesson.title,
      pagesFrom:    lesson.pagesFrom  ?? null,
      pagesTo:      lesson.pagesTo    ?? null,
      generatedAt:  new Date().toISOString(),
      counts: {
        pass1BlocksExtracted: pass1.blocks.length,
        topicsCreated:        pass2.topics.length,
        microNodesCreated:    totalNodes,
        exercisesCreated:     totalExercises,
        unmappedBlocks:       pass2.unmappedBlockIndices.length,
      },
      content: {
        aiGeneratedFields:        totalNodes * 2,   // title + learningObjective per MicroNode
        textbookSourcedExercises: totalExercises,   // all exercises are textbook-verbatim
        textbookSourcedNodes:     nodesWithFullContent,
      },
      quality: {
        coveragePercent,
        overallConfidencePercent: totalNodes > 0
          ? Math.round((nodesWithFullContent / totalNodes) * 100) : 0,
        teacherReviewRequired: reviewItems.length,
        reviewItems,
      },
    };

    // Persist so GET /mapping-report can return it without recomputing
    await db.update(lessonsTable)
      .set({ mappingMetadata: mappingReport as any })
      .where(eq(lessonsTable.id, lessonId));

    logger.info(
      {
        lessonId,
        pass1Blocks:     pass1.blocks.length,
        topicsCreated:   pass2.topics.length,
        microNodes:      totalNodes,
        exercises:       totalExercises,
        unmapped:        pass2.unmappedBlockIndices.length,
        coveragePercent,
        reviewRequired:  reviewItems.length,
      },
      "lesson mapping Pass 1 + Pass 2 complete"
    );

    await db.update(mappingJobsTable)
      .set({
        status: "completed",
        result: {
          pass1BlocksExtracted: pass1.blocks.length,
          topicsCreated:        pass2.topics.length,
          microNodesCreated:    totalNodes,
          exercisesCreated:     totalExercises,
          unmappedBlocks:       pass2.unmappedBlockIndices.length,
          mappingReport,
          topics: topicRows.map((t) => ({
            id:       t.id,
            sequence: t.sequence,
            title:    t.title,
            nodes:    nodeRows
              .filter((n) => n.topicId === t.id)
              .map((n) => ({ id: n.id, sequence: n.sequence, title: n.title })),
          })),
        } as any,
        updatedAt: new Date(),
      })
      .where(eq(mappingJobsTable.id, job.id));

    logger.info(
      {
        jobId:           job.id,
        lessonId,
        pass1Blocks:     pass1.blocks.length,
        topicsCreated:   pass2.topics.length,
        microNodes:      totalNodes,
        exercises:       totalExercises,
        unmapped:        pass2.unmappedBlockIndices.length,
        coveragePercent,
        reviewRequired:  reviewItems.length,
      },
      "lesson mapping job completed"
    );
  } catch (err) {
    logger.error({ err, lessonId, jobId: job.id }, "lesson mapping job failed");
    await db.update(mappingJobsTable)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : "Lesson mapping failed, please retry",
        updatedAt: new Date(),
      })
      .where(eq(mappingJobsTable.id, job.id))
      .catch(() => {});
  }
  }); // end setImmediate
});

// ── GET /lessons/jobs/:jobId — poll background job status ─────────────────────
router.get("/lessons/jobs/:jobId", requireAuth, requireTeacher, async (req: AuthRequest, res) => {
  const jobId = parseInt(String(req.params.jobId), 10);
  if (isNaN(jobId)) { res.status(400).json({ error: "Invalid job id" }); return; }

  const [job] = await db
    .select()
    .from(mappingJobsTable)
    .where(eq(mappingJobsTable.id, jobId))
    .limit(1);

  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  res.json({
    jobId:     job.id,
    lessonId:  job.lessonId,
    jobType:   job.jobType,
    status:    job.status,
    result:    job.result ?? null,
    error:     job.error  ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
});

// ── Phase 2: Generate teaching content for all MicroNodes in a lesson ─────────
// POST /lessons/:lessonId/generate-teaching-content
// Teacher-triggered after reviewing Pass 1+2 structure. Responds immediately
// with { jobId } and processes AI calls inside setImmediate.
router.post("/lessons/:lessonId/generate-teaching-content", requireAuth, requireTeacher, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  // Fetch all MicroNodes (fast DB read — done synchronously before responding)
  const nodes = await db
    .select({
      id:                lessonNodesTable.id,
      title:             lessonNodesTable.title,
      learningObjective: lessonNodesTable.learningObjective,
      theoryContent:     lessonNodesTable.theoryContent,
      blockType:         lessonNodesTable.blockType,
    })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence));

  if (nodes.length === 0) {
    res.status(400).json({ error: "No MicroNodes found — run /map first" });
    return;
  }

  // Fetch all exercises (fast DB read)
  const allExercises = await db
    .select({
      relatedNodeId:        lessonExercisesTable.relatedNodeId,
      exerciseId:           lessonExercisesTable.exerciseId,
      exerciseTextVerbatim: lessonExercisesTable.exerciseTextVerbatim,
    })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, lessonId))
    .orderBy(asc(lessonExercisesTable.sequence));

  const exercisesByNode = new Map<number, Phase2LinkedExercise[]>();
  for (const ex of allExercises) {
    if (ex.relatedNodeId == null) continue;
    const arr = exercisesByNode.get(ex.relatedNodeId) ?? [];
    arr.push({ exerciseId: ex.exerciseId, exerciseTextVerbatim: ex.exerciseTextVerbatim });
    exercisesByNode.set(ex.relatedNodeId, arr);
  }

  // ── Create job, respond immediately ──────────────────────────────────────
  const [job] = await db
    .insert(mappingJobsTable)
    .values({ lessonId, jobType: "generate_teaching_content", status: "pending" })
    .returning();

  res.json({ jobId: job.id, status: "pending" as const });

  // ── AI processing runs in background after HTTP response is sent ──────────
  setImmediate(async () => {
  try {
    await db.update(mappingJobsTable)
      .set({ status: "running", progress: `Generating teaching content for ${nodes.length} MicroNodes...`, updatedAt: new Date() })
      .where(eq(mappingJobsTable.id, job.id));

    const BATCH_SIZE = 3;
    const summaryRows: {
      nodeId:      number;
      title:       string;
      status:      string;
      confidence:  number | null;
      sourceType:  string;
      skipReason?: string;
    }[] = [];

    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
      const batch = nodes.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(batch.map(async (node) => {
        const input: Phase2Input = {
          nodeId:            node.id,
          title:             node.title,
          learningObjective: node.learningObjective ?? null,
          theoryContent:     node.theoryContent ?? null,
          blockType:         node.blockType ?? null,
        };
        const exercises: Phase2LinkedExercise[] = exercisesByNode.get(node.id) ?? [];
        return generatePhase2Content(input, exercises);
      }));

      // Update progress: show how many nodes have been processed so far
      const processed = Math.min(i + BATCH_SIZE, nodes.length);
      await db.update(mappingJobsTable)
        .set({ progress: `Generating teaching content... (${processed}/${nodes.length} MicroNodes)`, updatedAt: new Date() })
        .where(eq(mappingJobsTable.id, job.id)).catch(() => {});

      for (const result of batchResults) {
        if (result.skipped) {
          await db
            .update(lessonNodesTable)
            .set({ status: "needs_source_content" })
            .where(eq(lessonNodesTable.id, result.nodeId));

          summaryRows.push({
            nodeId:     result.nodeId,
            title:      nodes.find((n) => n.id === result.nodeId)?.title ?? "",
            status:     "needs_source_content",
            confidence: null,
            sourceType: "—",
            skipReason: result.skipReason,
          });
        } else {
          await db
            .update(lessonNodesTable)
            .set({
              explanationSteps:          result.explanationSteps          as any,
              beginnerExplanation:       result.beginnerExplanation       || null,
              advancedExplanation:       result.advancedExplanation       || null,
              analogy:                   result.analogy                   || null,
              commonErrors:              result.commonErrors              as any,
              recallQuestions:           result.recallQuestions           as any,
              understandingQuestions:    result.understandingQuestions    as any,
              applicationQuestions:      result.applicationQuestions      as any,
              faqEntries:                result.faqEntries                as any,
              contentSourceType:         result.contentSourceType,
              teachingContentConfidence: result.teachingContentConfidence,
              status:                    "approved",
            })
            .where(eq(lessonNodesTable.id, result.nodeId));

          summaryRows.push({
            nodeId:     result.nodeId,
            title:      nodes.find((n) => n.id === result.nodeId)?.title ?? "",
            status:     "approved",
            confidence: result.teachingContentConfidence,
            sourceType: result.contentSourceType,
          });
        }
      }
    }

    const approved         = summaryRows.filter((r) => r.status === "approved").length;
    const needsSourceCount = summaryRows.filter((r) => r.status === "needs_source_content").length;

    await db.update(mappingJobsTable)
      .set({
        status: "completed",
        result: {
          lessonId,
          lessonTitle:        lesson.title,
          totalNodes:         nodes.length,
          approved,
          needsSourceContent: needsSourceCount,
          summary:            summaryRows,
        } as any,
        updatedAt: new Date(),
      })
      .where(eq(mappingJobsTable.id, job.id));

    logger.info(
      { jobId: job.id, lessonId, total: nodes.length, approved, needsSource: needsSourceCount },
      "phase2 teaching content generation job completed"
    );
  } catch (err) {
    logger.error({ err, lessonId, jobId: job.id }, "phase2 teaching content generation job failed");
    await db.update(mappingJobsTable)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : "Teaching content generation failed",
        updatedAt: new Date(),
      })
      .where(eq(mappingJobsTable.id, job.id))
      .catch(() => {});
  }
  }); // end setImmediate
});

// ── GET /lessons/:lessonId/map-status ─────────────────────────────────────────
// Lesson-centric poll endpoint: returns the most recent 'map' job for this
// lesson so the teacher UI can resume progress display after navigation-away.
router.get("/lessons/:lessonId/map-status", requireAuth, requireTeacher, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [job] = await db
    .select()
    .from(mappingJobsTable)
    .where(and(eq(mappingJobsTable.lessonId, lessonId), eq(mappingJobsTable.jobType, "map")))
    .orderBy(desc(mappingJobsTable.id))
    .limit(1);

  if (!job) {
    res.json({ jobId: null, status: "none", progress: null, error: null });
    return;
  }
  res.json({
    jobId: job.id, lessonId: job.lessonId, jobType: job.jobType,
    status: job.status, progress: job.progress ?? null,
    result: job.result ?? null, error: job.error ?? null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  });
});

// ── GET /lessons/:lessonId/generate-status ────────────────────────────────────
// Same pattern for Phase 2 (generate_teaching_content jobs).
router.get("/lessons/:lessonId/generate-status", requireAuth, requireTeacher, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [job] = await db
    .select()
    .from(mappingJobsTable)
    .where(and(eq(mappingJobsTable.lessonId, lessonId), eq(mappingJobsTable.jobType, "generate_teaching_content")))
    .orderBy(desc(mappingJobsTable.id))
    .limit(1);

  if (!job) {
    res.json({ jobId: null, status: "none", progress: null, error: null });
    return;
  }
  res.json({
    jobId: job.id, lessonId: job.lessonId, jobType: job.jobType,
    status: job.status, progress: job.progress ?? null,
    result: job.result ?? null, error: job.error ?? null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  });
});

// ── P6: One-time lesson completion summary + homework presentation ─────────────
// POST /lessons/:lessonId/p6-summary
// Called once per lesson when the student reaches phase 4.
router.post("/lessons/:lessonId/p6-summary", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  const [subject] = await db.select().from(subjectsTable).where(eq(subjectsTable.id, lesson.subjectId)).limit(1);

  const hwExercises = await db
    .select()
    .from(lessonExercisesTable)
    .where(and(eq(lessonExercisesTable.lessonId, lessonId), eq(lessonExercisesTable.assignment, "HOMEWORK")))
    .orderBy(asc(lessonExercisesTable.sequence));

  const nodes = await db
    .select({
      title:                lessonNodesTable.title,
      masteryEvidenceCount: lessonNodesTable.masteryEvidenceCount,
      lastEvidenceQuality:  lessonNodesTable.lastEvidenceQuality,
      consecutiveCorrect:   lessonNodesTable.consecutiveCorrect,
      consecutiveIncorrect: lessonNodesTable.consecutiveIncorrect,
    })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence));

  const performanceSummary = nodes.length > 0
    ? `Nodes: ${nodes.map((n) =>
        `\u00ab${n.title}\u00bb evidence=${n.masteryEvidenceCount} last_quality=${n.lastEvidenceQuality ?? "NONE"} consec_correct=${n.consecutiveCorrect} consec_incorrect=${n.consecutiveIncorrect}`
      ).join("; ")}`
    : "No node tracking data.";

  try {
    const p6 = await callAIP6({
      lessonTitle:    lesson.title,
      subjectName:    subject?.name ?? "",
      coreProblem:    (lesson as { coreProblem?: string | null }).coreProblem ?? null,
      coreIdea:       (lesson as { coreIdea?: string | null }).coreIdea ?? null,
      nodePerformanceSummary: performanceSummary,
      homeworkExercises: hwExercises.map((e) => ({
        exerciseId:      e.exerciseId,
        text:            e.exerciseTextVerbatim,
        difficultyLevel: e.difficultyLevel ?? null,
        sourcePage:      e.sourcePage ?? null,
      })),
    });

    res.json({
      completionStatus: p6.completion_status,
      homeworkTasks:    p6.homework_tasks,
      summaryMessage:   p6.student_summary.message,
    });
  } catch (err) {
    logger.error({ err, lessonId }, "P6 summary call failed");
    res.status(500).json({ error: "P6 summary generation failed" });
  }
});

// ── GET /lessons/debug-nodes-preview — server-rendered Armenian node viewer ───
// No auth required. Returns styled HTML for nodes 1002-1011 (lessons 68 & 69).
// Used for screenshot verification; can be removed after screenshots are taken.
router.get("/lessons/debug-nodes-preview", async (_req, res) => {
  const rows = await db
    .select({
      nodeId:     lessonNodesTable.id,
      nodeTitle:  lessonNodesTable.title,
      status:     lessonNodesTable.status,
      confidence: lessonNodesTable.teachingContentConfidence,
      theory:     lessonNodesTable.theoryContent,
      topicTitle: lessonTopicsTable.title,
      lessonId:   lessonNodesTable.lessonId,
    })
    .from(lessonNodesTable)
    .leftJoin(lessonTopicsTable, eq(lessonTopicsTable.id, lessonNodesTable.topicId))
    .where(and(
      // nodes 1002–1011 (lessons 68 & 69)
      ...[],
    ))
    .orderBy(asc(lessonNodesTable.lessonId), asc(lessonNodesTable.id));

  // Filter to 1002–1011
  const nodes = rows.filter((r) => r.nodeId >= 1002 && r.nodeId <= 1011);

  const STATUS_COLOR: Record<string, string> = {
    approved:             '#10b981',
    needs_source_content: '#f59e0b',
    draft:                '#6b7280',
  };

  const html = `<!DOCTYPE html>
<html lang="hy">
<head>
<meta charset="utf-8"/>
<title>Lesson Nodes · Armenian</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0f17;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;padding:24px;min-height:100vh}
  h1{font-size:1.1rem;font-weight:700;color:#a78bfa;margin-bottom:4px}
  .subtitle{font-size:.75rem;color:#64748b;margin-bottom:20px}
  .lesson{margin-bottom:28px}
  .lesson-title{font-size:.9rem;font-weight:700;color:#94a3b8;padding:6px 12px;background:#1e2235;border-radius:8px;margin-bottom:10px;border-left:3px solid #6366f1}
  .topic{margin-bottom:4px}
  .topic-label{font-size:.65rem;font-weight:700;color:#6366f1;text-transform:uppercase;letter-spacing:.08em;margin:10px 0 4px 0;padding-left:4px}
  .node{background:#131625;border:1px solid #1e2235;border-radius:10px;padding:12px 14px;margin-bottom:8px}
  .node-header{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .node-id{font-size:.65rem;font-family:monospace;color:#4b5563;background:#1e2235;padding:2px 6px;border-radius:4px}
  .node-title{font-size:.95rem;font-weight:600;color:#f1f5f9;flex:1}
  .badge{font-size:.6rem;font-weight:700;padding:2px 7px;border-radius:100px;border:1px solid;white-space:nowrap}
  .conf{font-size:.65rem;color:#94a3b8;margin-top:2px}
  .theory{font-size:.72rem;color:#64748b;margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .topic-label{display:flex;align-items:center;gap:6px}
  .topic-label::before{content:'';display:inline-block;width:8px;height:8px;border-radius:2px;background:#6366f1;flex-shrink:0}
</style>
</head>
<body>
<h1>🗺️ Lesson MicroNodes — Armenian Script Verification</h1>
<p class="subtitle">Nodes 1002–1011 · Lessons 68 (Հatuk Anun) & 69 (Bay) · ${new Date().toISOString()}</p>
${(() => {
  const byLesson = new Map<number, typeof nodes>();
  for (const n of nodes) {
    const arr = byLesson.get(n.lessonId!) ?? [];
    arr.push(n);
    byLesson.set(n.lessonId!, arr);
  }
  return [...byLesson.entries()].map(([lid, ns]) => {
    const byTopic = new Map<string, typeof nodes>();
    for (const n of ns) {
      const key = n.topicTitle ?? '(no topic)';
      const arr = byTopic.get(key) ?? [];
      arr.push(n);
      byTopic.set(key, arr);
    }
    return `<div class="lesson">
<div class="lesson-title">Lesson ${lid}</div>
${[...byTopic.entries()].map(([topic, tnodes]) => `
<div class="topic">
  <div class="topic-label">${topic}</div>
  ${tnodes.map((n) => {
    const col = STATUS_COLOR[n.status ?? 'draft'] ?? '#6b7280';
    return `<div class="node">
  <div class="node-header">
    <span class="node-id">#${n.nodeId}</span>
    <span class="node-title">${n.nodeTitle}</span>
    <span class="badge" style="color:${col};border-color:${col}40">${n.status ?? 'draft'}</span>
    ${n.confidence != null ? `<span class="conf">${n.confidence}%</span>` : ''}
  </div>
  ${n.theory ? `<div class="theory">${n.theory.replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0, 200)}…</div>` : ''}
</div>`;
  }).join('')}
</div>`).join('')}
</div>`;
  }).join('');
})()}
</body></html>`;

  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

// ── Manual / Semi-Automatic Mapping ───────────────────────────────────────────
//
// POST /lessons/:lessonId/manual-map
//
// Accepts a JSON string (teacher-pasted from ChatGPT/Gemini) describing the
// lesson mapping.  Expected format:
//
//   {
//     "topics": [
//       {
//         "title": "Armenian topic title",
//         "topicType": "grammar | enrichment",
//         "microNodes": [
//           {
//             "title": "MicroNode title in Armenian",
//             "microNodeType": "knowledge | skill",
//             "learningObjective": "string  OR  {text, origin}",
//             "sourcePages": [58, 59],   // array OR single number
//             "theoryText": "Verbatim theory from textbook",
//             "exercises": [{ "text": "...", "page": 60 }]
//           }
//         ]
//       }
//     ]
//   }
//
// Processing steps:
//   1. Strip ```json fences.
//   2. SHA-256 idempotency check on (lessonId, hash).
//   3. JSON.parse; 400 on failure.
//   4. normalizeIncomingMapping() — tolerant pre-validation.
//   5. Schema validation — exclude invalid microNodes, log review items.
//   6. Source-integrity check — page-range only (blocks not stored); all flagged "sourcePage-unverified".
//   7. Duplicate check — Levenshtein > 0.9 within same parent topic.
//   8. Write lesson_topics / lesson_nodes / lesson_exercises.
//   9. Write mapping_import_log row.
//  10. Write mapping_review_items rows (persisted for review dashboard).
//  11. Return mapping-report shaped response + mappingOrigin: "manual".

/** Simple Levenshtein edit distance */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function titleSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (na === nb) return 1;
  const dist = levenshteinDistance(na, nb);
  return 1 - dist / Math.max(na.length, nb.length, 1);
}

/** Tolerant pre-validation: fix minor shape variance without guessing required content. */
function normalizeIncomingMapping(raw: unknown): {
  topics: {
    title: string;
    topicType: string;
    microNodes: {
      title: string;
      microNodeType: string;
      learningObjective: string;
      sourcePages: number[];
      theoryText: string;
      exercises: { text: string; page: number | null }[];
    }[];
  }[];
} {
  const obj = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const topics = Array.isArray(obj["topics"]) ? obj["topics"] : [];

  return {
    topics: topics.map((t: unknown) => {
      const tp = (t && typeof t === "object" && !Array.isArray(t)) ? t as Record<string, unknown> : {};
      const mns = Array.isArray(tp["microNodes"]) ? tp["microNodes"] : [];
      return {
        title:     String(tp["title"] ?? "").trim(),
        topicType: String(tp["topicType"] ?? "grammar").trim(),
        microNodes: mns.map((mn: unknown) => {
          const m = (mn && typeof mn === "object" && !Array.isArray(mn)) ? mn as Record<string, unknown> : {};

          // learningObjective: accept string or {text, origin}
          let lo = "";
          const rawLo = m["learningObjective"];
          if (typeof rawLo === "string") lo = rawLo.trim();
          else if (rawLo && typeof rawLo === "object" && "text" in (rawLo as object)) {
            lo = String((rawLo as Record<string, unknown>)["text"] ?? "").trim();
          }

          // sourcePages: accept array or single number
          let sp: number[] = [];
          const rawSp = m["sourcePages"];
          if (Array.isArray(rawSp)) sp = rawSp.map(Number).filter(Number.isFinite);
          else if (typeof rawSp === "number" && Number.isFinite(rawSp)) sp = [rawSp];

          // exercises: accept missing → []
          const exArr = Array.isArray(m["exercises"]) ? m["exercises"] : [];
          const exercises = exArr.map((ex: unknown) => {
            const e = (ex && typeof ex === "object") ? ex as Record<string, unknown> : {};
            return {
              text: String(e["text"] ?? "").trim(),
              page: typeof e["page"] === "number" ? e["page"] : null,
            };
          }).filter((e) => e.text.length > 0);

          return {
            title:             String(m["title"] ?? "").trim(),
            microNodeType:     String(m["microNodeType"] ?? "knowledge").trim(),
            learningObjective: lo,
            sourcePages:       sp,
            theoryText:        String(m["theoryText"] ?? "").trim(),
            exercises,
          };
        }),
      };
    }),
  };
}

// ── TEXT import handler (Contract v1.2) ──────────────────────────────────────

async function handleTextImport(
  req: AuthRequest, res: Response, lessonId: number, rawText: string, dryRun: boolean,
): Promise<void> {
  const parsed = parseMappingText(rawText);

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  const validation = validateParsedMapping(parsed, lesson.pagesFrom ?? null, lesson.pagesTo ?? null);

  if (dryRun) {
    const totalMicroNodes = parsed.nodes.reduce((s, n) => s + n.microNodes.length, 0);
    res.json({
      preview: {
        lessonTitle:   parsed.lesson?.title ?? lesson.title,
        pagesFrom:     parsed.lesson?.pagesFrom ?? lesson.pagesFrom ?? 0,
        pagesTo:       parsed.lesson?.pagesTo   ?? lesson.pagesTo   ?? 0,
        counts: {
          nodes:        parsed.nodes.length,
          microNodes:   totalMicroNodes,
          sourceBlocks: parsed.sourceBlocks.length,
          exercises:    parsed.exercises.length,
          dependencies: parsed.dependencies.length,
        },
        coverageAudit: validation.coverageAudit,
        errors:        validation.errors,
        warnings:      validation.warnings,
        hasErrors:     !validation.ok,
      },
      errors:    validation.errors,
      warnings:  validation.warnings,
      hasErrors: !validation.ok,
    });
    return;
  }

  if (!validation.ok) {
    res.status(422).json({
      error:    "Validation failed — resolve errors before importing.",
      errors:   validation.errors,
      warnings: validation.warnings,
    });
    return;
  }

  // Re-parse + re-validate: stale preview cannot be committed (contract §dryRun)
  const parsed2     = parseMappingText(rawText);
  const validation2 = validateParsedMapping(parsed2, lesson.pagesFrom ?? null, lesson.pagesTo ?? null);
  if (!validation2.ok) {
    res.status(422).json({
      error:    "Re-validation failed during commit — please retry.",
      errors:   validation2.errors,
      warnings: validation2.warnings,
    });
    return;
  }

  const rawTextHash = createHash("sha256").update(rawText).digest("hex");

  try {
    const result = await insertParsedMapping(
      lessonId, parsed2, req.userId ?? null, rawTextHash, rawText, validation2.warnings,
    );
    res.json({
      lessonId,
      lessonTitle:   lesson.title,
      mappingOrigin: "manual_text",
      counts: {
        topicsCreated:       result.topicsCreated,
        microNodesCreated:   result.microNodesCreated,
        exercisesCreated:    result.exercisesCreated,
        dependenciesCreated: result.dependenciesCreated,
      },
      quality: {
        reviewItems: result.reviewItemsCreated,
        warnings:    validation2.warnings.length,
      },
    });
  } catch (err) {
    logger.error({ err, lessonId }, "manual-map TEXT: insert failed");
    res.status(500).json({ error: "Import failed — database error." });
  }
}

// ── LEGACY JSON import handler ────────────────────────────────────────────────
// LEGACY — do not add features to this function

async function handleLegacyJsonImport(
  req: AuthRequest, res: Response, lessonId: number, rawText: string,
): Promise<void> {
  // DIAGNOSTIC
  logger.info(
    `[manual-map LEGACY] body received — length=${rawText.length}` +
    ` | head=${JSON.stringify(rawText.slice(0, 100))}` +
    ` | tail=${JSON.stringify(rawText.slice(-100))}`
  );

  // Strip ```json / ``` fences
  let text = rawText.trim();
  if (text.startsWith("```json")) text = text.slice(7);
  else if (text.startsWith("```"))   text = text.slice(3);
  if (text.endsWith("```")) text = text.slice(0, -3).trim();

  const rawTextHash = createHash("sha256").update(text).digest("hex");
  const existingImport = await db
    .select({ id: mappingImportLogTable.id })
    .from(mappingImportLogTable)
    .where(and(
      eq(mappingImportLogTable.lessonId, lessonId),
      eq(mappingImportLogTable.rawTextHash, rawTextHash),
    ))
    .limit(1);

  if (existingImport.length > 0) {
    const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
    if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }
    const [topicsResult, nodes, exercises] = await Promise.all([
      db.select().from(lessonTopicsTable).where(eq(lessonTopicsTable.lessonId, lessonId)),
      db.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId)),
      db.select().from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, lessonId)),
    ]);
    res.json({
      lessonId, lessonTitle: lesson.title, pagesFrom: lesson.pagesFrom ?? null, pagesTo: lesson.pagesTo ?? null,
      generatedAt: new Date().toISOString(), mappingOrigin: "manual", idempotent: true,
      counts: { topicsCreated: topicsResult.length, microNodesCreated: nodes.length, exercisesCreated: exercises.length },
      quality: { reviewItems: [] },
    });
    return;
  }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(text);
  } catch (parseErr) {
    const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    res.status(400).json({
      error: "AI-\u056b \u057a\u0561\u057f\u0561\u057d\u056d\u0561\u0576\u0568 \u0579\u056b \u0570\u0561\u0563\u0565\u056c JSON \u0571\u0587\u057e\u0561\u0579\u0561\u0583\u0578\u057e\u0589",
      _debug_parseError: parseMsg,
      _debug_textLength: text.length,
      _debug_textHead: text.slice(0, 200),
    });
    return;
  }

  const normalized = normalizeIncomingMapping(parsedRaw);
  if (normalized.topics.length === 0) {
    res.status(400).json({ error: "\u0584\u0561\u0580\u057f\u0587\u0566\u0561\u0563\u0580\u0574\u0561\u0576 \u0564\u0561\u0577\u057f\u0587\u0580\u0568 \u0579\u056b \u0563\u057f\u0576\u057e\u0565\u056c\u0589" });
    return;
  }

  const [{ maxTopicSeq }] = await db
    .select({ maxTopicSeq: max(lessonTopicsTable.sequence) })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId));
  const [{ maxNodeSeq }] = await db
    .select({ maxNodeSeq: max(lessonNodesTable.sequence) })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId));
  const [{ maxExSeq }] = await db
    .select({ maxExSeq: max(lessonExercisesTable.sequence) })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, lessonId));

  let topicSeqCounter = (maxTopicSeq ?? 0);
  let nodeSeqCounter  = (maxNodeSeq  ?? 0);
  let exSeqCounter    = (maxExSeq    ?? 0);

  const reviewItems: { entityId: number | null; entityType: string; issueType: string; severity: string; description: string }[] = [];
  const createdTopicIds: number[] = [];
  const createdNodeIds:  number[] = [];
  const createdExIds:    number[] = [];

  for (const topic of normalized.topics) {
    if (!topic.title) {
      reviewItems.push({ entityId: null, entityType: "import", issueType: "validation-failed", severity: "error",
        description: `Topic missing title; skipped.` });
      continue;
    }

    topicSeqCounter += 1;
    const [insertedTopic] = await db
      .insert(lessonTopicsTable)
      .values({ lessonId, title: topic.title, sequence: topicSeqCounter })
      .returning();
    createdTopicIds.push(insertedTopic.id);

    const acceptedTitlesInTopic: string[] = [];

    for (const mn of topic.microNodes) {
      const validationErrors: string[] = [];
      if (!mn.title)             validationErrors.push("missing title");
      if (!mn.microNodeType || !["knowledge","skill"].includes(mn.microNodeType))
        mn.microNodeType = "knowledge";
      if (!mn.learningObjective) validationErrors.push("missing learningObjective");
      if (mn.sourcePages.length === 0) validationErrors.push("sourcePages is empty");

      if (validationErrors.length > 0) {
        reviewItems.push({ entityId: null, entityType: "node", issueType: "validation-failed", severity: "error",
          description: `MicroNode \u00ab${mn.title || "(no title)"}\u00bb excluded: ${validationErrors.join(", ")}.` });
        continue;
      }

      const dupTitle = acceptedTitlesInTopic.find((t) => titleSimilarity(t, mn.title) > 0.9);
      if (dupTitle) {
        reviewItems.push({ entityId: null, entityType: "node", issueType: "duplicate-title", severity: "warning",
          description: `Duplicate or similar MicroNode title \u00ab${mn.title}\u00bb (similar to \u00ab${dupTitle}\u00bb). Skipped.` });
        continue;
      }
      acceptedTitlesInTopic.push(mn.title);

      nodeSeqCounter += 1;
      const [insertedNode] = await db
        .insert(lessonNodesTable)
        .values({
          lessonId,
          topicId:           insertedTopic.id,
          sequence:          nodeSeqCounter,
          title:             mn.title,
          learningObjective: mn.learningObjective || null,
          microNodeType:     mn.microNodeType,
          theoryContent:     mn.theoryText || null,
          verbatimTheoryAnchor: mn.theoryText || null,
          sourcePage:        mn.sourcePages[0] ?? null,
          sourceText:        mn.theoryText || null,
          status:            "needs_review",
          contentSourceType: "manual",
          createdBy:         "teacher",
          confidenceScore:   null,
          targetBloomLevel:  1,
          estimatedMinutes:  5,
        })
        .returning();
      createdNodeIds.push(insertedNode.id);

      const pagesFrom = lesson.pagesFrom ?? null;
      const pagesTo   = lesson.pagesTo   ?? null;
      const outOfRange = pagesFrom != null && pagesTo != null
        ? mn.sourcePages.filter((p) => p < pagesFrom || p > pagesTo)
        : [];

      if (outOfRange.length > 0) {
        reviewItems.push({ entityId: insertedNode.id, entityType: "node", issueType: "sourcePage-out-of-range", severity: "warning",
          description: `MicroNode \u00ab${mn.title}\u00bb: pages ${outOfRange.join(", ")} are outside lesson page range (${pagesFrom}\u2013${pagesTo}).` });
      }
      reviewItems.push({ entityId: insertedNode.id, entityType: "node", issueType: "sourcePage-unverified", severity: "warning",
        description: `MicroNode \u00ab${mn.title}\u00bb: sourcePages [${mn.sourcePages.join(", ")}] unverified (original blocks not stored).` });

      for (const ex of mn.exercises) {
        exSeqCounter += 1;
        const [insertedEx] = await db
          .insert(lessonExercisesTable)
          .values({
            lessonId,
            exerciseId:           `EX-${lessonId}-M${exSeqCounter}`,
            exerciseTextVerbatim: ex.text,
            sourcePage:           ex.page != null ? String(ex.page) : null,
            relatedNodeId:        insertedNode.id,
            sequence:             exSeqCounter,
            sourceType:           "manual" as const,
            status:               "needs_review",
            sourceText:           ex.text,
          })
          .returning();
        createdExIds.push(insertedEx.id);
      }
    }
  }

  await db.insert(mappingImportLogTable).values({
    lessonId,
    source:               "manual",
    mappingMode:          "MANUAL_AI_JSON",
    rawTextHash,
    rawInput:             rawText,
    mappingSchemaVersion: "1.0",
    importedBy:           req.userId ?? null,
  });

  if (reviewItems.length > 0) {
    await db.insert(mappingReviewItemsTable).values(
      reviewItems.map((ri) => ({
        lessonId,
        entityId:    ri.entityId,
        entityType:  ri.entityType,
        issueType:   ri.issueType,
        severity:    ri.severity,
        description: ri.description,
        status:      "open" as const,
      }))
    );
  }

  res.json({
    lessonId,
    lessonTitle:   lesson.title,
    pagesFrom:     lesson.pagesFrom  ?? null,
    pagesTo:       lesson.pagesTo    ?? null,
    generatedAt:   new Date().toISOString(),
    mappingOrigin: "manual",
    counts: {
      pass1BlocksExtracted: null,
      topicsCreated:        createdTopicIds.length,
      microNodesCreated:    createdNodeIds.length,
      exercisesCreated:     createdExIds.length,
      unmappedBlocks:       null,
    },
    content: {
      aiGeneratedFields:        0,
      textbookSourcedExercises: createdExIds.length,
      textbookSourcedNodes:     createdNodeIds.length,
    },
    quality: {
      coveragePercent:          null,
      overallConfidencePercent: 0,
      teacherReviewRequired:    reviewItems.length,
      reviewItems: reviewItems.map((ri) => ({
        nodeId:    ri.entityId,
        nodeTitle: ri.description,
        reason:    ri.issueType,
      })),
    },
  });
}

// ── Route: POST /lessons/:lessonId/manual-map ─────────────────────────────────

router.post("/lessons/:lessonId/manual-map", requireTeacher, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const { rawText, format, dryRun } = req.body as { rawText?: string; format?: string; dryRun?: boolean };
  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    res.status(400).json({ error: "rawText is required" });
    return;
  }

  // format is REQUIRED — no content-sniffing (Contract v1.2 §2)
  if (format !== "text" && format !== "json") {
    res.status(400).json({ error: 'format is required: must be "text" or "json"' });
    return;
  }

  logger.info(`[manual-map] format=${format} dryRun=${dryRun ?? false} length=${rawText.length}`);

  if (format === "text") {
    await handleTextImport(req, res, lessonId, rawText, dryRun === true);
    return;
  }

  // LEGACY JSON PATH — do not add features
  await handleLegacyJsonImport(req, res, lessonId, rawText);
});

export default router;