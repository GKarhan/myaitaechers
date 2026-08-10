// ─────────────────────────────────────────────────────────────────────────────
// Activity Placement Validator — Phase 5
//
// Detects two categories of activity mis-placement that source-coverage alone
// cannot catch:
//
//   ACTIVITY_IN_THEORY   — an EXERCISE / ACTIVITY / HOMEWORK block appears in a
//                          MicroNode's sourceBlockIndices (theory) instead of
//                          exercises[] or additionalExercises[].  This makes the
//                          student-facing task invisible to the AI Teacher as an
//                          exercise and buries it in NODE_THEORY instead.
//
//   EXERCISE_IN_UNMAPPED — an EXERCISE / ACTIVITY / HOMEWORK block appears in
//                          unmappedBlockIndices.  Unmapped blocks are never
//                          inserted into lesson_exercises, so the activity is
//                          permanently lost to the AI Teacher.
//
// Both findings are HIGH severity (advisory, never block the mapping).
//
// This function is pure and dependency-free — easy to unit-test.
// ─────────────────────────────────────────────────────────────────────────────

/** Block types that represent student-facing activities. */
export const ACTIVITY_BLOCK_TYPES = new Set<string>([
  "EXERCISE",
  "ACTIVITY",
  "HOMEWORK",
]);

export interface ActivityFinding {
  blockIndex:     number;
  blockType:      string;
  blockPage:      number;
  /** First 80 chars of sourceText, newlines collapsed to spaces. */
  blockPreview:   string;
  /** Title of the MicroNode that owns this block (or "—" for unmapped). */
  microNodeTitle: string;
  issue:
    | "ACTIVITY_IN_THEORY"   // P5.1: activity block in sourceBlockIndices
    | "EXERCISE_IN_UNMAPPED"; // P5.4: activity block in unmappedBlockIndices
}

/** Minimal Pass1Block shape required for this validator. */
export interface ActivityValidatorBlock {
  blockType:   string;
  sourceText:  string;
  sourcePage:  number;
}

/** Minimal Pass2 topic shape required for this validator. */
export interface ActivityValidatorTopic {
  title:      string;
  microNodes: ReadonlyArray<{
    title:              string;
    sourceBlockIndices: ReadonlyArray<number>;
  }>;
  unmappedBlockIndices: ReadonlyArray<number>;
}

/**
 * Runs the activity placement validator.
 *
 * @param blocks    The Pass1 blocks[] array (index-addressable).
 * @param topics    The Pass2 topic results (microNodes + unmappedBlockIndices).
 * @returns         Array of ActivityFinding; empty when everything is correct.
 */
export function validateActivityPlacement(
  blocks:  ReadonlyArray<ActivityValidatorBlock>,
  topics:  ReadonlyArray<ActivityValidatorTopic>,
): ActivityFinding[] {
  const findings: ActivityFinding[] = [];

  for (const topic of topics) {
    // ── P5.1: EXERCISE/ACTIVITY/HOMEWORK in sourceBlockIndices ───────────────
    for (const mn of topic.microNodes) {
      for (const idx of mn.sourceBlockIndices) {
        const block = blocks[idx];
        if (!block) continue;
        if (!ACTIVITY_BLOCK_TYPES.has(block.blockType)) continue;

        findings.push({
          blockIndex:    idx,
          blockType:     block.blockType,
          blockPage:     block.sourcePage,
          blockPreview:  block.sourceText.slice(0, 80).replace(/\n/g, " ").trim(),
          microNodeTitle: mn.title,
          issue:         "ACTIVITY_IN_THEORY",
        });
      }
    }

    // ── P5.4: EXERCISE/ACTIVITY/HOMEWORK in unmappedBlockIndices ─────────────
    for (const idx of topic.unmappedBlockIndices) {
      const block = blocks[idx];
      if (!block) continue;
      if (!ACTIVITY_BLOCK_TYPES.has(block.blockType)) continue;

      findings.push({
        blockIndex:    idx,
        blockType:     block.blockType,
        blockPage:     block.sourcePage,
        blockPreview:  block.sourceText.slice(0, 80).replace(/\n/g, " ").trim(),
        microNodeTitle: "—",
        issue:         "EXERCISE_IN_UNMAPPED",
      });
    }
  }

  return findings;
}

/**
 * Formats an ActivityFinding as a human-readable review item reason string.
 * Matches the format used in mappingReport.quality.reviewItems.
 */
export function formatActivityFinding(f: ActivityFinding): string {
  switch (f.issue) {
    case "ACTIVITY_IN_THEORY":
      return (
        `[ACTIVITY IN THEORY · HIGH] Block ${f.blockIndex} (${f.blockType}, p${f.blockPage}) ` +
        `appears in sourceBlockIndices of MicroNode «${f.microNodeTitle}» — ` +
        `this student-facing task should be in exercises[], not theory. ` +
        `Preview: "${f.blockPreview}"`
      );
    case "EXERCISE_IN_UNMAPPED":
      return (
        `[EXERCISE IN UNMAPPED · HIGH] Block ${f.blockIndex} (${f.blockType}, p${f.blockPage}) ` +
        `was placed in unmappedBlocks — student-facing activities must not be discarded here. ` +
        `Block has been rescued to additionalExercises. ` +
        `Preview: "${f.blockPreview}"`
      );
  }
}
