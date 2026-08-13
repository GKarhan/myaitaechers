/**
 * P1.7 — Final Lesson Approval Validation Gate
 *
 * Single authoritative validator called by POST /lessons/:lessonId/final-approve.
 * Never calls AI. Reads only persisted DB state.
 * Returns { errors, warnings } — errors block approval, warnings do not.
 */
import { db, lessonsTable, lessonNodesTable, lessonTopicsTable, lessonExercisesTable } from "@workspace/db";
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

  const approvedNodes = nodes.filter((n) => n.status === "approved");
  const sourceExercises = exercises.filter((e) => e.sourceType === "textbook");
  const draftSourceExercises = sourceExercises.filter((e) => e.status !== "approved");
  const phase2CompleteNodes = approvedNodes.filter(
    (n) => phase2MissingFields(n as any).length === 0
  );

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
    if (compound?.isCompound) {
      warnings.push({
        code: "COMPOUND_LO",
        messageArm: `Haytnvum e mek ej mi kavm npatakner · «${node.title}»`,
        nodeId: node.id,
        nodeTitle: node.title,
      });
    }
    if (mega?.isMegaNode) {
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
