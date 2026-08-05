import { logger } from "../lib/logger";
import { updateStudentProfile } from "../services/student-profile";
import { Router } from "express";
import { db, lessonsTable, lessonSessionsTable, subjectsTable, knowledgeNodesTable, lessonNodesTable, resourcesTable, lessonExercisesTable, lessonNodeDependenciesTable, evidenceEventsTable, coursesTable, classStudentsTable } from "@workspace/db";
import { eq, and, asc, max, inArray } from "drizzle-orm";
import { requireAuth, requireTeacher, type AuthRequest } from "../middlewares/auth";
import { extractPdfPageRange, resolveUploadedFilePath, mapLessonWithAI, topologicalSortNodes } from "../services/lesson-mapping";
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
      sequence: n.sequence,
      title: n.title,
      theoryContent: n.theoryContent ?? null,
      targetBloomLevel: n.targetBloomLevel ?? null,
      estimatedMinutes: n.estimatedMinutes ?? null,
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

  const { title, theoryContent, targetBloomLevel, estimatedMinutes } = req.body as {
    title?: string;
    theoryContent?: string;
    targetBloomLevel?: number;
    estimatedMinutes?: number;
  };

  const patch: Partial<typeof existing> = {};
  if (title !== undefined) patch.title = title.trim();
  if (theoryContent !== undefined) patch.theoryContent = theoryContent.trim() || null;
  if (targetBloomLevel !== undefined) patch.targetBloomLevel = targetBloomLevel;
  if (estimatedMinutes !== undefined) patch.estimatedMinutes = estimatedMinutes;

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
// ── LESSON MAPPING (P1-lite) ────────────────────────────────────────────────

// POST /lessons/:lessonId/map — extract the real textbook text for this
// lesson's page range from its linked textbook resource, call the AI to
// produce a lesson goal/outcomes/core idea plus structured knowledge nodes,
// then replace this lesson's existing lesson_nodes with the new ones.
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

  try {
    const filePath = resolveUploadedFilePath(resource.fileUrl);
    const lessonText = await extractPdfPageRange(
      filePath,
      lesson.pagesFrom,
      lesson.pagesTo
    );

    const mapping = await mapLessonWithAI({
      subjectName: subject?.name ?? "",
      lessonTitle: lesson.title,
      chapterTitle: lesson.chapterTitle ?? null,
      textbookTitle: lesson.textbookTitle ?? null,
      textbookAuthor: lesson.textbookAuthor ?? null,
      pagesFrom: lesson.pagesFrom,
      pagesTo: lesson.pagesTo,
      lessonText,
      teacherGoal: lesson.lessonGoal ?? null,
      teacherOutcomes: Array.isArray(lesson.lessonOutcomes)
        ? (lesson.lessonOutcomes as string[])
        : null,
    });

    await db
      .update(lessonsTable)
      .set({
        lessonGoal: mapping.lessonGoal,
        lessonOutcomes: mapping.lessonOutcomes,
        coreProblem: mapping.coreProblem,
        coreIdea: mapping.coreIdea,
        essentialQuestion: mapping.essentialQuestion ?? null,
        practicalTasks: mapping.practicalTasks,
        knowledgeBoundaries: mapping.knowledgeBoundaries ?? [],
        // Save textbook metadata extracted from page content when teacher left these blank
        ...(mapping.textbookAuthor && !lesson.textbookAuthor
          ? { textbookAuthor: mapping.textbookAuthor } : {}),
        ...(mapping.textbookTitle && !lesson.textbookTitle
          ? { textbookTitle: mapping.textbookTitle } : {}),
        ...(mapping.chapterTitle && !lesson.chapterTitle
          ? { chapterTitle: mapping.chapterTitle } : {}),
      })
      .where(eq(lessonsTable.id, lessonId));

    // ── Replace this lesson's node set with the freshly mapped one ──
    await db.delete(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId));

    // Topological sort: assign sequence by real pedagogical dependency, not model array order
    const sortedTitles = topologicalSortNodes(
      mapping.nodes.map((n) => n.title),
      mapping.nodeDependencies ?? []
    );
    const titleToSeq = new Map<string, number>(sortedTitles.map((t, i) => [t, i + 1]));

    const insertedNodes = await db
      .insert(lessonNodesTable)
      .values(
        mapping.nodes.map((n) => ({
          lessonId,
          sequence: titleToSeq.get(n.title) ?? 999,
          title: n.title,
          theoryContent: n.theoryContent,
          targetBloomLevel: n.targetBloomLevel,
          estimatedMinutes: n.estimatedMinutes,
          childFriendlyExplanation: n.childFriendlyExplanation,
          basicExamples: n.basicExamples,
          realLifeExamples: n.realLifeExamples,
          commonMisconception: n.commonMisconception,
          prerequisiteNodes: n.prerequisiteNodes,
          verbatimTheoryAnchor: (n as { verbatimTheoryAnchor?: string }).verbatimTheoryAnchor ?? null,
          nonExamples: (n as { nonExamples?: unknown[] }).nonExamples ?? [],
        }))
      )
      .returning();

    // ── Persist authoring-time dependency graph ──────────────────────────────
    await db.delete(lessonNodeDependenciesTable).where(
      eq(lessonNodeDependenciesTable.lessonId, lessonId)
    );
    if ((mapping.nodeDependencies ?? []).length > 0) {
      const nodeTitleToIdMap = new Map<string, number>(insertedNodes.map((n) => [n.title, n.id]));
      const depRows = (mapping.nodeDependencies ?? [])
        .map((dep) => {
          const fromId = nodeTitleToIdMap.get(dep.fromNodeTitle);
          const toId   = nodeTitleToIdMap.get(dep.toNodeTitle);
          if (!fromId || !toId) {
            logger.warn({ dep, lessonId }, "lesson-mapping: dependency title not found in inserted nodes — skipped");
            return null;
          }
          return {
            lessonId,
            fromNodeId: fromId,
            toNodeId: toId,
            dependencyType: dep.dependencyType,
            requiredLevel: dep.requiredLevel,
            reason: dep.reason ?? null,
          };
        })
        .filter(Boolean) as {
          lessonId: number; fromNodeId: number; toNodeId: number;
          dependencyType: string; requiredLevel: string; reason: string | null;
        }[];
      if (depRows.length > 0) {
        await db.insert(lessonNodeDependenciesTable).values(depRows);
      }
    }

    // P1 STEP 17: Populate lesson_exercises with structured, queryable exercise data
    await db.delete(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, lessonId));

    if (mapping.practicalTasks.length > 0) {
      const nodeTitleToId = new Map<string, number>(
        insertedNodes.map((n) => [n.title, n.id])
      );
      await db.insert(lessonExercisesTable).values(
        mapping.practicalTasks.map((t, i) => ({
          lessonId,
          exerciseId:           `EX-${lessonId}-${i + 1}`,
          sourcePage:           t.sourcePage ?? null,
          exerciseTextVerbatim: t.exerciseTextVerbatim || t.task,
          exercisePurpose:      t.exercisePurpose || "AI_ADAPTED",
          relatedNodeId:        nodeTitleToId.get(t.relatedNodeTitle) ?? null,
          successCriteria:      t.successCriteria || null,
          difficultyLevel:      t.difficultyLevel || null,
          assignment:           t.assignment || "CLASS",
          sequence:             i + 1,
        }))
      );
    }

    // ── Eager knowledge_nodes creation for all enrolled students ────────────
    // Immediately after lesson_nodes are inserted, create per-student
    // knowledge_nodes rows (status="not_started", no scores) for every student
    // currently enrolled in the class this lesson's course belongs to.
    //
    // Idempotent: the unique index on (userId, lessonNodeId) means
    // .onConflictDoNothing() silently skips any pair that already exists
    // (e.g. from a prior re-map or a quiz submission).  NULL lessonNodeId rows
    // created by chat.ts are unaffected because PostgreSQL treats NULLs as
    // distinct in unique indexes.
    let knowledgeNodesCreated = 0;
    let knowledgeNodesSkipped = 0;

    if (lesson.courseId && insertedNodes.length > 0) {
      const [course] = await db
        .select({ classId: coursesTable.classId })
        .from(coursesTable)
        .where(eq(coursesTable.id, lesson.courseId))
        .limit(1);

      if (course) {
        const enrolledStudents = await db
          .select({ studentId: classStudentsTable.studentId })
          .from(classStudentsTable)
          .where(eq(classStudentsTable.classId, course.classId));

        if (enrolledStudents.length > 0) {
          const knRows = enrolledStudents.flatMap((s) =>
            insertedNodes.map((n) => ({
              subjectId:    lesson.subjectId,
              userId:       s.studentId,
              topicName:    n.title,
              lessonNodeId: n.id,
              status:       "not_started" as const,
              isProvisional: true,
              bloomLevel:   n.targetBloomLevel ?? 1,
            }))
          );

          const inserted = await db
            .insert(knowledgeNodesTable)
            .values(knRows)
            .onConflictDoNothing()
            .returning({ id: knowledgeNodesTable.id });

          knowledgeNodesCreated = inserted.length;
          knowledgeNodesSkipped = knRows.length - inserted.length;

          logger.info(
            {
              lessonId,
              courseId:          lesson.courseId,
              classId:           course.classId,
              enrolledStudents:  enrolledStudents.length,
              nodesCount:        insertedNodes.length,
              knowledgeNodesCreated,
              knowledgeNodesSkipped,
            },
            "lesson-mapping: eager knowledge_nodes creation complete"
          );
        }
      }
    }

    res.json({
      nodesCreated:          insertedNodes.length,
      exercisesCreated:      mapping.practicalTasks.length,
      knowledgeNodesCreated,
      knowledgeNodesSkipped,
      lessonGoal:            mapping.lessonGoal,
      lessonOutcomes:        mapping.lessonOutcomes,
      coreProblem:           mapping.coreProblem,
      coreIdea:              mapping.coreIdea,
      practicalTasks:        mapping.practicalTasks,
    });
  } catch (err) {
    logger.error({ err, lessonId }, "lesson mapping failed");
    res.status(500).json({
      error:
        err instanceof Error
          ? err.message
          : "Lesson mapping failed, please retry",
    });
  }
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

export default router;