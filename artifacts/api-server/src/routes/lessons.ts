import { logger } from "../lib/logger";
import { updateStudentProfile } from "../services/student-profile";
import { Router, type NextFunction, type Response } from "express";
import { db, lessonsTable, lessonSessionsTable, subjectsTable, knowledgeNodesTable, lessonNodesTable, lessonTopicsTable, resourcesTable, lessonExercisesTable, lessonNodeDependenciesTable, evidenceEventsTable, coursesTable, classStudentsTable, mappingJobsTable, mappingImportLogTable, mappingReviewItemsTable, quizzesTable, quizLessonLinksTable, quizQuestionsTable, quizAssignmentsTable, quizAttemptsTable, lessonNodeCognitiveLevelsTable, lessonNodeCognitiveTasksTable, lessonOutcomesTable, lessonOutcomeNodeAlignmentsTable, lessonNodeTeachingPackageItemsTable, chatMessagesTable, COGNITIVE_LEVEL_TO_BLOOM_INT } from "@workspace/db";
import { parseMappingText } from "../mapping/mapTextParser.js";
import { validateParsedMapping } from "../mapping/mapTextValidator.js";
import { insertParsedMapping } from "../mapping/mapTextInserter.js";
import { createHash } from "crypto";
import { eq, and, asc, desc, max, inArray, count, or, ne, isNotNull, sql } from "drizzle-orm";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { requireAuth, requireTeacher, type AuthRequest } from "../middlewares/auth";
import { extractPdfPageRange, resolveUploadedFilePath, isGarbledText, rasterizePdfPages, extractBlocksWithAI, extractBlocksWithVision, runPass2Pipeline, assertDetailedMappingHasMicroNodes, MappingPass2ParserError, MappingZeroMicroNodesError, getTeacherFacingMappingFailure, generatePhase2Content, isWeakSource, generateCognitivePath, type Pass1Result, type Phase2Input, type Phase2LinkedExercise, type CogPathInput, type CogPathExercise, type ConfirmedCogLevel } from "../services/lesson-mapping";
import { validateActivityPlacement, formatActivityFinding } from "../lib/activity-validator.js";
import { callAIP6 } from "../services/ai";
import { getDueReviewTopics } from "../services/review-schedule";
import { refreshSequentialDependencies } from "../lib/sequential-deps.js";
import { validateKnowledgeBaseLesson } from "../lib/kb-validator.js";
import { validateLessonForFinalApproval } from "../lib/lesson-final-approval.js";
import { invalidateLessonApproval } from "../lib/lesson-approval-invalidation.js";
import { normalizeSourceExerciseAnswerContract } from "../lib/source-exercise-answer.js";
import { validateRequiredLessonPageRange } from "../lib/lesson-page-range.js";
import {
  isLearnerDeliveryEligible,
  resolveLearnerExerciseContent,
} from "../lib/exercise-content-boundary.js";
import {
  deriveNodeCognitiveCapacity,
  buildTemporarySequencePlan,
  getAlignmentWarnings,
  isCognitiveDepth,
  isDepthWithinCapacity,
  type CognitiveDepth,
} from "../lib/lesson-outcome-validation.js";
import {
  getDeterministicTeachingPackageSeedCandidates,
  isStableCognitiveLevel,
  isServerControlledTeachingPackageProvenance,
  isTeachingPackageItemType,
  isTeachingPackageProvenance,
  isTeachingPackageStatus,
  provenanceAfterExplicitTeachingPackageApproval,
  requiresExplicitTeachingPackageApproval,
  TEACHING_PACKAGE_ITEM_TYPES,
  type TeachingPackageItemType,
  type TeachingPackageProvenance,
} from "../lib/teaching-package.js";

const router = Router();

/**
 * Exercise answer keys are teacher-authoring data. Keep them behind both a
 * teacher/admin role check and lesson ownership (direct or through the course).
 */
function requireLessonAuthor(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  requireTeacher(req, res, () => {
    void (async () => {
      const lessonId = parseInt(String(req.params.lessonId), 10);
      if (isNaN(lessonId)) {
        res.status(400).json({ error: "Invalid lesson id" });
        return;
      }

      const [lesson] = await db
        .select({
          teacherId: lessonsTable.teacherId,
          courseTeacherId: coursesTable.teacherId,
        })
        .from(lessonsTable)
        .leftJoin(coursesTable, eq(coursesTable.id, lessonsTable.courseId))
        .where(eq(lessonsTable.id, lessonId))
        .limit(1);

      if (!lesson) {
        res.status(404).json({ error: "Lesson not found" });
        return;
      }

      if (
        req.userRole !== "admin" &&
        lesson.teacherId !== req.userId &&
        lesson.courseTeacherId !== req.userId
      ) {
        res.status(403).json({ error: "Lesson author access required" });
        return;
      }

      next();
    })().catch(next);
  });
}

// ── Package 1A / C1 canonical outcome helpers ─────────────────────────────────
// These are intentionally authoring-only. They neither alter final approval nor
// lesson delivery: legacy lessons keep their existing learner-facing behavior.
type OutcomeRole = "REQUIRED" | "SUPPORTING";
const OUTCOME_ROLES: readonly OutcomeRole[] = ["REQUIRED", "SUPPORTING"];
const OUTCOME_STATUSES = ["draft", "reviewed", "approved"] as const;
const TEACHER_EDITABLE_OUTCOME_STATUSES = ["draft", "reviewed"] as const;
type GoalOutcomeReviewStatus = "legacy" | "draft" | "proposed" | "confirmed" | "needs_review";
const GOAL_OUTCOME_REVIEW_STATUSES: readonly GoalOutcomeReviewStatus[] = [
  "legacy", "draft", "proposed", "confirmed", "needs_review",
];

function getGoalOutcomeReviewStatus(lesson: Record<string, unknown>): GoalOutcomeReviewStatus {
  const value = lesson.goalOutcomeReviewStatus;
  return typeof value === "string" && GOAL_OUTCOME_REVIEW_STATUSES.includes(value as GoalOutcomeReviewStatus)
    ? value as GoalOutcomeReviewStatus
    : "legacy";
}

function requiresGoalOutcomeConfirmation(lesson: Record<string, unknown>): boolean {
  const status = getGoalOutcomeReviewStatus(lesson);
  return status !== "legacy" && status !== "confirmed";
}

async function markGoalOutcomeReviewStale(lessonId: number): Promise<void> {
  const [lesson] = await db.select({
    status: lessonsTable.goalOutcomeReviewStatus,
  }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) return;
  const status = getGoalOutcomeReviewStatus({ goalOutcomeReviewStatus: lesson.status });
  // A teacher's first canonical Outcome edit intentionally opts a lesson into
  // the review workflow. Legacy lessons are otherwise never retroactively gated.
  if (status === "legacy") {
    await db.update(lessonsTable).set({
      goalOutcomeReviewStatus: "draft",
      goalOutcomeConfirmedAt: null,
      goalOutcomeConfirmedBy: null,
    }).where(eq(lessonsTable.id, lessonId));
    return;
  }
  if (status === "confirmed") {
    await db.update(lessonsTable).set({
      goalOutcomeReviewStatus: "needs_review",
      goalOutcomeConfirmedAt: null,
      goalOutcomeConfirmedBy: null,
    }).where(eq(lessonsTable.id, lessonId));
  }
}

function parseGoalOutcomeProposal(raw: string): { lessonGoal: string; outcomes: string[] } | null {
  const stripped = raw.replace(/```json\s*|```/gi, "").trim();
  const candidate = stripped.match(/\{[\s\S]*\}/)?.[0] ?? stripped;
  try {
    const value = JSON.parse(candidate) as { lessonGoal?: unknown; outcomes?: unknown };
    const lessonGoal = typeof value.lessonGoal === "string" ? value.lessonGoal.trim() : "";
    const outcomes = Array.isArray(value.outcomes)
      ? [...new Set(value.outcomes.filter((item): item is string => typeof item === "string")
        .map((item) => item.trim()).filter(Boolean))].slice(0, 12)
      : [];
    return lessonGoal && outcomes.length > 0 ? { lessonGoal, outcomes } : null;
  } catch {
    return null;
  }
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeLegacyOutcomes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

async function getCanonicalOutcomeBundle(lessonId: number) {
  const [lessonRows, outcomes, nodes, alignments, cognitiveLevels] = await Promise.all([
    db.select({
      id: lessonsTable.id,
      legacyOutcomes: lessonsTable.lessonOutcomes,
      goalOutcomeReviewStatus: lessonsTable.goalOutcomeReviewStatus,
      goalOutcomeConfirmedAt: lessonsTable.goalOutcomeConfirmedAt,
    }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1),
    db.select().from(lessonOutcomesTable)
      .where(eq(lessonOutcomesTable.lessonId, lessonId))
      .orderBy(asc(lessonOutcomesTable.sequence)),
    db.select({
      id: lessonNodesTable.id,
      sequence: lessonNodesTable.sequence,
      title: lessonNodesTable.title,
      topicId: lessonNodesTable.topicId,
      status: lessonNodesTable.status,
      targetBloomLevel: lessonNodesTable.targetBloomLevel,
      cogPathStatus: lessonNodesTable.cogPathStatus,
    }).from(lessonNodesTable)
      .where(eq(lessonNodesTable.lessonId, lessonId))
      .orderBy(asc(lessonNodesTable.sequence)),
    db.select().from(lessonOutcomeNodeAlignmentsTable)
      .where(eq(lessonOutcomeNodeAlignmentsTable.lessonId, lessonId)),
    db.select({
      lessonNodeId: lessonNodeCognitiveLevelsTable.lessonNodeId,
      cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel,
      isApplicable: lessonNodeCognitiveLevelsTable.isApplicable,
      isTargetCeiling: lessonNodeCognitiveLevelsTable.isTargetCeiling,
    }).from(lessonNodeCognitiveLevelsTable)
      .innerJoin(lessonNodesTable, eq(lessonNodesTable.id, lessonNodeCognitiveLevelsTable.lessonNodeId))
      .where(eq(lessonNodesTable.lessonId, lessonId)),
  ]);

  const lesson = lessonRows[0];
  if (!lesson) return null;

  const levelsByNode = new Map<number, typeof cognitiveLevels>();
  for (const level of cognitiveLevels) {
    const existing = levelsByNode.get(level.lessonNodeId) ?? [];
    existing.push(level);
    levelsByNode.set(level.lessonNodeId, existing);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const capacityByNode = new Map(nodes.map((node) => [
    node.id,
    deriveNodeCognitiveCapacity({
      targetBloomLevel: node.targetBloomLevel,
      cogPathStatus: node.cogPathStatus,
      levels: levelsByNode.get(node.id) ?? [],
    }),
  ]));
  const alignmentsByOutcome = new Map<number, typeof alignments>();
  for (const alignment of alignments) {
    const existing = alignmentsByOutcome.get(alignment.lessonOutcomeId) ?? [];
    existing.push(alignment);
    alignmentsByOutcome.set(alignment.lessonOutcomeId, existing);
  }

  const serializeAlignment = (alignment: (typeof alignments)[number]) => {
    const node = nodeById.get(alignment.lessonNodeId);
    const capacity = capacityByNode.get(alignment.lessonNodeId);
    const role = alignment.role as OutcomeRole;
    const requiredDepth = alignment.requiredCognitiveDepth as CognitiveDepth;
    const warnings = capacity && isCognitiveDepth(requiredDepth)
      ? getAlignmentWarnings(role, requiredDepth, capacity)
      : ["INVALID_PERSISTED_ALIGNMENT_DEPTH"];

    return {
      id: alignment.id,
      lessonId: alignment.lessonId,
      lessonOutcomeId: alignment.lessonOutcomeId,
      lessonNodeId: alignment.lessonNodeId,
      role,
      requiredCognitiveDepth: requiredDepth,
      createdAt: alignment.createdAt.toISOString(),
      updatedAt: alignment.updatedAt.toISOString(),
      node: node ? {
        id: node.id,
        title: node.title,
        sequence: node.sequence,
        topicId: node.topicId,
        status: node.status,
        cogPathStatus: node.cogPathStatus,
        capacity: capacity ? {
          depth: capacity.depth,
          source: capacity.source,
          isConfirmed: capacity.source === "confirmed_path",
        } : null,
      } : null,
      warnings,
      isDepthWithinCapacity: !!capacity && isCognitiveDepth(requiredDepth)
        && isDepthWithinCapacity(requiredDepth, capacity),
    };
  };

  return {
    lessonId,
    legacyOutcomes: normalizeLegacyOutcomes(lesson.legacyOutcomes),
    goalOutcomeReview: {
      status: getGoalOutcomeReviewStatus(lesson),
      requiresConfirmation: requiresGoalOutcomeConfirmation(lesson),
      confirmedAt: lesson.goalOutcomeConfirmedAt?.toISOString() ?? null,
    },
    canonicalEnabled: outcomes.length > 0,
    outcomes: outcomes.map((outcome) => ({
      id: outcome.id,
      lessonId: outcome.lessonId,
      outcomeText: outcome.outcomeText,
      sequence: outcome.sequence,
      status: outcome.status,
      provenance: outcome.provenance,
      createdAt: outcome.createdAt.toISOString(),
      updatedAt: outcome.updatedAt.toISOString(),
      alignments: (alignmentsByOutcome.get(outcome.id) ?? []).map(serializeAlignment),
    })),
    nodes: nodes.map((node) => {
      const capacity = capacityByNode.get(node.id);
      return {
        id: node.id,
        title: node.title,
        sequence: node.sequence,
        topicId: node.topicId,
        status: node.status,
        cogPathStatus: node.cogPathStatus,
        capacity: capacity ? {
          depth: capacity.depth,
          source: capacity.source,
          isConfirmed: capacity.source === "confirmed_path",
        } : null,
        alignmentCount: alignments.filter((alignment) => alignment.lessonNodeId === node.id).length,
      };
    }),
  };
}

// ── Package 1B / C1 MicroNode Teaching Package helpers ────────────────────────
// Teaching Package rows are authoring data only. They intentionally do not
// participate in current AI Teacher delivery, lesson approval, learner evidence,
// or the existing exercise/task selection pipeline.
function normalizeKnowledgeBoundaries(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseOptionalPositiveInt(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  return parsePositiveInt(value) ?? "invalid";
}

async function getTeachingPackageBundle(lessonId: number) {
  const [lessonRows, nodes, itemRows] = await Promise.all([
    db.select({
      id: lessonsTable.id,
      knowledgeBoundaries: lessonsTable.knowledgeBoundaries,
    }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1),
    db.select({
      id: lessonNodesTable.id,
      sequence: lessonNodesTable.sequence,
      title: lessonNodesTable.title,
      learningObjective: lessonNodesTable.learningObjective,
      status: lessonNodesTable.status,
    }).from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId))
      .orderBy(asc(lessonNodesTable.sequence)),
    db.select({
      id: lessonNodeTeachingPackageItemsTable.id,
      lessonNodeId: lessonNodeTeachingPackageItemsTable.lessonNodeId,
      itemType: lessonNodeTeachingPackageItemsTable.itemType,
      content: lessonNodeTeachingPackageItemsTable.content,
      cognitiveLevel: lessonNodeTeachingPackageItemsTable.cognitiveLevel,
      status: lessonNodeTeachingPackageItemsTable.status,
      provenance: lessonNodeTeachingPackageItemsTable.provenance,
      isPrimary: lessonNodeTeachingPackageItemsTable.isPrimary,
      resourceId: lessonNodeTeachingPackageItemsTable.resourceId,
      sequence: lessonNodeTeachingPackageItemsTable.sequence,
      createdAt: lessonNodeTeachingPackageItemsTable.createdAt,
      updatedAt: lessonNodeTeachingPackageItemsTable.updatedAt,
      resourceTitle: resourcesTable.title,
      resourceUrl: resourcesTable.fileUrl,
    }).from(lessonNodeTeachingPackageItemsTable)
      .leftJoin(resourcesTable, eq(resourcesTable.id, lessonNodeTeachingPackageItemsTable.resourceId))
      .where(eq(lessonNodeTeachingPackageItemsTable.lessonId, lessonId))
      .orderBy(
        asc(lessonNodeTeachingPackageItemsTable.lessonNodeId),
        asc(lessonNodeTeachingPackageItemsTable.itemType),
        asc(lessonNodeTeachingPackageItemsTable.sequence),
      ),
  ]);
  const lesson = lessonRows[0];
  if (!lesson) return null;
  const itemsByNode = new Map<number, typeof itemRows>();
  for (const item of itemRows) {
    const existing = itemsByNode.get(item.lessonNodeId) ?? [];
    existing.push(item);
    itemsByNode.set(item.lessonNodeId, existing);
  }
  const knowledgeBoundaries = normalizeKnowledgeBoundaries(lesson.knowledgeBoundaries);
  return {
    lessonId,
    // Existing mapping stores boundaries at lesson scope. They are deliberately
    // visible beside every MicroNode review rather than copied or replaced.
    knowledgeBoundaries,
    nodes: nodes.map((node) => ({
      ...node,
      knowledgeBoundaries,
      items: (itemsByNode.get(node.id) ?? []).map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        resource: item.resourceId && item.resourceTitle
          ? { id: item.resourceId, title: item.resourceTitle, fileUrl: item.resourceUrl }
          : null,
      })),
    })),
  };
}

async function getTeachingPackageNode(lessonId: number, nodeId: number) {
  const [node] = await db.select({
    id: lessonNodesTable.id,
    lessonId: lessonNodesTable.lessonId,
  }).from(lessonNodesTable)
    .where(and(eq(lessonNodesTable.id, nodeId), eq(lessonNodesTable.lessonId, lessonId)))
    .limit(1);
  return node ?? null;
}

async function isApplicableTeachingPackageCognitiveLevel(
  lessonNodeId: number,
  cognitiveLevel: string | null,
): Promise<boolean> {
  if (!cognitiveLevel) return true;
  const [row] = await db.select({ id: lessonNodeCognitiveLevelsTable.id })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(
      eq(lessonNodeCognitiveLevelsTable.lessonNodeId, lessonNodeId),
      eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, cognitiveLevel),
      eq(lessonNodeCognitiveLevelsTable.isApplicable, true),
    ))
    .limit(1);
  return !!row;
}

async function resourceBelongsToLessonCourse(lessonId: number, resourceId: number): Promise<boolean> {
  const [row] = await db.select({
    lessonCourseId: lessonsTable.courseId,
    resourceCourseId: resourcesTable.courseId,
  }).from(lessonsTable)
    .innerJoin(resourcesTable, eq(resourcesTable.id, resourceId))
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);
  return !!row && row.lessonCourseId !== null && row.lessonCourseId === row.resourceCourseId;
}

// ── Phase 2A R3 helper ────────────────────────────────────────────────────────
// When a CONFIRMED cognitive path is edited or deleted, de-confirm it and mark
// existing teaching content as stale (so teacher knows to regenerate).
async function invalidateCogPathConfirmation(nodeId: number): Promise<void> {
  const [row] = await db
    .select({ cogPathStatus: lessonNodesTable.cogPathStatus, hasTc: lessonNodesTable.childFriendlyExplanation })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, nodeId))
    .limit(1);
  if (!row || row.cogPathStatus !== "confirmed") return;
  const updates: Record<string, unknown> = { cogPathStatus: "needs_review" };
  if (row.hasTc !== null) updates.teachingContentStale = true;
  await db.update(lessonNodesTable).set(updates).where(eq(lessonNodesTable.id, nodeId));
}

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

router.post("/lessons/:lessonId/delete", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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

  // Resolve active cognitive level name for test/debug exposure
  let _activeCognitiveLevel: string | null = null;
  if (session && (session as any).activeCognitiveLevelId) {
    const [cogRow] = await db
      .select({ cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel })
      .from(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.id, (session as any).activeCognitiveLevelId))
      .limit(1);
    _activeCognitiveLevel = cogRow?.cognitiveLevel ?? null;
  }

  res.json({
    id: lesson.id,
    subjectId: lesson.subjectId,
    subjectName: subject?.name ?? "",
    title: lesson.title,
    description: lesson.description,
    bloomLevel: lesson.bloomLevel,
    content: lesson.content ?? null,
    // P1.7: Expose authoring status — values: "draft","needs_review","approved" (+ assignment values)
    authoringStatus: lesson.status ?? "draft",
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
          // V2-R4A.3: required-session completion state
          requiredSessionCompletedAt: (session as any).requiredSessionCompletedAt?.toISOString() ?? null,
          optionalContinuation: (session as any).optionalContinuation ?? false,
          // V2-R4A.4: time fields for student countdown
          requiredSessionMinutes:  (session as any).requiredSessionMinutes  ?? null,
          activeLearningSeconds:   (session as any).activeLearningSeconds   ?? 0,
          // Test/debug: teaching runtime state
          nodeTeachingStage:       (session as any).nodeTeachingStage       ?? null,
          activeCognitiveLevelId:  (session as any).activeCognitiveLevelId  ?? null,
          activeCognitiveLevel:    _activeCognitiveLevel,
          activeLessonExerciseId:  (session as any).activeLessonExerciseId  ?? null,
        }
      : null,
  });
});

// Start or resume a lesson session
// ── GET /api/lessons/:lessonId/student-package ───────────────────────────────
// Student-facing read-only bundle. Requires lesson.status === "active" for
// students; teachers bypass the gate to preview the student view.
// Returns: lesson meta, topics, APPROVED nodes (with Phase 2 fields), APPROVED
// exercises, SEQUENTIAL dependencies, linked quizzes with per-student release
// state from quiz_assignments. READ ONLY — no AI, no writes.
router.get("/lessons/:lessonId/student-package", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const userId    = req.userId!;
  const isTeacher = req.userRole === "teacher" || req.userRole === "admin";

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  // Authorization: students may only access active lessons; teachers preview any.
  if (!isTeacher && lesson.status !== "active") {
    res.status(403).json({ error: "LESSON_NOT_ACTIVE" }); return;
  }

  const [subject] = await db
    .select({ name: subjectsTable.name })
    .from(subjectsTable)
    .where(eq(subjectsTable.id, lesson.subjectId))
    .limit(1);

  // Parallel fetch — all reads, no writes.
  const [topics, nodes, exercises, deps, linkedQuizRows, myAssignments] = await Promise.all([
    db.select()
      .from(lessonTopicsTable)
      .where(eq(lessonTopicsTable.lessonId, lessonId))
      .orderBy(asc(lessonTopicsTable.sequence)),

    db.select()
      .from(lessonNodesTable)
      .where(and(eq(lessonNodesTable.lessonId, lessonId), eq(lessonNodesTable.status, "approved")))
      .orderBy(asc(lessonNodesTable.sequence)),

    db.select()
      .from(lessonExercisesTable)
      .where(and(eq(lessonExercisesTable.lessonId, lessonId), eq(lessonExercisesTable.status, "approved")))
      .orderBy(asc(lessonExercisesTable.sequence)),

    db.select()
      .from(lessonNodeDependenciesTable)
      .where(eq(lessonNodeDependenciesTable.lessonId, lessonId)),

    db.select({
      quizId:   quizzesTable.id,
      title:    quizzesTable.title,
      quizType: quizzesTable.quizType,
      classId:  quizzesTable.classId,
      status:   quizzesTable.status,
    })
      .from(quizLessonLinksTable)
      .innerJoin(quizzesTable, eq(quizzesTable.id, quizLessonLinksTable.quizId))
      .where(eq(quizLessonLinksTable.lessonId, lessonId))
      .orderBy(desc(quizzesTable.createdAt)),

    // All assignment rows for this student — we derive latest status per quiz below.
    db.select({
      quizId:     quizAssignmentsTable.quizId,
      status:     quizAssignmentsTable.status,
      assignedAt: quizAssignmentsTable.assignedAt,
    })
      .from(quizAssignmentsTable)
      .where(eq(quizAssignmentsTable.studentId, userId))
      .orderBy(desc(quizAssignmentsTable.assignedAt)),
  ]);

  // Build a map: quizId → latest assignment (most recent assignedAt, already ordered DESC)
  // Used to compute isReleased and isCompleted per quiz.
  const latestAssignmentPerQuiz = new Map<number, { status: string }>();
  for (const a of myAssignments) {
    if (!latestAssignmentPerQuiz.has(a.quizId)) {
      // First occurrence is the latest (ordered DESC)
      latestAssignmentPerQuiz.set(a.quizId, { status: a.status });
    }
  }

  res.json({
    lesson: {
      id:          lesson.id,
      title:       lesson.title,
      description: lesson.description ?? null,
      status:      lesson.status,
      subjectId:   lesson.subjectId,
      subjectName: subject?.name ?? "",
    },
    topics: topics.map((t) => ({
      id:       t.id,
      sequence: t.sequence,
      title:    t.title,
    })),
    nodes: nodes.map((n) => ({
      id:                       n.id,
      topicId:                  n.topicId ?? null,
      sequence:                 n.sequence,
      title:                    n.title,
      learningObjective:        n.learningObjective ?? null,
      theoryContent:            n.theoryContent ?? null,
      childFriendlyExplanation: n.childFriendlyExplanation ?? null,
      commonMisconception:      n.commonMisconception ?? null,
      basicExamples:            Array.isArray(n.basicExamples) ? n.basicExamples : [],
      nonExamples:              Array.isArray(n.nonExamples) ? n.nonExamples : [],
      realLifeExamples:         Array.isArray((n as any).realLifeExamples) ? (n as any).realLifeExamples : [],
    })),
    exercises: exercises.flatMap((e) => {
      const learnerContent = resolveLearnerExerciseContent(e);
      if (!isLearnerDeliveryEligible(learnerContent)) {
        logger.warn({
          lessonId,
          exerciseId: e.id,
          issueCodes: learnerContent.ok ? learnerContent.reviewWarnings : learnerContent.issues.map((issue) => issue.code),
        }, "student-package: omitted learner-ineligible exercise");
        return [];
      }
      return [{
        id:                    e.id,
        relatedNodeId:         e.relatedNodeId ?? null,
        sequence:              e.sequence,
        sourcePage:            e.sourcePage ?? null,
        exerciseText:          learnerContent.learnerText,
        effectiveExerciseText: learnerContent.learnerText,
        difficultyLevel:       e.difficultyLevel ?? null,
        assignment:            e.assignment ?? null,
      }];
    }),
    dependencies: deps.map((d) => ({
      fromNodeId:     d.fromNodeId,
      toNodeId:       d.toNodeId,
      dependencyType: (d as any).dependencyType ?? "SEQUENTIAL",
    })),
    quizzes: linkedQuizRows.map((q) => {
      const latest = latestAssignmentPerQuiz.get(q.quizId);
      return {
        id:          q.quizId,
        title:       q.title,
        quizType:    q.quizType ?? null,
        classId:     q.classId ?? null,
        isReleased:  latest !== undefined,
        isCompleted: latest?.status === "COMPLETED",
      };
    }),
  });
});

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

  // P1.12: Students may only start lessons that have been activated (status="active").
  // Teachers and admins bypass this gate so they can test/preview any lesson.
  if (req.userRole !== "teacher" && req.userRole !== "admin" && lesson.status !== "active") {
    res.status(403).json({ error: "LESSON_NOT_ACTIVE", message: "This lesson is not yet available" });
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

  // V2-R4A: snapshot the lesson's requiredSessionMinutes at creation time.
  // Once the session exists its budget contract is immutable — teacher edits
  // to the lesson default do NOT silently change a running session's budget.
  const [session] = await db
    .insert(lessonSessionsTable)
    .values({
      userId: req.userId!,
      lessonId,
      currentPhase: selectedInitialPhase,
      status: "active",
      currentNodeId: firstNode?.id ?? null,
      nodeStartedAt: firstNode ? now : null,
      requiredSessionMinutes: (lesson as any).requiredSessionMinutes ?? null,
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

// ── POST /lessons/:lessonId/start-fresh ──────────────────────────────────────
// Resets the existing lesson session to a clean initial state for re-learning,
// then clears chat history for this user+lesson. Persistent evidence/mastery
// (evidence_events, knowledge_nodes) are NEVER touched.
// If no session exists, falls through to normal first-session creation.
router.post("/lessons/:lessonId/start-fresh", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  // Resolve first approved MicroNode (same ordering as normal session creation)
  const [firstNode] = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(and(eq(lessonNodesTable.lessonId, lessonId), eq(lessonNodesTable.status, "approved")))
    .orderBy(asc(lessonNodesTable.sequence))
    .limit(1);

  // Fresh/relearn testing starts directly in the Phase 2 MicroNode teaching
  // contract. Normal POST /lessons/start retains its review-phase selection.
  const selectedInitialPhase = 2;
  const now = new Date();

  // Find the existing session for this user+lesson
  const [existing] = await db
    .select({ id: lessonSessionsTable.id })
    .from(lessonSessionsTable)
    .where(and(eq(lessonSessionsTable.lessonId, lessonId), eq(lessonSessionsTable.userId, req.userId!)))
    .limit(1);

  let sessionId: number;

  if (existing) {
    // Atomically reset session + clear chat
    await db.transaction(async (tx) => {
      await tx.update(lessonSessionsTable)
        .set({
          currentPhase:           selectedInitialPhase,
          status:                 "active",
          masteryScore:           null,
          currentNodeId:          firstNode?.id ?? null,
          nodeStartedAt:          firstNode ? now : null,
          startedAt:              now,
          completedAt:            null,
          nodeAttemptCount:       0,
          lastQuestionAsked:      null,
          askedQuestionTemplates: [],
          reviewQuestionCount:    0,
          deepDiveExerciseIndex:  0,
          nodeMasteryEvidenceCount:   0,
          nodeConsecutiveCorrect:     0,
          nodeConsecutiveIncorrect:   0,
          nodeLastEvidenceQuality:    null,
          nodeTeachingStage:          "THEORY",
          phase1ConsecutiveCorrect:   0,
          introConfirmed:             false,
          activeLessonExerciseId:     null,
          activeCognitiveLevelId:     null,
          activeTaskProvenance:       null,
          activeObjectiveTaskPayload: null,
          activeAttemptSequence:      0,
          activeHelpCount:            0,
          activeAssistanceLevel:      "none",
          remediationStep:            0,
          requiredSessionMinutes:     (lesson as any).requiredSessionMinutes ?? null,
          activeLearningSeconds:      0,
          lastActivityAt:             null,
          requiredSessionCompletedAt: null,
          optionalContinuation:       false,
        } as any)
        .where(eq(lessonSessionsTable.id, existing.id));

      await tx.delete(chatMessagesTable)
        .where(and(
          eq(chatMessagesTable.userId, req.userId!),
          eq(chatMessagesTable.lessonId, lessonId),
        ));
    });
    sessionId = existing.id;
    logger.info({ sessionId, lessonId, userId: req.userId!, firstNodeId: firstNode?.id ?? null }, "start-fresh: session reset in place");
  } else {
    // No session yet — create a fresh one (same as /start new-session path)
    const [session] = await db.insert(lessonSessionsTable).values({
      userId: req.userId!,
      lessonId,
      currentPhase: selectedInitialPhase,
      status: "active",
      currentNodeId: firstNode?.id ?? null,
      nodeStartedAt: firstNode ? now : null,
      requiredSessionMinutes: (lesson as any).requiredSessionMinutes ?? null,
    }).returning();
    sessionId = session.id;
    logger.info({ sessionId, lessonId, userId: req.userId!, firstNodeId: firstNode?.id ?? null }, "start-fresh: no existing session, created new");
  }

  res.json({ sessionId, lessonId, currentNodeId: firstNode?.id ?? null, currentPhase: selectedInitialPhase });
});

// ── V2-R4A.3: POST /lessons/:lessonId/session/finish ─────────────────────────
// Learner chose «Ավարտել» after the required session completed.
// Semantics: required session remains completed; optionalContinuation stays false.
// The session is NOT marked "completed" here — the learner's unfinished curriculum
// must remain resumable in a later session.
// Idempotent: safe to call multiple times.
router.post("/lessons/:lessonId/session/finish", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [session] = await db
    .select()
    .from(lessonSessionsTable)
    .where(and(
      eq(lessonSessionsTable.lessonId, lessonId),
      eq(lessonSessionsTable.userId, req.userId!)
    ))
    .limit(1);

  if (!session) { res.status(404).json({ error: "No active session for this lesson" }); return; }

  if (!(session as any).requiredSessionCompletedAt) {
    res.status(400).json({ error: "Required session has not yet completed" });
    return;
  }

  // Nothing to write — optionalContinuation stays false (already the default).
  // Return current state for the frontend to confirm.
  res.json({
    ok:                          true,
    requiredSessionCompleted:    true,
    requiredSessionCompletedAt:  (session as any).requiredSessionCompletedAt?.toISOString() ?? null,
    optionalContinuation:        false,
  });
});

// ── V2-R4A.3: POST /lessons/:lessonId/session/continue ────────────────────────
// Learner chose «Շարունակել կամավոր» after the required session completed.
// Sets optionalContinuation=true so that subsequent chat turns are no longer
// blocked by END_REQUIRED_SESSION.
// Idempotent: safe to call multiple times.
router.post("/lessons/:lessonId/session/continue", requireAuth, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [session] = await db
    .select()
    .from(lessonSessionsTable)
    .where(and(
      eq(lessonSessionsTable.lessonId, lessonId),
      eq(lessonSessionsTable.userId, req.userId!)
    ))
    .limit(1);

  if (!session) { res.status(404).json({ error: "No active session for this lesson" }); return; }

  if (!(session as any).requiredSessionCompletedAt) {
    res.status(400).json({ error: "Required session has not yet completed" });
    return;
  }

  // Idempotent write: set optionalContinuation=true
  await db
    .update(lessonSessionsTable)
    .set({ optionalContinuation: true } as any)
    .where(eq(lessonSessionsTable.id, session.id));

  res.json({
    ok:                          true,
    requiredSessionCompleted:    true,
    requiredSessionCompletedAt:  (session as any).requiredSessionCompletedAt?.toISOString() ?? null,
    optionalContinuation:        true,
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

// ── Package 1A — Canonical Lesson Outcomes (C1 authoring boundary) ───────────

router.get("/lessons/:lessonId/outcomes", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  if (!lessonId) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const bundle = await getCanonicalOutcomeBundle(lessonId);
  if (!bundle) { res.status(404).json({ error: "Lesson not found" }); return; }
  res.json(bundle);
});

// ── Package 1C — Goal/Outcome review gate ─────────────────────────────────────
// These routes are deliberately authoring-only. A proposal is source-aware, but
// it is not canonical until a teacher explicitly applies and confirms it.
router.get("/lessons/:lessonId/goal-outcome-review", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  if (!lessonId) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const [lesson] = await db.select({
    id: lessonsTable.id,
    lessonGoal: lessonsTable.lessonGoal,
    goalOutcomeReviewStatus: lessonsTable.goalOutcomeReviewStatus,
    goalOutcomeProposal: lessonsTable.goalOutcomeProposal,
    goalOutcomeConfirmedAt: lessonsTable.goalOutcomeConfirmedAt,
  }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }
  const status = getGoalOutcomeReviewStatus(lesson);
  res.json({
    lessonId,
    lessonGoal: lesson.lessonGoal ?? "",
    status,
    requiresConfirmation: requiresGoalOutcomeConfirmation(lesson),
    proposal: lesson.goalOutcomeProposal ?? null,
    confirmedAt: lesson.goalOutcomeConfirmedAt?.toISOString() ?? null,
    compatibility: status === "legacy" ? "legacy_mapping_remains_usable" : "canonical_review_active",
  });
});

router.post("/lessons/:lessonId/goal-outcome-review/draft", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const lessonGoal = typeof req.body?.lessonGoal === "string" ? req.body.lessonGoal.trim() : null;
  if (!lessonId || lessonGoal === null) {
    res.status(400).json({ error: "lessonGoal must be a string" }); return;
  }
  const [current] = await db.select({
    goalOutcomeReviewStatus: lessonsTable.goalOutcomeReviewStatus,
  }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!current) { res.status(404).json({ error: "Lesson not found" }); return; }
  const currentStatus = getGoalOutcomeReviewStatus(current);
  const nextStatus: GoalOutcomeReviewStatus = currentStatus === "confirmed" ? "needs_review" : "draft";
  await db.update(lessonsTable).set({
    lessonGoal,
    goalOutcomeReviewStatus: nextStatus,
    goalOutcomeConfirmedAt: null,
    goalOutcomeConfirmedBy: null,
  }).where(eq(lessonsTable.id, lessonId));
  res.json({ lessonId, lessonGoal, status: nextStatus, requiresConfirmation: true });
});

router.post("/lessons/:lessonId/goal-outcome-review/proposal", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  if (!lessonId) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }
  if (!lesson.textbookResourceId || !lesson.pagesFrom || !lesson.pagesTo) {
    res.status(409).json({
      error: "SOURCE_CONTEXT_REQUIRED",
      message: "Աղբյուրային առաջարկի համար դասագրքի ֆայլը և էջերի տիրույթը պետք է սահմանված լինեն։",
    });
    return;
  }
  const [[resource], [subject]] = await Promise.all([
    db.select({ fileUrl: resourcesTable.fileUrl }).from(resourcesTable)
      .where(eq(resourcesTable.id, lesson.textbookResourceId)).limit(1),
    db.select({ name: subjectsTable.name }).from(subjectsTable)
      .where(eq(subjectsTable.id, lesson.subjectId)).limit(1),
  ]);
  if (!resource?.fileUrl) { res.status(409).json({ error: "SOURCE_CONTEXT_REQUIRED" }); return; }

  try {
    const sourceText = await extractPdfPageRange(
      resolveUploadedFilePath(resource.fileUrl), lesson.pagesFrom, lesson.pagesTo,
    );
    if (!sourceText.trim()) { res.status(422).json({ error: "SOURCE_TEXT_UNAVAILABLE" }); return; }
    const existingOutcomes = await db.select({
      outcomeText: lessonOutcomesTable.outcomeText,
    }).from(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId, lessonId))
      .orderBy(asc(lessonOutcomesTable.sequence));
    const response = await openrouter.chat.completions.create({
      model: "deepseek/deepseek-chat-v3-0324",
      max_tokens: 1800,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a curriculum source analyst. Return only JSON with lessonGoal (one Armenian sentence) and outcomes (2-8 Armenian observable learner outcomes). Analyze the provided source; teacher drafts are optional context and never authoritative. Do not create topics, micro-nodes, exercises, or approval decisions.",
        },
        {
          role: "user",
          content: [
            `SUBJECT: ${subject?.name ?? ""}`,
            `LESSON: ${lesson.title}`,
            `PAGES: ${lesson.pagesFrom}-${lesson.pagesTo}`,
            `OPTIONAL TEACHER GOAL DRAFT: ${lesson.lessonGoal ?? "(none)"}`,
            `OPTIONAL EXISTING OUTCOME DRAFTS: ${existingOutcomes.map((row) => row.outcomeText).join(" | ") || "(none)"}`,
            "SOURCE TEXT:",
            sourceText.slice(0, 24000),
          ].join("\n"),
        },
      ],
    });
    const proposal = parseGoalOutcomeProposal(response.choices[0]?.message?.content ?? "");
    if (!proposal) {
      res.status(502).json({ error: "INVALID_GOAL_OUTCOME_PROPOSAL" }); return;
    }
    const storedProposal = { ...proposal, generatedAt: new Date().toISOString(), source: "textbook_pages" };
    await db.update(lessonsTable).set({
      goalOutcomeProposal: storedProposal as any,
      goalOutcomeReviewStatus: "proposed",
      goalOutcomeConfirmedAt: null,
      goalOutcomeConfirmedBy: null,
    }).where(eq(lessonsTable.id, lessonId));
    res.json({ lessonId, status: "proposed", proposal: storedProposal });
  } catch (error) {
    logger.error({ error, lessonId }, "goal/outcome source proposal failed");
    res.status(502).json({ error: "GOAL_OUTCOME_PROPOSAL_FAILED" });
  }
});

router.post("/lessons/:lessonId/goal-outcome-review/apply-proposal", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  if (!lessonId) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const result = await db.transaction(async (tx) => {
    // Serialize imports per lesson, so double clicks and parallel tabs cannot
    // allocate duplicate sequences from the same source proposal.
    await tx.execute(sql`SELECT id FROM lessons WHERE id = ${lessonId} FOR UPDATE`);
    const [lesson] = await tx.select({
      goalOutcomeProposal: lessonsTable.goalOutcomeProposal,
      lessonGoal: lessonsTable.lessonGoal,
      goalOutcomeReviewStatus: lessonsTable.goalOutcomeReviewStatus,
    }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
    const proposal = lesson?.goalOutcomeProposal as { lessonGoal?: unknown; outcomes?: unknown } | null;
    const lessonGoal = typeof proposal?.lessonGoal === "string" ? proposal.lessonGoal.trim() : "";
    const outcomes = Array.isArray(proposal?.outcomes)
      ? [...new Set(proposal.outcomes
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean))]
      : [];
    if (!lesson || !lessonGoal || outcomes.length === 0) throw new Error("NO_VALID_PROPOSAL");
    const existing = await tx.select({
      outcomeText: lessonOutcomesTable.outcomeText,
      sequence: lessonOutcomesTable.sequence,
    }).from(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId, lessonId));
    const existingTexts = new Set(existing.map((row) => row.outcomeText.trim()));
    const proposedTexts = new Set(outcomes);
    const canonicalGoal = lesson.lessonGoal?.trim() ?? "";
    const hasConflictingGoal = canonicalGoal.length > 0 && canonicalGoal !== lessonGoal;
    const hasConflictingOutcome = existing.some((row) => !proposedTexts.has(row.outcomeText.trim()));
    const reviewStatus = getGoalOutcomeReviewStatus(lesson);
    const proposalIsNotCurrent = reviewStatus !== "proposed" && reviewStatus !== "draft";
    const missingFromPreviouslyAppliedDraft = reviewStatus === "draft"
      && outcomes.some((outcome) => !existingTexts.has(outcome));
    if (
      hasConflictingGoal
      || hasConflictingOutcome
      || proposalIsNotCurrent
      || missingFromPreviouslyAppliedDraft
    ) {
      return { conflict: true as const };
    }
    const missing = outcomes.filter((outcome) => !existingTexts.has(outcome));
    if (missing.length) {
      const nextSequence = Math.max(0, ...existing.map((row) => row.sequence)) + 1;
      await tx.insert(lessonOutcomesTable).values(missing.map((outcomeText, index) => ({
        lessonId, outcomeText, sequence: nextSequence + index, status: "draft", provenance: "mapping_import",
      })));
    }
    await tx.update(lessonsTable).set({
      lessonGoal,
      goalOutcomeReviewStatus: "draft",
      goalOutcomeConfirmedAt: null,
      goalOutcomeConfirmedBy: null,
    }).where(eq(lessonsTable.id, lessonId));
    return { conflict: false as const, lessonGoal, createdCount: missing.length, outcomeCount: outcomes.length };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "NO_VALID_PROPOSAL") return null;
    throw error;
  });
  if (!result) { res.status(409).json({ error: "NO_VALID_GOAL_OUTCOME_PROPOSAL" }); return; }
  if (result.conflict) {
    res.status(409).json({
      error: "CANONICAL_DRAFT_CONFLICT",
      message: "Կանոնական սևագիրը արդեն տարբերվում է առաջարկից։ Խմբագրեք այն ձեռքով, որպեսզի ուսուցչի փոփոխությունները չվերագրվեն։",
    });
    return;
  }
  res.json({ lessonId, status: "draft", ...result, requiresConfirmation: true });
});

router.post("/lessons/:lessonId/goal-outcome-review/confirm", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  if (!lessonId) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const confirmed = await db.transaction(async (tx) => {
    const [lesson] = await tx.select({
      lessonGoal: lessonsTable.lessonGoal,
    }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
    const outcomes = await tx.select({ id: lessonOutcomesTable.id })
      .from(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId, lessonId));
    if (!lesson?.lessonGoal?.trim() || outcomes.length === 0) return false;
    await tx.update(lessonOutcomesTable).set({ status: "approved", updatedAt: new Date() })
      .where(eq(lessonOutcomesTable.lessonId, lessonId));
    await tx.update(lessonsTable).set({
      goalOutcomeReviewStatus: "confirmed",
      goalOutcomeConfirmedAt: new Date(),
      goalOutcomeConfirmedBy: req.userId ?? null,
    }).where(eq(lessonsTable.id, lessonId));
    return true;
  });
  if (!confirmed) {
    res.status(422).json({
      error: "GOAL_AND_CANONICAL_OUTCOMES_REQUIRED",
      message: "Հաստատման համար լրացրեք դասի նպատակը և առնվազն մեկ կանոնական վերջնարդյունք։",
    });
    return;
  }
  res.json({ lessonId, status: "confirmed", requiresConfirmation: false });
});

router.post("/lessons/:lessonId/outcomes", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const outcomeText = typeof req.body?.outcomeText === "string" ? req.body.outcomeText.trim() : "";
  const status = req.body?.status;
  if (!lessonId || !outcomeText) {
    res.status(400).json({ error: "outcomeText is required" }); return;
  }
  if (status !== undefined && !(OUTCOME_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: "Invalid outcome status" }); return;
  }
  if (status === "approved") {
    res.status(409).json({ error: "OUTCOME_APPROVAL_REQUIRES_GOAL_OUTCOME_CONFIRMATION" }); return;
  }

  // Serialize sequence allocation per lesson so simultaneous teacher requests
  // cannot both claim max(sequence) + 1.
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM lessons WHERE id = ${lessonId} FOR UPDATE`);
    const [maxRow] = await tx.select({ value: max(lessonOutcomesTable.sequence) })
      .from(lessonOutcomesTable)
      .where(eq(lessonOutcomesTable.lessonId, lessonId));
    const [created] = await tx.insert(lessonOutcomesTable).values({
      lessonId,
      outcomeText,
      sequence: (maxRow?.value ?? 0) + 1,
      status: status ?? "draft",
      provenance: "teacher_authored",
    }).returning();
    return created;
  });
  await markGoalOutcomeReviewStale(lessonId);

  res.status(201).json({
    id: outcome.id,
    lessonId: outcome.lessonId,
    outcomeText: outcome.outcomeText,
    sequence: outcome.sequence,
    status: outcome.status,
    provenance: outcome.provenance,
  });
});

router.post("/lessons/:lessonId/outcomes/:outcomeId/update", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const outcomeId = parsePositiveInt(req.params.outcomeId);
  if (!lessonId || !outcomeId) { res.status(400).json({ error: "Invalid ids" }); return; }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (req.body?.outcomeText !== undefined) {
    if (typeof req.body.outcomeText !== "string" || !req.body.outcomeText.trim()) {
      res.status(400).json({ error: "outcomeText cannot be empty" }); return;
    }
    patch.outcomeText = req.body.outcomeText.trim();
  }
  if (req.body?.status !== undefined) {
    if (!(OUTCOME_STATUSES as readonly string[]).includes(req.body.status)) {
      res.status(400).json({ error: "Invalid outcome status" }); return;
    }
    if (!(TEACHER_EDITABLE_OUTCOME_STATUSES as readonly string[]).includes(req.body.status)) {
      res.status(409).json({ error: "OUTCOME_APPROVAL_REQUIRES_GOAL_OUTCOME_CONFIRMATION" }); return;
    }
    patch.status = req.body.status;
  }
  if (Object.keys(patch).length === 1) { res.status(400).json({ error: "No fields to update" }); return; }

  const [updated] = await db.update(lessonOutcomesTable).set(patch)
    .where(and(eq(lessonOutcomesTable.id, outcomeId), eq(lessonOutcomesTable.lessonId, lessonId)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Outcome not found" }); return; }
  await markGoalOutcomeReviewStale(lessonId);
  res.json(updated);
});

router.post("/lessons/:lessonId/outcomes/:outcomeId/delete", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const outcomeId = parsePositiveInt(req.params.outcomeId);
  if (!lessonId || !outcomeId) { res.status(400).json({ error: "Invalid ids" }); return; }

  const [outcome] = await db.select({ id: lessonOutcomesTable.id })
    .from(lessonOutcomesTable)
    .where(and(eq(lessonOutcomesTable.id, outcomeId), eq(lessonOutcomesTable.lessonId, lessonId)))
    .limit(1);
  if (!outcome) { res.status(404).json({ error: "Outcome not found" }); return; }

  const approvedRelations = await db.select({ nodeId: lessonNodesTable.id, nodeTitle: lessonNodesTable.title })
    .from(lessonOutcomeNodeAlignmentsTable)
    .innerJoin(lessonNodesTable, eq(lessonNodesTable.id, lessonOutcomeNodeAlignmentsTable.lessonNodeId))
    .where(and(
      eq(lessonOutcomeNodeAlignmentsTable.lessonOutcomeId, outcomeId),
      eq(lessonNodesTable.status, "approved"),
    ));
  if (approvedRelations.length > 0 && req.body?.confirmApprovedRelationRemoval !== true) {
    res.status(409).json({
      error: "APPROVED_NODE_ALIGNMENT_CONFIRMATION_REQUIRED",
      message: "Այս վերջնարդյունքը հեռացնելը կապերը կջնջի հաստատված MicroNode-ներից։",
      approvedNodeCount: approvedRelations.length,
      approvedNodes: approvedRelations,
    });
    return;
  }

  await db.delete(lessonOutcomesTable).where(eq(lessonOutcomesTable.id, outcomeId));
  await markGoalOutcomeReviewStale(lessonId);
  res.json({ deleted: true, id: outcomeId, removedAlignmentCount: approvedRelations.length });
});

router.post("/lessons/:lessonId/outcomes/reorder", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const orderedOutcomeIds = req.body?.orderedOutcomeIds;
  if (!lessonId || !Array.isArray(orderedOutcomeIds) || new Set(orderedOutcomeIds).size !== orderedOutcomeIds.length) {
    res.status(400).json({ error: "orderedOutcomeIds must be a duplicate-free array" }); return;
  }
  try {
    const updated = await db.transaction(async (tx) => {
      // Hold the same parent-row lock used by creation/backfill so the supplied
      // full ordering remains authoritative while it is normalized.
      await tx.execute(sql`SELECT id FROM lessons WHERE id = ${lessonId} FOR UPDATE`);
      const existing = await tx.select({
        id: lessonOutcomesTable.id,
        sequence: lessonOutcomesTable.sequence,
      }).from(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId, lessonId));
      if (existing.length !== orderedOutcomeIds.length || orderedOutcomeIds.some((id) => !existing.some((row) => row.id === id))) {
        throw new Error("OUTCOME_ORDER_CHANGED");
      }

      const sequencePlan = buildTemporarySequencePlan(
        existing.map((outcome) => outcome.sequence),
        orderedOutcomeIds,
      );
      // First move every row out of 1…N. This makes an adjacent swap safe with
      // PostgreSQL's immediate unique constraint; only then assign final order.
      for (const step of sequencePlan) {
        await tx.update(lessonOutcomesTable)
          .set({ sequence: step.temporarySequence, updatedAt: new Date() })
          .where(eq(lessonOutcomesTable.id, step.id));
      }
      for (const step of sequencePlan) {
        await tx.update(lessonOutcomesTable)
          .set({ sequence: step.finalSequence, updatedAt: new Date() })
          .where(eq(lessonOutcomesTable.id, step.id));
      }
      return tx.select().from(lessonOutcomesTable)
        .where(eq(lessonOutcomesTable.lessonId, lessonId))
        .orderBy(asc(lessonOutcomesTable.sequence));
    });
    await markGoalOutcomeReviewStale(lessonId);
    res.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "OUTCOME_ORDER_CHANGED") {
      res.status(409).json({ error: "OUTCOME_ORDER_CHANGED", message: "Վերջնարդյունքների ցանկը փոխվել է․ բեռնել և փորձել կրկին։" });
      return;
    }
    throw error;
  }
});

router.post("/lessons/:lessonId/outcomes/backfill-legacy", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  if (!lessonId) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const missing = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM lessons WHERE id = ${lessonId} FOR UPDATE`);
    const [lesson] = await tx.select({
      legacyOutcomes: lessonsTable.lessonOutcomes,
      goalOutcomeReviewStatus: lessonsTable.goalOutcomeReviewStatus,
    }).from(lessonsTable)
      .where(eq(lessonsTable.id, lessonId)).limit(1);
    if (!lesson) throw new Error("LESSON_NOT_FOUND");
    const existing = await tx.select().from(lessonOutcomesTable)
      .where(eq(lessonOutcomesTable.lessonId, lessonId));
    const legacy = normalizeLegacyOutcomes(lesson.legacyOutcomes);
    const existingTexts = new Set(existing.map((outcome) => outcome.outcomeText.trim()));
    const toCreate = legacy.filter((outcome) => !existingTexts.has(outcome));
    if (toCreate.length > 0) {
      const nextSequence = Math.max(0, ...existing.map((outcome) => outcome.sequence)) + 1;
      await tx.insert(lessonOutcomesTable).values(toCreate.map((outcomeText, index) => ({
        lessonId,
        outcomeText,
        sequence: nextSequence + index,
        status: "draft",
        provenance: "legacy_backfill",
      })));
      const status = getGoalOutcomeReviewStatus(lesson);
      if (status === "legacy" || status === "confirmed") {
        await tx.update(lessonsTable).set({
          goalOutcomeReviewStatus: status === "legacy" ? "draft" : "needs_review",
          goalOutcomeConfirmedAt: null,
          goalOutcomeConfirmedBy: null,
        }).where(eq(lessonsTable.id, lessonId));
      }
    }
    return toCreate;
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "LESSON_NOT_FOUND") return null;
    throw error;
  });
  if (missing === null) { res.status(404).json({ error: "Lesson not found" }); return; }
  res.status(201).json({
    createdCount: missing.length,
    note: "Legacy outcomes were copied as draft records; no MicroNode relations were inferred.",
  });
});

router.post("/lessons/:lessonId/outcomes/:outcomeId/alignments", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const outcomeId = parsePositiveInt(req.params.outcomeId);
  const nodeId = parsePositiveInt(req.body?.lessonNodeId);
  const role = req.body?.role;
  const requiredDepth = req.body?.requiredCognitiveDepth;
  if (!lessonId || !outcomeId || !nodeId) { res.status(400).json({ error: "Valid lessonNodeId is required" }); return; }
  if (!OUTCOME_ROLES.includes(role)) { res.status(400).json({ error: "role must be REQUIRED or SUPPORTING" }); return; }
  if (!isCognitiveDepth(requiredDepth)) { res.status(400).json({ error: "Invalid requiredCognitiveDepth" }); return; }

  const [outcomeRows, nodeRows, levels] = await Promise.all([
    db.select({ id: lessonOutcomesTable.id }).from(lessonOutcomesTable)
      .where(and(eq(lessonOutcomesTable.id, outcomeId), eq(lessonOutcomesTable.lessonId, lessonId))).limit(1),
    db.select({
      id: lessonNodesTable.id,
      targetBloomLevel: lessonNodesTable.targetBloomLevel,
      cogPathStatus: lessonNodesTable.cogPathStatus,
    }).from(lessonNodesTable)
      .where(and(eq(lessonNodesTable.id, nodeId), eq(lessonNodesTable.lessonId, lessonId))).limit(1),
    db.select({
      cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel,
      isApplicable: lessonNodeCognitiveLevelsTable.isApplicable,
      isTargetCeiling: lessonNodeCognitiveLevelsTable.isTargetCeiling,
    }).from(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId)),
  ]);
  const outcome = outcomeRows[0];
  const node = nodeRows[0];
  if (!outcome) { res.status(404).json({ error: "Outcome not found in this lesson" }); return; }
  if (!node) { res.status(400).json({ error: "MicroNode must belong to the same lesson" }); return; }

  const capacity = deriveNodeCognitiveCapacity({
    targetBloomLevel: node.targetBloomLevel,
    cogPathStatus: node.cogPathStatus,
    levels,
  });
  if (!isDepthWithinCapacity(requiredDepth, capacity)) {
    res.status(409).json({
      error: "REQUIRED_DEPTH_EXCEEDS_NODE_CAPACITY",
      message: `Requested depth ${requiredDepth} exceeds this MicroNode target ${capacity.depth}.`,
      capacity,
    });
    return;
  }

  const [alignment] = await db.insert(lessonOutcomeNodeAlignmentsTable).values({
    lessonId,
    lessonOutcomeId: outcomeId,
    lessonNodeId: nodeId,
    role,
    requiredCognitiveDepth: requiredDepth,
  }).onConflictDoNothing().returning();
  if (!alignment) { res.status(409).json({ error: "OUTCOME_NODE_ALIGNMENT_ALREADY_EXISTS" }); return; }
  await markGoalOutcomeReviewStale(lessonId);
  res.status(201).json({
    alignment,
    warnings: getAlignmentWarnings(role, requiredDepth, capacity),
  });
});

router.post("/lessons/:lessonId/outcomes/:outcomeId/alignments/:alignmentId/delete", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const outcomeId = parsePositiveInt(req.params.outcomeId);
  const alignmentId = parsePositiveInt(req.params.alignmentId);
  if (!lessonId || !outcomeId || !alignmentId) { res.status(400).json({ error: "Invalid ids" }); return; }
  const [deleted] = await db.delete(lessonOutcomeNodeAlignmentsTable)
    .where(and(
      eq(lessonOutcomeNodeAlignmentsTable.id, alignmentId),
      eq(lessonOutcomeNodeAlignmentsTable.lessonId, lessonId),
      eq(lessonOutcomeNodeAlignmentsTable.lessonOutcomeId, outcomeId),
    ))
    .returning({ id: lessonOutcomeNodeAlignmentsTable.id });
  if (!deleted) { res.status(404).json({ error: "Alignment not found" }); return; }
  await markGoalOutcomeReviewStale(lessonId);
  res.json({ deleted: true, id: alignmentId });
});

router.get("/lessons/:lessonId/outcomes/readiness", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  if (!lessonId) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const bundle = await getCanonicalOutcomeBundle(lessonId);
  if (!bundle) { res.status(404).json({ error: "Lesson not found" }); return; }
  const review = bundle.goalOutcomeReview;
  const errors: Array<{ code: string; message: string; nodeId?: number; outcomeId?: number }> = [];
  const warnings: Array<{ code: string; message: string; nodeId?: number; outcomeId?: number }> = [];
  const info: Array<{ code: string; message: string }> = [];
  if (review.requiresConfirmation) {
    errors.push({
      code: "GOAL_OUTCOME_CONFIRMATION_REQUIRED",
      message: "Նպատակը և վերջնարդյունքները դեռ ուսուցչի հաստատման են սպասում։",
    });
  } else if (review.status === "legacy") {
    warnings.push({
      code: "LEGACY_GOAL_OUTCOME_COMPATIBILITY",
      message: "Այս դասը պահպանում է նախկին քարտեզագրման համատեղելիությունը, մինչև կանոնական վերանայումը սկսելը։",
    });
  }
  if (!bundle.canonicalEnabled) {
    res.json({
      canonicalEnabled: false,
      goalOutcomeReview: review,
      errors,
      warnings,
      info,
      summary: { approvedNodes: 0, outcomes: 0, alignedNodes: 0 },
    });
    return;
  }

  const alignedNodeIds = new Set<number>();
  const hasDetailedMapping = bundle.nodes.length > 0;
  for (const outcome of bundle.outcomes) {
    const required = outcome.alignments.filter((alignment) => alignment.role === "REQUIRED");
    if (hasDetailedMapping && required.length === 0) {
      errors.push({ code: "OUTCOME_WITHOUT_REQUIRED_NODE", outcomeId: outcome.id, message: "Յուրաքանչյուր վերջնարդյունք պետք է ունենա առնվազն մեկ REQUIRED MicroNode։" });
    }
    for (const alignment of outcome.alignments) {
      alignedNodeIds.add(alignment.lessonNodeId);
      if (!alignment.isDepthWithinCapacity) {
        errors.push({ code: "REQUIRED_DEPTH_EXCEEDS_NODE_CAPACITY", outcomeId: outcome.id, nodeId: alignment.lessonNodeId, message: "Պահանջվող ճանաչողական խորությունը գերազանցում է MicroNode-ի թիրախը։" });
      }
      for (const warning of alignment.warnings) {
        const issue = { code: warning, outcomeId: outcome.id, nodeId: alignment.lessonNodeId, message: "MicroNode-ի ճանաչողական ուղին դեռ վերջնականապես հաստատված չէ։" };
        if (warning === "REQUIRED_DEPTH_NEEDS_CONFIRMED_PATH") errors.push(issue);
        else warnings.push(issue);
      }
    }
  }
  for (const node of bundle.nodes.filter((node) => node.status === "approved")) {
    if (!alignedNodeIds.has(node.id)) {
      errors.push({ code: "APPROVED_NODE_WITHOUT_OUTCOME", nodeId: node.id, message: "Հաստատված MicroNode-ը կապված չէ որևէ վերջնարդյունքի հետ։" });
    }
  }
  const [unlinkedExercises, teachingItems] = await Promise.all([
    db.select({ id: lessonExercisesTable.id }).from(lessonExercisesTable)
      .where(and(eq(lessonExercisesTable.lessonId, lessonId), sql`${lessonExercisesTable.relatedNodeId} IS NULL`)),
    db.select({ lessonNodeId: lessonNodeTeachingPackageItemsTable.lessonNodeId })
      .from(lessonNodeTeachingPackageItemsTable)
      .where(eq(lessonNodeTeachingPackageItemsTable.lessonId, lessonId)),
  ]);
  const nodesWithTeachingItems = new Set(teachingItems.map((item) => item.lessonNodeId));
  for (const node of bundle.nodes) {
    if (node.topicId === null) {
      warnings.push({
        code: "MICRONODE_WITHOUT_TOPIC",
        nodeId: node.id,
        message: "MicroNode-ը դեռ թեմայի չի կցված։",
      });
    }
    if (node.status !== "approved") {
      info.push({
        code: "DRAFT_MICRONODE",
        message: `«${node.title}» MicroNode-ը դեռ draft/review վիճակում է։`,
      });
    }
    if (!nodesWithTeachingItems.has(node.id)) {
      warnings.push({
        code: "TEACHING_PACKAGE_ABSENT",
        nodeId: node.id,
        message: `«${node.title}» MicroNode-ի Teaching Package-ը դեռ դատարկ է։`,
      });
    }
  }
  if (unlinkedExercises.length > 0) {
    warnings.push({
      code: "UNLINKED_EXERCISES",
      message: `${unlinkedExercises.length} վարժություն MicroNode-ի չի կցված և պահպանված է որպես lesson-level վարժություն։`,
    });
  }
  if (bundle.nodes.length === 0) {
    info.push({ code: "NO_DETAILED_MAPPING", message: "Մանրամասն քարտեզագրում դեռ չկա։" });
    info.push({
      code: "MICRONODE_ALIGNMENT_DEFERRED",
      message: "MicroNode կապերը կստեղծվեն և կստուգվեն մանրամասն քարտեզագրումից հետո։",
    });
  }
  res.json({
    canonicalEnabled: true,
    goalOutcomeReview: review,
    errors,
    warnings,
    info,
    summary: {
      approvedNodes: bundle.nodes.filter((node) => node.status === "approved").length,
      outcomes: bundle.outcomes.length,
      alignedNodes: alignedNodeIds.size,
    },
  });
});

// ── Package 1B / C1 MicroNode Teaching Package ────────────────────────────────
router.get("/lessons/:lessonId/teaching-package", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  if (!lessonId) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const bundle = await getTeachingPackageBundle(lessonId);
  if (!bundle) { res.status(404).json({ error: "Lesson not found" }); return; }
  res.json(bundle);
});

router.post("/lessons/:lessonId/nodes/:nodeId/teaching-package", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const nodeId = parsePositiveInt(req.params.nodeId);
  const itemType = req.body?.itemType;
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  const status = req.body?.status ?? "draft";
  const provenance = req.body?.provenance ?? "teacher_created";
  const cognitiveLevel = req.body?.cognitiveLevel ?? null;
  const isPrimary = req.body?.isPrimary ?? false;
  const resourceId = parseOptionalPositiveInt(req.body?.resourceId);
  if (!lessonId || !nodeId || !content) { res.status(400).json({ error: "Valid node and non-empty content are required" }); return; }
  if (!isTeachingPackageItemType(itemType)) { res.status(400).json({ error: "Invalid Teaching Package item type" }); return; }
  if (!isTeachingPackageStatus(status)) { res.status(400).json({ error: "Invalid Teaching Package status" }); return; }
  if (!isTeachingPackageProvenance(provenance)) { res.status(400).json({ error: "Invalid Teaching Package provenance" }); return; }
  if (isServerControlledTeachingPackageProvenance(provenance)) {
    res.status(400).json({ error: "AI_APPROVED_PROVENANCE_IS_SERVER_CONTROLLED" }); return;
  }
  if (cognitiveLevel !== null && !isStableCognitiveLevel(cognitiveLevel)) {
    res.status(400).json({ error: "Invalid cognitive level" }); return;
  }
  if (typeof isPrimary !== "boolean" || (isPrimary && itemType !== "MAIN_EXPLANATION")) {
    res.status(400).json({ error: "Only MAIN_EXPLANATION may be primary" }); return;
  }
  if (resourceId === "invalid") { res.status(400).json({ error: "resourceId must be a positive integer or null" }); return; }
  if (requiresExplicitTeachingPackageApproval(provenance, status)) {
    res.status(400).json({ error: "AI-generated material must be explicitly approved" }); return;
  }
  const node = await getTeachingPackageNode(lessonId, nodeId);
  if (!node) { res.status(400).json({ error: "MicroNode must belong to the same lesson" }); return; }
  if (!(await isApplicableTeachingPackageCognitiveLevel(nodeId, cognitiveLevel))) {
    res.status(409).json({ error: "COGNITIVE_LEVEL_NOT_APPLICABLE_TO_NODE" }); return;
  }
  if (resourceId && !(await resourceBelongsToLessonCourse(lessonId, resourceId))) {
    res.status(400).json({ error: "Resource must belong to this lesson's course" }); return;
  }

  try {
    const item = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM lesson_nodes WHERE id = ${nodeId} AND lesson_id = ${lessonId} FOR UPDATE`);
      if (isPrimary && status === "approved") {
        const [existingPrimary] = await tx.select({ id: lessonNodeTeachingPackageItemsTable.id })
          .from(lessonNodeTeachingPackageItemsTable)
          .where(and(
            eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
            eq(lessonNodeTeachingPackageItemsTable.itemType, "MAIN_EXPLANATION"),
            eq(lessonNodeTeachingPackageItemsTable.status, "approved"),
            eq(lessonNodeTeachingPackageItemsTable.isPrimary, true),
          ))
          .limit(1);
        if (existingPrimary) throw new Error("PRIMARY_EXPLANATION_EXISTS");
      }
      const [maxRow] = await tx.select({ value: max(lessonNodeTeachingPackageItemsTable.sequence) })
        .from(lessonNodeTeachingPackageItemsTable)
        .where(and(
          eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
          eq(lessonNodeTeachingPackageItemsTable.itemType, itemType),
        ));
      const [created] = await tx.insert(lessonNodeTeachingPackageItemsTable).values({
        lessonId,
        lessonNodeId: nodeId,
        itemType,
        content,
        cognitiveLevel,
        status,
        provenance,
        isPrimary,
        resourceId,
        sequence: (maxRow?.value ?? 0) + 1,
      }).returning();
      return created;
    });
    res.status(201).json(item);
  } catch (error) {
    if (error instanceof Error && error.message === "PRIMARY_EXPLANATION_EXISTS") {
      res.status(409).json({ error: "PRIMARY_APPROVED_MAIN_EXPLANATION_EXISTS", message: "Այս MicroNode-ի համար արդեն կա առաջնային հաստատված բացատրություն։" });
      return;
    }
    throw error;
  }
});

router.post("/lessons/:lessonId/nodes/:nodeId/teaching-package/:itemId/update", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const nodeId = parsePositiveInt(req.params.nodeId);
  const itemId = parsePositiveInt(req.params.itemId);
  if (!lessonId || !nodeId || !itemId) { res.status(400).json({ error: "Invalid ids" }); return; }
  const node = await getTeachingPackageNode(lessonId, nodeId);
  if (!node) { res.status(400).json({ error: "MicroNode must belong to the same lesson" }); return; }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (req.body?.content !== undefined) {
    if (typeof req.body.content !== "string" || !req.body.content.trim()) {
      res.status(400).json({ error: "content cannot be empty" }); return;
    }
    patch.content = req.body.content.trim();
  }
  if (req.body?.cognitiveLevel !== undefined) {
    const cognitiveLevel = req.body.cognitiveLevel === null || req.body.cognitiveLevel === "" ? null : req.body.cognitiveLevel;
    if (cognitiveLevel !== null && !isStableCognitiveLevel(cognitiveLevel)) {
      res.status(400).json({ error: "Invalid cognitive level" }); return;
    }
    if (!(await isApplicableTeachingPackageCognitiveLevel(nodeId, cognitiveLevel))) {
      res.status(409).json({ error: "COGNITIVE_LEVEL_NOT_APPLICABLE_TO_NODE" }); return;
    }
    patch.cognitiveLevel = cognitiveLevel;
  }
  if (req.body?.status !== undefined) {
    if (!isTeachingPackageStatus(req.body.status)) { res.status(400).json({ error: "Invalid Teaching Package status" }); return; }
    if (req.body.status === "approved") {
      res.status(400).json({ error: "Use the explicit approve action" }); return;
    }
    patch.status = req.body.status;
  }
  if (req.body?.isPrimary !== undefined) {
    if (typeof req.body.isPrimary !== "boolean") { res.status(400).json({ error: "isPrimary must be boolean" }); return; }
    patch.isPrimary = req.body.isPrimary;
  }
  if (req.body?.resourceId !== undefined) {
    const resourceId = parseOptionalPositiveInt(req.body.resourceId);
    if (resourceId === "invalid") { res.status(400).json({ error: "resourceId must be a positive integer or null" }); return; }
    if (resourceId && !(await resourceBelongsToLessonCourse(lessonId, resourceId))) {
      res.status(400).json({ error: "Resource must belong to this lesson's course" }); return;
    }
    patch.resourceId = resourceId;
  }
  if (Object.keys(patch).length === 1) { res.status(400).json({ error: "No fields to update" }); return; }

  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM lesson_nodes WHERE id = ${nodeId} AND lesson_id = ${lessonId} FOR UPDATE`);
      const [item] = await tx.select().from(lessonNodeTeachingPackageItemsTable)
        .where(and(
          eq(lessonNodeTeachingPackageItemsTable.id, itemId),
          eq(lessonNodeTeachingPackageItemsTable.lessonId, lessonId),
          eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
        ))
        .limit(1);
      if (!item) throw new Error("TEACHING_ITEM_NOT_FOUND");
      const nextPrimary = patch.isPrimary === undefined ? item.isPrimary : patch.isPrimary === true;
      const nextStatus = typeof patch.status === "string" ? patch.status : item.status;
      if (nextPrimary && item.itemType !== "MAIN_EXPLANATION") throw new Error("PRIMARY_TYPE_INVALID");
      if (nextPrimary && nextStatus === "approved") {
        const [existingPrimary] = await tx.select({ id: lessonNodeTeachingPackageItemsTable.id })
          .from(lessonNodeTeachingPackageItemsTable)
          .where(and(
            eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
            eq(lessonNodeTeachingPackageItemsTable.itemType, "MAIN_EXPLANATION"),
            eq(lessonNodeTeachingPackageItemsTable.status, "approved"),
            eq(lessonNodeTeachingPackageItemsTable.isPrimary, true),
            ne(lessonNodeTeachingPackageItemsTable.id, itemId),
          ))
          .limit(1);
        if (existingPrimary) throw new Error("PRIMARY_EXPLANATION_EXISTS");
      }
      const [result] = await tx.update(lessonNodeTeachingPackageItemsTable).set(patch)
        .where(eq(lessonNodeTeachingPackageItemsTable.id, itemId)).returning();
      return result;
    });
    res.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "TEACHING_ITEM_NOT_FOUND") {
      res.status(404).json({ error: "Teaching Package item not found" }); return;
    }
    if (error instanceof Error && error.message === "PRIMARY_TYPE_INVALID") {
      res.status(400).json({ error: "Only MAIN_EXPLANATION may be primary" }); return;
    }
    if (error instanceof Error && error.message === "PRIMARY_EXPLANATION_EXISTS") {
      res.status(409).json({ error: "PRIMARY_APPROVED_MAIN_EXPLANATION_EXISTS" }); return;
    }
    throw error;
  }
});

router.post("/lessons/:lessonId/nodes/:nodeId/teaching-package/:itemId/approve", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const nodeId = parsePositiveInt(req.params.nodeId);
  const itemId = parsePositiveInt(req.params.itemId);
  const makePrimary = req.body?.makePrimary;
  if (!lessonId || !nodeId || !itemId) { res.status(400).json({ error: "Invalid ids" }); return; }
  if (makePrimary !== undefined && typeof makePrimary !== "boolean") {
    res.status(400).json({ error: "makePrimary must be boolean" }); return;
  }
  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM lesson_nodes WHERE id = ${nodeId} AND lesson_id = ${lessonId} FOR UPDATE`);
      const [item] = await tx.select().from(lessonNodeTeachingPackageItemsTable)
        .where(and(
          eq(lessonNodeTeachingPackageItemsTable.id, itemId),
          eq(lessonNodeTeachingPackageItemsTable.lessonId, lessonId),
          eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
        ))
        .limit(1);
      if (!item) throw new Error("TEACHING_ITEM_NOT_FOUND");
      const nextPrimary = makePrimary === undefined ? item.isPrimary : makePrimary;
      if (nextPrimary && item.itemType !== "MAIN_EXPLANATION") throw new Error("PRIMARY_TYPE_INVALID");
      if (nextPrimary) {
        const [existingPrimary] = await tx.select({ id: lessonNodeTeachingPackageItemsTable.id })
          .from(lessonNodeTeachingPackageItemsTable)
          .where(and(
            eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
            eq(lessonNodeTeachingPackageItemsTable.itemType, "MAIN_EXPLANATION"),
            eq(lessonNodeTeachingPackageItemsTable.status, "approved"),
            eq(lessonNodeTeachingPackageItemsTable.isPrimary, true),
            ne(lessonNodeTeachingPackageItemsTable.id, itemId),
          ))
          .limit(1);
        if (existingPrimary) throw new Error("PRIMARY_EXPLANATION_EXISTS");
      }
      const [result] = await tx.update(lessonNodeTeachingPackageItemsTable).set({
        status: "approved",
        isPrimary: nextPrimary,
        provenance: provenanceAfterExplicitTeachingPackageApproval(item.provenance as TeachingPackageProvenance),
        updatedAt: new Date(),
      }).where(eq(lessonNodeTeachingPackageItemsTable.id, itemId)).returning();
      return result;
    });
    res.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "TEACHING_ITEM_NOT_FOUND") {
      res.status(404).json({ error: "Teaching Package item not found" }); return;
    }
    if (error instanceof Error && error.message === "PRIMARY_TYPE_INVALID") {
      res.status(400).json({ error: "Only MAIN_EXPLANATION may be primary" }); return;
    }
    if (error instanceof Error && error.message === "PRIMARY_EXPLANATION_EXISTS") {
      res.status(409).json({ error: "PRIMARY_APPROVED_MAIN_EXPLANATION_EXISTS" }); return;
    }
    throw error;
  }
});

router.post("/lessons/:lessonId/nodes/:nodeId/teaching-package/:itemId/delete", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const nodeId = parsePositiveInt(req.params.nodeId);
  const itemId = parsePositiveInt(req.params.itemId);
  if (!lessonId || !nodeId || !itemId) { res.status(400).json({ error: "Invalid ids" }); return; }
  const [deleted] = await db.delete(lessonNodeTeachingPackageItemsTable)
    .where(and(
      eq(lessonNodeTeachingPackageItemsTable.id, itemId),
      eq(lessonNodeTeachingPackageItemsTable.lessonId, lessonId),
      eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
    ))
    .returning({ id: lessonNodeTeachingPackageItemsTable.id });
  if (!deleted) { res.status(404).json({ error: "Teaching Package item not found" }); return; }
  res.json({ deleted: true, id: itemId });
});

router.post("/lessons/:lessonId/nodes/:nodeId/teaching-package/reorder", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  const nodeId = parsePositiveInt(req.params.nodeId);
  const itemType = req.body?.itemType;
  const orderedItemIds = req.body?.orderedItemIds;
  if (!lessonId || !nodeId || !isTeachingPackageItemType(itemType)
    || !Array.isArray(orderedItemIds)
    || !orderedItemIds.every((id) => Number.isInteger(id))
    || new Set(orderedItemIds).size !== orderedItemIds.length) {
    res.status(400).json({ error: "itemType and a duplicate-free integer orderedItemIds array are required" }); return;
  }
  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM lesson_nodes WHERE id = ${nodeId} AND lesson_id = ${lessonId} FOR UPDATE`);
      const existing = await tx.select({
        id: lessonNodeTeachingPackageItemsTable.id,
        sequence: lessonNodeTeachingPackageItemsTable.sequence,
      }).from(lessonNodeTeachingPackageItemsTable)
        .where(and(
          eq(lessonNodeTeachingPackageItemsTable.lessonId, lessonId),
          eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
          eq(lessonNodeTeachingPackageItemsTable.itemType, itemType),
        ));
      if (existing.length !== orderedItemIds.length || orderedItemIds.some((id) => !existing.some((item) => item.id === id))) {
        throw new Error("TEACHING_ITEM_ORDER_CHANGED");
      }
      const sequencePlan = buildTemporarySequencePlan(existing.map((item) => item.sequence), orderedItemIds);
      for (const step of sequencePlan) {
        await tx.update(lessonNodeTeachingPackageItemsTable).set({
          sequence: step.temporarySequence,
          updatedAt: new Date(),
        }).where(eq(lessonNodeTeachingPackageItemsTable.id, step.id));
      }
      for (const step of sequencePlan) {
        await tx.update(lessonNodeTeachingPackageItemsTable).set({
          sequence: step.finalSequence,
          updatedAt: new Date(),
        }).where(eq(lessonNodeTeachingPackageItemsTable.id, step.id));
      }
      return tx.select().from(lessonNodeTeachingPackageItemsTable)
        .where(and(
          eq(lessonNodeTeachingPackageItemsTable.lessonId, lessonId),
          eq(lessonNodeTeachingPackageItemsTable.lessonNodeId, nodeId),
          eq(lessonNodeTeachingPackageItemsTable.itemType, itemType),
        ))
        .orderBy(asc(lessonNodeTeachingPackageItemsTable.sequence));
    });
    res.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "TEACHING_ITEM_ORDER_CHANGED") {
      res.status(409).json({ error: "TEACHING_ITEM_ORDER_CHANGED", message: "Նյութերի ցանկը փոխվել է․ բեռնել և փորձել կրկին։" }); return;
    }
    throw error;
  }
});

router.post("/lessons/:lessonId/teaching-package/backfill-existing", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parsePositiveInt(req.params.lessonId);
  if (!lessonId) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM lessons WHERE id = ${lessonId} FOR UPDATE`);
    const nodes = await tx.select({
      id: lessonNodesTable.id,
      theoryContent: lessonNodesTable.theoryContent,
      childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
      basicExamples: lessonNodesTable.basicExamples,
      realLifeExamples: lessonNodesTable.realLifeExamples,
      commonMisconception: lessonNodesTable.commonMisconception,
      nonExamples: lessonNodesTable.nonExamples,
      contentSourceType: lessonNodesTable.contentSourceType,
      createdBy: lessonNodesTable.createdBy,
    }).from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId));
    const existing = await tx.select({
      lessonNodeId: lessonNodeTeachingPackageItemsTable.lessonNodeId,
      itemType: lessonNodeTeachingPackageItemsTable.itemType,
      sourceItemKey: lessonNodeTeachingPackageItemsTable.sourceItemKey,
      sequence: lessonNodeTeachingPackageItemsTable.sequence,
    }).from(lessonNodeTeachingPackageItemsTable)
      .where(eq(lessonNodeTeachingPackageItemsTable.lessonId, lessonId));
    const existingKeys = new Set(existing
      .filter((item): item is typeof item & { sourceItemKey: string } => !!item.sourceItemKey)
      .map((item) => `${item.lessonNodeId}:${item.sourceItemKey}`));
    const nextSequence = new Map<string, number>();
    for (const item of existing) {
      const key = `${item.lessonNodeId}:${item.itemType}`;
      nextSequence.set(key, Math.max(nextSequence.get(key) ?? 0, item.sequence));
    }
    const toInsert: Array<{
      lessonId: number; lessonNodeId: number; itemType: TeachingPackageItemType;
      content: string; sourceItemKey: string; provenance: TeachingPackageProvenance; sequence: number;
    }> = [];
    for (const node of nodes) {
      for (const candidate of getDeterministicTeachingPackageSeedCandidates(node)) {
        if (existingKeys.has(`${node.id}:${candidate.sourceItemKey}`)) continue;
        const orderKey = `${node.id}:${candidate.itemType}`;
        const sequence = (nextSequence.get(orderKey) ?? 0) + 1;
        nextSequence.set(orderKey, sequence);
        toInsert.push({
          lessonId,
          lessonNodeId: node.id,
          itemType: candidate.itemType,
          content: candidate.content,
          sourceItemKey: candidate.sourceItemKey,
          provenance: candidate.provenance,
          sequence,
        });
      }
    }
    if (toInsert.length > 0) {
      await tx.insert(lessonNodeTeachingPackageItemsTable).values(toInsert);
    }
    return { createdCount: toInsert.length, scannedNodeCount: nodes.length };
  });
  res.status(201).json({
    ...result,
    note: "Only deterministic existing fields were copied as draft Teaching Package items; original MicroNode fields remain unchanged.",
  });
});

// GET /lessons/:lessonId/nodes — list all nodes for this lesson, ordered by sequence
router.get("/lessons/:lessonId/nodes", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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
      learningObjective: n.learningObjective ?? null,
      theoryContent: n.theoryContent ?? null,
      targetBloomLevel: n.targetBloomLevel ?? null,
      estimatedMinutes: n.estimatedMinutes ?? null,
      verbatimTheoryAnchor: n.verbatimTheoryAnchor ?? null,
      commonMisconception: n.commonMisconception ?? null,
      childFriendlyExplanation: n.childFriendlyExplanation ?? null,
      basicExamples: Array.isArray(n.basicExamples) ? n.basicExamples : [],
      nonExamples: Array.isArray(n.nonExamples) ? n.nonExamples : [],
      realLifeExamples: Array.isArray(n.realLifeExamples) ? n.realLifeExamples : [],
      // Authoring provenance fields — used by teacher dashboard for badging
      status: n.status ?? "draft",
      contentSourceType: n.contentSourceType ?? "textbook",
      createdBy: n.createdBy ?? "ai",
      sourcePage: n.sourcePage ?? null,
      cogPathStatus: (n as any).cogPathStatus ?? null,
      teachingContentStale: !!((n as any).teachingContentStale),
    }))
  );
});

// POST /lessons/:lessonId/nodes — create a new node (sequence auto-assigned)
router.post("/lessons/:lessonId/nodes", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson id" });
    return;
  }

  const { title, theoryContent, targetBloomLevel, estimatedMinutes, topicId, learningObjective } = req.body as {
    title?: string;
    theoryContent?: string;
    targetBloomLevel?: number;
    estimatedMinutes?: number;
    topicId?: number | null;
    learningObjective?: string;
  };

  if (!title?.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  // Atomic: insert + SEQUENTIAL rebuild in one transaction so the graph is
  // never left stale after a new node is appended.
  const node = await db.transaction(async (tx) => {
    const [maxRow] = await tx
      .select({ maxSeq: max(lessonNodesTable.sequence) })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.lessonId, lessonId));

    const nextSeq = (maxRow?.maxSeq ?? 0) + 1;

    const [inserted] = await tx
      .insert(lessonNodesTable)
      .values({
        lessonId,
        sequence: nextSeq,
        title: title.trim(),
        theoryContent: theoryContent?.trim() ?? null,
        targetBloomLevel: targetBloomLevel ?? 1,
        estimatedMinutes: estimatedMinutes ?? 5,
        topicId: topicId ?? null,
        learningObjective: learningObjective?.trim() ?? null,
        createdBy: "teacher",
      })
      .returning();

    await refreshSequentialDependencies(lessonId, tx as unknown as typeof db);
    return inserted;
  });

  await invalidateLessonApproval(lessonId);
  res.status(201).json({
    id: node.id,
    lessonId: node.lessonId,
    sequence: node.sequence,
    topicId: node.topicId ?? null,
    title: node.title,
    learningObjective: node.learningObjective ?? null,
    theoryContent: node.theoryContent ?? null,
    targetBloomLevel: node.targetBloomLevel ?? null,
    estimatedMinutes: node.estimatedMinutes ?? null,
  });
});

// POST /lessons/:lessonId/nodes/:nodeId/update — partial update
router.post("/lessons/:lessonId/nodes/:nodeId/update", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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

  const { title, theoryContent, targetBloomLevel, estimatedMinutes, verbatimTheoryAnchor, commonMisconception, childFriendlyExplanation, basicExamples, nonExamples, realLifeExamples, learningObjective, status, topicId } = req.body as {
    title?: string;
    theoryContent?: string;
    targetBloomLevel?: number;
    estimatedMinutes?: number;
    verbatimTheoryAnchor?: string;
    commonMisconception?: string;
    childFriendlyExplanation?: string;
    basicExamples?: string[];
    nonExamples?: string[];
    realLifeExamples?: string[];
    learningObjective?: string;
    status?: "approved" | "needs_review" | "draft";
    topicId?: number | null;
  };

  // Use Record<string, unknown> so drizzle's set() receives a plain object
  // (Partial<typeof existing> carries drizzle's inferred select type which
  //  is not directly assignable to drizzle's UpdateSet, causing "No values to set"
  //  when only the status field is being changed).
  const patch: Record<string, unknown> = {};
  if (title !== undefined) patch.title = title.trim();
  if (theoryContent !== undefined) patch.theoryContent = theoryContent.trim() || null;
  if (targetBloomLevel !== undefined) patch.targetBloomLevel = targetBloomLevel;
  if (estimatedMinutes !== undefined) patch.estimatedMinutes = estimatedMinutes;
  if (verbatimTheoryAnchor !== undefined) patch.verbatimTheoryAnchor = verbatimTheoryAnchor.trim() || null;
  if (commonMisconception !== undefined) patch.commonMisconception = commonMisconception.trim() || null;
  if (childFriendlyExplanation !== undefined) patch.childFriendlyExplanation = childFriendlyExplanation.trim() || null;
  if (basicExamples !== undefined) patch.basicExamples = Array.isArray(basicExamples) ? basicExamples : [];
  if (nonExamples !== undefined) patch.nonExamples = Array.isArray(nonExamples) ? nonExamples : [];
  if (realLifeExamples !== undefined) patch.realLifeExamples = Array.isArray(realLifeExamples) ? realLifeExamples : [];
  if (learningObjective !== undefined) patch.learningObjective = learningObjective.trim() || null;
  // P6.5: Teacher approval — only allow safe status transitions
  if (status !== undefined && ["approved", "needs_review", "draft"].includes(status)) {
    patch.status = status;
  }
  // P12: Allow teacher to move a MicroNode between topics (or make standalone)
  if (topicId !== undefined) patch.topicId = topicId; // null = standalone

  // ── P1.5: Learning Objective invariant ──────────────────────────────────────
  // A MicroNode cannot become "approved" if its effective LO (after the patch)
  // is null / empty / whitespace-only.
  if (patch.status === "approved") {
    const effectiveLO = learningObjective !== undefined
      ? String(learningObjective).trim()
      : (existing.learningObjective ?? "").trim();
    if (!effectiveLO) {
      res.status(400).json({
        error: "MISSING_LEARNING_OBJECTIVE",
        message: "Ուusumnatanumahy npataky bacakayum e: hastatrelou hamar anhrjesht e:",
      });
      return;
    }
  }

  // P1.5: If an approved node's LO is being cleared, auto-revert to needs_review
  // rather than silently creating an approved node without a Learning Objective.
  if (
    learningObjective !== undefined &&
    patch.learningObjective === null &&     // LO being cleared
    existing.status === "approved" &&       // node currently approved
    patch.status === undefined              // not also changing status explicitly
  ) {
    patch.status = "needs_review";
  }
  // ────────────────────────────────────────────────────────────────────────────

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No fields to update" }); return;
  }

  const [updated] = await db
    .update(lessonNodesTable)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .set(patch as any)
    .where(eq(lessonNodesTable.id, nodeId))
    .returning();

  await invalidateLessonApproval(lessonId);
  res.json({
    id: updated.id,
    lessonId: updated.lessonId,
    sequence: updated.sequence,
    title: updated.title,
    learningObjective: updated.learningObjective ?? null,
    theoryContent: updated.theoryContent ?? null,
    targetBloomLevel: updated.targetBloomLevel ?? null,
    estimatedMinutes: updated.estimatedMinutes ?? null,
    verbatimTheoryAnchor: updated.verbatimTheoryAnchor ?? null,
    commonMisconception: updated.commonMisconception ?? null,
    childFriendlyExplanation: updated.childFriendlyExplanation ?? null,
    basicExamples: Array.isArray(updated.basicExamples) ? updated.basicExamples : [],
    nonExamples: Array.isArray(updated.nonExamples) ? updated.nonExamples : [],
    realLifeExamples: Array.isArray(updated.realLifeExamples) ? updated.realLifeExamples : [],
    status: updated.status ?? "draft",
    sourcePage: updated.sourcePage ?? null,
  });
});

// POST /lessons/:lessonId/nodes/approve-all — set all draft/needs_review nodes to approved
// P6.6: Convenience bulk approval — does NOT run Phase 2.
// P8:   After approval, always rebuilds SEQUENTIAL dependencies for the lesson.
router.post("/lessons/:lessonId/nodes/approve-all", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  // P1.5: Count nodes that are eligible by status but will be skipped due to blank LO
  const [skippedLOResult] = await db
    .select({ count: count() })
    .from(lessonNodesTable)
    .where(
      and(
        eq(lessonNodesTable.lessonId, lessonId),
        or(eq(lessonNodesTable.status, "draft"), eq(lessonNodesTable.status, "needs_review")),
        or(
          sql`${lessonNodesTable.learningObjective} IS NULL`,
          sql`TRIM(${lessonNodesTable.learningObjective}) = ''`,
        ),
      )
    );
  const skippedLOCount = Number(skippedLOResult?.count ?? 0);

  const updated = await db
    .update(lessonNodesTable)
    .set({ status: "approved" })
    .where(
      and(
        eq(lessonNodesTable.lessonId, lessonId),
        // Only promote eligible statuses — never downgrade approved or override needs_source_content
        or(
          eq(lessonNodesTable.status, "draft"),
          eq(lessonNodesTable.status, "needs_review"),
        ),
        // P1.5: Never bulk-approve nodes that have no Learning Objective
        isNotNull(lessonNodesTable.learningObjective),
        sql`TRIM(${lessonNodesTable.learningObjective}) != ''`,
      )
    )
    .returning({ id: lessonNodesTable.id });

  // P8: Rebuild sequential dependency chain after node approval.
  const depResult = await refreshSequentialDependencies(lessonId);

  res.json({
    approvedCount:          updated.length,
    nodeIds:                updated.map((n) => n.id),
    skippedLOCount,          // P1.5: nodes skipped because LO was blank
    sequentialDependencies: depResult,
  });
});

// POST /lessons/:lessonId/refresh-dependencies — explicit sequential dependency refresh
// P8: Standalone route for rebuilding SEQUENTIAL deps on an already-approved lesson.
// Preserves REQUIRED / CONCEPTUAL / other dep types.
router.post("/lessons/:lessonId/refresh-dependencies", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [lesson] = await db.select({ id: lessonsTable.id }).from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  const result = await refreshSequentialDependencies(lessonId);
  res.json(result);
});

// POST /lessons/:lessonId/topics/:topicId/update — partial update for topic title
// P6.3: Minimal topic editability — title only for v1.
router.post("/lessons/:lessonId/topics/:topicId/update", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const topicId  = parseInt(String(req.params.topicId),  10);
  if (isNaN(lessonId) || isNaN(topicId)) {
    res.status(400).json({ error: "Invalid lesson id or topic id" }); return;
  }

  const [existing] = await db
    .select()
    .from(lessonTopicsTable)
    .where(and(eq(lessonTopicsTable.id, topicId), eq(lessonTopicsTable.lessonId, lessonId)))
    .limit(1);

  if (!existing) { res.status(404).json({ error: "Topic not found" }); return; }

  const { title, description } = req.body as { title?: string; description?: string };
  if (title !== undefined && !title.trim()) {
    res.status(400).json({ error: "title cannot be empty" }); return;
  }

  const patch: Record<string, unknown> = {};
  if (title !== undefined) patch.title = title.trim();
  if (description !== undefined) patch.description = description.trim() || null;

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No fields to update" }); return;
  }

  const [updated] = await db
    .update(lessonTopicsTable)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .set(patch as any)
    .where(eq(lessonTopicsTable.id, topicId))
    .returning();

  await invalidateLessonApproval(lessonId);
  res.json({ id: updated.id, lessonId: updated.lessonId, sequence: updated.sequence, title: updated.title, description: updated.description ?? null });
});

// ── TOPIC CRUD + REORDER ──────────────────────────────────────────────────────

// POST /lessons/:lessonId/topics — create a new topic
// Auto-assigns next available sequence; returns the new topic row.
router.post("/lessons/:lessonId/topics", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const { title, description } = req.body as { title?: string; description?: string };
  if (!title?.trim()) { res.status(400).json({ error: "title is required" }); return; }

  const [maxRow] = await db
    .select({ maxSeq: max(lessonTopicsTable.sequence) })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId));

  const nextSeq = (maxRow?.maxSeq ?? 0) + 1;
  const [topic] = await db
    .insert(lessonTopicsTable)
    .values({ lessonId, title: title.trim(), sequence: nextSeq, description: description?.trim() ?? null })
    .returning();
  await invalidateLessonApproval(lessonId);
  res.status(201).json({ id: topic.id, lessonId: topic.lessonId, sequence: topic.sequence, title: topic.title, description: topic.description ?? null });
});

// POST /lessons/:lessonId/topics/:topicId/delete — delete a topic
// lesson_nodes.topic_id FK onDelete: SET NULL — nodes in this topic become standalone.
// Exercises are untouched (they reference lesson_nodes, not topics).
router.post("/lessons/:lessonId/topics/:topicId/delete", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const topicId  = parseInt(String(req.params.topicId),  10);
  if (isNaN(lessonId) || isNaN(topicId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const [existing] = await db
    .select({ id: lessonTopicsTable.id })
    .from(lessonTopicsTable)
    .where(and(eq(lessonTopicsTable.id, topicId), eq(lessonTopicsTable.lessonId, lessonId)))
    .limit(1);
  if (!existing) { res.status(404).json({ error: "Topic not found" }); return; }

  await db.delete(lessonTopicsTable).where(eq(lessonTopicsTable.id, topicId));
  await invalidateLessonApproval(lessonId);
  res.json({ message: "Topic deleted", id: topicId });
});

// POST /lessons/:lessonId/topics/reorder — bulk reorder topics (normalized, transactional)
// Payload: { orderedTopicIds: number[] } — must include ALL topic IDs for this lesson.
// Normalizes sequences to 1, 2, 3, … contiguous integers.
router.post("/lessons/:lessonId/topics/reorder", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const { orderedTopicIds } = req.body as { orderedTopicIds?: number[] };
  if (!Array.isArray(orderedTopicIds) || orderedTopicIds.length === 0) {
    res.status(400).json({ error: "orderedTopicIds must be a non-empty array" }); return;
  }
  if (new Set(orderedTopicIds).size !== orderedTopicIds.length) {
    res.status(400).json({ error: "Duplicate topic IDs" }); return;
  }

  const existing = await db
    .select({ id: lessonTopicsTable.id })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId));
  const existingIds = new Set(existing.map((t) => t.id));

  for (const id of orderedTopicIds) {
    if (!existingIds.has(id)) {
      res.status(400).json({ error: `Topic ${id} does not belong to lesson ${lessonId}` }); return;
    }
  }
  if (orderedTopicIds.length !== existingIds.size) {
    res.status(400).json({ error: "orderedTopicIds must include all topics for this lesson" }); return;
  }

  // Transactional normalized update
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedTopicIds.length; i++) {
      await tx.update(lessonTopicsTable).set({ sequence: i + 1 }).where(eq(lessonTopicsTable.id, orderedTopicIds[i]));
    }
  });

  const updated = await db
    .select()
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId))
    .orderBy(asc(lessonTopicsTable.sequence));
  await invalidateLessonApproval(lessonId);
  res.json(updated.map((t) => ({ id: t.id, lessonId: t.lessonId, sequence: t.sequence, title: t.title, description: t.description ?? null })));
});

// POST /lessons/:lessonId/nodes/reorder — bulk reorder nodes (normalized, transactional + dep sync)
// Payload: { orderedNodeIds: number[] } — must include ALL node IDs for this lesson.
// Normalizes sequences to 1, 2, 3, … then rebuilds SEQUENTIAL deps (preserves REQUIRED/other).
router.post("/lessons/:lessonId/nodes/reorder", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const { orderedNodeIds } = req.body as { orderedNodeIds?: number[] };
  if (!Array.isArray(orderedNodeIds) || orderedNodeIds.length === 0) {
    res.status(400).json({ error: "orderedNodeIds must be a non-empty array" }); return;
  }
  if (new Set(orderedNodeIds).size !== orderedNodeIds.length) {
    res.status(400).json({ error: "Duplicate node IDs" }); return;
  }

  const existing = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId));
  const existingIds = new Set(existing.map((n) => n.id));

  for (const id of orderedNodeIds) {
    if (!existingIds.has(id)) {
      res.status(400).json({ error: `Node ${id} does not belong to lesson ${lessonId}` }); return;
    }
  }
  if (orderedNodeIds.length !== existingIds.size) {
    res.status(400).json({ error: "orderedNodeIds must include all nodes for this lesson" }); return;
  }

  // Transactional: sequence updates + dep rebuild happen atomically.
  // Passing tx to refreshSequentialDependencies ensures we never commit
  // a new node order without a matching updated dependency graph.
  const depResult = await db.transaction(async (tx) => {
    for (let i = 0; i < orderedNodeIds.length; i++) {
      await tx.update(lessonNodesTable).set({ sequence: i + 1 }).where(eq(lessonNodesTable.id, orderedNodeIds[i]));
    }
    return refreshSequentialDependencies(lessonId, tx as unknown as typeof db);
  });

  const updated = await db
    .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence));

  await invalidateLessonApproval(lessonId);
  res.json({ nodes: updated, dependencies: depResult });
});

// POST /lessons/:lessonId/nodes/:nodeId/delete — delete a node
// lesson_sessions.currentNodeId has onDelete: "set null" so no manual cleanup needed
router.post("/lessons/:lessonId/nodes/:nodeId/delete", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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

  // Atomic: delete + SEQUENTIAL rebuild so no stale edges remain after removal.
  // FK CASCADE on lesson_node_dependencies removes edges touching nodeId first;
  // refreshSequentialDependencies then rebuilds the chain from remaining nodes.
  await db.transaction(async (tx) => {
    await tx.delete(lessonNodesTable).where(eq(lessonNodesTable.id, nodeId));
    await refreshSequentialDependencies(lessonId, tx as unknown as typeof db);
  });
  await invalidateLessonApproval(lessonId);
  res.json({ message: "Node deleted" });
});

// POST /lessons/:lessonId/nodes/:nodeId/enrich
// Selective Phase 2 enrichment for a single MicroNode.
// Gate (Phase 2A R3): requires confirmed cognitive path before Teaching Content can be generated.
// Runs synchronously (returns when AI is done) — designed for single-node operations.
// Uses same don't-degrade semantics as whole-lesson generate-teaching-content.
// Does NOT require whole-lesson final approval afterward.
router.post("/lessons/:lessonId/nodes/:nodeId/enrich", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId = parseInt(String(req.params.nodeId), 10);
  if (isNaN(lessonId) || isNaN(nodeId)) {
    res.status(400).json({ error: "Invalid lesson id or node id" });
    return;
  }

  const [node] = await db
    .select({
      id:                lessonNodesTable.id,
      title:             lessonNodesTable.title,
      learningObjective: lessonNodesTable.learningObjective,
      theoryContent:     lessonNodesTable.theoryContent,
      blockType:         lessonNodesTable.blockType,
      cogPathStatus:     (lessonNodesTable as any).cogPathStatus,
    })
    .from(lessonNodesTable)
    .where(and(eq(lessonNodesTable.id, nodeId), eq(lessonNodesTable.lessonId, lessonId)))
    .limit(1);

  if (!node) {
    res.status(404).json({ error: "Node not found" });
    return;
  }

  // Phase 2A R3 gate: cognitive path must be confirmed before Teaching Content can be generated
  const cogStatus = (node as any).cogPathStatus as string | null;
  if (cogStatus !== "confirmed") {
    res.status(422).json({
      error: "COG_PATH_NOT_CONFIRMED",
      message: cogStatus === "needs_review"
        ? "Նախ հաստատեք ճանաչողական ուղին (✓ Հаstatsel)"
        : "Նախ ստեղծեք եւ հաստատեք ճանաչողական ուղին",
    });
    return;
  }

  // Fetch confirmed cognitive path for prompt context
  const cogLevels = await db
    .select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId))
    .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));

  // Fetch exercises linked to this node
  const nodeExercises = await db
    .select({
      exerciseId:           lessonExercisesTable.exerciseId,
      exerciseTextVerbatim: lessonExercisesTable.exerciseTextVerbatim,
    })
    .from(lessonExercisesTable)
    .where(and(
      eq(lessonExercisesTable.lessonId, lessonId),
      eq(lessonExercisesTable.relatedNodeId, nodeId),
    ));

  const input: Phase2Input = {
    nodeId:            node.id,
    title:             node.title,
    learningObjective: (node as any).learningObjective ?? null,
    theoryContent:     (node as any).theoryContent ?? null,
    blockType:         (node as any).blockType ?? null,
    cogPath: cogLevels.map((l): ConfirmedCogLevel => ({
      cognitiveLevel:       l.cognitiveLevel,
      sequence:             l.sequence,
      isTargetCeiling:      l.isTargetCeiling,
      performanceObjective: l.performanceObjective ?? null,
      successCriterion:     l.successCriterion ?? null,
    })),
  };
  const exercises: Phase2LinkedExercise[] = nodeExercises.map((e) => ({
    exerciseId:           e.exerciseId,
    exerciseTextVerbatim: e.exerciseTextVerbatim,
  }));

  const result = await generatePhase2Content(input, exercises);

  if (result.skipped) {
    res.status(422).json({
      error: "SKIP",
      skipReason: result.skipReason,
      message: result.skipReason === "skipped_needs_review"
        ? "Node has not been reviewed yet"
        : "Theory content is too thin for Phase 2 generation",
    });
    return;
  }

  // Apply don't-degrade semantics: never overwrite a valid field with empty AI response
  const phase2Updates: Record<string, unknown> = { status: "approved" as const, teachingContentStale: false };
  if (result.childFriendlyExplanation?.trim())
    phase2Updates.childFriendlyExplanation = result.childFriendlyExplanation;
  if (Array.isArray(result.basicExamples) && result.basicExamples.length > 0)
    phase2Updates.basicExamples = result.basicExamples;
  if (result.commonMisconception?.trim())
    phase2Updates.commonMisconception = result.commonMisconception;
  if (Array.isArray(result.nonExamples) && result.nonExamples.length > 0)
    phase2Updates.nonExamples = result.nonExamples;

  await db
    .update(lessonNodesTable)
    .set(phase2Updates)
    .where(eq(lessonNodesTable.id, nodeId));

  // Return the freshly-saved node for immediate UI update
  const [updated] = await db
    .select()
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, nodeId))
    .limit(1);

  logger.info({ lessonId, nodeId, fields: Object.keys(phase2Updates) }, "single-node Phase 2 enrichment completed");
  res.json({ success: true, nodeId, node: updated });
});

// DELETE /lessons/:lessonId/mapping — delete entire lesson mapping (nodes, topics, exercises, deps)
// Lesson row itself is NOT deleted — only the mapping data.
router.delete("/lessons/:lessonId/mapping", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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
router.get("/lessons/:lessonId/exercises", requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const exercises = await db
    .select()
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, lessonId))
    .orderBy(asc(lessonExercisesTable.sequence));

  res.json(exercises.map((e) => {
    const edited = (e as any).exerciseTextEdited as string | null | undefined;
    const effectiveText = edited?.trim() ? edited.trim() : e.exerciseTextVerbatim;
    const learnerContent = resolveLearnerExerciseContent(e);
    return {
      id: e.id,
      lessonId: e.lessonId,
      exerciseId: e.exerciseId,
      sequence: e.sequence,
      sourcePage: e.sourcePage ?? null,
      exerciseTextVerbatim: e.exerciseTextVerbatim,
      exerciseTextEdited: edited ?? null,
      effectiveExerciseText: effectiveText,
      exercisePurpose: e.exercisePurpose ?? null,
      relatedNodeId: e.relatedNodeId ?? null,
      successCriteria: e.successCriteria ?? null,
      interactionType: e.interactionType ?? null,
      correctAnswer: e.correctAnswer ?? null,
      difficultyLevel: e.difficultyLevel ?? null,
      assignment: e.assignment ?? null,
      // Provenance / review fields — included for teacher review UI
      sourceType: e.sourceType ?? null,
      sourceBlockIndex: e.sourceBlockIndex ?? null,
      status: e.status ?? null,
      learnerContentSafe: learnerContent.ok,
      learnerContentSource: learnerContent.source,
      learnerContentIssues: learnerContent.ok
        ? learnerContent.reviewWarnings
        : learnerContent.issues.map((issue) => issue.code),
    };
  }));
});

// POST /lessons/:lessonId/exercises — create a new exercise
router.post("/lessons/:lessonId/exercises", requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const { exerciseTextVerbatim, exerciseTextEdited, relatedNodeId, sourcePage, successCriteria, interactionType, correctAnswer, difficultyLevel, assignment, exercisePurpose } = req.body as {
    exerciseTextVerbatim?: string;
    exerciseTextEdited?: string | null;
    relatedNodeId?: number | null;
    sourcePage?: string;
    successCriteria?: string;
    interactionType?: string | null;
    correctAnswer?: string | null;
    difficultyLevel?: string;
    assignment?: string;
    exercisePurpose?: string;
  };

  if (!exerciseTextVerbatim?.trim()) {
    res.status(400).json({ error: "exerciseTextVerbatim is required" });
    return;
  }

  const answerContract = normalizeSourceExerciseAnswerContract({
    interactionType,
    correctAnswer,
  });
  if (!answerContract.ok) {
    res.status(400).json({
      error: "INVALID_EXERCISE_ANSWER_CONTRACT",
      message: answerContract.error,
    });
    return;
  }

  const learnerText = exerciseTextEdited?.trim() || exerciseTextVerbatim.trim();
  const learnerContent = resolveLearnerExerciseContent({
    exerciseTextVerbatim,
    exerciseTextEdited: learnerText,
    successCriteria,
    correctAnswer: answerContract.correctAnswer,
  });
  if (!learnerContent.ok) {
    res.status(422).json({
      error: "UNSAFE_LEARNER_EXERCISE_CONTENT",
      message: "Learner-facing exercise text contains hidden evaluator content.",
      issues: learnerContent.issues,
    });
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
      exerciseTextEdited: learnerContent.learnerText,
      relatedNodeId: relatedNodeId ?? null,
      sourcePage: sourcePage ?? null,
      successCriteria: successCriteria ?? null,
      interactionType: answerContract.interactionType,
      correctAnswer: answerContract.correctAnswer,
      difficultyLevel: difficultyLevel ?? "MEDIUM",
      assignment: assignment ?? "CLASS",
      exercisePurpose: exercisePurpose ?? "INDEPENDENT_PRACTICE",
      // P1.6B: teacher-created exercises are always manual — never pretend to be textbook.
      sourceType: "manual",
    })
    .returning();

  await invalidateLessonApproval(lessonId);
  res.status(201).json({
    id: ex.id,
    lessonId: ex.lessonId,
    exerciseId: ex.exerciseId,
    sequence: ex.sequence,
    sourcePage: ex.sourcePage ?? null,
    exerciseTextVerbatim: ex.exerciseTextVerbatim,
    exerciseTextEdited: ex.exerciseTextEdited,
    effectiveExerciseText: learnerContent.learnerText,
    exercisePurpose: ex.exercisePurpose ?? null,
    relatedNodeId: ex.relatedNodeId ?? null,
    successCriteria: ex.successCriteria ?? null,
    interactionType: ex.interactionType ?? null,
    correctAnswer: ex.correctAnswer ?? null,
    difficultyLevel: ex.difficultyLevel ?? null,
    assignment: ex.assignment ?? null,
    status: ex.status ?? "draft",
    sourceType: ex.sourceType ?? "manual",
    sourceBlockIndex: null,
    learnerContentSafe: true,
    learnerContentSource: learnerContent.source,
    learnerContentIssues: learnerContent.reviewWarnings,
  });
});

// POST /lessons/:lessonId/exercises/:exerciseId/update — partial update
router.post("/lessons/:lessonId/exercises/:exerciseId/update", requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const exerciseId = parseInt(String(req.params.exerciseId), 10);
  if (isNaN(lessonId) || isNaN(exerciseId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db
    .select()
    .from(lessonExercisesTable)
    .where(and(eq(lessonExercisesTable.id, exerciseId), eq(lessonExercisesTable.lessonId, lessonId)))
    .limit(1);

  if (!existing) { res.status(404).json({ error: "Exercise not found" }); return; }

  const {
    exerciseTextVerbatim, exerciseTextEdited,
    relatedNodeId, sourcePage, successCriteria, interactionType, correctAnswer, difficultyLevel,
    assignment, exercisePurpose, status,
  } = req.body as {
    exerciseTextVerbatim?: string;
    exerciseTextEdited?: string | null;
    relatedNodeId?: number | null;
    sourcePage?: string;
    successCriteria?: string;
    interactionType?: string | null;
    correctAnswer?: string | null;
    difficultyLevel?: string;
    assignment?: string;
    exercisePurpose?: string;
    status?: string;
  };

  // Gate 1.4: only allow known lifecycle values
  if (status !== undefined && !["draft", "reviewed", "approved"].includes(status)) {
    res.status(400).json({ error: "Invalid status; allowed values: draft, reviewed, approved" }); return;
  }

  const answerContract = normalizeSourceExerciseAnswerContract({
    interactionType: interactionType !== undefined ? interactionType : existing.interactionType,
    correctAnswer: correctAnswer !== undefined ? correctAnswer : existing.correctAnswer,
  });
  if (!answerContract.ok) {
    res.status(400).json({
      error: "INVALID_EXERCISE_ANSWER_CONTRACT",
      message: answerContract.error,
    });
    return;
  }

  // P1.6B: protect textbook provenance — immutable fields for textbook exercises
  const isTextbook = existing.sourceType === "textbook";
  if (isTextbook) {
    const forbidden: string[] = [];
    if (exerciseTextVerbatim !== undefined) forbidden.push("exerciseTextVerbatim");
    if (sourcePage !== undefined) forbidden.push("sourcePage");
    if (forbidden.length > 0) {
      res.status(400).json({
        error: "IMMUTABLE_TEXTBOOK_PROVENANCE",
        message: `Textbook provenance fields are immutable: ${forbidden.join(", ")}. ` +
          "To adapt exercise wording use exerciseTextEdited instead.",
        immutableFields: forbidden,
      });
      return;
    }
  }

  if (!isTextbook && exerciseTextVerbatim !== undefined && !exerciseTextVerbatim.trim()) {
    res.status(400).json({ error: "exerciseTextVerbatim cannot be empty" });
    return;
  }

  const candidateEdited = exerciseTextEdited !== undefined
    ? exerciseTextEdited?.trim() || null
    : existing.exerciseTextEdited;
  const candidateVerbatim = !isTextbook && exerciseTextVerbatim !== undefined
    ? exerciseTextVerbatim.trim()
    : existing.exerciseTextVerbatim;
  const candidateCriteria = successCriteria !== undefined
    ? successCriteria.trim() || null
    : existing.successCriteria;
  const learnerContent = resolveLearnerExerciseContent({
    exerciseTextVerbatim: candidateVerbatim,
    exerciseTextEdited: candidateEdited,
    successCriteria: candidateCriteria,
    correctAnswer: answerContract.correctAnswer,
  });
  if (!learnerContent.ok) {
    res.status(422).json({
      error: "UNSAFE_LEARNER_EXERCISE_CONTENT",
      message: "Learner-facing exercise text contains hidden evaluator content.",
      issues: learnerContent.issues,
    });
    return;
  }

  const patch: Record<string, unknown> = {};

  // Text editing: textbook → write to exerciseTextEdited; manual → allow verbatim patch
  if (isTextbook) {
    if (exerciseTextEdited !== undefined) {
      // null or blank string = reset (teacher reverts to original verbatim)
      patch.exerciseTextEdited = exerciseTextEdited === null || exerciseTextEdited.trim() === ""
        ? null
        : exerciseTextEdited.trim();
    }
  } else {
    // Manual exercise: allow patching verbatim directly
    if (exerciseTextVerbatim !== undefined) patch.exerciseTextVerbatim = exerciseTextVerbatim.trim();
    if (exerciseTextEdited !== undefined) {
      patch.exerciseTextEdited = exerciseTextEdited === null || exerciseTextEdited.trim() === ""
        ? null
        : exerciseTextEdited.trim();
    }
    if (sourcePage !== undefined) patch.sourcePage = sourcePage;
  }

  if (relatedNodeId !== undefined) patch.relatedNodeId = relatedNodeId;
  if (successCriteria !== undefined) patch.successCriteria = successCriteria.trim() || null;
  if (interactionType !== undefined || correctAnswer !== undefined) {
    patch.interactionType = answerContract.interactionType;
    patch.correctAnswer = answerContract.correctAnswer;
  }
  if (difficultyLevel !== undefined) patch.difficultyLevel = difficultyLevel;
  if (assignment !== undefined) patch.assignment = assignment;
  if (exercisePurpose !== undefined) patch.exercisePurpose = exercisePurpose;
  if (status !== undefined) patch.status = status;

  const [updated] = await db
    .update(lessonExercisesTable)
    .set(patch)
    .where(eq(lessonExercisesTable.id, exerciseId))
    .returning();

  const updatedEdited = (updated as any).exerciseTextEdited as string | null | undefined;
  const effectiveText = updatedEdited?.trim() ? updatedEdited.trim() : updated.exerciseTextVerbatim;
  const updatedLearnerContent = resolveLearnerExerciseContent(updated);

  await invalidateLessonApproval(lessonId);
  res.json({
    id: updated.id,
    lessonId: updated.lessonId,
    exerciseId: updated.exerciseId,
    sequence: updated.sequence,
    sourcePage: updated.sourcePage ?? null,
    exerciseTextVerbatim: updated.exerciseTextVerbatim,
    exerciseTextEdited: updatedEdited ?? null,
    effectiveExerciseText: effectiveText,
    exercisePurpose: updated.exercisePurpose ?? null,
    relatedNodeId: updated.relatedNodeId ?? null,
    successCriteria: updated.successCriteria ?? null,
    interactionType: updated.interactionType ?? null,
    correctAnswer: updated.correctAnswer ?? null,
    difficultyLevel: updated.difficultyLevel ?? null,
    assignment: updated.assignment ?? null,
    status: updated.status ?? "draft",
    sourceType: updated.sourceType ?? null,
    sourceBlockIndex: updated.sourceBlockIndex ?? null,
    learnerContentSafe: updatedLearnerContent.ok,
    learnerContentSource: updatedLearnerContent.source,
    learnerContentIssues: updatedLearnerContent.ok
      ? updatedLearnerContent.reviewWarnings
      : updatedLearnerContent.issues.map((issue) => issue.code),
  });
});

// POST /lessons/:lessonId/exercises/approve-all — bulk approve all non-approved exercises in a lesson
// Gate 1.4: transaction-safe; only touches the current lesson's exercises.
// Uses fail-closed logic: status === "approved" is the only eligible value.
router.post("/lessons/:lessonId/exercises/approve-all", requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [lesson] = await db.select({ id: lessonsTable.id }).from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  const candidates = await db
    .select()
    .from(lessonExercisesTable)
    .where(and(
      eq(lessonExercisesTable.lessonId, lessonId),
      ne(lessonExercisesTable.status, "approved"),
    ));
  const classified = candidates.map((exercise) => ({
    exercise,
    content: resolveLearnerExerciseContent(exercise),
  }));
  const safeIds = classified
    .filter(({ content }) => isLearnerDeliveryEligible(content))
    .map(({ exercise }) => exercise.id);
  const rejected = classified
    .filter(({ content }) => !isLearnerDeliveryEligible(content))
    .map(({ exercise, content }) => ({
      id: exercise.id,
      issues: content.ok ? content.reviewWarnings : content.issues.map((issue) => issue.code),
    }));
  const updated = safeIds.length === 0
    ? []
    : await db
      .update(lessonExercisesTable)
      .set({ status: "approved" })
      .where(inArray(lessonExercisesTable.id, safeIds))
      .returning({ id: lessonExercisesTable.id });

  await invalidateLessonApproval(lessonId);
  res.json({ approvedCount: updated.length, lessonId, rejected });
});

// POST /lessons/:lessonId/exercises/:exerciseId/delete
router.post("/lessons/:lessonId/exercises/:exerciseId/delete", requireLessonAuthor, async (req: AuthRequest, res) => {
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
  await invalidateLessonApproval(lessonId);
  res.json({ message: "Exercise deleted" });
});

// ── TOPICS & MAPPING REPORT ───────────────────────────────────────────────────

// GET /lessons/:lessonId/topics — ordered list of topics for the lesson
router.get("/lessons/:lessonId/topics", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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

// POST /lessons/:lessonId/final-approve — P1.7 Final Lesson Approval Gate
// Runs full deterministic validation; if errors === 0, sets lesson status → 'approved'.
// Returns { approved, lessonId, errors[], warnings[], summary } always.
// On validation failure: 422 with errors. On success: 200 with approved: true.
router.post("/lessons/:lessonId/final-approve", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [lesson] = await db.select({ id: lessonsTable.id })
    .from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  const result = await validateLessonForFinalApproval(lessonId);

  if (result.errors.length > 0) {
    res.status(422).json({
      approved: false,
      lessonId,
      errors: result.errors,
      warnings: result.warnings,
      summary: result.summary,
    });
    return;
  }

  // All checks passed — stamp the lesson as approved.
  // Also set everApproved=true (sticky flag) so future teacher edits do NOT
  // revert the lesson to needs_review (POST-P1.12 authoring simplification).
  await db.update(lessonsTable)
    .set({ status: "approved", everApproved: true } as any)
    .where(eq(lessonsTable.id, lessonId));

  res.json({
    approved: true,
    lessonId,
    errors: [],
    warnings: result.warnings,
    summary: result.summary,
  });
});

// GET /lessons/:lessonId/kb-validate — Phase 9 Knowledge Base Validation
//   Deterministic, read-only structural check. Zero AI calls. Zero DB writes.
//   Returns whether the lesson is structurally sound and ready for AI Teacher.
router.get("/lessons/:lessonId/kb-validate", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const result = await validateKnowledgeBaseLesson(lessonId);
  if (result.microNodes.total === 0 && result.sourceCoverage.note?.includes("not been mapped")) {
    res.status(404).json({ error: "Lesson not found or not yet mapped" });
    return;
  }
  res.json(result);
});

// GET /lessons/:lessonId/mapping-report — quality report from the last /map run
//   If stored metadata exists (from a fresh /map run), returns it directly.
//   Otherwise computes a best-effort report from current DB state.
router.get("/lessons/:lessonId/mapping-report", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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
router.post("/lessons/:lessonId/map", requireLessonAuthor, async (req: AuthRequest, res) => {
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
  if (requiresGoalOutcomeConfirmation(lesson)) {
    res.status(409).json({
      error: "GOAL_OUTCOME_CONFIRMATION_REQUIRED",
      message: "Նախ հաստատեք դասի նպատակը և վերջնարդյունքները, ապա ստեղծեք մանրամասն քարտեզագրումը։",
    });
    return;
  }

  if (!lesson.textbookResourceId) {
    res.status(400).json({
      error: "Այս դասին կապված դասագրքի ֆայլ չկա, ընտրիր այն դասը խմբագրելիս",
    });
    return;
  }

  const pageRange = validateRequiredLessonPageRange(lesson.pagesFrom, lesson.pagesTo);
  if (!pageRange.valid) {
    res.status(400).json({
      error: pageRange.error,
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
    const lessonText = await extractPdfPageRange(filePath, pageRange.pagesFrom, pageRange.pagesTo);

    const confirmedOutcomes = lesson.goalOutcomeReviewStatus === "confirmed"
      ? await db.select({ outcomeText: lessonOutcomesTable.outcomeText })
        .from(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId, lessonId))
        .orderBy(asc(lessonOutcomesTable.sequence))
      : [];
    const baseInput = {
      subjectName:   subject?.name ?? "",
      lessonTitle:   lesson.title,
      chapterTitle:  lesson.chapterTitle  ?? null,
      textbookTitle: lesson.textbookTitle ?? null,
      textbookAuthor: lesson.textbookAuthor ?? null,
      pagesFrom:     pageRange.pagesFrom,
      pagesTo:       pageRange.pagesTo,
      teacherGoal:   lesson.lessonGoal ?? null,
      // Canonical records constrain new detailed mapping only after explicit
      // confirmation. Legacy lessons retain their historical JSON compatibility.
      teacherOutcomes: confirmedOutcomes.length > 0
        ? confirmedOutcomes.map((outcome) => outcome.outcomeText)
        : Array.isArray(lesson.lessonOutcomes) ? (lesson.lessonOutcomes as string[]) : null,
    };

    // ── Pass 1: Pure verbatim block extraction (in-memory, no DB write yet) ──
    let pass1: Pass1Result;
    if (isGarbledText(lessonText)) {
      logger.info(
        { lessonId, pagesFrom: lesson.pagesFrom, pagesTo: lesson.pagesTo },
        "lesson mapping: garbled text — using vision-based Pass 1"
      );
      const pageImages = await rasterizePdfPages(filePath, lesson.pagesFrom!, lesson.pagesTo!);
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
      pagesFrom:   pageRange.pagesFrom,
      pagesTo:     pageRange.pagesTo,
      teacherGoal: baseInput.teacherGoal,
      teacherOutcomes: baseInput.teacherOutcomes,
    });
    // A Topic is an organisational label, not an atomic learning unit. This
    // invariant runs before any destructive replacement so a failed detailed
    // map cannot erase a previously valid lesson map.
    assertDetailedMappingHasMicroNodes(pass2);

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
    // Sequence bug fix: lesson-wide counter so MicroNode sequence is unique across
    // all topics (previously reset per topic, giving every first node sequence=1).
    let mnSeq = 0;

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

      for (const mn of topic.microNodes) {
        mnSeq += 1;

        // Combine source-block texts as theoryContent / verbatimTheoryAnchor
        const sourceBlocks = mn.sourceBlockIndices.map((i) => pass1.blocks[i]).filter(Boolean);
        const theoryContent = sourceBlocks
          .map((b) => b.sourceText.trim())
          .filter(Boolean)
          .join("\n\n");
        const firstSourcePage = sourceBlocks.find((b) => b.sourcePage)?.sourcePage ?? null;

        // Primary source block — used to populate per-block provenance fields (RC-3 fix).
        // MicroNodes aggregate multiple blocks; we use the first as the canonical source anchor.
        const primaryBlock = sourceBlocks[0] ?? null;

        // 2. Insert the MicroNode
        const [insertedNode] = await db
          .insert(lessonNodesTable)
          .values({
            lessonId,
            topicId:             insertedTopic.id,
            sequence:            mnSeq,
            title:               mn.title,
            learningObjective:   mn.learningObjective || null,
            microNodeType:       mn.microNodeType,
            theoryContent:       theoryContent || null,
            verbatimTheoryAnchor: theoryContent || null,
            sourcePage:          firstSourcePage,
            // RC-3: persist Pass-1 block provenance fields that were previously dropped
            sourceText:          primaryBlock?.sourceText.trim() || null,
            sourceParagraph:     primaryBlock?.sourceParagraph ?? null,
            sourceBoundingBox:   primaryBlock?.sourceBoundingBox ?? null,
            blockType:           primaryBlock?.blockType ?? null,
            // STEP-3: persist all source block indices for coverage auditing
            sourceBlockIndices:  mn.sourceBlockIndices as any,
            status:              "draft" as const,
            createdBy:           "ai"   as const,
            targetBloomLevel:    1,
            estimatedMinutes:    5,
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
          if (!block) {
            // After the deterministic rescue passes in runPass2Pipeline, this should
            // not happen for valid activity blocks.  If it does, the AI returned an
            // invalid blockIndex for a MicroNode exercise — log and skip.
            logger.warn(
              { lessonId, nodeTitle: mn.title, blockIndex: ex.blockIndex },
              "lesson mapping: MicroNode exercise has invalid/out-of-range blockIndex after rescue — skipping",
            );
            continue;
          }
          exerciseCounter += 1;

          await db.insert(lessonExercisesTable).values({
            lessonId,
            exerciseId:          `EX-${lessonId}-${exerciseCounter}`,
            exerciseTextVerbatim: block.sourceText.trim(),
            sourcePage:          block.sourcePage ? String(block.sourcePage) : null,
            relatedNodeId:       insertedNode.id,
            sequence:            exerciseCounter,
            // P3.4: persist the Pass-1 block index for MAPPING → SOURCE traceability
            sourceBlockIndex:    ex.blockIndex,
            interactionType:     null,
            correctAnswer:       null,
            sourceType:          "textbook" as const,
            status:              "draft"    as const,
            // P5.2: exercises attached to a MicroNode are CLASS exercises.
            // chat.ts Phase 2 filters on assignment = "CLASS" to populate CLASS_EXERCISES.
            assignment:          "CLASS"    as const,
          });
          totalExercises += 1;
        }
      }

      // 4. Insert additional exercises — real textbook exercises with no dedicated MicroNode.
      //    relatedNodeId = null (schema already supports nullable FK).
      //    These are NOT fake MicroNodes; they are preserved as-is for platform access.
      //    After the deterministic rescue passes (Step C in runPass2Pipeline), all
      //    real activity blocks should have a valid blockIndex here.  Any remaining
      //    null/invalid entries are AI-generated stubs that the rescue already handled
      //    by inserting the real block separately — skip with a warning.
      for (const ex of topic.additionalExercises ?? []) {
        const block = pass1.blocks[ex.blockIndex];
        if (!block) {
          logger.warn(
            { lessonId, topicTitle: topic.title, blockIndex: ex.blockIndex },
            "lesson mapping: additionalExercises entry has invalid blockIndex after rescue — skipping orphan stub",
          );
          continue;
        }
        exerciseCounter += 1;

        // P5.2: derive assignment from the Pass1 block type.
        // HOMEWORK blocks → "HOMEWORK" (shown in HOMEWORK_TASKS context).
        // EXERCISE / ACTIVITY → "CLASS" (shown in DEEP_DIVE_EXERCISES context, Phase 3).
        // chat.ts Phase 3 now includes relatedNodeId IS NULL + assignment = "CLASS".
        const additionalAssignment: "CLASS" | "HOMEWORK" =
          block.blockType === "HOMEWORK" ? "HOMEWORK" : "CLASS";

        await db.insert(lessonExercisesTable).values({
          lessonId,
          exerciseId:           `EX-${lessonId}-${exerciseCounter}`,
          exerciseTextVerbatim: block.sourceText.trim(),
          sourcePage:           block.sourcePage ? String(block.sourcePage) : null,
          relatedNodeId:        null,
          sequence:             exerciseCounter,
          // P3.4: persist the Pass-1 block index for MAPPING → SOURCE traceability
          sourceBlockIndex:     ex.blockIndex,
          interactionType:      null,
          correctAnswer:        null,
          sourceType:           "textbook" as const,
          status:               "draft"    as const,
          assignment:           additionalAssignment,
        });
        totalExercises += 1;
      }
    }

    // ── P5.1 — Activity placement validation ──────────────────────────────────
    // Detects EXERCISE/ACTIVITY/HOMEWORK blocks that ended up in sourceBlockIndices
    // (theory) or in unmappedBlockIndices instead of exercises[]/additionalExercises[].
    // This is purely additive — never changes the mapping result.
    // Note: P5.4 rescue already moved EXERCISE blocks from unmappedBlockIndices to
    // additionalExercises inside runPass2Pipeline, so EXERCISE_IN_UNMAPPED findings
    // here represent any that were missed by the rescue (e.g. added back post-rescue).
    const activityFindings = validateActivityPlacement(pass1.blocks, pass2.topics);
    const activityIssuesRaw = activityFindings.length;
    if (activityIssuesRaw > 0) {
      logger.warn(
        { lessonId, activityIssues: activityIssuesRaw },
        "lesson mapping: P5.1 activity placement issues detected",
      );
    }

    // ── Build, store, and return the structured mapping report ────────────────
    // P3.2: use the validator's canonical metric — coveredBlocks / totalBlocks — as the
    // single source of truth for coverage percent.  The old formula
    // ((totalBlocks - unmappedBlocks) / totalBlocks) excluded missingIndices and diverged
    // from the validator's result.
    const coveragePercent = pass2.coverageValidation.coveragePercent;

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
    // P3.2: use canonical validator metric (missingIndices.length) not the old unmapped formula.
    if (coveragePercent < 90) {
      reviewItems.push({
        nodeId:    null as unknown as number,
        nodeTitle: "—",
        reason:    `Coverage is only ${coveragePercent}% — ${pass2.coverageValidation.missingIndices.length} of ${pass1.blocks.length} source blocks were not accounted for by the mapping pipeline. Significant content may be missing.`,
      });
    }

    // ── P4.8 — Phase 4 granularity findings → reviewItems ────────────────────
    // Advisory only: these do NOT change jobStatus or coverageValidation.
    // coverageIssues = Phase 3 findings (skipped pages + coverage gaps).
    // granularityIssues = Phase 4 semantic findings (mega-node / over-split / exercise mismatch).
    const coverageIssues = reviewItems.length;  // count before appending Phase 4 items
    for (const gf of pass2.granularityFindings) {
      reviewItems.push({
        nodeId:    null as unknown as number,
        nodeTitle: gf.microNodeTitle,
        reason:    `[${gf.issue} · ${gf.confidence}] ${gf.reason}${gf.suggestedAction ? ` — ${gf.suggestedAction}` : ""}`,
      });
    }
    const granularityIssues = pass2.granularityFindings.length;

    // ── P5.1 + P5.4 — Activity placement findings → reviewItems ──────────────
    // HIGH severity: advisory only, never blocks the mapping.
    // activityIssues = P5.1 (EXERCISE in sourceBlockIndices) +
    //                  P5.4 (EXERCISE in unmappedBlocks — detected post-rescue).
    for (const af of activityFindings) {
      reviewItems.push({
        nodeId:    null as unknown as number,
        nodeTitle: af.microNodeTitle,
        reason:    formatActivityFinding(af),
      });
    }
    const activityIssues = activityIssuesRaw;

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
        // P4.12: separate Phase 3 (structural) vs Phase 4 (semantic) issue counts
        coverageIssues,
        granularityIssues,
        activityIssues,
        reviewItems,
        coverageValidation: pass2.coverageValidation,
        granularityFindings: pass2.granularityFindings,
        pass2Diagnostics: pass2.diagnostics,
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

    // P3.1: branch completion status on coverage validity.
    //   "completed"      → all source blocks accounted for (valid = true)
    //   "coverage_failed"→ mapping ran but validator found missing/duplicate/invalid indices
    //   "failed"         → technical/runtime exception (handled in catch block)
    const jobStatus = pass2.coverageValidation.valid ? "completed" : "coverage_failed";

    await db.update(mappingJobsTable)
      .set({
        status: jobStatus,
        result: {
          // P3.1: surface coverage validity at the top level for easy polling
          coverageValid:        pass2.coverageValidation.valid,
          pass1BlocksExtracted: pass1.blocks.length,
          topicsCreated:        pass2.topics.length,
          microNodesCreated:    totalNodes,
          exercisesCreated:     totalExercises,
          unmappedBlocks:       pass2.unmappedBlockIndices.length,
          mappingReport,
          // P3.3: persist full Pass-1 block array so any missingIndices can later
          // be resolved to their original blockType / sourceText / page metadata.
          pass1Blocks:          pass1.blocks,
          topics: topicRows.map((t) => ({
            id:       t.id,
            sequence: t.sequence,
            title:    t.title,
            nodes:    nodeRows
              .filter((n) => n.topicId === t.id)
              .map((n) => ({ id: n.id, sequence: n.sequence, title: n.title })),
          })),
          pass2Diagnostics:     pass2.diagnostics,
        } as any,
        updatedAt: new Date(),
      })
      .where(eq(mappingJobsTable.id, job.id));

    logger.info(
      {
        jobId:           job.id,
        lessonId,
        jobStatus,
        coverageValid:   pass2.coverageValidation.valid,
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
    const preservedDiagnosticFailure = err instanceof MappingZeroMicroNodesError
      ? {
          progress: "Detailed mapping produced zero valid MicroNodes; existing mapping was preserved.",
          reason: "ZERO_MICRONODES_PRE_PERSISTENCE",
          diagnostics: err.diagnostics,
        }
      : err instanceof MappingPass2ParserError
        ? {
            progress: "Pass 2 response could not be parsed; existing mapping was preserved.",
            reason: "PASS2_JSON_PARSE_FAILED_PRE_PERSISTENCE",
            diagnostics: err.diagnostics,
          }
        : null;
    await db.update(mappingJobsTable)
      .set({
        status: "failed",
        error: getTeacherFacingMappingFailure(err),
        ...(preservedDiagnosticFailure ? {
          progress: preservedDiagnosticFailure.progress,
          result: {
            reason: preservedDiagnosticFailure.reason,
            pass2Diagnostics: preservedDiagnosticFailure.diagnostics,
          } as any,
        } : {}),
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
router.post("/lessons/:lessonId/generate-teaching-content", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  // Fetch all MicroNodes (fast DB read — done synchronously before responding)
  const allNodes = await db
    .select({
      id:                        lessonNodesTable.id,
      title:                     lessonNodesTable.title,
      learningObjective:         lessonNodesTable.learningObjective,
      theoryContent:             lessonNodesTable.theoryContent,
      blockType:                 lessonNodesTable.blockType,
      status:                    lessonNodesTable.status,
      childFriendlyExplanation:  lessonNodesTable.childFriendlyExplanation,
    })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence));

  // Only process nodes that are missing Phase 2 content — never overwrite completed nodes.
  const nodes = allNodes.filter((n) => !n.childFriendlyExplanation);

  if (allNodes.length === 0) {
    res.status(400).json({ error: "No MicroNodes found — run /map first" });
    return;
  }
  if (nodes.length === 0) {
    res.status(400).json({ error: "All MicroNodes already have Phase 2 content — nothing to generate" });
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
        // No status gate here — the teacher's explicit click on "Generate Teaching Content"
        // IS the review action. The real quality gate is isWeakSource() inside
        // generatePhase2Content(), which rejects nodes whose theoryContent is too thin.
        // This allows Phase 2 to run on freshly-mapped (draft) nodes without requiring
        // individual teacher approval of each node first.
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
        const nodeTitle = nodes.find((n) => n.id === result.nodeId)?.title ?? "";
        if (result.skipped && result.skipReason === "skipped_needs_review") {
          // Teacher has not yet reviewed this node — do NOT touch its status
          summaryRows.push({
            nodeId:     result.nodeId,
            title:      nodeTitle,
            status:     "skipped_needs_review",
            confidence: null,
            sourceType: "—",
            skipReason: result.skipReason,
          });
        } else if (result.skipped) {
          // Source content too thin — mark accordingly
          await db
            .update(lessonNodesTable)
            .set({ status: "needs_source_content" })
            .where(eq(lessonNodesTable.id, result.nodeId));

          summaryRows.push({
            nodeId:     result.nodeId,
            title:      nodeTitle,
            status:     "needs_source_content",
            confidence: null,
            sourceType: "—",
            skipReason: result.skipReason,
          });
        } else {
          // Success — write the 4 Set A fields, using "don't degrade" semantics:
          // never overwrite a non-empty field with an empty/null AI response.
          // This preserves Phase 2 data from a prior run when the AI returns
          // a partial result (e.g. empty basicExamples for a borderline-thin node).
          const phase2Updates: Record<string, unknown> = { status: "approved" as const };
          if (result.childFriendlyExplanation?.trim())
            phase2Updates.childFriendlyExplanation = result.childFriendlyExplanation;
          if (Array.isArray(result.basicExamples) && result.basicExamples.length > 0)
            phase2Updates.basicExamples = result.basicExamples;
          if (result.commonMisconception?.trim())
            phase2Updates.commonMisconception = result.commonMisconception;
          if (Array.isArray(result.nonExamples) && result.nonExamples.length > 0)
            phase2Updates.nonExamples = result.nonExamples;

          await db
            .update(lessonNodesTable)
            .set(phase2Updates)
            .where(eq(lessonNodesTable.id, result.nodeId));

          summaryRows.push({
            nodeId:     result.nodeId,
            title:      nodeTitle,
            status:     "approved",
            confidence: null,
            sourceType: "textbook",
          });
        }
      }
    }

    const approved              = summaryRows.filter((r) => r.status === "approved").length;
    const needsSourceCount      = summaryRows.filter((r) => r.status === "needs_source_content").length;
    const skippedReviewCount    = summaryRows.filter((r) => r.status === "skipped_needs_review").length;

    await db.update(mappingJobsTable)
      .set({
        status: "completed",
        result: {
          lessonId,
          lessonTitle:         lesson.title,
          totalNodes:          nodes.length,
          approved,
          needsSourceContent:  needsSourceCount,
          skippedNeedsReview:  skippedReviewCount,
          summary:             summaryRows,
        } as any,
        updatedAt: new Date(),
      })
      .where(eq(mappingJobsTable.id, job.id));

    logger.info(
      { jobId: job.id, lessonId, total: nodes.length, approved, needsSource: needsSourceCount, skippedReview: skippedReviewCount },
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
router.get("/lessons/:lessonId/map-status", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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
router.get("/lessons/:lessonId/generate-status", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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
router.post("/lessons/:lessonId/p6-summary", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
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
            interactionType:      null,
            correctAnswer:        null,
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

router.post("/lessons/:lessonId/manual-map", requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson id" }); return; }
  const [lesson] = await db.select({
    goalOutcomeReviewStatus: lessonsTable.goalOutcomeReviewStatus,
  }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }
  if (requiresGoalOutcomeConfirmation(lesson)) {
    res.status(409).json({
      error: "GOAL_OUTCOME_CONFIRMATION_REQUIRED",
      message: "Նախ հաստատեք դասի նպատակը և վերջնարդյունքները, ապա ներմուծեք մանրամասն քարտեզագրումը։",
    });
    return;
  }

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

// ── GET /api/lessons/:lessonId/quizzes ────────────────────────────────────────
// Phase 1.9 — return quizzes linked to a lesson via quiz_lesson_links.
// Teacher-only. Returns metadata suitable for the Lesson card / authoring UI.
// Each quiz appears exactly once regardless of how many lessons it links to.
router.get("/lessons/:lessonId/quizzes", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson id" });
    return;
  }

  // Verify lesson exists (no ownership check — teachers can view any linked quiz
  // they own; the quiz join below implicitly scopes to teacher-owned quizzes).
  const [lesson] = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);
  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Join quiz_lesson_links → quizzes and count questions — single query, no N+1.
  const rows = await db
    .select({
      quizId:        quizzesTable.id,
      title:         quizzesTable.title,
      status:        quizzesTable.status,
      quizType:      quizzesTable.quizType,
      difficultyMode: quizzesTable.difficultyMode,
      classId:       quizzesTable.classId,
      createdAt:     quizzesTable.createdAt,
    })
    .from(quizLessonLinksTable)
    .innerJoin(quizzesTable, eq(quizzesTable.id, quizLessonLinksTable.quizId))
    .where(eq(quizLessonLinksTable.lessonId, lessonId))
    .orderBy(desc(quizzesTable.createdAt));

  // Batch-load question counts, assignment stats, and score averages — same
  // aggregation pattern as GET /api/quizzes so the lesson-linked cards show
  // the same live completion state as the global Tests section.
  const quizIds = rows.map((r) => r.quizId);
  const qCounts:      Record<number, number>         = {};
  const assignStats:  Record<number, { totalAssigned: number; completedCount: number }> = {};
  const scoreStats:   Record<number, number | null>  = {};

  if (quizIds.length > 0) {
    // Question counts
    const countRows = await db
      .select({ quizId: quizQuestionsTable.quizId, cnt: count(quizQuestionsTable.id) })
      .from(quizQuestionsTable)
      .where(inArray(quizQuestionsTable.quizId, quizIds))
      .groupBy(quizQuestionsTable.quizId);
    for (const r of countRows) qCounts[r.quizId] = Number(r.cnt);

    // Assignment stats: totalAssigned + completedCount per quiz
    const aRows = await db
      .select({
        quizId:         quizAssignmentsTable.quizId,
        totalAssigned:  sql<number>`cast(count(*) as integer)`,
        completedCount: sql<number>`cast(count(*) filter (where ${quizAssignmentsTable.status} = 'COMPLETED') as integer)`,
      })
      .from(quizAssignmentsTable)
      .where(inArray(quizAssignmentsTable.quizId, quizIds))
      .groupBy(quizAssignmentsTable.quizId);
    for (const r of aRows) assignStats[r.quizId] = { totalAssigned: r.totalAssigned, completedCount: r.completedCount };

    // Average score per quiz (completed attempts only)
    const sRows = await db
      .select({
        quizId:              quizAssignmentsTable.quizId,
        averageScorePercent: sql<number | null>`round(avg(${quizAttemptsTable.scorePercent}))`,
      })
      .from(quizAttemptsTable)
      .innerJoin(quizAssignmentsTable, eq(quizAssignmentsTable.id, quizAttemptsTable.quizAssignmentId))
      .where(inArray(quizAssignmentsTable.quizId, quizIds))
      .groupBy(quizAssignmentsTable.quizId);
    for (const r of sRows) scoreStats[r.quizId] = r.averageScorePercent ?? null;
  }

  res.json(rows.map((r) => ({
    id:                  r.quizId,
    title:               r.title,
    status:              r.status,
    quizType:            r.quizType ?? null,
    difficultyMode:      r.difficultyMode,
    classId:             r.classId ?? null,
    questionCount:       qCounts[r.quizId]               ?? 0,
    createdAt:           r.createdAt.toISOString(),
    totalAssigned:       assignStats[r.quizId]?.totalAssigned   ?? 0,
    completedCount:      assignStats[r.quizId]?.completedCount  ?? 0,
    averageScorePercent: scoreStats[r.quizId]              ?? null,
  })));
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2A R3: Cognitive Path routes
// ─────────────────────────────────────────────────────────────────────────────

/** Helper: verify node belongs to lesson and exists. Returns node or null. */
async function getCogNode(lessonId: number, nodeId: number) {
  const [node] = await db
    .select({
      id: lessonNodesTable.id,
      title: lessonNodesTable.title,
      learningObjective: lessonNodesTable.learningObjective,
      theoryContent: lessonNodesTable.theoryContent,
      blockType: lessonNodesTable.blockType,
      targetBloomLevel: lessonNodesTable.targetBloomLevel,
      childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
      basicExamples: lessonNodesTable.basicExamples,
      topicId: lessonNodesTable.topicId,
    })
    .from(lessonNodesTable)
    .where(and(eq(lessonNodesTable.id, nodeId), eq(lessonNodesTable.lessonId, lessonId)))
    .limit(1);
  return node ?? null;
}

// GET /lessons/:lessonId/nodes/:nodeId/cognitive-path
// Returns all cognitive levels for a MicroNode with their linked exercises.
router.get("/lessons/:lessonId/nodes/:nodeId/cognitive-path", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId   = parseInt(String(req.params.nodeId),   10);
  if (isNaN(lessonId) || isNaN(nodeId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const node = await getCogNode(lessonId, nodeId);
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  // Fetch cogPathStatus for this node (Phase 2A R3 confirmation state)
  const [nodeStatusRow] = await db
    .select({ cogPathStatus: (lessonNodesTable as any).cogPathStatus })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, nodeId))
    .limit(1);
  const cogPathStatus = (nodeStatusRow as any)?.cogPathStatus ?? null;

  // Load levels ordered by sequence
  const levels = await db
    .select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId))
    .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));

  if (levels.length === 0) {
    res.json({ nodeId, cogPathStatus, levels: [] });
    return;
  }

  // Load tasks for all levels + their exercise details in one pass
  const levelIds = levels.map((l) => l.id);
  const tasks = await db
    .select({
      id:              lessonNodeCognitiveTasksTable.id,
      cognitiveLevelId: lessonNodeCognitiveTasksTable.cognitiveLevelId,
      lessonExerciseId: lessonNodeCognitiveTasksTable.lessonExerciseId,
      taskProvenance:  lessonNodeCognitiveTasksTable.taskProvenance,
      notes:           lessonNodeCognitiveTasksTable.notes,
      exerciseId:      lessonExercisesTable.exerciseId,
      exerciseText:    lessonExercisesTable.exerciseTextVerbatim,
      exerciseTextEdited: lessonExercisesTable.exerciseTextEdited,
    })
    .from(lessonNodeCognitiveTasksTable)
    .leftJoin(lessonExercisesTable, eq(lessonExercisesTable.id, lessonNodeCognitiveTasksTable.lessonExerciseId))
    .where(inArray(lessonNodeCognitiveTasksTable.cognitiveLevelId, levelIds));

  const tasksByLevel = new Map<number, typeof tasks>();
  for (const t of tasks) {
    const arr = tasksByLevel.get(t.cognitiveLevelId) ?? [];
    arr.push(t);
    tasksByLevel.set(t.cognitiveLevelId, arr);
  }

  res.json({
    nodeId,
    cogPathStatus,
    levels: levels.map((l) => ({
      ...l,
      preferredInteractionTypes: (l.preferredInteractionTypes ?? []) as string[],
      tasks: (tasksByLevel.get(l.id) ?? []).map((t) => ({
        id:              t.id,
        cognitiveLevelId: t.cognitiveLevelId,
        lessonExerciseId: t.lessonExerciseId,
        taskProvenance:  t.taskProvenance,
        notes:           t.notes,
        exercise: t.exerciseId ? {
          exerciseId:          t.exerciseId,
          exerciseTextVerbatim: t.exerciseText ?? "",
          exerciseTextEdited:  t.exerciseTextEdited ?? null,
        } : null,
      })),
    })),
  });
});

// POST /lessons/:lessonId/nodes/:nodeId/generate-cognitive-path
// Generate (or safely regenerate) the cognitive path for a MicroNode.
// Body: { force?: boolean }
//   force=false (default): returns 409 if teacher-authored rows exist
//   force=true: replaces all existing levels (use after explicit teacher confirmation)
router.post("/lessons/:lessonId/nodes/:nodeId/generate-cognitive-path", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId   = parseInt(String(req.params.nodeId),   10);
  if (isNaN(lessonId) || isNaN(nodeId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const node = await getCogNode(lessonId, nodeId);
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const force = !!(req.body as { force?: boolean })?.force;

  // Regeneration safety: check for teacher-authored rows
  const existingLevels = await db
    .select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId))
    .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));

  const [priorStatusRow] = await db
    .select({ cogPathStatus: (lessonNodesTable as any).cogPathStatus, hasTc: lessonNodesTable.childFriendlyExplanation })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, nodeId))
    .limit(1);
  const priorIsConfirmed = (priorStatusRow as any)?.cogPathStatus === "confirmed";
  const priorHasTc = !!((priorStatusRow as any)?.hasTc);

  const hasTeacherEdits = existingLevels.some((l) => l.provenance === "teacher_authored");
  if ((hasTeacherEdits || priorIsConfirmed) && !force) {
    res.status(409).json({
      error: "TEACHER_EDITS_EXIST",
      isConfirmed: priorIsConfirmed,
      message: priorIsConfirmed
        ? "Oucutsichn hastatatsrel e channachogakan ughiny. Vertasteghtsele kartsne hastatumey?"
        : "Oucutsichn ardem khmbagrel e channachogakan ughiny. Vertasteghtsele kartsne khmbaghrumnery?",
    });
    return;
  }

  // Build full context for AI generation
  const [lesson] = await db
    .select({ title: lessonsTable.title, subjectId: lessonsTable.subjectId })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  const [subject] = await db
    .select({ name: subjectsTable.name })
    .from(subjectsTable)
    .where(eq(subjectsTable.id, lesson?.subjectId ?? 0))
    .limit(1);

  const topicRow = node.topicId
    ? await db.select({ title: lessonTopicsTable.title }).from(lessonTopicsTable).where(eq(lessonTopicsTable.id, node.topicId)).limit(1).then((r) => r[0] ?? null)
    : null;

  const nodeExercises = await db
    .select({ exerciseId: lessonExercisesTable.exerciseId, exerciseTextVerbatim: lessonExercisesTable.exerciseTextVerbatim })
    .from(lessonExercisesTable)
    .where(and(eq(lessonExercisesTable.lessonId, lessonId), eq(lessonExercisesTable.relatedNodeId, nodeId)));

  const input: CogPathInput = {
    nodeId:            node.id,
    title:             node.title,
    learningObjective: node.learningObjective ?? null,
    theoryContent:     node.theoryContent ?? null,
    blockType:         node.blockType ?? null,
    subjectName:       subject?.name ?? "Unknown Subject",
    lessonTitle:       lesson?.title ?? "Unknown Lesson",
    topicTitle:        topicRow?.title ?? null,
    childFriendlyExplanation: (node as any).childFriendlyExplanation ?? null,
    basicExamples:     (node as any).basicExamples ?? null,
    exercises:         nodeExercises.map((e): CogPathExercise => ({ exerciseId: e.exerciseId, exerciseText: e.exerciseTextVerbatim })),
    existingLevels:    existingLevels.length > 0 ? existingLevels.map((l) => ({
      cognitiveLevel:       l.cognitiveLevel,
      sequence:             l.sequence,
      isTargetCeiling:      l.isTargetCeiling,
      performanceObjective: l.performanceObjective,
      successCriterion:     l.successCriterion,
    })) : undefined,
  };

  const result = await generateCognitivePath(input);

  if (result.skipped) {
    res.status(422).json({ error: "SKIP", skipReason: result.skipReason, message: result.skipReason });
    return;
  }

  // Persist: delete old levels (cascade removes tasks), insert new ones
  await db.delete(lessonNodeCognitiveLevelsTable).where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId));

  let newCeilingLevel: string | undefined;
  for (const level of result.levels) {
    await db.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId:             nodeId,
      cognitiveLevel:           level.cognitiveLevel,
      sequence:                 level.sequence,
      isApplicable:             true,
      isTargetCeiling:          level.isTargetCeiling,
      performanceObjective:     level.performanceObjective || null,
      successCriterion:         level.successCriterion || null,
      provenance:               "ai_generated",
      minimumIndependentEvidence: level.minimumIndependentEvidence,
      preferredInteractionTypes:  level.preferredInteractionTypes,
    });
    if (level.isTargetCeiling) newCeilingLevel = level.cognitiveLevel;
  }

  // Sync legacy targetBloomLevel for backward compat
  if (newCeilingLevel && COGNITIVE_LEVEL_TO_BLOOM_INT[newCeilingLevel as keyof typeof COGNITIVE_LEVEL_TO_BLOOM_INT]) {
    await db
      .update(lessonNodesTable)
      .set({ targetBloomLevel: COGNITIVE_LEVEL_TO_BLOOM_INT[newCeilingLevel as keyof typeof COGNITIVE_LEVEL_TO_BLOOM_INT] })
      .where(eq(lessonNodesTable.id, nodeId));
  }

  // Phase 2A R3: set cogPathStatus = 'needs_review'; if was confirmed + TC exists → mark stale
  const cogStatusUpdates: Record<string, unknown> = { cogPathStatus: "needs_review" };
  if (priorIsConfirmed && priorHasTc) cogStatusUpdates.teachingContentStale = true;
  await db.update(lessonNodesTable).set(cogStatusUpdates).where(eq(lessonNodesTable.id, nodeId));

  logger.info({ lessonId, nodeId, levelCount: result.levels.length }, "cognitive path generated");

  // Return the freshly-persisted path (same shape as GET)
  const saved = await db
    .select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId))
    .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));

  res.json({
    nodeId,
    cogPathStatus: "needs_review",
    levels: saved.map((l) => ({
      ...l,
      preferredInteractionTypes: (l.preferredInteractionTypes ?? []) as string[],
      tasks: [],
    })),
  });
});

// POST /lessons/:lessonId/nodes/:nodeId/confirm-cognitive-path
// Teacher explicitly confirms the cognitive path. Requirements: ≥1 level, exactly 1 ceiling.
// Sets cogPathStatus = 'confirmed' on lesson_nodes.
router.post("/lessons/:lessonId/nodes/:nodeId/confirm-cognitive-path", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId   = parseInt(String(req.params.nodeId),   10);
  if (isNaN(lessonId) || isNaN(nodeId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const node = await getCogNode(lessonId, nodeId);
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const levels = await db
    .select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId));

  if (levels.length === 0) {
    res.status(422).json({ error: "NO_LEVELS", message: "Channachogakan ughine bats e. Nakhapez ksteghtsi." });
    return;
  }
  const ceilings = levels.filter((l) => l.isTargetCeiling);
  if (ceilings.length !== 1) {
    res.status(422).json({ error: "CEILING_REQUIRED", message: `Petq e lini kovki mek thirakayin macardak. Ayzhm: ${ceilings.length}.` });
    return;
  }

  await db.update(lessonNodesTable).set({ cogPathStatus: "confirmed" } as any).where(eq(lessonNodesTable.id, nodeId));
  res.json({ cogPathStatus: "confirmed", nodeId });
});

// POST /lessons/:lessonId/nodes/:nodeId/cognitive-levels
// Add a single cognitive level (teacher-authored). Invalidates confirmed path.
router.post("/lessons/:lessonId/nodes/:nodeId/cognitive-levels", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId   = parseInt(String(req.params.nodeId),   10);
  if (isNaN(lessonId) || isNaN(nodeId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const node = await getCogNode(lessonId, nodeId);
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const { cognitiveLevel, performanceObjective, successCriterion, minimumIndependentEvidence, preferredInteractionTypes } = req.body as {
    cognitiveLevel?: string;
    performanceObjective?: string;
    successCriterion?: string;
    minimumIndependentEvidence?: number;
    preferredInteractionTypes?: string[];
  };
  if (!cognitiveLevel) { res.status(400).json({ error: "cognitiveLevel required" }); return; }

  const existing = await db
    .select({ seq: lessonNodeCognitiveLevelsTable.sequence })
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId));
  const nextSeq = existing.length > 0 ? Math.max(...existing.map((r) => r.seq)) + 1 : 1;

  const [inserted] = await db.insert(lessonNodeCognitiveLevelsTable).values({
    lessonNodeId: nodeId,
    cognitiveLevel,
    sequence: nextSeq,
    isApplicable: true,
    isTargetCeiling: false,
    performanceObjective: performanceObjective ?? null,
    successCriterion: successCriterion ?? null,
    provenance: "teacher_authored",
    minimumIndependentEvidence: minimumIndependentEvidence ?? 3,
    preferredInteractionTypes: preferredInteractionTypes ?? [],
  }).returning();

  await invalidateCogPathConfirmation(nodeId);

  res.status(201).json({ ...inserted, preferredInteractionTypes: (inserted.preferredInteractionTypes ?? []) as string[], tasks: [] });
});

// POST /lessons/:lessonId/nodes/:nodeId/cognitive-levels/reorder
// Reorder cognitive levels by providing the new ordered level ID array.
router.post("/lessons/:lessonId/nodes/:nodeId/cognitive-levels/reorder", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId   = parseInt(String(req.params.nodeId),   10);
  if (isNaN(lessonId) || isNaN(nodeId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const node = await getCogNode(lessonId, nodeId);
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const { orderedLevelIds } = req.body as { orderedLevelIds?: number[] };
  if (!Array.isArray(orderedLevelIds) || orderedLevelIds.length === 0) {
    res.status(400).json({ error: "orderedLevelIds required" });
    return;
  }

  // Two-pass update to avoid unique-sequence constraint violations during reorder
  await db.transaction(async (tx) => {
    const offset = orderedLevelIds.length + 1000;
    for (let i = 0; i < orderedLevelIds.length; i++) {
      await tx.update(lessonNodeCognitiveLevelsTable)
        .set({ sequence: offset + i })
        .where(and(eq(lessonNodeCognitiveLevelsTable.id, orderedLevelIds[i]), eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId)));
    }
    for (let i = 0; i < orderedLevelIds.length; i++) {
      await tx.update(lessonNodeCognitiveLevelsTable)
        .set({ sequence: i + 1 })
        .where(and(eq(lessonNodeCognitiveLevelsTable.id, orderedLevelIds[i]), eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId)));
    }
  });

  await invalidateCogPathConfirmation(nodeId);
  res.json({ reordered: orderedLevelIds.length });
});

// POST /lessons/:lessonId/nodes/:nodeId/cognitive-levels/:levelId/update
// Partial update of a cognitive level (marks it teacher_authored).
router.post("/lessons/:lessonId/nodes/:nodeId/cognitive-levels/:levelId/update", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId   = parseInt(String(req.params.nodeId),   10);
  const levelId  = parseInt(String(req.params.levelId),  10);
  if (isNaN(lessonId) || isNaN(nodeId) || isNaN(levelId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const node = await getCogNode(lessonId, nodeId);
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const [level] = await db
    .select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.id, levelId), eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId)))
    .limit(1);
  if (!level) { res.status(404).json({ error: "Cognitive level not found" }); return; }

  const body = req.body as {
    performanceObjective?:     string;
    successCriterion?:         string;
    minimumIndependentEvidence?: number;
    preferredInteractionTypes?:  string[];
    isTargetCeiling?:          boolean;
    isApplicable?:             boolean;
  };

  const updates: Record<string, unknown> = { provenance: "teacher_authored", updatedAt: new Date() };
  if (body.performanceObjective    !== undefined) updates.performanceObjective    = body.performanceObjective    || null;
  if (body.successCriterion        !== undefined) updates.successCriterion        = body.successCriterion        || null;
  if (body.minimumIndependentEvidence !== undefined) updates.minimumIndependentEvidence = Math.max(1, body.minimumIndependentEvidence);
  if (body.preferredInteractionTypes !== undefined) updates.preferredInteractionTypes = body.preferredInteractionTypes;
  if (body.isApplicable            !== undefined) updates.isApplicable            = body.isApplicable;
  if (body.isTargetCeiling === true) {
    // Clear any existing ceiling first (bypass partial-unique-index constraint)
    await db
      .update(lessonNodeCognitiveLevelsTable)
      .set({ isTargetCeiling: false, updatedAt: new Date() })
      .where(and(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId), eq(lessonNodeCognitiveLevelsTable.isTargetCeiling, true)));
    updates.isTargetCeiling = true;
    // Sync legacy targetBloomLevel
    const bloomInt = COGNITIVE_LEVEL_TO_BLOOM_INT[level.cognitiveLevel as keyof typeof COGNITIVE_LEVEL_TO_BLOOM_INT];
    if (bloomInt) await db.update(lessonNodesTable).set({ targetBloomLevel: bloomInt }).where(eq(lessonNodesTable.id, nodeId));
  } else if (body.isTargetCeiling === false) {
    updates.isTargetCeiling = false;
  }

  if (Object.keys(updates).length === 2) { res.status(400).json({ error: "No updatable fields provided" }); return; }

  await db.update(lessonNodeCognitiveLevelsTable).set(updates).where(eq(lessonNodeCognitiveLevelsTable.id, levelId));

  // Invalidate confirmation if this node's cog path was confirmed
  await invalidateCogPathConfirmation(nodeId);

  const [updated] = await db
    .select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(eq(lessonNodeCognitiveLevelsTable.id, levelId))
    .limit(1);

  res.json({ success: true, level: { ...updated, preferredInteractionTypes: (updated.preferredInteractionTypes ?? []) as string[] } });
});

// DELETE /lessons/:lessonId/nodes/:nodeId/cognitive-levels/:levelId
// Remove a cognitive level (and cascade-deletes its linked tasks).
router.delete("/lessons/:lessonId/nodes/:nodeId/cognitive-levels/:levelId", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId   = parseInt(String(req.params.nodeId),   10);
  const levelId  = parseInt(String(req.params.levelId),  10);
  if (isNaN(lessonId) || isNaN(nodeId) || isNaN(levelId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const node = await getCogNode(lessonId, nodeId);
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const [level] = await db
    .select({ id: lessonNodeCognitiveLevelsTable.id })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.id, levelId), eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId)))
    .limit(1);
  if (!level) { res.status(404).json({ error: "Level not found" }); return; }

  // Invalidate confirmation before deleting (must check confirmed state first)
  await invalidateCogPathConfirmation(nodeId);
  await db.delete(lessonNodeCognitiveLevelsTable).where(eq(lessonNodeCognitiveLevelsTable.id, levelId));
  res.json({ success: true });
});

// POST /lessons/:lessonId/nodes/:nodeId/cognitive-tasks
// Link an existing lesson_exercise to a cognitive level of this node.
// Body: { cognitiveLevelId: number, lessonExerciseId: number }
router.post("/lessons/:lessonId/nodes/:nodeId/cognitive-tasks", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId   = parseInt(String(req.params.nodeId),   10);
  if (isNaN(lessonId) || isNaN(nodeId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const node = await getCogNode(lessonId, nodeId);
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const { cognitiveLevelId, lessonExerciseId } = req.body as { cognitiveLevelId?: number; lessonExerciseId?: number };
  if (!cognitiveLevelId) { res.status(400).json({ error: "cognitiveLevelId required" }); return; }

  // Verify level belongs to this node
  const [level] = await db
    .select({ id: lessonNodeCognitiveLevelsTable.id })
    .from(lessonNodeCognitiveLevelsTable)
    .where(and(eq(lessonNodeCognitiveLevelsTable.id, cognitiveLevelId), eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId)))
    .limit(1);
  if (!level) { res.status(404).json({ error: "Cognitive level not found on this node" }); return; }

  // Verify exercise belongs to this lesson (if provided)
  if (lessonExerciseId) {
    const [ex] = await db
      .select({ id: lessonExercisesTable.id })
      .from(lessonExercisesTable)
      .where(and(eq(lessonExercisesTable.id, lessonExerciseId), eq(lessonExercisesTable.lessonId, lessonId)))
      .limit(1);
    if (!ex) { res.status(404).json({ error: "Exercise not found in this lesson" }); return; }
  }

  try {
    const [task] = await db
      .insert(lessonNodeCognitiveTasksTable)
      .values({
        cognitiveLevelId,
        lessonExerciseId: lessonExerciseId ?? null,
        taskProvenance: "source_derived",
      })
      .returning();
    res.status(201).json({ success: true, task });
  } catch (err: unknown) {
    const msg = String((err as Error)?.message ?? "");
    if (msg.includes("lnct_level_exercise_uniq")) {
      res.status(409).json({ error: "Exercise already linked to this cognitive level" });
    } else {
      throw err;
    }
  }
});

// DELETE /lessons/:lessonId/nodes/:nodeId/cognitive-tasks/:taskId
// Unlink a task annotation (does NOT delete the exercise itself).
router.delete("/lessons/:lessonId/nodes/:nodeId/cognitive-tasks/:taskId", requireAuth, requireLessonAuthor, async (req: AuthRequest, res) => {
  const lessonId = parseInt(String(req.params.lessonId), 10);
  const nodeId   = parseInt(String(req.params.nodeId),   10);
  const taskId   = parseInt(String(req.params.taskId),   10);
  if (isNaN(lessonId) || isNaN(nodeId) || isNaN(taskId)) { res.status(400).json({ error: "Invalid ids" }); return; }

  const node = await getCogNode(lessonId, nodeId);
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  // Verify task belongs to a level of this node
  const [task] = await db
    .select({ id: lessonNodeCognitiveTasksTable.id })
    .from(lessonNodeCognitiveTasksTable)
    .innerJoin(lessonNodeCognitiveLevelsTable, eq(lessonNodeCognitiveLevelsTable.id, lessonNodeCognitiveTasksTable.cognitiveLevelId))
    .where(and(eq(lessonNodeCognitiveTasksTable.id, taskId), eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId)))
    .limit(1);
  if (!task) { res.status(404).json({ error: "Task not found on this node" }); return; }

  await db.delete(lessonNodeCognitiveTasksTable).where(eq(lessonNodeCognitiveTasksTable.id, taskId));
  res.json({ success: true });
});

export default router;