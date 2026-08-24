/**
 * P1.7 — Final Lesson Approval Validation Gate
 *
 * Single authoritative validator called by POST /lessons/:lessonId/final-approve.
 * Never calls AI. Reads only persisted DB state.
 * Returns { errors, overrideable, warnings } — errors block approval,
 * overrideable issues require an explicit teacher decision, warnings do not.
 */
import {
  db,
  lessonsTable,
  lessonNodesTable,
  lessonTopicsTable,
  lessonExercisesTable,
  lessonOutcomesTable,
  lessonOutcomeNodeAlignmentsTable,
  lessonNodeCognitiveLevelsTable,
} from "@workspace/db";
import { eq, asc, inArray } from "drizzle-orm";
import { detectCompoundLO, detectMegaNode } from "./granularity-heuristics.js";
import { validateCognitivePathGrounding } from "./cognitive-path-grounding.js";

export interface ValidationIssue {
  code: string;
  messageArm: string;   // Armenian teacher-facing text
  nodeId?: number;
  nodeTitle?: string;
  count?: number;
}

export interface LessonValidationResult {
  /** Canonical readiness classification for the current persisted lesson state. */
  readiness: "READY" | "REVIEW_REQUIRED" | "BLOCKED";
  errors: ValidationIssue[];
  /** Issues that are safe only when the teacher explicitly accepts the tradeoff. */
  overrideable: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Summary counts for the final report */
  summary: {
    totalNodes: number;
    approvedNodes: number;
    totalTopics: number;
    sourceExercises: number;
    approvedSourceExercises: number;
    draftSourceExercises: number;
    phase2CompleteNodes: number;
    missingLONodes: number;
    emptyNodes: number;
  };
}

/**
 * P1.7 Rule A — Learning Objectives: every approved node must have a non-empty LO.
 * Reuses Phase 1.5 constraint semantics.
 */
function isLOValid(lo: string | null | undefined): boolean {
  return !!(lo?.trim());
}

/**
 * P1.7 Rule B — Non-empty MicroNode: approved node must have theory or verbatim anchor.
 * Conservative: short but non-blank content is accepted.
 */
function isNodeContentPresent(node: {
  theoryContent: string | null | undefined;
  verbatimTheoryAnchor: string | null | undefined;
}): boolean {
  return !!(node.theoryContent?.trim() || node.verbatimTheoryAnchor?.trim());
}

/**
 * P1.7 Rule G — Phase 2 completeness: approved nodes must have all four core enrichment fields.
 * Required fields: childFriendlyExplanation, commonMisconception, basicExamples (≥1), nonExamples (≥1).
 */
function phase2MissingFields(node: {
  childFriendlyExplanation: string | null | undefined;
  commonMisconception: string | null | undefined;
  basicExamples: unknown;
  nonExamples: unknown;
}): string[] {
  const missing: string[] = [];
  if (!node.childFriendlyExplanation?.trim()) missing.push("childFriendlyExplanation");
  if (!node.commonMisconception?.trim()) missing.push("commonMisconception");
  if (!Array.isArray(node.basicExamples) || node.basicExamples.length === 0) missing.push("basicExamples");
  if (!Array.isArray(node.nonExamples) || node.nonExamples.length === 0) missing.push("nonExamples");
  return missing;
}

/**
 * P1.7 Rule C — Sequence validity helper.
 * Sequences must be contiguous 1,2,...N with no duplicates, gaps, zeros, or negatives.
 */
function findSequenceErrors(seqs: number[]): "DUPLICATE" | "GAP" | "ZERO_NEGATIVE" | null {
  if (seqs.length === 0) return null;
  const sorted = [...seqs].sort((a, b) => a - b);
  if (sorted.some((s) => s <= 0)) return "ZERO_NEGATIVE";
  const unique = new Set(sorted);
  if (unique.size !== sorted.length) return "DUPLICATE";
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) return "GAP";
  }
  return null;
}

/**
 * Main validator — deterministic, read-only, no AI.
 */
export async function validateLessonForFinalApproval(
  lessonId: number
): Promise<LessonValidationResult> {
  const errors: ValidationIssue[] = [];
  const overrideable: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // ── Load all authoritative data ─────────────────────────────────────────────
  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);
  if (!lesson) throw new Error(`Lesson ${lessonId} not found`);

  const nodes = await db
    .select()
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence));

  const topics = await db
    .select()
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId))
    .orderBy(asc(lessonTopicsTable.sequence));

  const exercises = await db
    .select()
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, lessonId));

  const [canonicalOutcomes, outcomeAlignments] = await Promise.all([
    db.select({ id: lessonOutcomesTable.id })
      .from(lessonOutcomesTable)
      .where(eq(lessonOutcomesTable.lessonId, lessonId)),
    db.select({
      lessonOutcomeId: lessonOutcomeNodeAlignmentsTable.lessonOutcomeId,
      lessonNodeId: lessonOutcomeNodeAlignmentsTable.lessonNodeId,
      role: lessonOutcomeNodeAlignmentsTable.role,
    }).from(lessonOutcomeNodeAlignmentsTable)
      .where(eq(lessonOutcomeNodeAlignmentsTable.lessonId, lessonId)),
  ]);

  // Final approval is the teacher's one explicit acceptance action. Current
  // canonical content—not a routine per-node approval flag—determines whether
  // a mapped node is safe to deliver.
  const approvedNodes = nodes;
  const sourceExercises = exercises.filter((e) => e.sourceType === "textbook");
  const draftSourceExercises = sourceExercises.filter((e) => e.status !== "approved");
  const phase2CompleteNodes = approvedNodes.filter(
    (n) => phase2MissingFields(n as any).length === 0
  );
  const metadata = (lesson.mappingMetadata ?? {}) as Record<string, any>;
  const instructionalCoverage = metadata?.quality?.instructionalCoverage;
  const sourceScope = metadata?.quality?.sourceAudit?.sourceScope;
  const sourceSet = metadata?.quality?.sourceAudit?.sourceSet;
  const sourceAlignment = metadata?.quality?.sourceAlignment;

  if (sourceScope?.valid !== true || sourceSet?.titleMatch?.valid !== true) {
    errors.push({
      code: "UNVERIFIED_LESSON_SOURCE_SCOPE",
      messageArm: "Դասի քարտեզի աղբյուրը չի հաստատվել ընտրված դասագրքի և PDF-ի էջերի համար։",
    });
  }
  if (nodes.length === 0) {
    errors.push({
      code: "NO_MICRONODES",
      messageArm: "Դասը պետք է ունենա առնվազն մեկ MicroNode՝ վերջնական հաստատման համար։",
    });
  }
  if (instructionalCoverage && instructionalCoverage.valid !== true) {
    const unresolved = Array.isArray(instructionalCoverage.unresolvedInstructionalIndices)
      ? instructionalCoverage.unresolvedInstructionalIndices.length
      : 0;
    errors.push({
      code: "UNRESOLVED_INSTRUCTIONAL_SOURCE",
      messageArm: `Ընթեռնելի ուսումնական աղբյուրից ${unresolved} հատված MicroNode-ի պատասխանատու չունի։`,
      count: unresolved,
    });
  }
  if (Array.isArray(sourceAlignment?.nodes)) {
    const currentNodeIds = new Set(nodes.map((node) => node.id));
    const unresolvedSourceNodes = sourceAlignment.nodes.filter(
      (entry: { nodeId?: number; status?: string; reviewStatus?: string }) =>
        currentNodeIds.has(entry.nodeId ?? -1)
        && (entry.status === "INSUFFICIENT" || entry.status === "UNREADABLE")
        && entry.reviewStatus !== "RESOLVED_BY_TEACHER",
    );
    if (unresolvedSourceNodes.length > 0) {
      errors.push({
        code: "MICRONODE_SOURCE_ALIGNMENT_REQUIRED",
        messageArm: "Յուրաքանչյուր MicroNode պետք է բավարար չափով հիմնավորվի իր հաստատված աղբյուրով։",
        count: unresolvedSourceNodes.length,
      });
    }
  }
  if (Array.isArray(sourceAlignment?.nodes)) {
    const safeReviewCount = sourceAlignment.nodes.filter(
      (entry: { nodeId?: number; status?: string }) =>
        nodes.some((node) => node.id === entry.nodeId) && entry.status === "PARTIAL",
    ).length;
    if (safeReviewCount > 0) {
      warnings.push({
        code: "MICRONODE_SOURCE_ALIGNMENT_REVIEW_REQUIRED",
        messageArm: `${safeReviewCount} MicroNode-ի աղբյուրային կապը խորհուրդ է տրվում վերանայել։`,
        count: safeReviewCount,
      });
    }
  }
  const outcomeAlignmentAudit = metadata?.quality?.outcomeAlignmentAudit;
  if (
    outcomeAlignmentAudit?.persistedAlignments > 0 &&
    outcomeAlignmentAudit.requiresTeacherReview === true &&
    !outcomeAlignmentAudit.reviewedAt
  ) {
    // Final approval is the teacher's single explicit acceptance action. An
    // existing, source-safe automatic relation that only retains its old review
    // marker is advisory; it cannot force a second per-alignment approval step.
    warnings.push({
      code: "AUTOMATIC_OUTCOME_ALIGNMENT_REVIEW_REQUIRED",
      messageArm: "Outcome–MicroNode ավտոմատ կապերը խորհուրդ է տրվում վերանայել։ Դրանք չեն խանգարում դասի վերջնական հաստատմանը։",
    });
  }

  // Goal/Outcome edits are reviewed as part of the one delivery decision, not
  // through a separate confirmation gate. The persisted state remains visible
  // for audit, while the teacher explicitly accepts it only when assigning the
  // lesson.
  if (
    (lesson as any).goalOutcomeReviewStatus !== "legacy" &&
    (lesson as any).goalOutcomeReviewStatus !== "confirmed"
  ) {
    overrideable.push({
      code: "GOAL_OUTCOME_REVIEW_REQUIRED",
      messageArm: "Դասի նպատակն ու վերջնարդյունքները փոխվել են և խորհուրդ է տրվում վերանայել։",
    });
  }

  // Mapped canonical Outcomes without a REQUIRED relation are a teacher-review
  // concern, not permission to manufacture a relationship. A teacher may accept
  // the lesson as-is at assignment time; the canonical graph is left untouched.
  if (
    canonicalOutcomes.length > 0 &&
    nodes.length > 0
  ) {
    const requiredOutcomeIds = new Set(
      outcomeAlignments
        .filter((alignment) =>
          alignment.role === "REQUIRED"
          && nodes.some((node) => node.id === alignment.lessonNodeId),
        )
        .map((alignment) => alignment.lessonOutcomeId),
    );
    for (const outcome of canonicalOutcomes) {
      if (!requiredOutcomeIds.has(outcome.id)) {
        overrideable.push({
          code: "OUTCOME_WITHOUT_REQUIRED_NODE",
          messageArm: "Վերջնարդյունքներից մեկը դեռ REQUIRED MicroNode կապ չունի։",
        });
      }
    }
  }

  // ── A: Learning Objectives ──────────────────────────────────────────────────
  const missingLONodes = approvedNodes.filter((n) => !isLOValid(n.learningObjective));
  for (const node of missingLONodes) {
    errors.push({
      code: "MISSING_LO",
      messageArm: `Ուusumnatanumahy npataky bacakayum e · «${node.title}»`,
      nodeId: node.id,
      nodeTitle: node.title,
    });
  }

  // ── B: Empty MicroNodes ─────────────────────────────────────────────────────
  const emptyNodes = approvedNodes.filter(
    (n) => !isNodeContentPresent(n as any)
  );
  for (const node of emptyNodes) {
    errors.push({
      code: "EMPTY_NODE",
      messageArm: `Hastavarvats hangyuts datark e · «${node.title}»`,
      nodeId: node.id,
      nodeTitle: node.title,
    });
  }

  // ── C: Sequence validity ────────────────────────────────────────────────────
  const topicSeqErr = findSequenceErrors(topics.map((t) => t.sequence));
  if (topicSeqErr) {
    errors.push({
      code: `INVALID_TOPIC_SEQUENCE_${topicSeqErr}`,
      messageArm:
        topicSeqErr === "DUPLICATE"
          ? "Katvakumn en tema ardyunabanutyan kargery"
          : topicSeqErr === "GAP"
          ? "Tema ardyunabanutyan kargin mas bacakayum e"
          : "Tema ardyunabanutyan kargy skhaly e (zero/batsasakan)",
    });
  }

  const nodeSeqErr = findSequenceErrors(nodes.map((n) => n.sequence));
  if (nodeSeqErr) {
    errors.push({
      code: `INVALID_NODE_SEQUENCE_${nodeSeqErr}`,
      messageArm:
        nodeSeqErr === "DUPLICATE"
          ? "Katvakumn en hanguyts ardyunabanutyan kargery"
          : nodeSeqErr === "GAP"
          ? "Hanguyts ardyunabanutyan kargin mas bacakayum e"
          : "Hanguyts ardyunabanutyan kargy skhaly e (zero/batsasakan)",
    });
  }

  // ── D/E: Source integrity + Lost exercises ──────────────────────────────────
  // All textbook exercises must have a valid sourceBlockIndex (provenance not lost).
  const orphanedTextbook = sourceExercises.filter((e) => e.sourceBlockIndex === null);
  if (orphanedTextbook.length > 0) {
    errors.push({
      code: "LOST_SOURCE_IDENTITY",
      messageArm: `Aghjuray varjutyunner kharmanym blocki bnaginaky bacakayum e · ${orphanedTextbook.length}`,
      count: orphanedTextbook.length,
    });
  }

  // Check against mappingMetadata.sourceExerciseCount if persisted
  const meta = (lesson.mappingMetadata ?? {}) as Record<string, unknown>;
  const expectedSourceCount = typeof meta.sourceExerciseCount === "number" ? meta.sourceExerciseCount : null;
  const currentSourceCount = sourceExercises.length;
  if (expectedSourceCount !== null && currentSourceCount < expectedSourceCount) {
    const lost = expectedSourceCount - currentSourceCount;
    errors.push({
      code: "LOST_SOURCE_EXERCISES",
      messageArm: `Khumaregayin aghbyuray varjutyunner (lost) · ${lost}`,
      count: lost,
    });
  }

  // ── F: Exercise approval states ─────────────────────────────────────────────
  if (draftSourceExercises.length > 0) {
    warnings.push({
      code: "DRAFT_SOURCE_EXERCISES_REVIEW_REQUIRED",
      messageArm: `Աղբյուրային ${draftSourceExercises.length} վարժություն խորհուրդ է տրվում վերանայել։`,
      count: draftSourceExercises.length,
    });
  }

  // ── G: Phase 2 enrichment ───────────────────────────────────────────────────
  const nodesNeedingPhase2 = approvedNodes.filter(
    (n) => phase2MissingFields(n as any).length > 0
  );
  for (const node of nodesNeedingPhase2) {
    const missing = phase2MissingFields(node as any);
    overrideable.push({
      code: "MISSING_PHASE2",
      messageArm: `Phase 2 pataratsma tvaynery bacakayum en (${missing.length}) · «${node.title}»`,
      nodeId: node.id,
      nodeTitle: node.title,
      count: missing.length,
    });
  }

  // C1 Fix #6: a source-aligned automatic mapping must not bypass Cognitive
  // Path grounding or explicit teacher confirmation. Legacy/manual lessons do
  // not acquire this new requirement retroactively.
  if (Array.isArray(sourceAlignment?.nodes) && sourceAlignment.nodes.length > 0 && approvedNodes.length > 0) {
    const nodeIds = approvedNodes.map((node) => node.id);
    const cognitiveLevels = await db.select()
      .from(lessonNodeCognitiveLevelsTable)
      .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeIds));
    for (const node of approvedNodes) {
      const levels = cognitiveLevels.filter((level) => level.lessonNodeId === node.id);
      if (levels.length === 0 || levels.filter((level) => level.isTargetCeiling).length !== 1) {
        warnings.push({
          code: "COGNITIVE_PATH_INVALID",
          messageArm: `«${node.title}» MicroNode-ի ճանաչողական ուղին բացակայում է կամ ամբողջական չէ և խորհուրդ է տրվում վերանայել։`,
          nodeId: node.id,
          nodeTitle: node.title,
        });
        continue;
      }
      const grounding = validateCognitivePathGrounding(
        node.theoryContent,
        node.learningObjective,
        levels.map((level) => ({
          performanceObjective: level.performanceObjective,
          successCriterion: level.successCriterion,
          preferredInteractionTypes: (level.preferredInteractionTypes ?? []) as string[],
        })),
      );
      if (!grounding.valid) {
        warnings.push({
          code: "COGNITIVE_PATH_GROUNDING_INVALID",
          messageArm: `«${node.title}» MicroNode-ի ճանաչողական ուղին պահանջում է վերանայում՝ աղբյուրի սահմանների պատճառով։`,
          nodeId: node.id,
          nodeTitle: node.title,
        });
      } else if (grounding.status === "REVIEW_REQUIRED" || (node as any).cogPathStatus !== "confirmed") {
        warnings.push({
          code: "COGNITIVE_PATH_REVIEW_REQUIRED",
          messageArm: `«${node.title}» MicroNode-ի ճանաչողական ուղին խորհուրդ է տրվում վերանայել։`,
          nodeId: node.id,
          nodeTitle: node.title,
        });
      }
    }
  }

  // ── Warnings: Phase 1.5 advisory signals ───────────────────────────────────
  for (const node of approvedNodes) {
    if (!node.learningObjective?.trim()) continue; // already blocked above
    const compound = detectCompoundLO(node.learningObjective);
    const mega = detectMegaNode(node.learningObjective);
    if (compound?.flagged) {
      warnings.push({
        code: "COMPOUND_LO",
        messageArm: `Haytnvum e mek ej mi kavm npatakner · «${node.title}»`,
        nodeId: node.id,
        nodeTitle: node.title,
      });
    }
    if (mega?.flagged) {
      warnings.push({
        code: "MEGA_NODE",
        messageArm: `Khorin mega-node nerazank · «${node.title}»`,
        nodeId: node.id,
        nodeTitle: node.title,
      });
    }
  }

  return {
    readiness: errors.length > 0
      ? "BLOCKED"
      : overrideable.length > 0 || warnings.length > 0
        ? "REVIEW_REQUIRED"
        : "READY",
    errors,
    overrideable,
    warnings,
    summary: {
      totalNodes: nodes.length,
      approvedNodes: approvedNodes.length,
      totalTopics: topics.length,
      sourceExercises: currentSourceCount,
      approvedSourceExercises: sourceExercises.filter((e) => e.status === "approved").length,
      draftSourceExercises: draftSourceExercises.length,
      phase2CompleteNodes: phase2CompleteNodes.length,
      missingLONodes: missingLONodes.length,
      emptyNodes: emptyNodes.length,
    },
  };
}
