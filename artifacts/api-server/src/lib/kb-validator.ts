/**
 * Phase 9 — Knowledge Base Validation
 *
 * Deterministic, DB-driven, read-only validator that answers:
 * "Is this lesson structurally safe and complete enough for AI Teacher consumption?"
 *
 * CONTRACT:
 * - Zero AI calls — pure DB reads + deterministic logic.
 * - Zero DB writes — purely observational.
 * - Idempotent — same data → same result, always.
 * - All core gate functions are pure (no DB) and fully unit-testable.
 *
 * Reuses detectCycle() from sequential-deps.ts for Graph gate (Gate 6).
 */

import { detectCycle } from "./sequential-deps";

// ─────────────────────────────────────────────────────────────────────────────
// Gate result types
// ─────────────────────────────────────────────────────────────────────────────

export interface KbCoverageGate {
  valid: boolean;
  coveragePercent: number;
  /** True only when the selected resource/pages and all persisted blocks were source-scoped. */
  sourceScopeValid?: boolean;
  /** Block indices missing from coverage (empty when not persisted in metadata). */
  missingSourceBlocks: number[];
  /** Readable instructional blocks that do not have a MicroNode owner. */
  unresolvedInstructionalBlocks?: number;
  /** Human-readable note for architecture gaps (e.g. missing metadata). */
  note?: string;
}

export interface KbActivityGate {
  /** Number of activities the mapping pipeline originally produced (from metadata). */
  sourceCount: number;
  /** Number of activity rows currently in DB. */
  storedCount: number;
  assignedCount: number;
  additionalCount: number;
  /** sourceCount - storedCount; 0 means no activities were lost. */
  lostCount: number;
  /**
   * Number of exercises that share a sourceBlockIndex with another exercise in
   * the same lesson — indicates a double-insertion of the same source block.
   * Does NOT use fuzzy text matching.
   */
  duplicateCount: number;
  valid: boolean;
}

export interface KbMicroNodeGate {
  total: number;
  /** Nodes whose title is null or whitespace-only. */
  emptyTitleCount: number;
  /** Nodes whose theoryContent is null or whitespace-only. */
  emptyCount: number;
  /** Count of non-positive or duplicate sequence values within the lesson. */
  invalidSequenceCount: number;
  valid: boolean;
}

export interface KbPhase2Gate {
  approvedNodeCount: number;
  /** Approved nodes missing at least one mandatory Phase 2 field. */
  missingEnrichmentCount: number;
  /** IDs of approved nodes with missing enrichment. */
  missingEnrichmentNodeIds: number[];
  valid: boolean;
}

export interface KbDependencyGate {
  total: number;
  /** Number of node IDs referenced in deps that do not exist in the lesson. */
  invalidReferenceCount: number;
  selfDependencyCount: number;
  duplicateEdgeCount: number;
  cycleDetected: boolean;
  valid: boolean;
}

export interface KbValidationResult {
  valid: boolean;
  lessonId: number;
  sourceCoverage: KbCoverageGate;
  activities: KbActivityGate;
  microNodes: KbMicroNodeGate;
  phase2: KbPhase2Gate;
  dependencies: KbDependencyGate;
  errors: string[];
  warnings: string[];
  /**
   * True only when ALL gates pass AND at least one node is approved with
   * complete Phase 2 enrichment. "Mapped" ≠ "ready for AI Teacher".
   */
  readyForAiTeacher: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure gate functions (no DB — fully unit-testable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate 1 — Source Coverage.
 * Reads persisted coverage result from mapping_metadata.
 * Does NOT call validateSourceCoverage() (which requires in-memory Pass2 data);
 * instead uses the result stored during the last mapping job.
 */
export function gateSourceCoverage(mappingMetadata: unknown): KbCoverageGate {
  if (!mappingMetadata || typeof mappingMetadata !== "object") {
    return {
      valid: false,
      coveragePercent: 0,
      missingSourceBlocks: [],
      note: "No mapping metadata — lesson has not been mapped yet.",
    };
  }
  const meta = mappingMetadata as Record<string, any>;
  const cv = meta?.quality?.coverageValidation;
  if (!cv) {
    return {
      valid: false,
      coveragePercent: 0,
      missingSourceBlocks: [],
      note: "Coverage validation absent from mapping_metadata — architecture gap.",
    };
  }
  const instructional = meta?.quality?.instructionalCoverage;
  const sourceScope = meta?.quality?.sourceAudit?.sourceScope;
  const sourceSet = meta?.quality?.sourceAudit?.sourceSet;
  const unresolvedInstructionalBlocks = Array.isArray(instructional?.unresolvedInstructionalIndices)
    ? instructional.unresolvedInstructionalIndices.length
    : 0;
  const instructionalValid = instructional === undefined || instructional?.valid === true;
  const sourceScopeValid = sourceScope?.valid === true && sourceSet?.titleMatch?.valid === true;
  return {
    valid: cv.valid === true && instructionalValid && sourceScopeValid,
    coveragePercent: typeof cv.coveragePercent === "number" ? cv.coveragePercent : 0,
    sourceScopeValid,
    // Exact missing indices are not persisted; only the validity flag is stored.
    missingSourceBlocks: Array.isArray(cv.missingIndices) ? cv.missingIndices : [],
    unresolvedInstructionalBlocks,
    note: !sourceScopeValid
      ? "Selected textbook resource/pages have no verified Source Set."
      : !instructionalValid
      ? `${unresolvedInstructionalBlocks} readable instructional source block(s) are not owned by a MicroNode.`
      : undefined,
  };
}

/**
 * Gate 2 — Activity Integrity (Phase 5 invariant: source = assigned + additional).
 *
 * @param exercises  Rows from lesson_exercises for this lesson.
 * @param sourceCount  Number of activities the pipeline originally created
 *   (from mapping_metadata.counts.exercisesCreated). If unavailable, pass null
 *   and lostCount will be reported as 0 with a warning.
 */
export function gateActivityIntegrity(
  exercises: ReadonlyArray<{
    id: number;
    relatedNodeId: number | null;
    sourceBlockIndex: number | null;
  }>,
  sourceCount: number | null,
): KbActivityGate {
  const storedCount = exercises.length;
  const assignedCount = exercises.filter((e) => e.relatedNodeId !== null).length;
  const additionalCount = exercises.filter((e) => e.relatedNodeId === null).length;
  const effectiveSource = sourceCount ?? storedCount;
  const lostCount = Math.max(0, effectiveSource - storedCount);

  // Duplicate detection: two or more exercises share the same sourceBlockIndex.
  // sourceBlockIndex is the stable source identity — no fuzzy text matching.
  const blockIndexGroups = new Map<number, number[]>();
  for (const ex of exercises) {
    if (ex.sourceBlockIndex === null) continue;
    const group = blockIndexGroups.get(ex.sourceBlockIndex) ?? [];
    group.push(ex.id);
    blockIndexGroups.set(ex.sourceBlockIndex, group);
  }
  const duplicateCount = [...blockIndexGroups.values()]
    .filter((ids) => ids.length > 1)
    .reduce((sum, ids) => sum + (ids.length - 1), 0);

  const valid = lostCount === 0 && duplicateCount === 0;
  return {
    sourceCount: effectiveSource,
    storedCount,
    assignedCount,
    additionalCount,
    lostCount,
    duplicateCount,
    valid,
  };
}

/**
 * Gate 3 + Gate 5 — MicroNode Structural Integrity + Sequence Validity.
 * Merged because both operate on the same node rows.
 *
 * Sequence scoping: the current schema uses lesson-global sequences
 * (not topic-local). Uniqueness is validated at lesson scope.
 */
export function gateMicroNodeIntegrity(
  nodes: ReadonlyArray<{
    id: number;
    title: string | null;
    theoryContent: string | null;
    sequence: number;
  }>,
): KbMicroNodeGate {
  const total = nodes.length;

  const emptyTitleCount = nodes.filter(
    (n) => !n.title || n.title.trim().length === 0,
  ).length;

  const emptyCount = nodes.filter(
    (n) => !n.theoryContent || n.theoryContent.trim().length === 0,
  ).length;

  // Sequence must be a positive integer.
  const nonPositiveCount = nodes.filter((n) => n.sequence <= 0).length;

  // Sequences must be unique within the lesson.
  const seqFrequency = new Map<number, number>();
  for (const n of nodes) {
    seqFrequency.set(n.sequence, (seqFrequency.get(n.sequence) ?? 0) + 1);
  }
  const duplicateSeqCount = [...seqFrequency.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + (count - 1), 0);

  const invalidSequenceCount = nonPositiveCount + duplicateSeqCount;

  const valid =
    total >= 1 &&
    emptyTitleCount === 0 &&
    emptyCount === 0 &&
    invalidSequenceCount === 0;

  return { total, emptyTitleCount, emptyCount, invalidSequenceCount, valid };
}

/**
 * Gate 4 — Phase 2 Enrichment.
 * Only APPROVED nodes must have all four mandatory enrichment fields.
 * Draft / needs_review nodes are not held to this standard (they are in progress).
 *
 * Mandatory fields:
 *   1. childFriendlyExplanation — non-empty string
 *   2. basicExamples            — non-empty array
 *   3. commonMisconception      — non-empty string
 *   4. nonExamples              — non-empty array
 */
export function gatePhase2Enrichment(
  nodes: ReadonlyArray<{
    id: number;
    status: string;
    childFriendlyExplanation: string | null;
    basicExamples: unknown;
    commonMisconception: string | null;
    nonExamples: unknown;
  }>,
): KbPhase2Gate {
  const approvedNodes = nodes.filter((n) => n.status === "approved");
  const approvedNodeCount = approvedNodes.length;

  const missingEnrichmentNodeIds: number[] = [];

  for (const n of approvedNodes) {
    const missing: string[] = [];

    if (!n.childFriendlyExplanation || n.childFriendlyExplanation.trim().length === 0)
      missing.push("childFriendlyExplanation");

    const be = toArray(n.basicExamples);
    if (be.length === 0) missing.push("basicExamples");

    if (!n.commonMisconception || n.commonMisconception.trim().length === 0)
      missing.push("commonMisconception");

    const ne = toArray(n.nonExamples);
    if (ne.length === 0) missing.push("nonExamples");

    if (missing.length > 0) {
      missingEnrichmentNodeIds.push(n.id);
    }
  }

  const missingEnrichmentCount = missingEnrichmentNodeIds.length;
  const valid = missingEnrichmentCount === 0;

  return {
    approvedNodeCount,
    missingEnrichmentCount,
    missingEnrichmentNodeIds,
    valid,
  };
}

/**
 * Gate 6 — Dependency Graph Validation (read-only, no AI).
 * Checks: valid node refs, lesson scope, no self-deps, no duplicate edges, no cycles.
 * Reuses detectCycle() from sequential-deps.ts.
 */
export function gateDependencies(
  deps: ReadonlyArray<{
    id: number;
    lessonId: number;
    fromNodeId: number;
    toNodeId: number;
  }>,
  lessonId: number,
  lessonNodeIds: ReadonlySet<number>,
): KbDependencyGate {
  const total = deps.length;

  // Invalid references: node IDs not in this lesson's node set
  const invalidNodeIds = new Set<number>();
  let selfDependencyCount = 0;
  const edgeSeen = new Set<string>();
  let duplicateEdgeCount = 0;
  const crossLessonDeps: number[] = [];

  for (const d of deps) {
    // Cross-lesson scope
    if (d.lessonId !== lessonId) crossLessonDeps.push(d.id);
    // Invalid node references
    if (!lessonNodeIds.has(d.fromNodeId)) invalidNodeIds.add(d.fromNodeId);
    if (!lessonNodeIds.has(d.toNodeId)) invalidNodeIds.add(d.toNodeId);
    // Self-dependency
    if (d.fromNodeId === d.toNodeId) selfDependencyCount++;
    // Duplicate edge (same from→to pair)
    const key = `${d.fromNodeId}->${d.toNodeId}`;
    if (edgeSeen.has(key)) duplicateEdgeCount++;
    else edgeSeen.add(key);
  }

  const invalidReferenceCount = invalidNodeIds.size + crossLessonDeps.length;

  // Cycle detection — reuses the DFS-based detectCycle from sequential-deps.ts
  const cycleDetected = total > 0
    ? detectCycle(deps.map((d) => ({ from: d.fromNodeId, to: d.toNodeId })))
    : false;

  const valid =
    invalidReferenceCount === 0 &&
    selfDependencyCount === 0 &&
    duplicateEdgeCount === 0 &&
    !cycleDetected;

  return {
    total,
    invalidReferenceCount,
    selfDependencyCount,
    duplicateEdgeCount,
    cycleDetected,
    valid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembler — collects errors/warnings from gate results
// ─────────────────────────────────────────────────────────────────────────────

export function assembleResult(
  lessonId: number,
  cov: KbCoverageGate,
  act: KbActivityGate,
  mn: KbMicroNodeGate,
  p2: KbPhase2Gate,
  dep: KbDependencyGate,
): KbValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Gate 1 — Coverage
  if (!cov.valid) {
    const msg = cov.note ?? `Source coverage ${cov.coveragePercent}% — invalid`;
    errors.push(`[COVERAGE] ${msg}`);
  }

  // Gate 2 — Activity Integrity
  if (act.lostCount > 0)
    errors.push(`[ACTIVITY] ${act.lostCount} activity/activities lost (sourceCount=${act.sourceCount}, storedCount=${act.storedCount})`);
  if (act.duplicateCount > 0)
    errors.push(`[ACTIVITY] ${act.duplicateCount} duplicate source block(s) detected`);
  if (act.additionalCount > 0)
    warnings.push(`[ACTIVITY] ${act.additionalCount} exercise(s) in Additional (relatedNodeId=null) — valid preservation, not an error`);

  // Gate 3 — MicroNode Integrity
  if (mn.total === 0)
    errors.push("[MICRONODE] No MicroNodes found — lesson is unmapped or empty");
  if (mn.emptyTitleCount > 0)
    errors.push(`[MICRONODE] ${mn.emptyTitleCount} MicroNode(s) have empty/null title`);
  if (mn.emptyCount > 0)
    errors.push(`[MICRONODE] ${mn.emptyCount} MicroNode(s) have empty/null theoryContent`);
  if (mn.invalidSequenceCount > 0)
    errors.push(`[SEQUENCE] ${mn.invalidSequenceCount} invalid sequence value(s) (non-positive or duplicate)`);

  // Gate 4 — Phase 2 Enrichment
  if (p2.missingEnrichmentCount > 0)
    errors.push(`[PHASE2] ${p2.missingEnrichmentCount} approved node(s) missing mandatory enrichment fields (IDs: ${p2.missingEnrichmentNodeIds.join(", ")})`);
  if (p2.approvedNodeCount === 0)
    warnings.push("[PHASE2] No approved nodes — lesson not yet teacher-reviewed; not AI Teacher ready");

  // Gate 6 — Dependencies
  if (dep.invalidReferenceCount > 0)
    errors.push(`[DEPS] ${dep.invalidReferenceCount} dependency edge(s) reference non-existent or cross-lesson nodes`);
  if (dep.selfDependencyCount > 0)
    errors.push(`[DEPS] ${dep.selfDependencyCount} self-dependency edge(s) detected`);
  if (dep.duplicateEdgeCount > 0)
    errors.push(`[DEPS] ${dep.duplicateEdgeCount} duplicate dependency edge(s) detected`);
  if (dep.cycleDetected)
    errors.push("[DEPS] Directed cycle detected in dependency graph");

  const valid = errors.length === 0;

  // readyForAiTeacher: structurally valid + at least one approved node with complete enrichment
  const readyForAiTeacher = valid && p2.approvedNodeCount > 0 && p2.valid;

  return {
    valid,
    lessonId,
    sourceCoverage: cov,
    activities: act,
    microNodes: mn,
    phase2: p2,
    dependencies: dep,
    errors,
    warnings,
    readyForAiTeacher,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-driven top-level function
// ─────────────────────────────────────────────────────────────────────────────

import { db as defaultDb } from "@workspace/db";
import {
  lessonsTable,
  lessonNodesTable,
  lessonExercisesTable,
  lessonNodeDependenciesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Validate a lesson's knowledge base from the current DB state.
 * Pure read — performs ZERO AI calls and ZERO DB writes.
 *
 * @param lessonId   The lesson to validate.
 * @param dbInstance Optionally inject a DB instance (for testing).
 */
export async function validateKnowledgeBaseLesson(
  lessonId: number,
  dbInstance: typeof defaultDb = defaultDb,
): Promise<KbValidationResult> {
  // ── 1. Fetch all required data in parallel ────────────────────────────────
  const [lessonRows, nodes, exercises, deps] = await Promise.all([
    dbInstance
      .select({ mappingMetadata: lessonsTable.mappingMetadata })
      .from(lessonsTable)
      .where(eq(lessonsTable.id, lessonId))
      .limit(1),
    dbInstance
      .select({
        id: lessonNodesTable.id,
        title: lessonNodesTable.title,
        theoryContent: lessonNodesTable.theoryContent,
        sequence: lessonNodesTable.sequence,
        status: lessonNodesTable.status,
        childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
        basicExamples: lessonNodesTable.basicExamples,
        commonMisconception: lessonNodesTable.commonMisconception,
        nonExamples: lessonNodesTable.nonExamples,
      })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.lessonId, lessonId)),
    dbInstance
      .select({
        id: lessonExercisesTable.id,
        relatedNodeId: lessonExercisesTable.relatedNodeId,
        sourceBlockIndex: lessonExercisesTable.sourceBlockIndex,
      })
      .from(lessonExercisesTable)
      .where(eq(lessonExercisesTable.lessonId, lessonId)),
    dbInstance
      .select({
        id: lessonNodeDependenciesTable.id,
        lessonId: lessonNodeDependenciesTable.lessonId,
        fromNodeId: lessonNodeDependenciesTable.fromNodeId,
        toNodeId: lessonNodeDependenciesTable.toNodeId,
      })
      .from(lessonNodeDependenciesTable)
      .where(eq(lessonNodeDependenciesTable.lessonId, lessonId)),
  ]);

  // ── 2. Extract mapping metadata ───────────────────────────────────────────
  const meta = lessonRows[0]?.mappingMetadata ?? null;
  const sourceCountFromMeta =
    (meta as any)?.counts?.exercisesCreated ?? null;

  // ── 3. Build node ID set ──────────────────────────────────────────────────
  const nodeIds = new Set<number>(nodes.map((n) => n.id));

  // ── 4. Run all gates (pure functions — no DB, no AI) ─────────────────────
  const cov = gateSourceCoverage(meta);
  const act = gateActivityIntegrity(exercises, sourceCountFromMeta);
  const mn  = gateMicroNodeIntegrity(nodes);
  const p2  = gatePhase2Enrichment(nodes);
  const dep = gateDependencies(deps, lessonId, nodeIds);

  // ── 5. Assemble final result ──────────────────────────────────────────────
  return assembleResult(lessonId, cov, act, mn, p2, dep);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
