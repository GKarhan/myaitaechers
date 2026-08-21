/**
 * P1.7 — Final Lesson Approval Validation Gate
 *
 * Single authoritative validator called by POST /lessons/:lessonId/final-approve.
 * Never calls AI. Reads only persisted DB state.
 * Returns { errors, warnings } — errors block approval, warnings do not.
 */
import {
  db,
  lessonsTable,
  lessonNodesTable,
  lessonTopicsTable,
  lessonExercisesTable,
  lessonOutcomesTable,
  lessonOutcomeNodeAlignmentsTable,
} from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { detectCompoundLO, detectMegaNode } from "./granularity-heuristics.js";

export interface ValidationIssue {
  code: string;
  messageArm: string;   // Armenian teacher-facing text
  nodeId?: number;
  nodeTitle?: string;
  count?: number;
}

export interface LessonValidationResult {
  errors: ValidationIssue[];
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
      role: lessonOutcomeNodeAlignmentsTable.role,
    }).from(lessonOutcomeNodeAlignmentsTable)
      .where(eq(lessonOutcomeNodeAlignmentsTable.lessonId, lessonId)),
  ]);

  const approvedNodes = nodes.filter((n) => n.status === "approved");
  const sourceExercises = exercises.filter((e) => e.sourceType === "textbook");
  const draftSourceExercises = sourceExercises.filter((e) => e.status !== "approved");
  const phase2CompleteNodes = approvedNodes.filter(
    (n) => phase2MissingFields(n as any).length === 0
  );
  const metadata = (lesson.mappingMetadata ?? {}) as Record<string, any>;
  const instructionalCoverage = metadata?.quality?.instructionalCoverage;
  const sourceScope = metadata?.quality?.sourceAudit?.sourceScope;
  const sourceSet = metadata?.quality?.sourceAudit?.sourceSet;

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
  const unreviewedNodes = nodes.filter((node) => node.status !== "approved");
  if (unreviewedNodes.length > 0) {
    errors.push({
      code: "UNREVIEWED_MICRONODES",
      messageArm: `${unreviewedNodes.length} MicroNode դեռ ուսուցչի կողմից հաստատված չէ։`,
      count: unreviewedNodes.length,
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
  const outcomeAlignmentAudit = metadata?.quality?.outcomeAlignmentAudit;
  if (
    outcomeAlignmentAudit?.persistedAlignments > 0 &&
    outcomeAlignmentAudit.requiresTeacherReview === true &&
    !outcomeAlignmentAudit.reviewedAt
  ) {
    errors.push({
      code: "AUTOMATIC_OUTCOME_ALIGNMENT_REVIEW_REQUIRED",
      messageArm: "Ավտոմատ ստեղծված Outcome–MicroNode կապերը պետք է ուսուցչի կողմից վերանայվեն մինչև վերջնական հաստատումը։",
    });
  }

  // Package 1C: legacy lessons retain their established approval behavior.
  // Once a teacher explicitly starts canonical Goal/Outcome review, however,
  // final approval cannot bypass the same explicit confirmation that protects
  // detailed mapping generation.
  if (
    (lesson as any).goalOutcomeReviewStatus !== "legacy" &&
    (lesson as any).goalOutcomeReviewStatus !== "confirmed"
  ) {
    errors.push({
      code: "GOAL_OUTCOME_CONFIRMATION_REQUIRED",
      messageArm: "Դասի նպատակը և վերջնարդյունքները պետք է ուսուցչի կողմից հաստատվեն մինչև վերջնական հաստատումը։",
    });
  }

  // Goal/Outcome confirmation deliberately happens before detailed mapping.
  // Once mapping has produced MicroNodes, though, final approval must require
  // every canonical Outcome to have a REQUIRED mapping relation.
  if (
    (lesson as any).goalOutcomeReviewStatus === "confirmed" &&
    nodes.length > 0
  ) {
    const requiredOutcomeIds = new Set(
      outcomeAlignments
        .filter((alignment) => alignment.role === "REQUIRED")
        .map((alignment) => alignment.lessonOutcomeId),
    );
    for (const outcome of canonicalOutcomes) {
      if (!requiredOutcomeIds.has(outcome.id)) {
        errors.push({
          code: "OUTCOME_WITHOUT_REQUIRED_NODE",
          messageArm: "Յուրաքանչյուր վերջնարդյունք պետք է ունենա առնվազն մեկ REQUIRED MicroNode՝ վերջնական հաստատումից առաջ։",
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
    errors.push({
      code: "DRAFT_SOURCE_EXERCISES",
      messageArm: `Chakatagrvacu aghbyuray varjutyunner · ${draftSourceExercises.length}`,
      count: draftSourceExercises.length,
    });
  }

  // ── G: Phase 2 enrichment ───────────────────────────────────────────────────
  const nodesNeedingPhase2 = approvedNodes.filter(
    (n) => phase2MissingFields(n as any).length > 0
  );
  for (const node of nodesNeedingPhase2) {
    const missing = phase2MissingFields(node as any);
    errors.push({
      code: "MISSING_PHASE2",
      messageArm: `Phase 2 pataratsma tvaynery bacakayum en (${missing.length}) · «${node.title}»`,
      nodeId: node.id,
      nodeTitle: node.title,
      count: missing.length,
    });
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
    errors,
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
