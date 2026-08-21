// ─────────────────────────────────────────────────────────────────────────────
// Deterministic Source-Coverage Validator
//
// Computes block-level coverage entirely from Pass1/Pass2 index arrays —
// independent of the AI self-report (`unmappedBlocks` count).
//
// Algorithm:
//   • Walk all topics → microNodes → sourceBlockIndices / exercises /
//     supportingMaterialIndices, and topic → unmappedBlockIndices.
//   • Build a seenMap: blockIndex → placement labels (to detect duplicates).
//   • Derive: missing, duplicate, invalid indices; empty MicroNodes; counts.
//
// The validator never throws. It always returns a structured result.
// ─────────────────────────────────────────────────────────────────────────────

export interface CoverageValidationResult {
  /** True only when there are zero missing, duplicate, invalid or empty-MN issues. */
  valid: boolean;
  totalBlocks: number;
  coveredBlocks: number;
  /** Rounded integer 0-100. */
  coveragePercent: number;
  /** Block indices that appear in no category at all. */
  missingIndices: number[];
  /** Block indices that appear in more than one placement slot. */
  duplicateIndices: number[];
  /** Block indices that fall outside [0, totalBlocks). */
  invalidIndices: number[];
  /** Titles of MicroNodes whose sourceBlockIndices array is empty. */
  emptyMicroNodeTitles: string[];
  categoryCounts: {
    /** Total placements in sourceBlockIndices across all MicroNodes. */
    source: number;
    /** Total placements in exercises[] across all MicroNodes. */
    exercises: number;
    /** Total placements in additionalExercises across all topics
     *  (exercises with no dedicated MicroNode). */
    additionalExercises: number;
    /** Total placements in supportingMaterialIndices across all MicroNodes. */
    supportingMaterial: number;
    /** Total placements in unmappedBlockIndices across all topics. */
    unmapped: number;
  };
}

/**
 * The instructional-coverage layer intentionally has stricter semantics than
 * placement coverage. A block in `unmappedBlockIndices` is structurally placed,
 * but it is not necessarily safe to consider it taught.
 */
export type SourceDisposition =
  | "MICRONODE_OWNED"
  | "EXERCISE_OWNED"
  | "LEGITIMATE_NON_INSTRUCTIONAL"
  | "UNREADABLE"
  | "UNRESOLVED";

export interface SourceDispositionRecord {
  blockIndex: number;
  blockType: string;
  sourcePage: number;
  disposition: SourceDisposition;
  reason:
    | "MICRONODE_SOURCE_OWNER"
    | "EXERCISE_OWNER"
    | "STRUCTURAL_HEADING"
    | "SUPPORTING_VISUAL"
    | "NO_READABLE_TEXT"
    | "INSTRUCTIONAL_BLOCK_NOT_MICRONODE_OWNED"
    | "ACTIVITY_BLOCK_NOT_EXERCISE_OWNED";
}

export interface InstructionalCoverageResult {
  valid: boolean;
  readableInstructionalBlocks: number;
  microNodeOwnedInstructionalBlocks: number;
  unresolvedInstructionalIndices: number[];
  unresolvedActivityIndices: number[];
  dispositionCounts: Record<SourceDisposition, number>;
  /** Safe, structural per-block audit; deliberately excludes source text. */
  blocks: SourceDispositionRecord[];
}

export interface SourceCoverageBlock {
  blockType: string;
  sourceText: string;
  sourcePage: number;
}

// Minimal structural interfaces — avoids importing from lesson-mapping to
// keep the validator dependency-free and easy to unit-test.
export interface ValidatorMicroNode {
  title: string;
  sourceBlockIndices: ReadonlyArray<number>;
  exercises: ReadonlyArray<{ blockIndex: number }>;
  supportingMaterialIndices: ReadonlyArray<number>;
}

export interface ValidatorTopic {
  microNodes: ReadonlyArray<ValidatorMicroNode>;
  unmappedBlockIndices: ReadonlyArray<number>;
  /** Exercises preserved without a dedicated MicroNode (no source block exists for them).
   *  Their blockIndices are counted as covered but never trigger emptyMicroNode errors. */
  additionalExercises?: ReadonlyArray<{ blockIndex: number }>;
}

const ACTIVITY_TYPES = new Set(["EXERCISE", "ACTIVITY", "HOMEWORK"]);
const VISUAL_SUPPORT_TYPES = new Set(["IMAGE", "CAPTION", "TABLE"]);
const ALWAYS_INSTRUCTIONAL_TYPES = new Set(["DEFINITION", "RULE", "EXAMPLE", "WARNING", "EXCEPTION"]);

/**
 * Pass 1 represents both textual headings and instructional statements as NOTE
 * or OBJECTIVE. Keep short title-like labels out of MicroNode requirements, but
 * never use length alone to discard a short rule/definition.
 */
export function isLikelyStructuralHeading(block: SourceCoverageBlock): boolean {
  if (!["NOTE", "OBJECTIVE"].includes(block.blockType)) return false;
  const text = block.sourceText.trim();
  if (text.length === 0 || text.length > 30) return false;
  if (/[.!?։]/u.test(text)) return false;
  const standaloneCopula = /(?:^|\s)(?:է|են)(?:$|\s)/u.test(text);
  const instructionalMarker = /(?:կանոն|նշանակ|կոչ|ինչպես|պետք|կարող|գտ|որոշ|կիրառ|բացատր)/iu.test(text);
  return !standaloneCopula && !instructionalMarker;
}

export function requiresMicroNodeOwnership(block: SourceCoverageBlock): boolean {
  if (!block.sourceText.trim()) return false;
  if (ACTIVITY_TYPES.has(block.blockType) || VISUAL_SUPPORT_TYPES.has(block.blockType)) return false;
  if (ALWAYS_INSTRUCTIONAL_TYPES.has(block.blockType)) return true;
  return !isLikelyStructuralHeading(block);
}

/**
 * Server-owned semantic coverage audit. This never relies on the provider's
 * reason strings and never returns source text, generated titles, or objectives.
 */
export function validateInstructionalCoverage(
  blocks: ReadonlyArray<SourceCoverageBlock>,
  topics: ReadonlyArray<ValidatorTopic>,
): InstructionalCoverageResult {
  const microNodeOwners = new Set<number>();
  const exerciseOwners = new Set<number>();
  for (const topic of topics) {
    for (const node of topic.microNodes) {
      for (const index of node.sourceBlockIndices) microNodeOwners.add(index);
      for (const exercise of node.exercises) exerciseOwners.add(exercise.blockIndex);
    }
    for (const exercise of topic.additionalExercises ?? []) exerciseOwners.add(exercise.blockIndex);
  }

  const dispositionCounts: Record<SourceDisposition, number> = {
    MICRONODE_OWNED: 0,
    EXERCISE_OWNED: 0,
    LEGITIMATE_NON_INSTRUCTIONAL: 0,
    UNREADABLE: 0,
    UNRESOLVED: 0,
  };
  const unresolvedInstructionalIndices: number[] = [];
  const unresolvedActivityIndices: number[] = [];
  const records: SourceDispositionRecord[] = [];

  blocks.forEach((block, blockIndex) => {
    let disposition: SourceDisposition;
    let reason: SourceDispositionRecord["reason"];
    if (!block.sourceText.trim()) {
      disposition = "UNREADABLE";
      reason = "NO_READABLE_TEXT";
    } else if (ACTIVITY_TYPES.has(block.blockType)) {
      if (exerciseOwners.has(blockIndex)) {
        disposition = "EXERCISE_OWNED";
        reason = "EXERCISE_OWNER";
      } else {
        disposition = "UNRESOLVED";
        reason = "ACTIVITY_BLOCK_NOT_EXERCISE_OWNED";
        unresolvedActivityIndices.push(blockIndex);
      }
    } else if (requiresMicroNodeOwnership(block)) {
      if (microNodeOwners.has(blockIndex)) {
        disposition = "MICRONODE_OWNED";
        reason = "MICRONODE_SOURCE_OWNER";
      } else {
        disposition = "UNRESOLVED";
        reason = "INSTRUCTIONAL_BLOCK_NOT_MICRONODE_OWNED";
        unresolvedInstructionalIndices.push(blockIndex);
      }
    } else if (VISUAL_SUPPORT_TYPES.has(block.blockType)) {
      disposition = "LEGITIMATE_NON_INSTRUCTIONAL";
      reason = "SUPPORTING_VISUAL";
    } else {
      disposition = "LEGITIMATE_NON_INSTRUCTIONAL";
      reason = "STRUCTURAL_HEADING";
    }
    dispositionCounts[disposition]++;
    records.push({
      blockIndex,
      blockType: block.blockType,
      sourcePage: block.sourcePage,
      disposition,
      reason,
    });
  });

  const readableInstructionalBlocks = blocks.filter(requiresMicroNodeOwnership).length;
  return {
    valid: unresolvedInstructionalIndices.length === 0 && unresolvedActivityIndices.length === 0,
    readableInstructionalBlocks,
    microNodeOwnedInstructionalBlocks: dispositionCounts.MICRONODE_OWNED,
    unresolvedInstructionalIndices,
    unresolvedActivityIndices,
    dispositionCounts,
    blocks: records,
  };
}

/**
 * Run the deterministic coverage validator.
 *
 * @param totalBlocks  Length of the Pass1 `blocks[]` array.
 * @param topics       Pass2 topic results (each with microNodes + unmappedBlockIndices).
 */
export function validateSourceCoverage(
  totalBlocks: number,
  topics: ReadonlyArray<ValidatorTopic>,
): CoverageValidationResult {
  // seenMap: blockIndex → array of human-readable placement labels
  // (used to detect duplicates without losing context for debugging)
  const seenMap = new Map<number, string[]>();
  const emptyMicroNodeTitles: string[] = [];
  const categoryCounts = { source: 0, exercises: 0, additionalExercises: 0, supportingMaterial: 0, unmapped: 0 };

  function record(idx: number, label: string): void {
    const existing = seenMap.get(idx);
    if (existing) {
      existing.push(label);
    } else {
      seenMap.set(idx, [label]);
    }
  }

  for (const topic of topics) {
    for (const mn of topic.microNodes) {
      if (mn.sourceBlockIndices.length === 0) {
        emptyMicroNodeTitles.push(mn.title);
      }
      for (const i of mn.sourceBlockIndices) {
        record(i, `src:${mn.title}`);
        categoryCounts.source++;
      }
      for (const ex of mn.exercises) {
        record(ex.blockIndex, `ex:${mn.title}`);
        categoryCounts.exercises++;
      }
      for (const i of mn.supportingMaterialIndices) {
        record(i, `sup:${mn.title}`);
        categoryCounts.supportingMaterial++;
      }
    }
    for (const i of topic.unmappedBlockIndices) {
      record(i, "unmapped");
      categoryCounts.unmapped++;
    }
    for (const ex of topic.additionalExercises ?? []) {
      record(ex.blockIndex, "additionalEx");
      categoryCounts.additionalExercises++;
    }
  }

  const allSeenIndices = [...seenMap.keys()];

  // Invalid: outside valid index range [0, totalBlocks)
  const invalidIndices = allSeenIndices.filter((i) => i < 0 || i >= totalBlocks);
  const invalidSet = new Set(invalidIndices);

  // Duplicate: seen more than once, and not already flagged as invalid
  const duplicateIndices = allSeenIndices.filter(
    (i) => !invalidSet.has(i) && seenMap.get(i)!.length > 1,
  );

  // Missing: valid indices [0, totalBlocks) that never appeared in seenMap
  const validSeenSet = new Set(allSeenIndices.filter((i) => !invalidSet.has(i)));
  const missingIndices: number[] = [];
  for (let i = 0; i < totalBlocks; i++) {
    if (!validSeenSet.has(i)) missingIndices.push(i);
  }

  const coveredBlocks = validSeenSet.size;
  const coveragePercent =
    totalBlocks > 0 ? Math.round((coveredBlocks / totalBlocks) * 100) : 100;

  const valid =
    missingIndices.length === 0 &&
    duplicateIndices.length === 0 &&
    invalidIndices.length === 0 &&
    emptyMicroNodeTitles.length === 0;

  return {
    valid,
    totalBlocks,
    coveredBlocks,
    coveragePercent,
    missingIndices,
    duplicateIndices,
    invalidIndices,
    emptyMicroNodeTitles,
    categoryCounts,
  };
}
