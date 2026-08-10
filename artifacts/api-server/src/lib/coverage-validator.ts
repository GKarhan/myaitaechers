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
    /** Total placements in exercises across all MicroNodes. */
    exercises: number;
    /** Total placements in supportingMaterialIndices across all MicroNodes. */
    supportingMaterial: number;
    /** Total placements in unmappedBlockIndices across all topics. */
    unmapped: number;
  };
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
  const categoryCounts = { source: 0, exercises: 0, supportingMaterial: 0, unmapped: 0 };

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
