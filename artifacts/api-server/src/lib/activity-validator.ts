// ─────────────────────────────────────────────────────────────────────────────
// Activity Placement Validator — Phase 5
//
// Detects five categories of activity mis-placement / invariant violation:
//
//   ACTIVITY_IN_THEORY         (P5.1) — EXERCISE/ACTIVITY/HOMEWORK appears in
//                                        a MicroNode's sourceBlockIndices instead
//                                        of exercises[] or additionalExercises[].
//
//   EXERCISE_IN_UNMAPPED       (P5.4) — EXERCISE/ACTIVITY/HOMEWORK appears in
//                                        unmappedBlockIndices (run BEFORE rescue;
//                                        after rescue this count should be 0).
//
//   INVALID_ACTIVITY_BLOCK_INDEX       — an exercises[] or additionalExercises[]
//                                        entry has a null / non-integer / out-of-range
//                                        blockIndex.  The server deterministically
//                                        rescues the activity from the original Pass1 block.
//
//   MISSING_ACTIVITY_PLACEMENT         — a Pass1 EXERCISE/ACTIVITY/HOMEWORK block
//                                        does not appear in ANY valid activity
//                                        destination (exercises[] or additionalExercises[])
//                                        with a valid blockIndex.
//
//   DUPLICATE_ACTIVITY_PLACEMENT       — the same Pass1 activity block appears in two
//                                        or more valid activity destinations.
//
// All findings are HIGH severity and advisory — they never block the mapping.
// This function is pure and dependency-free — easy to unit-test.
// ─────────────────────────────────────────────────────────────────────────────

/** Block types that represent student-facing activities. */
export const ACTIVITY_BLOCK_TYPES = new Set<string>([
  "EXERCISE",
  "ACTIVITY",
  "HOMEWORK",
]);

export type ActivityIssueType =
  | "ACTIVITY_IN_THEORY"          // P5.1
  | "EXERCISE_IN_UNMAPPED"        // P5.4 (before rescue)
  | "INVALID_ACTIVITY_BLOCK_INDEX"
  | "MISSING_ACTIVITY_PLACEMENT"
  | "DUPLICATE_ACTIVITY_PLACEMENT";

export interface ActivityFinding {
  /**
   * For INVALID_ACTIVITY_BLOCK_INDEX this is -1 (the original index is not known).
   * For MISSING_ACTIVITY_PLACEMENT and DUPLICATE_ACTIVITY_PLACEMENT this is the Pass1 index.
   */
  blockIndex:     number;
  blockType:      string;
  blockPage:      number;
  /** First 80 chars of sourceText, newlines collapsed to spaces. */
  blockPreview:   string;
  /** Title of the MicroNode that owns this block (or "—" if not applicable). */
  microNodeTitle: string;
  issue:          ActivityIssueType;
  /**
   * Human-readable detail: which destination(s) contain the block (for DUPLICATE)
   * or what invalid value was found (for INVALID_ACTIVITY_BLOCK_INDEX).
   */
  detail?:        string;
}

/** Minimal Pass1Block shape required for this validator. */
export interface ActivityValidatorBlock {
  blockType:   string;
  sourceText:  string;
  sourcePage:  number;
}

/** MicroNode shape — blockIndex in exercises is `unknown` to catch null from AI. */
export interface ActivityValidatorMicroNode {
  title:              string;
  sourceBlockIndices: ReadonlyArray<number>;
  exercises?:         ReadonlyArray<{ blockIndex: unknown }>;
}

/** Topic shape — blockIndex in additionalExercises is `unknown` to catch null from AI. */
export interface ActivityValidatorTopic {
  title:                string;
  microNodes:           ReadonlyArray<ActivityValidatorMicroNode>;
  unmappedBlockIndices: ReadonlyArray<number>;
  additionalExercises?: ReadonlyArray<{ blockIndex: unknown }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function isValidIdx(
  blockIndex: unknown,
  totalBlocks: number,
): blockIndex is number {
  return (
    typeof blockIndex === "number" &&
    Number.isInteger(blockIndex) &&
    blockIndex >= 0 &&
    blockIndex < totalBlocks
  );
}

function blockPreview(b: ActivityValidatorBlock): string {
  return b.sourceText.slice(0, 80).replace(/\n/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the full activity placement validator.
 *
 * Detects all five issue types (A–E) in one pass.
 *
 * @param blocks    The Pass1 blocks[] array (index-addressable).
 * @param topics    The Pass2 topic results (post-rescue state is expected).
 * @returns         Array of ActivityFinding; empty when everything is correct.
 */
export function validateActivityPlacement(
  blocks:  ReadonlyArray<ActivityValidatorBlock>,
  topics:  ReadonlyArray<ActivityValidatorTopic>,
): ActivityFinding[] {
  const findings: ActivityFinding[] = [];
  const totalBlocks = blocks.length;

  // Track valid activity destinations per block index:
  //   key = block index, value = list of destination labels for duplicate detection
  const activityDestinationMap = new Map<number, string[]>();

  function recordActivityDestination(idx: number, label: string): void {
    const existing = activityDestinationMap.get(idx);
    if (existing) {
      existing.push(label);
    } else {
      activityDestinationMap.set(idx, [label]);
    }
  }

  for (const topic of topics) {

    // ── A: ACTIVITY_IN_THEORY ───────────────────────────────────────────────
    // EXERCISE/ACTIVITY/HOMEWORK in sourceBlockIndices → theory, NOT exercise
    for (const mn of topic.microNodes) {
      for (const idx of mn.sourceBlockIndices) {
        const block = blocks[idx];
        if (!block) continue;
        if (!ACTIVITY_BLOCK_TYPES.has(block.blockType)) continue;

        findings.push({
          blockIndex:    idx,
          blockType:     block.blockType,
          blockPage:     block.sourcePage,
          blockPreview:  blockPreview(block),
          microNodeTitle: mn.title,
          issue:         "ACTIVITY_IN_THEORY",
        });
      }

      // ── C (part 1): INVALID_ACTIVITY_BLOCK_INDEX in mn.exercises ───────────
      // Also record valid ones for duplicate / missing detection
      for (const ex of mn.exercises ?? []) {
        if (!isValidIdx(ex.blockIndex, totalBlocks)) {
          findings.push({
            blockIndex:    -1,
            blockType:     "UNKNOWN",
            blockPage:     -1,
            blockPreview:  "",
            microNodeTitle: mn.title,
            issue:         "INVALID_ACTIVITY_BLOCK_INDEX",
            detail:        `exercises[] in MicroNode «${mn.title}» has blockIndex=${JSON.stringify(ex.blockIndex)} (expected integer 0–${totalBlocks - 1})`,
          });
        } else {
          recordActivityDestination(ex.blockIndex as number, `exercises[${mn.title}]`);
        }
      }
    }

    // ── B: EXERCISE_IN_UNMAPPED ─────────────────────────────────────────────
    // EXERCISE/ACTIVITY/HOMEWORK that the AI placed in unmappedBlocks (before rescue)
    for (const idx of topic.unmappedBlockIndices) {
      const block = blocks[idx];
      if (!block) continue;
      if (!ACTIVITY_BLOCK_TYPES.has(block.blockType)) continue;

      findings.push({
        blockIndex:    idx,
        blockType:     block.blockType,
        blockPage:     block.sourcePage,
        blockPreview:  blockPreview(block),
        microNodeTitle: "—",
        issue:         "EXERCISE_IN_UNMAPPED",
        detail:        `Topic «${topic.title}»`,
      });
    }

    // ── C (part 2): INVALID_ACTIVITY_BLOCK_INDEX in additionalExercises ────
    for (const ex of topic.additionalExercises ?? []) {
      if (!isValidIdx(ex.blockIndex, totalBlocks)) {
        findings.push({
          blockIndex:    -1,
          blockType:     "UNKNOWN",
          blockPage:     -1,
          blockPreview:  "",
          microNodeTitle: "—",
          issue:         "INVALID_ACTIVITY_BLOCK_INDEX",
          detail:        `additionalExercises in topic «${topic.title}» has blockIndex=${JSON.stringify(ex.blockIndex)} (expected integer 0–${totalBlocks - 1})`,
        });
      } else {
        recordActivityDestination(ex.blockIndex as number, `additionalExercises[${topic.title}]`);
      }
    }
  }

  // ── D: MISSING_ACTIVITY_PLACEMENT ────────────────────────────────────────
  // Any Pass1 activity block absent from all valid activity destinations
  for (let idx = 0; idx < totalBlocks; idx++) {
    const block = blocks[idx];
    if (!block || !ACTIVITY_BLOCK_TYPES.has(block.blockType)) continue;
    if (!activityDestinationMap.has(idx)) {
      findings.push({
        blockIndex:    idx,
        blockType:     block.blockType,
        blockPage:     block.sourcePage,
        blockPreview:  blockPreview(block),
        microNodeTitle: "—",
        issue:         "MISSING_ACTIVITY_PLACEMENT",
        detail:        `Block ${idx} (${block.blockType}) has no valid exercises[] or additionalExercises[] destination`,
      });
    }
  }

  // ── E: DUPLICATE_ACTIVITY_PLACEMENT ──────────────────────────────────────
  // Same Pass1 activity block appears in 2+ valid activity destinations
  for (const [idx, destinations] of activityDestinationMap.entries()) {
    if (destinations.length < 2) continue;
    const block = blocks[idx];
    findings.push({
      blockIndex:    idx,
      blockType:     block?.blockType ?? "UNKNOWN",
      blockPage:     block?.sourcePage ?? -1,
      blockPreview:  block ? blockPreview(block) : "",
      microNodeTitle: "—",
      issue:         "DUPLICATE_ACTIVITY_PLACEMENT",
      detail:        `Block ${idx} appears in ${destinations.length} destinations: ${destinations.join(", ")}`,
    });
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats an ActivityFinding as a human-readable review item reason string.
 * Matches the format used in mappingReport.quality.reviewItems.
 */
export function formatActivityFinding(f: ActivityFinding): string {
  const loc = f.blockIndex >= 0 ? `Block ${f.blockIndex}` : "Block ?";
  const typeStr = f.blockIndex >= 0 && f.blockType !== "UNKNOWN"
    ? ` (${f.blockType}, p${f.blockPage})` : "";
  const preview = f.blockPreview ? ` Preview: "${f.blockPreview}"` : "";
  const detail = f.detail ? ` ${f.detail}.` : "";

  switch (f.issue) {
    case "ACTIVITY_IN_THEORY":
      return (
        `[ACTIVITY IN THEORY · HIGH] ${loc}${typeStr} appears in sourceBlockIndices of ` +
        `MicroNode «${f.microNodeTitle}» — student-facing task should be in exercises[], not theory.` +
        preview
      );
    case "EXERCISE_IN_UNMAPPED":
      return (
        `[EXERCISE IN UNMAPPED · HIGH] ${loc}${typeStr} was placed in unmappedBlocks — ` +
        `student-facing activities must not be discarded here. Block rescued to additionalExercises.` +
        preview
      );
    case "INVALID_ACTIVITY_BLOCK_INDEX":
      return (
        `[INVALID BLOCK INDEX · HIGH] AI returned an activity with invalid blockIndex.` +
        detail +
        ` The activity was deterministically rescued from the original Pass1 block.`
      );
    case "MISSING_ACTIVITY_PLACEMENT":
      return (
        `[MISSING ACTIVITY · HIGH] ${loc}${typeStr} has no valid activity destination ` +
        `(not in any exercises[] or additionalExercises[]). Block was deterministically rescued.` +
        preview
      );
    case "DUPLICATE_ACTIVITY_PLACEMENT":
      return (
        `[DUPLICATE ACTIVITY · HIGH] ${loc}${typeStr} appears in multiple activity destinations.` +
        detail +
        preview
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: count findings by issue type
// ─────────────────────────────────────────────────────────────────────────────
export function countActivityFindings(findings: ActivityFinding[]): Record<ActivityIssueType, number> {
  const counts: Record<ActivityIssueType, number> = {
    ACTIVITY_IN_THEORY:          0,
    EXERCISE_IN_UNMAPPED:        0,
    INVALID_ACTIVITY_BLOCK_INDEX: 0,
    MISSING_ACTIVITY_PLACEMENT:  0,
    DUPLICATE_ACTIVITY_PLACEMENT: 0,
  };
  for (const f of findings) counts[f.issue]++;
  return counts;
}
