import fs from "fs";
import path from "path";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const { PDFParse } = _require("pdf-parse") as {
  PDFParse: new (opts: { data: Buffer }) => {
    getText(opts?: { partial?: number[] }): Promise<{ text: string }>;
    getInfo(): Promise<{ total: number }>;
    destroy(): Promise<void>;
  };
};
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";
import {
  validateInstructionalCoverage,
  validateSourceCoverage,
  isLikelyStructuralHeading,
  type CoverageValidationResult,
  type InstructionalCoverageResult,
  type SourceCoverageBlock,
} from "../lib/coverage-validator.js";
import { detectCompoundLO } from "../lib/granularity-heuristics.js";
import {
  classifyMicroNodeSourceAlignment,
  getMissingObjectiveConceptLabels,
  pedagogicalNearDuplicate,
  isUnreadableSource,
  type SourceAlignmentAudit,
} from "../lib/micronode-source-alignment.js";
import {
  assessCognitivePathStructure,
  satisfiesLearningObjectiveCognitiveFloor,
  validateCognitivePathGrounding,
  type CognitivePathGroundingAudit,
} from "../lib/cognitive-path-grounding.js";
import {
  assessC2GenerationPreflight,
  type C2GenerationBlockCode,
} from "../lib/c2-generation-preflight.js";
import { ACTIVITY_BLOCK_TYPES } from "../lib/activity-validator.js";
import { validateRequiredLessonPageRange } from "../lib/lesson-page-range.js";
import {
  validateTeachingContentGrounding,
  type TeachingContentGroundingAudit,
} from "../lib/teaching-content-grounding.js";

// ── Activity preservation helpers ─────────────────────────────────────────────

/**
 * Returns true when blockIndex is a valid integer index into pass1 blocks[].
 * Exported so tests can import it directly.
 */
export function isValidBlockIndex(
  blockIndex: unknown,
  blocks: readonly unknown[],
): blockIndex is number {
  return (
    typeof blockIndex === "number" &&
    Number.isInteger(blockIndex) &&
    blockIndex >= 0 &&
    blockIndex < blocks.length
  );
}

/**
 * Enforces the invariant:
 *   ∀ EXERCISE / ACTIVITY / HOMEWORK block N from Pass1 → exactly ONE valid placement in:
 *     1. microNode.exercises[]       — linked to a specific MicroNode
 *     2. topic.additionalExercises[] — unassigned (relatedNodeId = null)
 *
 * Canonical priority (higher wins; lower is removed):
 *   exercises[] > additionalExercises[]
 *
 * Mutates topics in place. Must be called AFTER all AI calls and the safety-net,
 * and BEFORE validateSourceCoverage.
 *
 * Handles all known duplicate-creating scenarios:
 *  a. Activity block in sourceBlockIndices (ACTIVITY_IN_THEORY) AND Step C rescue
 *     → Evict from sourceBlockIndices; rescue to additionalExercises.
 *  b. Same block in exercises[] of two different MicroNodes
 *     → Keep first (topic order), drop second.
 *  c. Same block in exercises[] AND additionalExercises[]
 *     → exercises[] wins; drop from additionalExercises[].
 *  d. Duplicate entries in additionalExercises (invalid or repeated blockIndex)
 *     → Keep first valid entry, drop the rest.
 *  e. Safety-net + AI: safety-net moves exercise with invalid blockIndex to
 *     additionalExercises; Step C rescues real block — no collision (invalid
 *     entries are dropped before Step C).
 *  f. Activity block in unmappedBlockIndices (AI misclassified as header)
 *     → Rescue to additionalExercises (Step B equivalent).
 *  g. Activity block missing from all Pass2 output
 *     → Rescue to additionalExercises of last topic (Step C equivalent).
 *
 * Exported for testing.
 */
export function normalizeActivityPlacements(
  topics: Pass2TopicResult[],
  blocks: Pass1Block[],
): {
  evictedFromSource: number[];
  postEvictionStripped: string[];
  dedupedExercises: number[];
  dedupedAdditional: number[];
  stepBRescued: number[];
  stepCRescued: number[];
} {
  // ── Phase 1: Evict activity blocks from sourceBlockIndices ──────────────────
  // EXERCISE/ACTIVITY/HOMEWORK have no place in sourceBlockIndices — those blocks
  // are never inserted into lesson_exercises via that path.
  // Remove them so they can be rescued to a proper activity destination below.
  const evictedFromSource: number[] = [];
  for (const topic of topics) {
    for (const mn of topic.microNodes) {
      const kept: number[] = [];
      for (const idx of mn.sourceBlockIndices) {
        if (!isValidBlockIndex(idx, blocks)) { kept.push(idx); continue; }
        const block = blocks[idx];
        if (block && ACTIVITY_BLOCK_TYPES.has(block.blockType)) {
          evictedFromSource.push(idx);
          // Do NOT add to kept — evicted from theory placement.
        } else {
          kept.push(idx);
        }
      }
      mn.sourceBlockIndices = kept;
    }
  }

  // ── Phase 1b: Strip MicroNodes that became empty after Phase 1 eviction ───────
  // A MicroNode with no remaining sourceBlockIndices is structurally invalid
  // (same rule the safety-net enforces at AI-output time, now extended to
  // post-eviction state). Strip it and rescue its exercises to additionalExercises.
  const postEvictionStripped: string[] = [];
  for (const topic of topics) {
    const keepMNs: Pass2MicroNode[] = [];
    for (const mn of topic.microNodes) {
      if (mn.sourceBlockIndices.length === 0) {
        postEvictionStripped.push(mn.title);
        // Rescue exercises to additionalExercises — Phases 2/3 will dedup.
        topic.additionalExercises.push(...mn.exercises);
      } else {
        keepMNs.push(mn);
      }
    }
    topic.microNodes = keepMNs;
  }

  // ── Phase 2: Deduplicate exercises[] (highest canonical priority) ───────────
  // First occurrence (by topic order, then MN order) wins. Invalid → drop.
  const inExercises = new Set<number>();
  const dedupedExercises: number[] = [];
  for (const topic of topics) {
    for (const mn of topic.microNodes) {
      mn.exercises = mn.exercises.filter(ex => {
        if (!isValidBlockIndex(ex.blockIndex, blocks)) return false;
        if (inExercises.has(ex.blockIndex)) {
          dedupedExercises.push(ex.blockIndex);
          return false;
        }
        inExercises.add(ex.blockIndex);
        return true;
      });
    }
  }

  // ── Phase 3: Deduplicate additionalExercises[] ──────────────────────────────
  // Drop: invalid blockIndex, blocks already in exercises[] (exercises[] wins),
  // duplicates within/across topics (first valid occurrence wins).
  const inAdditional = new Set<number>();
  const dedupedAdditional: number[] = [];
  for (const topic of topics) {
    topic.additionalExercises = topic.additionalExercises.filter(ex => {
      if (!isValidBlockIndex(ex.blockIndex, blocks)) return false;
      if (inExercises.has(ex.blockIndex)) {
        dedupedAdditional.push(ex.blockIndex);
        return false; // exercises[] wins
      }
      if (inAdditional.has(ex.blockIndex)) {
        dedupedAdditional.push(ex.blockIndex);
        return false; // duplicate — keep first
      }
      inAdditional.add(ex.blockIndex);
      return true;
    });
  }

  // ── Build valid-destination set after Phase 2 + 3 cleanup ──────────────────
  const validDestinations = new Set<number>([...inExercises, ...inAdditional]);

  // ── Phase 4: Rescue from unmappedBlockIndices (Step B) ─────────────────────
  const stepBRescued: number[] = [];
  const rescuedByTopic: Record<string, number[]> = {};
  for (const topic of topics) {
    const remaining: number[] = [];
    for (const idx of topic.unmappedBlockIndices) {
      const block = blocks[idx];
      if (block && ACTIVITY_BLOCK_TYPES.has(block.blockType) && !validDestinations.has(idx)) {
        stepBRescued.push(idx);
        (rescuedByTopic[topic.title] ??= []).push(idx);
        topic.additionalExercises.push({ blockIndex: idx, sourceParagraph: block.sourceParagraph });
        validDestinations.add(idx);
      } else {
        remaining.push(idx);
      }
    }
    topic.unmappedBlockIndices = remaining;
  }

  // ── Phase 5: Rescue evicted-from-source blocks not yet placed ───────────────
  // These were removed from sourceBlockIndices in Phase 1 and may not have
  // ended up in exercises[] or additionalExercises[] via any AI path.
  const lastTopic = topics.length > 0 ? topics[topics.length - 1] : null;
  for (const idx of evictedFromSource) {
    if (!validDestinations.has(idx) && lastTopic) {
      const block = blocks[idx];
      if (block) {
        lastTopic.additionalExercises.push({ blockIndex: idx, sourceParagraph: block.sourceParagraph });
        validDestinations.add(idx);
      }
    }
  }

  // ── Phase 6: Rescue completely missing activity blocks (Step C) ─────────────
  // Any Pass1 activity block still with no valid destination — handles null
  // blockIndex from AI, AI omitting blocks, AI using textbook number, etc.
  const stepCRescued: number[] = [];
  if (lastTopic) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block && ACTIVITY_BLOCK_TYPES.has(block.blockType) && !validDestinations.has(i)) {
        lastTopic.additionalExercises.push({ blockIndex: i, sourceParagraph: block.sourceParagraph });
        validDestinations.add(i);
        stepCRescued.push(i);
      }
    }
  }

  // ── Phase 7: Canonical activity ownership cleanup ──────────────────────────
  // `validDestinations` contains the exercise-first / additional-exercise-second
  // canonical owner for every activity block handled above. Coverage treats
  // source, supporting material, and unmapped arrays as ownership too, so remove
  // an activity from those non-canonical locations once its activity destination
  // is established. Non-activity source ownership is intentionally untouched.
  const hasCanonicalActivityDestination = (idx: number): boolean => {
    const block = isValidBlockIndex(idx, blocks) ? blocks[idx] : undefined;
    return !!block &&
      ACTIVITY_BLOCK_TYPES.has(block.blockType) &&
      validDestinations.has(idx);
  };
  for (const topic of topics) {
    topic.unmappedBlockIndices = topic.unmappedBlockIndices
      .filter((idx) => !hasCanonicalActivityDestination(idx));
    for (const mn of topic.microNodes) {
      mn.sourceBlockIndices = mn.sourceBlockIndices
        .filter((idx) => !hasCanonicalActivityDestination(idx));
      mn.supportingMaterialIndices = mn.supportingMaterialIndices
        .filter((idx) => !hasCanonicalActivityDestination(idx));
    }
  }

  return { evictedFromSource, postEvictionStripped, dedupedExercises, dedupedAdditional, stepBRescued, stepCRescued };
}

/**
 * A title-like Pass 1 block describes structure, not teachable evidence. It
 * must never be the sole source owner for a MicroNode: that creates a
 * plausible-looking node with no source-backed learning objective.
 *
 * This repair is deliberately mechanical. It neither invents a new MicroNode
 * nor assigns an instructional block to a different objective. It only moves
 * conservative structural headings to the topic's legitimate unmapped
 * disposition, and preserves activities from any node made source-less.
 */
export function removeStructuralHeadingSourceOwnership(
  topics: Pass2TopicResult[],
  blocks: Pass1Block[],
): {
  movedHeadingIndices: number[];
  removedMicroNodeTitles: string[];
  rescuedExerciseIndices: number[];
} {
  const movedHeadingIndices: number[] = [];
  const removedMicroNodeTitles: string[] = [];
  const rescuedExerciseIndices: number[] = [];
  const headingHome = new Map<number, Pass2TopicResult>();

  for (const topic of topics) {
    const keptNodes: Pass2MicroNode[] = [];
    for (const node of topic.microNodes) {
      const keptSource: number[] = [];
      for (const index of node.sourceBlockIndices) {
        const block = isValidBlockIndex(index, blocks) ? blocks[index] : undefined;
        if (block && isLikelyStructuralHeading(block)) {
          movedHeadingIndices.push(index);
          headingHome.set(index, topic);
          continue;
        }
        keptSource.push(index);
      }
      node.sourceBlockIndices = keptSource;

      if (node.sourceBlockIndices.length === 0) {
        removedMicroNodeTitles.push(node.title);
        for (const exercise of node.exercises) {
          topic.additionalExercises.push(exercise);
          rescuedExerciseIndices.push(exercise.blockIndex);
        }
        for (const supportIndex of node.supportingMaterialIndices) {
          if (!topic.unmappedBlockIndices.includes(supportIndex)) {
            topic.unmappedBlockIndices.push(supportIndex);
          }
        }
        continue;
      }
      keptNodes.push(node);
    }
    topic.microNodes = keptNodes;
  }

  // A heading may only be moved to `unmapped` if no valid destination still
  // owns it. This retains coverage's duplicate detection for malformed input.
  const stillOwned = new Set<number>();
  for (const topic of topics) {
    for (const node of topic.microNodes) {
      node.sourceBlockIndices.forEach((index) => stillOwned.add(index));
      node.supportingMaterialIndices.forEach((index) => stillOwned.add(index));
      node.exercises.forEach((exercise) => stillOwned.add(exercise.blockIndex));
    }
    topic.additionalExercises.forEach((exercise) => stillOwned.add(exercise.blockIndex));
    topic.unmappedBlockIndices.forEach((index) => stillOwned.add(index));
  }
  for (const index of new Set(movedHeadingIndices)) {
    const home = headingHome.get(index);
    if (home && !stillOwned.has(index)) {
      home.unmappedBlockIndices.push(index);
      stillOwned.add(index);
    }
  }

  return {
    movedHeadingIndices: [...new Set(movedHeadingIndices)].sort((a, b) => a - b),
    removedMicroNodeTitles,
    rescuedExerciseIndices: [...new Set(rescuedExerciseIndices)].sort((a, b) => a - b),
  };
}

const MODEL = "deepseek/deepseek-chat-v3-0324";
// Pass 1 is an extraction boundary and needs predictable structured-output
// adherence. Keep this model selection isolated; unrelated mapping/runtime
// stages continue using their existing model constants.
const PASS1_TEXT_MODEL = "openai/gpt-5.4-mini";
export const PASS1_CONTEXT_WINDOW_TOKENS = 163_840;
export const PASS1_MAX_OUTPUT_TOKENS = 8_000;
// Armenian textbook text tokenizes more densely than English. This deliberately
// conservative upper-bound catches requests before the provider rejects them.
const CONSERVATIVE_CHARS_PER_TOKEN = 1.2;

export interface MappingContextDiagnostics {
  stage: "pass1-text";
  model: string;
  contextWindowTokens: number;
  requestedOutputTokens: number;
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
  components: {
    systemInstructionChars: number;
    lessonMetadataChars: number;
    lessonSourceChars: number;
    confirmedGoalChars: number;
    confirmedOutcomeChars: number;
    existingMappingChars: number;
    exercisesChars: number;
    teachingPackageChars: number;
    cognitivePathChars: number;
    historyChars: number;
  };
}

export interface VisionMappingContextDiagnostics {
  stage: "pass1-vision";
  model: string;
  contextWindowTokens: number;
  requestedOutputTokens: number;
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
  components: {
    systemInstructionChars: number;
    lessonMetadataChars: number;
    imageCount: number;
    reservedImageInputTokens: number;
    confirmedGoalChars: number;
    confirmedOutcomeChars: number;
    existingMappingChars: number;
    exercisesChars: number;
    teachingPackageChars: number;
    cognitivePathChars: number;
    historyChars: number;
  };
}

export class MappingContextBudgetError extends Error {
  readonly teacherMessage =
    "Դասի աղբյուրի ծավալը գերազանցում է քարտեզագրման թույլատրելի սահմանը։ Ստուգեք էջերի միջակայքը և փորձեք կրկին։";

  constructor(readonly diagnostics: MappingContextDiagnostics | VisionMappingContextDiagnostics) {
    super("Mapping request exceeds the configured context budget");
    this.name = "MappingContextBudgetError";
  }
}

export class MappingSourceTruncatedError extends Error {
  readonly teacherMessage =
    "Դասի աղբյուրի ամբողջական քաղարկումը չհաջողվեց։ Փոխեք էջերի միջակայքը կամ ստուգեք աղբյուրը և փորձեք կրկին։";

  constructor() {
    super("Pass 1 provider response was truncated before all source blocks were extracted");
    this.name = "MappingSourceTruncatedError";
  }
}

/**
 * A syntactically valid provider payload with no usable source blocks is not a
 * source-scope failure: the server did read the selected pages, but Pass 1 did
 * not extract evidence from them. Keep this separate so it cannot be mistaken
 * for a rejected PDF or relaxed into an empty Pass 2 input.
 */
export class MappingPass1EmptyExtractionError extends Error {
  readonly teacherMessage =
    "Դասի աղբյուրից բովանդակության բլոկներ չստացվեցին։ Արդյունքը չի պահպանվել։ Խնդրում ենք կրկին փորձել։";

  constructor(readonly sourceState: "SUBSTANTIAL_SOURCE" | "EMPTY_OR_NONINSTRUCTIONAL_PAGE" = "SUBSTANTIAL_SOURCE") {
    super("Pass 1 provider response contained no usable source blocks");
    this.name = "MappingPass1EmptyExtractionError";
  }
}

export class MappingPass1MalformedResponseError extends Error {
  readonly teacherMessage =
    "Դասի աղբյուրի կառուցվածքային պատասխանը չստացվեց։ Արդյունքը չի պահպանվել։ Խնդրում ենք կրկին փորձել։";

  constructor() {
    super("Pass 1 provider response was not valid JSON");
    this.name = "MappingPass1MalformedResponseError";
  }
}

export class MappingPass1SchemaValidationError extends Error {
  readonly teacherMessage =
    "Դասի աղբյուրի կառուցվածքային պատասխանը չի համապատասխանել պահանջվող ձևաչափին։ Արդյունքը չի պահպանվել։ Խնդրում ենք կրկին փորձել։";

  constructor(readonly issueCodes: string[]) {
    super(`Pass 1 provider response failed schema validation: ${issueCodes.join(", ")}`);
    this.name = "MappingPass1SchemaValidationError";
  }
}

export class MappingZeroMicroNodesError extends Error {
  readonly teacherMessage =
    "Քարտեզագրումը չի ստեղծել գիտելիքի մանր հանգույցներ։ Արդյունքը չի պահպանվել։ Խնդրում ենք կրկին փորձել կամ ստուգել աղբյուրային նյութը։";

  constructor(readonly diagnostics: unknown) {
    super("Detailed mapping produced zero valid MicroNodes before persistence");
    this.name = "MappingZeroMicroNodesError";
  }
}

export class MappingSourcePlacementError extends Error {
  readonly teacherMessage =
    "Քարտեզագրումը աղբյուրային բլոկները անվտանգ չի տեղավորել։ Արդյունքը չի պահպանվել։ Խնդրում ենք կրկին փորձել կամ վերանայել աղբյուրը։";

  constructor(readonly coverage: CoverageValidationResult) {
    super("Detailed mapping contains invalid source placements before persistence");
    this.name = "MappingSourcePlacementError";
  }
}

export class MappingInstructionalCoverageError extends Error {
  readonly teacherMessage =
    "Քարտեզագրումը չի ընդգրկել բոլոր ընթեռնելի ուսումնական նյութերը։ Արդյունքը չի պահպանվել։ Խնդրում ենք կրկին փորձել կամ ստուգել աղբյուրը։";

  constructor(readonly coverage: InstructionalCoverageResult, readonly diagnostics: Pass2Diagnostics) {
    super("Detailed mapping left readable instructional source without a MicroNode owner");
    this.name = "MappingInstructionalCoverageError";
  }
}

export class MappingSourceAlignmentError extends Error {
  readonly teacherMessage =
    "MicroNode-ի նպատակը բավարար չափով չի հիմնավորվել իր ընտրված աղբյուրով։ Արդյունքը չի պահպանվել։ Խնդրում ենք վերանայել քարտեզագրումը։";
  constructor(readonly alignment: Pass2SourceAlignment) {
    super("Detailed mapping contains MicroNodes without sufficient owned-source support");
    this.name = "MappingSourceAlignmentError";
  }
}

export class MappingGranularityReviewError extends Error {
  readonly teacherMessage =
    "Քարտեզագրումը պարունակում է կրկնվող կամ չափազանց մասնատված MicroNode-ներ, որոնք պահանջում են վերանայում։ Արդյունքը չի պահպանվել։";

  constructor(readonly duplicateResolution: DuplicateResolutionAudit) {
    super("Detailed mapping contains unresolved duplicate or over-split MicroNode suspicion");
    this.name = "MappingGranularityReviewError";
  }
}

export class MappingAtomicityError extends Error {
  readonly teacherMessage =
    "Քարտեզագրումը ստեղծվել է, բայց որոշ գիտելիքի հանգույցներ չափազանց լայն են։ Խնդրում ենք կրկին փորձել քարտեզագրումը։";

  constructor(
    readonly findings: GranularityFinding[],
    readonly diagnostics?: AtomicityVerificationDiagnostics,
  ) {
    super("Detailed mapping contains unresolved pedagogical atomicity findings");
    this.name = "MappingAtomicityError";
  }
}

export class MappingAtomicityReviewUnavailableError extends Error {
  readonly teacherMessage =
    "Քարտեզագրման ստուգումը տեխնիկական պատճառով չի ավարտվել։ Կարող եք կրկին փորձել՝ առանց դասի տվյալները նորից լրացնելու։";

  constructor(
    readonly reason: "EMPTY_RESPONSE" | "INVALID_RESPONSE" | "REQUEST_FAILED",
    readonly diagnostics?: AtomicityVerificationDiagnostics,
  ) {
    super(`Detailed mapping atomicity review unavailable: ${reason}`);
    this.name = "MappingAtomicityReviewUnavailableError";
  }
}

export class MappingSourceScopeError extends Error {
  readonly code = "LESSON_SCOPE_MISMATCH";
  readonly teacherMessage =
    "Ընտրված PDF էջերի բովանդակությունը չհաջողվեց վստահորեն հաստատել որպես այս դասի աղբյուր։";

  constructor(readonly audit: unknown) {
    super("Mapping source set is outside the verified lesson scope");
    this.name = "MappingSourceScopeError";
  }
}

export class MappingPdfPageRangeError extends Error {
  readonly code = "INVALID_PDF_PAGE_RANGE";
  readonly teacherMessage =
    "Նշված PDF էջերը չեն գտնվում վերբեռնված ֆայլի էջերի սահմաններում։";

  constructor(
    readonly pagesFrom: number,
    readonly pagesTo: number,
    readonly totalPages: number | null,
  ) {
    super(
      totalPages === null
        ? `Requested invalid PDF page range ${pagesFrom}–${pagesTo}`
        : `Requested PDF pages ${pagesFrom}–${pagesTo} are outside document range 1–${totalPages}`,
    );
    this.name = "MappingPdfPageRangeError";
  }
}

export class MappingPdfPageExtractionError extends Error {
  readonly code = "PDF_PAGE_EXTRACTION_FAILED";
  readonly teacherMessage =
    "Չհաջողվեց կարդալ ընտրված PDF էջերը։ Խնդրում ենք ստուգել վերբեռնված ֆայլը և փորձել կրկին։";

  constructor() {
    super("Selected PDF page extraction failed");
    this.name = "MappingPdfPageExtractionError";
  }
}

export class MappingOutcomeAlignmentError extends Error {
  readonly teacherMessage =
    "Քարտեզագրումը չի կարողացել համապատասխանեցնել բոլոր հաստատված վերջնարդյունքները MicroNode-ներին։ Արդյունքը չի պահպանվել։";

  constructor(readonly unresolvedOutcomeIndexes: number[]) {
    super("Confirmed outcomes could not be matched to generated MicroNode objectives");
    this.name = "MappingOutcomeAlignmentError";
  }
}

export function getTeacherFacingMappingFailure(error: unknown): string {
  if (error instanceof MappingContextBudgetError) return error.teacherMessage;
  if (error instanceof MappingSourceTruncatedError) return error.teacherMessage;
  if (error instanceof MappingPass1EmptyExtractionError) return error.teacherMessage;
  if (error instanceof MappingPass1MalformedResponseError) return error.teacherMessage;
  if (error instanceof MappingPass1SchemaValidationError) return error.teacherMessage;
  if (error instanceof MappingZeroMicroNodesError) return error.teacherMessage;
  if (error instanceof MappingSourcePlacementError) return error.teacherMessage;
  if (error instanceof MappingInstructionalCoverageError) return error.teacherMessage;
  if (error instanceof MappingSourceAlignmentError) return error.teacherMessage;
  if (error instanceof MappingGranularityReviewError) return error.teacherMessage;
  if (error instanceof MappingAtomicityError) return error.teacherMessage;
  if (error instanceof MappingAtomicityReviewUnavailableError) return error.teacherMessage;
  if (error instanceof MappingSourceScopeError) return error.teacherMessage;
  if (error instanceof MappingPdfPageRangeError) return error.teacherMessage;
  if (error instanceof MappingPdfPageExtractionError) return error.teacherMessage;
  if (error instanceof MappingOutcomeAlignmentError) return error.teacherMessage;
  if (error instanceof MappingPass2ParserError) return error.teacherMessage;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/maximum context length|context length|too many tokens|context window/i.test(message)) {
    return "Քարտեզագրման հարցումը չափազանց մեծ է։ Ստուգեք դասի էջերի միջակայքը և փորձեք կրկին։";
  }
  return "Քարտեզագրումը չհաջողվեց։ Խնդրում ենք փորձել կրկին։";
}

export function assertPass1ResponseComplete(finishReason: string | null | undefined): void {
  if (finishReason === "length") throw new MappingSourceTruncatedError();
}

/** Empty Pass 1 output is never an empty-but-valid source set. */
export function assertPass1HasBlocks(blocks: ReadonlyArray<Pass1Block>): void {
  if (blocks.length === 0) throw new MappingPass1EmptyExtractionError();
}

/**
 * An entirely blank/non-instructional selected range cannot enter Pass 2, but
 * is not a provider extraction failure. Mixed ranges may still continue if a
 * substantial page produced a verified block.
 */
export function assertPass1AggregateHasBlocks(
  blocks: ReadonlyArray<Pass1Block>,
  emptyOrNonInstructionalSourcePages: ReadonlyArray<number>,
  selectedPageCount: number,
): void {
  if (blocks.length > 0) return;
  if (
    selectedPageCount > 0
    && new Set(emptyOrNonInstructionalSourcePages).size === selectedPageCount
  ) {
    throw new MappingPass1EmptyExtractionError("EMPTY_OR_NONINSTRUCTIONAL_PAGE");
  }
  assertPass1HasBlocks(blocks);
}

/**
 * Extracts the real textbook text for a specific page range from a PDF
 * already stored on disk (uploaded via the course resources mechanism).
 * Returns an empty string if the range yields nothing (e.g. bad page numbers).
 */
export async function extractPdfPageRange(
  filePath: string,
  pagesFrom: number,
  pagesTo: number
): Promise<string> {
  const range = validateRequiredLessonPageRange(pagesFrom, pagesTo);
  if (!range.valid) {
    throw new Error(range.error);
  }
  const pages = await extractPdfPages(filePath, range.pagesFrom, range.pagesTo);
  return pages.map((page) => page.text).join("\n\n").trim();
}

export type ExtractedPdfPage = { pageNumber: number; text: string };

/**
 * The teacher-visible PDF page is the canonical page identity everywhere after
 * this adapter boundary. pdf-parse's `partial` API is 1-based, so this is an
 * intentional identity conversion rather than a hidden offset.
 */
export function teacherVisiblePdfPageToParserPage(pageNumber: number): number {
  return pageNumber;
}

/** Extract pages independently so the selected physical PDF identity survives
 * beyond an aggregate string and can validate every Pass 1 block. */
export async function extractPdfPages(
  filePath: string,
  pagesFrom: number,
  pagesTo: number,
): Promise<ExtractedPdfPage[]> {
  const range = validateRequiredLessonPageRange(pagesFrom, pagesTo);
  if (!range.valid) throw new MappingPdfPageRangeError(pagesFrom, pagesTo, null);
  let parser: {
    getText(opts?: { partial?: number[] }): Promise<{ text: string }>;
    getInfo(): Promise<{ total: number }>;
    destroy(): Promise<void>;
  } | undefined;
  try {
    parser = new PDFParse({ data: fs.readFileSync(filePath) });
    const { total: totalPages } = await parser.getInfo();
    if (!Number.isInteger(totalPages) || totalPages < 1) {
      throw new MappingPdfPageExtractionError();
    }
    if (range.pagesTo > totalPages) {
      throw new MappingPdfPageRangeError(range.pagesFrom, range.pagesTo, totalPages);
    }
    const pages: ExtractedPdfPage[] = [];
    for (let pageNumber = range.pagesFrom; pageNumber <= range.pagesTo; pageNumber++) {
      const parserPage = teacherVisiblePdfPageToParserPage(pageNumber);
      const result = await parser.getText({ partial: [parserPage] });
      pages.push({ pageNumber, text: result.text.trim() });
    }
    return pages;
  } catch (error) {
    if (
      error instanceof MappingPdfPageRangeError ||
      error instanceof MappingPdfPageExtractionError
    ) {
      throw error;
    }
    throw new MappingPdfPageExtractionError();
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch (cleanupError) {
        logger.warn({ err: cleanupError }, "PDF parser cleanup failed after page extraction");
      }
    }
  }
}

/** Resolves a resources-table fileUrl (e.g. /api/teacher/documents/files/xyz.pdf) to its real path on disk. */
export function resolveUploadedFilePath(fileUrl: string): string {
  const filename = fileUrl.split("/").pop() ?? "";
  return path.join(process.cwd(), "uploads", filename);
}

export interface LessonMappingInput {
  subjectName: string;
  lessonTitle: string;
  chapterTitle: string | null;
  textbookTitle: string | null;
  textbookAuthor: string | null;
  pagesFrom: number | null;
  pagesTo: number | null;
  lessonText: string; // the real extracted textbook text for this lesson's pages
  teacherGoal?: string | null;       // teacher's draft goal — refine against text, don't silently overwrite
  teacherOutcomes?: string[] | null; // teacher's draft outcomes — refine if present, derive if absent
}

export function buildPass1TextRequest(input: LessonMappingInput): {
  userPrompt: string;
  diagnostics: MappingContextDiagnostics;
} {
  const metadataLines = [
    `SUBJECT: ${input.subjectName}`,
    `LESSON TITLE: ${input.lessonTitle}`,
    input.chapterTitle   ? `CHAPTER: ${input.chapterTitle}`     : "",
    input.textbookTitle  ? `TEXTBOOK: ${input.textbookTitle}`   : "",
    input.textbookAuthor ? `AUTHOR: ${input.textbookAuthor}`    : "",
    input.pagesFrom && input.pagesTo
      ? `PAGES: ${input.pagesFrom}–${input.pagesTo}` : "",
    "",
    "TEXTBOOK TEXT FROM THESE PAGES:",
  ].filter(Boolean);
  const metadataText = metadataLines.join("\n");
  const lessonSource = input.lessonText || "(no text extracted from PDF)";
  const userPrompt = `${metadataText}\n${lessonSource}`;
  const components = {
    systemInstructionChars: PASS1_SYSTEM_PROMPT.length,
    lessonMetadataChars: metadataText.length,
    lessonSourceChars: lessonSource.length,
    // Pass 1 intentionally receives no curriculum/runtime state: it is a
    // verbatim source extraction boundary. Confirmed constraints enter Pass 2.
    confirmedGoalChars: 0,
    confirmedOutcomeChars: 0,
    existingMappingChars: 0,
    exercisesChars: 0,
    teachingPackageChars: 0,
    cognitivePathChars: 0,
    historyChars: 0,
  };
  const estimatedInputTokens = Math.ceil(
    (components.systemInstructionChars + userPrompt.length) / CONSERVATIVE_CHARS_PER_TOKEN,
  );
  return {
    userPrompt,
    diagnostics: {
      stage: "pass1-text",
      model: PASS1_TEXT_MODEL,
      contextWindowTokens: PASS1_CONTEXT_WINDOW_TOKENS,
      requestedOutputTokens: PASS1_MAX_OUTPUT_TOKENS,
      estimatedInputTokens,
      estimatedTotalTokens: estimatedInputTokens + PASS1_MAX_OUTPUT_TOKENS,
      components,
    },
  };
}

export function assertPass1ContextBudget(diagnostics: MappingContextDiagnostics): void {
  logger.info({ mappingContext: diagnostics }, "lesson mapping context preflight");
  if (diagnostics.estimatedTotalTokens > diagnostics.contextWindowTokens) {
    throw new MappingContextBudgetError(diagnostics);
  }
}

/**
 * Vision providers bill/count image input differently from text. The mapping
 * path is intentionally bounded to two pages (or one fallback page), and
 * reserves this conservative per-page allowance before every provider call.
 */
const VISION_PAGE_INPUT_TOKEN_RESERVATION = 8_192;

export function buildVisionContextDiagnostics(
  model: string,
  headerText: string,
  imageCount: number,
  requestedOutputTokens: number,
): VisionMappingContextDiagnostics {
  const components = {
    systemInstructionChars: PASS1_SYSTEM_PROMPT.length,
    lessonMetadataChars: headerText.length,
    imageCount,
    reservedImageInputTokens: imageCount * VISION_PAGE_INPUT_TOKEN_RESERVATION,
    // Vision Pass 1 has the same pure-source boundary as text Pass 1.
    confirmedGoalChars: 0,
    confirmedOutcomeChars: 0,
    existingMappingChars: 0,
    exercisesChars: 0,
    teachingPackageChars: 0,
    cognitivePathChars: 0,
    historyChars: 0,
  };
  const estimatedInputTokens = Math.ceil(
    (components.systemInstructionChars + components.lessonMetadataChars) / CONSERVATIVE_CHARS_PER_TOKEN,
  ) + components.reservedImageInputTokens;
  return {
    stage: "pass1-vision",
    model,
    contextWindowTokens: PASS1_CONTEXT_WINDOW_TOKENS,
    requestedOutputTokens,
    estimatedInputTokens,
    estimatedTotalTokens: estimatedInputTokens + requestedOutputTokens,
    components,
  };
}

export function assertVisionContextBudget(diagnostics: VisionMappingContextDiagnostics): void {
  logger.info({ mappingContext: diagnostics }, "lesson mapping vision context preflight");
  if (diagnostics.estimatedTotalTokens > diagnostics.contextWindowTokens) {
    throw new MappingContextBudgetError(diagnostics);
  }
}

export function buildPass1RetryDiagnostics(
  diagnostics: MappingContextDiagnostics,
  retryInstruction: string,
): MappingContextDiagnostics {
  const estimatedInputTokens = Math.ceil(
    (
      diagnostics.components.systemInstructionChars
      + diagnostics.components.lessonMetadataChars
      + diagnostics.components.lessonSourceChars
      + retryInstruction.length
    ) / CONSERVATIVE_CHARS_PER_TOKEN,
  );
  return {
    ...diagnostics,
    estimatedInputTokens,
    estimatedTotalTokens: estimatedInputTokens + diagnostics.requestedOutputTokens,
  };
}

export interface LessonMappingResult {
  lessonGoal: string;
  lessonOutcomes: string[];
  // Extracted from textbook page content when teacher left these fields null
  textbookAuthor?: string | null;
  textbookTitle?: string | null;
  chapterTitle?: string | null;
  coreProblem: string;
  coreIdea: string;
  // NEW: what this lesson deliberately does NOT cover (prevents scope creep in chat.ts / AI teacher)
  knowledgeBoundaries: string[];
  nodes: {
    title: string;
    theoryContent: string;
    // NEW: word-for-word textbook paragraph(s) this node's theory is grounded in.
    // Empty string "" if there is no single clean matching passage (AI-synthesized theory).
    verbatimTheoryAnchor: string;
    targetBloomLevel: number;
    estimatedMinutes: number;
    childFriendlyExplanation: string;
    basicExamples: string[];
    realLifeExamples: string[];
    commonMisconception: string;
    // NEW: 1-2 short "this is NOT X" contrasts to sharpen the concept boundary
    nonExamples: string[];
    prerequisiteNodes: string[];
  }[];
  essentialQuestion: string;
  nodeDependencies: {
    fromNodeTitle: string;        // prerequisite node — must be taught BEFORE toNodeTitle
    toNodeTitle: string;          // node that depends on fromNodeTitle
    dependencyType: "REQUIRED" | "SEQUENTIAL" | "CONCEPTUAL";
    requiredLevel: "CRITICAL" | "SUPPORTING";
    reason: string;
  }[];
  practicalTasks: {
    task: string;
    purpose: string;
    // P1 STEP 17 — verbatim textbook exercise text and purpose enum
    exerciseTextVerbatim: string;   // word-for-word from textbook, or "" if AI-invented
    exercisePurpose: string;        // CONCEPT_DISCOVERY | RULE_DISCOVERY | WORKED_EXAMPLE | GUIDED_PRACTICE | INDEPENDENT_PRACTICE | PROBLEM_SOLVING | REVIEW | ASSESSMENT | AI_ADAPTED
    sourcePage: string | null;
    difficultyLevel: "LOW" | "MEDIUM" | "HIGH";
    successCriteria: string;
    relatedNodeTitle: string;
    assignment: "CLASS" | "HOMEWORK";
  }[];
}

// ─── Pass 1: Pure block extraction ────────────────────────────────────────────
//
// The model's ONLY job in Pass 1 is to read each page and output a flat array
// of content blocks — verbatim, in reading order, zero interpretation.
// Pass 2 (not yet implemented) will take this block list and organise it into
// topics, nodes, exercises, and the rest of the lesson structure.

export const PASS1_SYSTEM_PROMPT = `You are a textbook content extraction engine. Your ONLY task: read the given page(s) and output a flat JSON array of every content block you see, in reading order.

OUTPUT: Respond with ONLY valid JSON — no commentary, no markdown fences, no explanation before or after.
{
  "blocks": [
    {
      "blockType": "DEFINITION",
      "sourceText": "Exact verbatim text copied word-for-word from the page",
      "sourcePage": 22,
      "sourceParagraph": "1" or null,
      "sourceBoundingBox": {"x": 0, "y": 0, "w": 100, "h": 50} or null
    }
  ]
}

When supplied page text contains readable instructional content, "blocks" MUST contain at least one block.
The top-level object MUST contain exactly the "blocks" field. Never return {} and never return an empty "blocks" array for a readable page.

Valid blockType values (pick the one that best describes each block):
  DEFINITION  — a formal definition of a concept or term
  RULE        — a stated grammar, math, or subject rule or principle
  EXAMPLE     — a worked example or illustration
  EXERCISE    — any numbered student exercise, task, question, or problem
  OBJECTIVE   — a lesson goal or learning objective stated in the book
  WARNING     — a caution, "attention!", or important-notice callout
  EXCEPTION   — an explicit exception or special case to a rule
  TABLE       — a table, chart, or structured list
  IMAGE       — a figure or diagram (sourceText = visible caption or description if any)
  CAPTION     — a standalone caption for an image or table
  NOTE        — a side note, footnote, or informational callout box
  ACTIVITY    — a group activity, project, or in-class task
  HOMEWORK    — a homework section or assignment header

STRICT RULES — follow every one without exception:

1. COPY, DO NOT INTERPRET.
   sourceText MUST be the verbatim text from the page: every word, every number, every punctuation mark, exactly as written.
   No paraphrasing. No summarizing. No rewording. No adding or removing any word.
   If you cannot read a word clearly, write your best literal reading — never substitute a paraphrase.

2. NO INVENTION.
   Do NOT include any text that is not literally visible on the page.
   Do NOT invent examples, rules, explanations, or exercises from your own knowledge.
   Every character in sourceText must appear on the page.

3. EVERY EXERCISE IS ITS OWN BLOCK.
   Every numbered exercise, task, question, or problem on the page MUST become its own separate EXERCISE block.
   Do NOT skip any. Do NOT sample only some. Do NOT merge multiple exercises into one block.
   If there are 20 exercises, produce 20 EXERCISE blocks.

4. NO ORGANIZATION.
   Do NOT group blocks into topics, nodes, or sections.
   Do NOT reorder them.
   Extract and classify each block in the order it appears on the page: top-to-bottom, left-to-right.
   Section headings and titles should be extracted as OBJECTIVE or NOTE blocks — not skipped.

5. PHYSICAL PDF PAGE PROVENANCE.
   Text input is divided by server markers in the exact form [PDF PAGE N].
   sourcePage MUST be the N from the marker immediately above the block. Never
   use a printed textbook page number, footer number, chapter number, or exercise
   number as sourcePage.
   Example: if a block is below [PDF PAGE 11] but the printed footer says "37",
   return "sourcePage": 11 — not 37.

sourceBoundingBox: for vision (image) input, provide approximate pixel coordinates {x, y, w, h} of the block on the page image. Use null if uncertain.
sourceParagraph: paragraph number, section label, or exercise number visible on the page. Use null if not applicable.`;

// ── Pass 1 types ──────────────────────────────────────────────────────────────

export interface Pass1Block {
  blockType:
    | "DEFINITION" | "RULE"    | "EXAMPLE"  | "EXERCISE"
    | "OBJECTIVE"  | "WARNING" | "EXCEPTION"| "TABLE"
    | "IMAGE"      | "CAPTION" | "NOTE"     | "ACTIVITY" | "HOMEWORK";
  sourceText: string;
  sourcePage: number;
  sourceParagraph: string | null;
  sourceBoundingBox: { x: number; y: number; w: number; h: number } | null;
}

export interface Pass1Result {
  blocks: Pass1Block[];
  /** Physical pages with deterministically insufficient readable text. */
  emptyOrNonInstructionalSourcePages?: number[];
  /** Number of positive provider page labels replaced by a known server page. */
  providerPageLabelCorrectionCount?: number;
  /** Page ranges that failed to extract (even after 1-page fallback) and were
   *  skipped rather than thrown.  Propagated into mappingReport.reviewItems so
   *  the teacher knows which pages need manual review or a re-run. */
  skippedPageRanges?: { from: number; to: number; reason: string }[];
}

// ── Normalise raw model output into a clean Pass1Result ───────────────────────

const VALID_BLOCK_TYPES = new Set<string>([
  "DEFINITION", "RULE", "EXAMPLE", "EXERCISE", "OBJECTIVE",
  "WARNING", "EXCEPTION", "TABLE", "IMAGE", "CAPTION",
  "NOTE", "ACTIVITY", "HOMEWORK",
]);

const PASS1_BLOCK_TYPE_VALUES = [
  "DEFINITION", "RULE", "EXAMPLE", "EXERCISE", "OBJECTIVE", "WARNING",
  "EXCEPTION", "TABLE", "IMAGE", "CAPTION", "NOTE", "ACTIVITY", "HOMEWORK",
] as const;

/**
 * The provider receives a deliberately small schema. Generic json_object mode
 * accepts {}, which is not a valid Pass 1 extraction for readable source text.
 * The same constraints are also checked locally before normalisation.
 */
export const PASS1_RESPONSE_JSON_SCHEMA = {
  name: "pass1_source_blocks",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["blocks"],
    properties: {
      blocks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "blockType",
            "sourceText",
            "sourcePage",
            "sourceParagraph",
            "sourceBoundingBox",
          ],
          properties: {
            blockType: { type: "string", enum: PASS1_BLOCK_TYPE_VALUES },
            sourceText: { type: "string", minLength: 1 },
            sourcePage: { type: "integer", minimum: 1 },
            sourceParagraph: { type: ["string", "null"] },
            sourceBoundingBox: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["x", "y", "w", "h"],
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type Pass1ResponseState =
  | "VALID_NONEMPTY_EXTRACTION"
  | "EMPTY_PROVIDER_RESPONSE"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "SCHEMA_VALIDATION_FAILED";

export type Pass1ResponseInspection = {
  state: Pass1ResponseState;
  parsedObjectPresent: boolean;
  topLevelKeys: string[];
  blocksPresent: boolean;
  blocksCount: number | null;
  issueCodes: string[];
  result: Pass1Result | null;
};

function extractPass1JSON(raw: string): unknown | null {
  const stripped = raw.replace(/```json\s*|```/g, "").trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through */ }
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A source page is safely skippable only when the server extracted no content
 * after its physical-page marker. Do not use length/token heuristics here:
 * a short heading, rule, or exercise is still source evidence and must reach
 * the strict Pass 1 contract.
 */
export function hasSubstantialReadablePass1Source(text: string): boolean {
  const withoutMarkers = text.replace(/\[\s*PDF PAGE \d+\s*\]/giu, " ");
  return withoutMarkers.trim().length > 0;
}

/**
 * Validates every field before normalisation so a malformed provider object can
 * never be silently converted to an empty/partially-defaulted blocks array.
 */
export function inspectPass1StructuredResponse(
  raw: string,
  sourcePageOverride?: number,
): Pass1ResponseInspection {
  const parsed = extractPass1JSON(raw);
  if (parsed === null) {
    return {
      state: "MALFORMED_PROVIDER_RESPONSE",
      parsedObjectPresent: false,
      topLevelKeys: [],
      blocksPresent: false,
      blocksCount: null,
      issueCodes: ["INVALID_JSON"],
      result: null,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      state: "SCHEMA_VALIDATION_FAILED",
      parsedObjectPresent: false,
      topLevelKeys: [],
      blocksPresent: false,
      blocksCount: null,
      issueCodes: ["TOP_LEVEL_OBJECT_REQUIRED"],
      result: null,
    };
  }

  const object = parsed as Record<string, unknown>;
  const topLevelKeys = Object.keys(object).sort();
  if (topLevelKeys.length === 0) {
    return {
      state: "EMPTY_PROVIDER_RESPONSE",
      parsedObjectPresent: true,
      topLevelKeys,
      blocksPresent: false,
      blocksCount: null,
      issueCodes: ["EMPTY_OBJECT"],
      result: null,
    };
  }
  if (!Array.isArray(object.blocks)) {
    return {
      state: "SCHEMA_VALIDATION_FAILED",
      parsedObjectPresent: true,
      topLevelKeys,
      blocksPresent: false,
      blocksCount: null,
      issueCodes: ["BLOCKS_ARRAY_REQUIRED"],
      result: null,
    };
  }
  if (topLevelKeys.some((key) => key !== "blocks")) {
    return {
      state: "SCHEMA_VALIDATION_FAILED",
      parsedObjectPresent: true,
      topLevelKeys,
      blocksPresent: true,
      blocksCount: object.blocks.length,
      issueCodes: ["UNEXPECTED_TOP_LEVEL_PROPERTY"],
      result: null,
    };
  }
  if (object.blocks.length === 0) {
    return {
      state: "EMPTY_PROVIDER_RESPONSE",
      parsedObjectPresent: true,
      topLevelKeys,
      blocksPresent: true,
      blocksCount: 0,
      issueCodes: ["BLOCKS_MIN_ITEMS"],
      result: null,
    };
  }

  const issueCodes: string[] = [];
  object.blocks.forEach((candidate, index) => {
    const prefix = `BLOCK_${index}`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      issueCodes.push(`${prefix}_OBJECT_REQUIRED`);
      return;
    }
    const block = candidate as Record<string, unknown>;
    const allowedBlockKeys = new Set([
      "blockType",
      "sourceText",
      "sourcePage",
      "sourceParagraph",
      "sourceBoundingBox",
    ]);
    if (Object.keys(block).some((key) => !allowedBlockKeys.has(key))) {
      issueCodes.push(`${prefix}_UNEXPECTED_PROPERTY`);
    }
    if (!VALID_BLOCK_TYPES.has(String(block.blockType ?? ""))) issueCodes.push(`${prefix}_BLOCK_TYPE`);
    if (typeof block.sourceText !== "string" || block.sourceText.trim().length === 0) issueCodes.push(`${prefix}_SOURCE_TEXT`);
    if (!Number.isInteger(block.sourcePage) || (block.sourcePage as number) < 1) issueCodes.push(`${prefix}_SOURCE_PAGE`);
    if (!(typeof block.sourceParagraph === "string" || block.sourceParagraph === null)) issueCodes.push(`${prefix}_SOURCE_PARAGRAPH`);
    const box = block.sourceBoundingBox;
    if (box !== null) {
      if (!box || typeof box !== "object" || Array.isArray(box)) {
        issueCodes.push(`${prefix}_BOUNDING_BOX`);
      } else {
        const values = box as Record<string, unknown>;
        const allowedBoxKeys = new Set(["x", "y", "w", "h"]);
        if (Object.keys(values).some((key) => !allowedBoxKeys.has(key))) {
          issueCodes.push(`${prefix}_BOUNDING_BOX_UNEXPECTED_PROPERTY`);
        }
        if (!["x", "y", "w", "h"].every((key) => isFiniteNumber(values[key]))) {
          issueCodes.push(`${prefix}_BOUNDING_BOX`);
        }
      }
    }
  });
  if (issueCodes.length > 0) {
    return {
      state: "SCHEMA_VALIDATION_FAILED",
      parsedObjectPresent: true,
      topLevelKeys,
      blocksPresent: true,
      blocksCount: object.blocks.length,
      issueCodes,
      result: null,
    };
  }

  const result = normalisePass1(parsed, sourcePageOverride);
  return {
    state: result.blocks.length > 0 ? "VALID_NONEMPTY_EXTRACTION" : "EMPTY_PROVIDER_RESPONSE",
    parsedObjectPresent: true,
    topLevelKeys,
    blocksPresent: true,
    blocksCount: result.blocks.length,
    issueCodes: result.blocks.length > 0 ? [] : ["NORMALISATION_EMPTY"],
    result: result.blocks.length > 0 ? result : null,
  };
}

/**
 * Normalizes a provider response. Vision callers pass the physical page being
 * processed so that model-provided page labels can never become provenance.
 */
export function normalisePass1(raw: unknown, sourcePageOverride?: number): Pass1Result {
  const obj = raw as { blocks?: unknown[] };
  let providerPageLabelCorrectionCount = 0;
  const blocks: Pass1Block[] = (Array.isArray(obj?.blocks) ? obj.blocks : [])
    .map((b) => {
      const block = b as Record<string, unknown>;
      const bt = String(block.blockType ?? "");
      const providerSourcePage = typeof block.sourcePage === "number" && block.sourcePage > 0
        ? Math.round(block.sourcePage)
        : 0;
      if (
        sourcePageOverride !== undefined &&
        providerSourcePage > 0 &&
        providerSourcePage !== sourcePageOverride
      ) {
        providerPageLabelCorrectionCount++;
      }
      return {
        blockType: VALID_BLOCK_TYPES.has(bt)
          ? (bt as Pass1Block["blockType"])
          : "NOTE",
        sourceText: typeof block.sourceText === "string"
          ? block.sourceText.trim() : "",
        sourcePage: sourcePageOverride ?? (
          providerSourcePage
        ),
        sourceParagraph: typeof block.sourceParagraph === "string" && block.sourceParagraph.trim()
          ? block.sourceParagraph.trim() : null,
        sourceBoundingBox:
          block.sourceBoundingBox &&
          typeof block.sourceBoundingBox === "object" &&
          !Array.isArray(block.sourceBoundingBox)
            ? (block.sourceBoundingBox as { x: number; y: number; w: number; h: number })
            : null,
      };
    })
    .filter((b) => b.sourceText.length > 0); // drop empty blocks

  return { blocks, providerPageLabelCorrectionCount };
}

// ── Pass 1 text path ──────────────────────────────────────────────────────────

type Pass1ProviderResponse = {
  choices: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
  };
};

export type Pass1CompletionClient = {
  chat: {
    completions: {
      create: (request: unknown) => Promise<Pass1ProviderResponse>;
    };
  };
};

function pass1FailureForInspection(inspection: Pass1ResponseInspection): Error {
  if (inspection.state === "MALFORMED_PROVIDER_RESPONSE") {
    return new MappingPass1MalformedResponseError();
  }
  if (inspection.state === "SCHEMA_VALIDATION_FAILED") {
    return new MappingPass1SchemaValidationError(inspection.issueCodes);
  }
  return new MappingPass1EmptyExtractionError();
}

function logPass1ResponseShape(
  attempt: 1 | 2,
  response: Pass1ProviderResponse,
  raw: string,
  inspection: Pass1ResponseInspection,
): void {
  logger.info({
    pass1ProviderResponse: {
      attempt,
      model: PASS1_TEXT_MODEL,
      requestMode: "chat.completions",
      structuredOutputMode: "json_schema.strict",
      finishReason: response.choices[0]?.finish_reason ?? null,
      contentPresent: raw.length > 0,
      contentLength: raw.length,
      parsedObjectPresent: inspection.parsedObjectPresent,
      topLevelKeys: inspection.topLevelKeys,
      blocksPresent: inspection.blocksPresent,
      blocksCount: inspection.blocksCount,
      schemaValidation: inspection.state === "VALID_NONEMPTY_EXTRACTION" ? "PASS" : "FAIL",
      responseState: inspection.state,
      validationIssueCodes: inspection.issueCodes,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens ?? null,
        completionTokens: response.usage.completion_tokens ?? null,
        totalTokens: response.usage.total_tokens ?? null,
      } : null,
    },
  }, "pass1 text: provider response shape");
}

export async function extractBlocksWithAI(
  input: LessonMappingInput,
  options: {
    sourcePageOverride?: number;
    completionClient?: Pass1CompletionClient;
  } = {},
): Promise<Pass1Result> {
  const { userPrompt, diagnostics } = buildPass1TextRequest(input);
  assertPass1ContextBudget(diagnostics);
  if (!hasSubstantialReadablePass1Source(input.lessonText)) {
    logger.info(
      { sourceState: "EMPTY_OR_NONINSTRUCTIONAL_PAGE", sourceCharacterCount: input.lessonText.length },
      "pass1 text: skipping provider call for an empty/non-instructional page",
    );
    return {
      blocks: [],
      emptyOrNonInstructionalSourcePages: options.sourcePageOverride === undefined
        ? []
        : [options.sourcePageOverride],
    };
  }
  const client = options.completionClient ?? (openrouter as unknown as Pass1CompletionClient);
  const request = {
    model: PASS1_TEXT_MODEL,
    max_tokens: PASS1_MAX_OUTPUT_TOKENS,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: PASS1_RESPONSE_JSON_SCHEMA },
    messages: [
      { role: "system", content: PASS1_SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
  };
  const r1 = await client.chat.completions.create(request);
  const raw1 = r1.choices[0]?.message?.content ?? "";
  assertPass1ResponseComplete(r1.choices[0]?.finish_reason);
  let inspection = inspectPass1StructuredResponse(raw1, options.sourcePageOverride);
  logPass1ResponseShape(1, r1, raw1, inspection);

  if (inspection.state !== "VALID_NONEMPTY_EXTRACTION") {
    const retryInstruction = inspection.state === "MALFORMED_PROVIDER_RESPONSE"
      ? 'Your previous response was not valid JSON. Return ONLY a valid JSON object that satisfies the required response schema.'
      : inspection.state === "SCHEMA_VALIDATION_FAILED"
      ? 'Your previous response did not satisfy the required JSON schema. Return exactly one object with a non-empty "blocks" array and every required field on each block.'
      : 'Your previous response contained no usable source blocks. Return exactly one JSON object with a non-empty "blocks" array. Copy only verbatim text from the supplied page.';
    logger.warn(
      {
        responseState: inspection.state,
        validationIssueCodes: inspection.issueCodes,
        responseCharCount: raw1.length,
      },
      "pass1 text: retrying one invalid extraction response",
    );
    // Do not resend raw1: it can be up to the output ceiling and would expand
    // the retry past the original context budget without adding source evidence.
    assertPass1ContextBudget(buildPass1RetryDiagnostics(diagnostics, retryInstruction));
    const r2 = await client.chat.completions.create({
      model: PASS1_TEXT_MODEL,
      max_tokens: PASS1_MAX_OUTPUT_TOKENS,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: PASS1_RESPONSE_JSON_SCHEMA },
      messages: [
        { role: "system", content: PASS1_SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
        { role: "user",   content: retryInstruction },
      ],
    });
    const raw2 = r2.choices[0]?.message?.content ?? "";
    assertPass1ResponseComplete(r2.choices[0]?.finish_reason);
    inspection = inspectPass1StructuredResponse(raw2, options.sourcePageOverride);
    logPass1ResponseShape(2, r2, raw2, inspection);
    if (inspection.state !== "VALID_NONEMPTY_EXTRACTION") {
      throw pass1FailureForInspection(inspection);
    }
  }

  const result = inspection.result;
  if (!result) throw pass1FailureForInspection(inspection);
  logger.info({ blockCount: result.blocks.length }, "pass1 text: extraction complete");
  return result;
}

// ── Pass 1 vision path ────────────────────────────────────────────────────────

/** Pass 1 uses smaller page chunks than legacy vision mapping.
 *  Armenian language textbook pages have many verbatim exercises, so even
 *  16 000 tokens weren't enough for 3 pages.  2 pages keeps output comfortably
 *  below the 32 000-token ceiling. */
// One image per request is intentionally slower than two-page batching, but it
// lets the server (rather than the model) assign an unambiguous physical page.
const PASS1_CHUNK_PAGES = 1;
const PASS1_MAX_TOKENS  = 32000;

export async function extractBlocksWithVision(
  input: Omit<LessonMappingInput, "lessonText">,
  pageImages: string[]   // base64-encoded PNG, one element per page
): Promise<Pass1Result> {
  type TextPart  = { type: "text"; text: string };
  type ImagePart = { type: "image_url"; image_url: { url: string } };
  type ContentPart = TextPart | ImagePart;

  /** Strip markdown fences, try direct parse, then bracket-search.
   *  Truncated responses are never recovered: complete-looking early blocks
   *  cannot prove that the page source was fully extracted. */
  function extractJSON(raw: string): Pass1Result | null {
    const stripped = raw.replace(/```json\s*|```\s*/g, "").trim();

    // 1. Direct parse
    try { return JSON.parse(stripped); } catch { /* fall through */ }

    // 2. First {...} block (handles leading prose)
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }

    return null;
  }

  const totalFrom = input.pagesFrom ?? 1;
  const totalTo   = input.pagesTo   ?? pageImages.length;

  // Split into 2-page chunks to keep output within token budget
  const chunks: string[][] = [];
  for (let i = 0; i < pageImages.length; i += PASS1_CHUNK_PAGES) {
    chunks.push(pageImages.slice(i, i + PASS1_CHUNK_PAGES));
  }

  type ChunkOutcome = { blocks: Pass1Block[]; skipped: { from: number; to: number; reason: string }[] };

  // ── Process all chunks in parallel ─────────────────────────────────────────
  // All vision calls fire simultaneously (same pattern as Pass 2 Step 2).
  // Promise.all preserves index order, so block ordering by page is maintained.
  // Each chunk processor owns its own `skipped` array — no shared mutable state.
  logger.info({ chunkCount: chunks.length }, "pass1 vision: firing all chunks in parallel");

  const chunkResults: ChunkOutcome[] = await Promise.all(
    chunks.map(async (chunkImages, ci): Promise<ChunkOutcome> => {
      const chunkFrom  = totalFrom + ci * PASS1_CHUNK_PAGES;
      const chunkTo    = Math.min(chunkFrom + PASS1_CHUNK_PAGES - 1, totalTo);
      const chunkLabel = `chunk ${ci + 1}/${chunks.length} (pages ${chunkFrom}–${chunkTo})`;
      const skipped: { from: number; to: number; reason: string }[] = [];

      logger.info(
        { chunk: ci + 1, totalChunks: chunks.length, pagesFrom: chunkFrom, pagesTo: chunkTo },
        "pass1 vision: processing chunk"
      );

      const headerText = [
        `SUBJECT: ${input.subjectName}`,
        `LESSON TITLE: ${input.lessonTitle}`,
        input.chapterTitle   ? `CHAPTER: ${input.chapterTitle}`   : "",
        input.textbookTitle  ? `TEXTBOOK: ${input.textbookTitle}` : "",
        input.textbookAuthor ? `AUTHOR: ${input.textbookAuthor}`  : "",
        `PAGES IN THIS BATCH: ${chunkFrom}–${chunkTo}  [batch ${ci + 1}/${chunks.length}, full lesson range ${totalFrom}–${totalTo}]`,
        "",
        `You are looking at ${chunkImages.length} page image(s) covering pages ${chunkFrom}–${chunkTo}.`,
        `Extract EVERY content block visible on these pages in reading order.`,
        `IMPORTANT: Output ONLY the raw JSON object — no markdown fences, no \`\`\`json, no explanation.`,
        `For sourceBoundingBox, provide pixel coordinates {x, y, w, h} measured from the top-left of each page image.`,
      ].filter(Boolean).join("\n");

      const content: ContentPart[] = [
        { type: "text", text: headerText },
        ...chunkImages.map((b64): ImagePart => ({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${b64}` },
        })),
      ];

      assertVisionContextBudget(
        buildVisionContextDiagnostics(VISION_MODEL, headerText, chunkImages.length, PASS1_MAX_TOKENS),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r1 = await openrouter.chat.completions.create({
        model: VISION_MODEL,
        max_tokens: PASS1_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: "system", content: PASS1_SYSTEM_PROMPT },
          { role: "user",   content } as any,
        ],
      });
      const raw1          = r1.choices[0]?.message?.content ?? "";
      const wasTruncated1 = r1.choices[0]?.finish_reason === "length";
      let parsed: Pass1Result | null = null;

      // ── 1-page fallback helper (scoped to this chunk) ───────────────────────
      // Retries each page individually.  Pushes failures to this chunk's own
      // `skipped` array — no shared mutable state with sibling chunks.
      const run1PageFallback = async (triggerReason: string): Promise<Pass1Block[]> => {
        const subBlocks: Pass1Block[] = [];
        for (let pi = 0; pi < chunkImages.length; pi++) {
          const subPage  = chunkFrom + pi;
          const subLabel = `page ${subPage} (1-page fallback of ${chunkLabel})`;
          logger.info({ subLabel }, "pass1 vision: extracting 1-page sub-chunk");

          const subHeader = [
            `SUBJECT: ${input.subjectName}`,
            `LESSON TITLE: ${input.lessonTitle}`,
            input.chapterTitle   ? `CHAPTER: ${input.chapterTitle}`   : "",
            input.textbookTitle  ? `TEXTBOOK: ${input.textbookTitle}` : "",
            input.textbookAuthor ? `AUTHOR: ${input.textbookAuthor}`  : "",
            `PAGE: ${subPage}  [1-page extraction, full lesson range ${totalFrom}–${totalTo}]`,
            "",
            `You are looking at 1 page image (page ${subPage}).`,
            `Extract EVERY content block visible on this page in reading order.`,
            `IMPORTANT: Output ONLY the raw JSON object — no markdown fences, no \`\`\`json, no explanation.`,
            `For sourceBoundingBox, provide pixel coordinates {x, y, w, h} measured from the top-left.`,
          ].filter(Boolean).join("\n");

          const subContent: ContentPart[] = [
            { type: "text", text: subHeader },
            { type: "image_url", image_url: { url: `data:image/png;base64,${chunkImages[pi]}` } },
          ];

          assertVisionContextBudget(
            buildVisionContextDiagnostics(VISION_MODEL, subHeader, 1, PASS1_MAX_TOKENS),
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rSub = await openrouter.chat.completions.create({
            model: VISION_MODEL,
            max_tokens: PASS1_MAX_TOKENS,
            temperature: 0,
            messages: [
              { role: "system", content: PASS1_SYSTEM_PROMPT },
              { role: "user",   content: subContent } as any,
            ],
          });
          const rawSub       = rSub.choices[0]?.message?.content ?? "";
          const subTruncated = rSub.choices[0]?.finish_reason === "length";
          if (subTruncated) {
            logger.warn({ subLabel }, "pass1 vision: 1-page sub-chunk also truncated (very dense page)");
          }
          const subParsed = subTruncated ? null : extractJSON(rawSub);
          if (subParsed) {
            const subNorm = normalisePass1(subParsed, subPage);
            logger.info({ subLabel, blockCount: subNorm.blocks.length }, "pass1 vision: 1-page sub-chunk extracted");
            subBlocks.push(...subNorm.blocks);
          } else {
            // One page failed — record it; NEVER write error text as a block
            logger.error(
              { subPage, chunkLabel, raw: rawSub.slice(0, 200) },
              "pass1 vision: 1-page sub-chunk failed — skipping page"
            );
            skipped.push({
              from:   subPage,
              to:     subPage,
              reason: `Page ${subPage} failed extraction (${triggerReason}) — needs manual review or re-run`,
            });
          }
        }
        return subBlocks;
      };

      if (wasTruncated1) {
        // ── Truncation: discard 2-page result, retry each page individually ───
        logger.warn({ chunkLabel }, "pass1 vision: truncated — falling back to 1-page sub-chunks");
        const subBlocks = await run1PageFallback("truncated response");
        if (subBlocks.length === 0) {
          logger.error({ chunkLabel }, "pass1 vision: truncation 1-page fallback produced no blocks — skipping chunk");
          skipped.push({
            from:   chunkFrom,
            to:     chunkTo,
            reason: `Pages ${chunkFrom}–${chunkTo} failed extraction even at 1-page granularity (truncated) — needs manual review or re-run`,
          });
          return { blocks: [], skipped };   // ← return instead of continue
        }
        parsed = { blocks: subBlocks };

      } else {
        // ── Normal path: try direct JSON parse ────────────────────────────────
        parsed = extractJSON(raw1);

        if (!parsed) {
          // Not truncated but invalid JSON — retry once with correction prompt
          logger.warn({ chunkLabel, raw: raw1.slice(0, 200) }, "pass1 vision: chunk not valid JSON — retrying");
          const retryInstruction =
            'Output ONLY a raw JSON object with a "blocks" array — no markdown fences, no ```json, no text before or after the JSON.';
          const retryHeader = `${headerText}\n\n${retryInstruction}`;
          const retryContent: ContentPart[] = [
            { type: "text", text: retryHeader },
            ...chunkImages.map((b64): ImagePart => ({
              type: "image_url",
              image_url: { url: `data:image/png;base64,${b64}` },
            })),
          ];
          // As with text Pass 1, omit the malformed model output from the
          // retry so the retry is independently within its preflight budget.
          assertVisionContextBudget(
            buildVisionContextDiagnostics(VISION_MODEL, retryHeader, chunkImages.length, PASS1_MAX_TOKENS),
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r2 = await openrouter.chat.completions.create({
            model: VISION_MODEL,
            max_tokens: PASS1_MAX_TOKENS,
            temperature: 0,
            messages: [
              { role: "system", content: PASS1_SYSTEM_PROMPT },
              { role: "user",   content: retryContent } as any,
            ],
          });
          const raw2          = r2.choices[0]?.message?.content ?? "";
          const wasTruncated2 = r2.choices[0]?.finish_reason === "length";
          if (wasTruncated2) {
            logger.warn({ chunkLabel }, "pass1 vision: retry also hit max_tokens — using 1-page fallback");
          }
          parsed = wasTruncated2 ? null : extractJSON(raw2);

          if (!parsed) {
            // Both attempts failed — 1-page fallback as last resort.
            // CRITICAL: never store error text as block content or a node title.
            logger.warn(
              { chunkLabel, raw: raw2.slice(0, 300) },
              "pass1 vision: chunk failed after retry — applying 1-page fallback to avoid output corruption"
            );
            const subBlocks = await run1PageFallback("JSON parse failed after retry");
            if (subBlocks.length > 0) {
              parsed = { blocks: subBlocks };
            } else {
              // Every page in this chunk failed — skip it entirely
              logger.error({ chunkLabel }, "pass1 vision: chunk completely skipped — all 1-page fallbacks failed");
              return { blocks: [], skipped };   // ← return instead of continue
            }
          }
        }
      }

      const chunkBlocks = normalisePass1(parsed, chunkFrom).blocks;
      logger.info({ chunkLabel, blockCount: chunkBlocks.length }, "pass1 vision: chunk extracted");
      return { blocks: chunkBlocks, skipped };
    })
  );

  // Merge chunk results in page order (Promise.all preserves index → chunk order)
  const allBlocks: Pass1Block[] = [];
  const skippedPageRanges: { from: number; to: number; reason: string }[] = [];
  for (const r of chunkResults) {
    allBlocks.push(...r.blocks);
    skippedPageRanges.push(...r.skipped);
  }

  if (allBlocks.length === 0) {
    throw new Error(
      "Pass 1 vision extraction produced no blocks after all chunks" +
      (skippedPageRanges.length > 0
        ? ` (${skippedPageRanges.length} page range(s) skipped: ${skippedPageRanges.map(r => `${r.from}–${r.to}`).join(", ")})`
        : "")
    );
  }

  logger.info(
    { chunkCount: chunks.length, totalBlocks: allBlocks.length, skippedRanges: skippedPageRanges.length },
    "pass1 vision: all chunks merged"
  );

  return { blocks: allBlocks, skippedPageRanges };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2: Topic grouping → MicroNode organisation
//
// Two-step pipeline validated against lesson 68 (83 blocks, 5 topics, 6 nodes):
//   Step 1 — one call detects topic boundaries, outputs {title, blockIndices[]}
//   Step 1b — size-cap: any group >MAX_GROUP_SIZE blocks is subdivided
//   Step 2 — one call per topic (parallel) organises blocks into MicroNodes
//
// Key design decisions vs failed v1/v2 prompts:
//   • sourceBlockIndices ≠ "theory only"; it means "all owned non-exercise,
//     non-image blocks". This prevents the model creating exercise-only MicroNodes.
//   • Explicit CORRECT/WRONG few-shot example in the Step 2 prompt.
//   • "Exercises on X" MicroNode named as an anti-pattern by name.
// ─────────────────────────────────────────────────────────────────────────────

const PASS2_STEP1_MODEL   = "deepseek/deepseek-chat";   // topic boundary detection
const PASS2_STEP2_MODEL   = "google/gemini-2.5-flash";  // per-topic MicroNode org
const PASS2B_REVIEW_MODEL = "deepseek/deepseek-chat";   // semantic granularity review (Phase 4)
const PASS2_MAX_GROUP_SIZE = 20;                          // size-cap before subdividing

// ── Pass 2 output types ───────────────────────────────────────────────────────

export interface Pass2Exercise {
  /** 0-based index into the Pass1Block array passed to runPass2Pipeline. */
  blockIndex: number;
  sourceParagraph: string | null;
}

export interface Pass2MicroNode {
  /** Server-owned identity, stable only for this in-memory Pass 2 run. */
  candidateId?: string;
  title: string;
  learningObjective: string;
  microNodeType: "knowledge" | "skill";
  /** Indices of all "owned" blocks (DEFINITION/RULE/NOTE/EXAMPLE/OBJECTIVE-with-body).
   *  Must be non-empty — an empty list here is a pipeline error. */
  sourceBlockIndices: number[];
  exercises: Pass2Exercise[];
  supportingMaterialIndices: number[];
}

export interface Pass2TopicResult {
  sequence: number;
  title: string;
  topicType: string;   // "grammar" | "enrichment" | …
  /** The Step 1 source indices this Topic is responsible for. */
  inputBlockIndices?: number[];
  microNodes: Pass2MicroNode[];
  unmappedBlockIndices: number[];
  /** Exercises that practice a skill for which no instructional source block exists in
   *  this topic, and no existing MicroNode's LO genuinely covers that skill.
   *  Persisted in lesson_exercises with relatedNodeId = null.
   *  Never creates a source-less MicroNode. Never placed in unmappedBlocks. */
  additionalExercises: Pass2Exercise[];
}

export const PASS2_MICRONODE_REJECTION_REASONS = [
  "MISSING_MICRONODES_ARRAY",
  "INVALID_MICRONODE_NO_SOURCE_BLOCKS",
  "INVALID_MICRONODE_EMPTY_TITLE",
  "INVALID_MICRONODE_EMPTY_OBJECTIVE",
  "INVALID_BLOCK_INDEX",
] as const;

export type Pass2MicroNodeRejectionReason =
  typeof PASS2_MICRONODE_REJECTION_REASONS[number];

/**
 * Count-only Step 2 diagnostics. Never retain provider responses, source text,
 * learner data, or generated MicroNode/exercise text.
 */
export interface Pass2TopicDiagnostics {
  topicSequence: number;
  inputBlockCount: number;
  response: {
    expectedKeysPresent: Record<"microNodes" | "unmappedBlocks" | "additionalExercises", boolean>;
    unexpectedTopLevelKeyCount: number;
    arrayLengths: Record<"microNodes" | "unmappedBlocks" | "additionalExercises", number>;
    finishReason: string | null;
    retried: boolean;
    parserStatus: "PARSED" | "FAILED";
  };
  candidateMicroNodeCount: number;
  acceptedMicroNodeCount: number;
  rejectedMicroNodeCount: number;
  rejectionCounts: Partial<Record<Pass2MicroNodeRejectionReason, number>>;
  postNormalizationMicroNodeCount: number;
  instructionalCoverage?: {
    readableInstructionalBlocks: number;
    microNodeOwnedInstructionalBlocks: number;
    unresolvedInstructionalBlocks: number;
    targetedRepair: "NOT_NEEDED" | "RESOLVED" | "UNRESOLVED" | "FAILED";
    targetedRepairRecoveredBlocks: number;
  };
}

export interface Pass2Diagnostics {
  detectedGroupCount: number;
  groupsAfterTheoryMergeCount: number;
  topics: Pass2TopicDiagnostics[];
  totals: {
    candidateMicroNodes: number;
    acceptedBeforeNormalization: number;
    acceptedAfterNormalization: number;
    rejectedMicroNodes: number;
  };
}

export class MappingPass2ParserError extends Error {
  readonly teacherMessage =
    "Քարտեզագրումը չի կարողացել մշակել AI-ի պատասխանը։ Արդյունքը չի պահպանվել։ Խնդրում ենք կրկին փորձել։";

  constructor(readonly diagnostics: Pass2Diagnostics) {
    super("Pass 2 provider response could not be parsed before persistence");
    this.name = "MappingPass2ParserError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function inspectPass2Step2Response(
  value: unknown,
  finishReason: string | null | undefined,
  retried: boolean,
  parserStatus: "PARSED" | "FAILED" = "PARSED",
): Pass2TopicDiagnostics["response"] {
  const record = asRecord(value);
  const expectedKeys = ["microNodes", "unmappedBlocks", "additionalExercises"] as const;
  const arrayLength = (key: "microNodes" | "unmappedBlocks" | "additionalExercises") =>
    Array.isArray(record?.[key]) ? record![key].length : 0;
  return {
    expectedKeysPresent: {
      microNodes: Object.hasOwn(record ?? {}, "microNodes"),
      unmappedBlocks: Object.hasOwn(record ?? {}, "unmappedBlocks"),
      additionalExercises: Object.hasOwn(record ?? {}, "additionalExercises"),
    },
    unexpectedTopLevelKeyCount: Object.keys(record ?? {})
      .filter((key) => !expectedKeys.includes(key as typeof expectedKeys[number])).length,
    arrayLengths: {
      microNodes: arrayLength("microNodes"),
      unmappedBlocks: arrayLength("unmappedBlocks"),
      additionalExercises: arrayLength("additionalExercises"),
    },
    finishReason: finishReason ?? null,
    retried,
    parserStatus,
  };
}

export type Pass2Step2ParseAttempt =
  | { ok: true; parsedValue: unknown; response: Pass2TopicDiagnostics["response"] }
  | { ok: false; response: Pass2TopicDiagnostics["response"] };

/**
 * Converts a provider response into a parsed value or a count-only parser-failure
 * diagnostic. It intentionally does not retain the raw response or parse error.
 */
export function safelyParsePass2Step2Response(
  raw: string,
  finishReason: string | null | undefined,
  retried: boolean,
): Pass2Step2ParseAttempt {
  try {
    const parsedValue = parsePass2JSON(raw);
    return {
      ok: true,
      parsedValue,
      response: inspectPass2Step2Response(parsedValue, finishReason, retried, "PARSED"),
    };
  } catch {
    return {
      ok: false,
      response: inspectPass2Step2Response(undefined, finishReason, retried, "FAILED"),
    };
  }
}

class Pass2Step2ParserError extends Error {
  constructor(readonly diagnostics: Pass2TopicDiagnostics) {
    super("Pass 2 topic response could not be parsed");
    this.name = "Pass2Step2ParserError";
  }
}

export function getPass2MicroNodeRejectionReasons(
  microNode: Pick<Pass2MicroNode, "title" | "learningObjective" | "sourceBlockIndices">,
): Pass2MicroNodeRejectionReason[] {
  const reasons: Pass2MicroNodeRejectionReason[] = [];
  if (microNode.sourceBlockIndices.length === 0) reasons.push("INVALID_MICRONODE_NO_SOURCE_BLOCKS");
  if (!microNode.title.trim()) reasons.push("INVALID_MICRONODE_EMPTY_TITLE");
  if (!microNode.learningObjective.trim()) reasons.push("INVALID_MICRONODE_EMPTY_OBJECTIVE");
  if (microNode.sourceBlockIndices.some((index) => !Number.isInteger(index) || index < 0)) {
    reasons.push("INVALID_BLOCK_INDEX");
  }
  return reasons;
}

export function recordPass2PostNormalizationCounts(
  topics: Pick<Pass2TopicResult, "microNodes">[],
  topicDiagnostics: Pass2TopicDiagnostics[],
): void {
  for (let index = 0; index < topicDiagnostics.length; index++) {
    topicDiagnostics[index].postNormalizationMicroNodeCount = topics[index]?.microNodes.length ?? 0;
  }
}

export function assertDetailedMappingHasMicroNodes(
  result: Pick<Pass2Result, "topics" | "diagnostics">,
): void {
  const microNodeCount = result.topics.reduce((total, topic) => total + topic.microNodes.length, 0);
  if (microNodeCount === 0) throw new MappingZeroMicroNodesError(result.diagnostics);
}

// ── Phase 4: Granularity review types ────────────────────────────────────────

/**
 * A single finding from the Pass 2B semantic granularity review. Findings are
 * resolved by the one bounded repair pass or persisted as teacher-review
 * findings after every source and structural persistence gate has passed.
 */
export interface GranularityFinding {
  topicTitle: string;
  microNodeTitle: string;
  /** Provider actions must use this server-issued identity, never titles alone. */
  microNodeId?: string;
  /** MEGA_NODE is retained for legacy audit readability; UNDER_SPLIT is canonical. */
  issue:
    | "MEGA_NODE"
    | "UNDER_SPLIT"
    | "OVER_SPLIT"
    | "EXERCISE_MISMATCH"
    | "MISSING_ATOMIC_MICRONODE"
    | "UNSUPPORTED_MICRONODE";
  confidence: "HIGH" | "MEDIUM";
  /** Armenian-language explanation for the teacher. */
  reason: string;
  /** Optional concrete recommendation (e.g. "Split into 2: … / …" or "Merge with: …"). */
  suggestedAction?: string;
  /** Required only for a HIGH-confidence OVER_SPLIT finding that can be safely merged. */
  mergeIntoMicroNodeTitle?: string;
  /** Provider actions must use this server-issued identity, never titles alone. */
  mergeIntoMicroNodeId?: string;
  /** Exercise evidence is always identified by a server-validated Pass 1 index. */
  exerciseBlockIndex?: number;
}

export interface GranularityConsolidation {
  beforeMicroNodeCount: number;
  afterMicroNodeCount: number;
  mergedMicroNodeCount: number;
  /** Parsed HIGH OVER_SPLIT actions rejected by server-side identity checks. */
  rejectedDecisionCount: number;
  /**
   * Internal stable-identity record of the exact pair resolved by an explicit
   * HIGH OVER_SPLIT merge. It is used to preserve unrelated duplicate edges.
   */
  resolvedCandidatePairs: Array<{ candidateAId: string; candidateBId: string }>;
  /** Source-safe audit: titles/reasons only; never source text. */
  actions: Array<{
    topicSequence: number;
    keptMicroNodeTitle: string;
    removedMicroNodeTitle: string;
    reason: "HIGH_CONFIDENCE_OVER_SPLIT" | "NEAR_DUPLICATE_OBJECTIVE";
  }>;
}

/**
 * Applies one bounded merge pass from explicit HIGH-confidence Pass 2B
 * findings. It never guesses a target, never crosses Topics, and preserves all
 * source/exercise/supporting indices before deterministic validators rerun.
 */
export function consolidateHighConfidenceOverSplits(
  topics: Pass2TopicResult[],
  findings: ReadonlyArray<GranularityFinding>,
  options: { requireStableIds?: boolean } = {},
): GranularityConsolidation {
  const beforeMicroNodeCount = topics.reduce((sum, topic) => sum + topic.microNodes.length, 0);
  const actions: GranularityConsolidation["actions"] = [];
  const resolvedCandidatePairs: GranularityConsolidation["resolvedCandidatePairs"] = [];
  let rejectedDecisionCount = 0;

  for (const finding of findings) {
    if (finding.issue !== "OVER_SPLIT" || finding.confidence !== "HIGH") continue;
    if (!finding.mergeIntoMicroNodeTitle) {
      rejectedDecisionCount++;
      continue;
    }
    if (options.requireStableIds && (!finding.microNodeId || !finding.mergeIntoMicroNodeId)) {
      rejectedDecisionCount++;
      continue;
    }
    const topic = finding.microNodeId
      ? topics.find((candidate) => candidate.microNodes.some(
          (node) => node.candidateId === finding.microNodeId,
        ))
      : topics.find((candidate) => candidate.title === finding.topicTitle);
    if (!topic || topic.title !== finding.topicTitle) {
      rejectedDecisionCount++;
      continue;
    }
    const sourceIndex = finding.microNodeId
      ? topic.microNodes.findIndex((node) => node.candidateId === finding.microNodeId)
      : topic.microNodes.findIndex((node) => node.title === finding.microNodeTitle);
    const targetIndex = finding.mergeIntoMicroNodeId
      ? topic.microNodes.findIndex((node) => node.candidateId === finding.mergeIntoMicroNodeId)
      : topic.microNodes.findIndex((node) => node.title === finding.mergeIntoMicroNodeTitle);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
      rejectedDecisionCount++;
      continue;
    }

    const source = topic.microNodes[sourceIndex];
    const target = topic.microNodes[targetIndex];
    target.sourceBlockIndices = [...new Set([...target.sourceBlockIndices, ...source.sourceBlockIndices])];
    target.exercises = [...target.exercises, ...source.exercises];
    target.supportingMaterialIndices = [...new Set([
      ...target.supportingMaterialIndices,
      ...source.supportingMaterialIndices,
    ])];
    topic.microNodes.splice(sourceIndex, 1);
    if (finding.microNodeId && finding.mergeIntoMicroNodeId) {
      resolvedCandidatePairs.push({
        candidateAId: finding.microNodeId,
        candidateBId: finding.mergeIntoMicroNodeId,
      });
    }
    actions.push({
      topicSequence: topic.sequence,
      keptMicroNodeTitle: target.title,
      removedMicroNodeTitle: source.title,
      reason: "HIGH_CONFIDENCE_OVER_SPLIT",
    });
  }

  const afterMicroNodeCount = topics.reduce((sum, topic) => sum + topic.microNodes.length, 0);
  return {
    beforeMicroNodeCount,
    afterMicroNodeCount,
    mergedMicroNodeCount: beforeMicroNodeCount - afterMicroNodeCount,
    rejectedDecisionCount,
    resolvedCandidatePairs,
    actions,
  };
}

export type AtomicityRepairAction =
  | "SPLIT_MICRONODE"
  | "ASSIGN_PRIMARY_EXERCISE"
  | "MARK_INTEGRATIVE";

/**
 * A bounded repair action is a proposal, never an authority.  Source ownership
 * remains server-validated and a split may only partition the target's existing
 * source — it cannot manufacture or duplicate source support.
 */
export interface AtomicityRepairDecision {
  action: AtomicityRepairAction;
  topicSequence: number;
  microNodeId?: string;
  exerciseBlockIndex?: number;
  splitMicroNodes?: Array<{
    title: string;
    learningObjective: string;
    microNodeType: "knowledge" | "skill";
    sourceBlockIndices: number[];
    exerciseBlockIndices: number[];
  }>;
  reason: string;
}

export interface AtomicityRepairResult {
  attempted: boolean;
  appliedCount: number;
  rejectedDecisionCount: number;
  splitCandidateIds: string[];
  splitReplacementCandidateIds: Record<string, string[]>;
  primaryExerciseIndices: number[];
  primaryExerciseOwnerCandidateIds: Record<number, string[]>;
  integrativeExerciseIndices: number[];
}

function isAtomicityEligibleSource(block: Pass1Block | undefined): block is Pass1Block {
  return !!block &&
    !ACTIVITY_BLOCK_TYPES.has(block.blockType) &&
    !["IMAGE", "CAPTION", "TABLE"].includes(block.blockType) &&
    !isUnreadableSource(block.sourceText);
}

function removeExerciseFromEveryDestination(topics: Pass2TopicResult[], blockIndex: number): void {
  for (const topic of topics) {
    for (const node of topic.microNodes) {
      node.exercises = node.exercises.filter((exercise) => exercise.blockIndex !== blockIndex);
    }
    topic.additionalExercises = topic.additionalExercises.filter((exercise) => exercise.blockIndex !== blockIndex);
  }
}

/**
 * Applies at most one provider-reviewed atomicity repair plan.  The only node
 * creation primitive is a true split: children must form an exact, disjoint
 * partition of the original node's source ownership.  This keeps source
 * provenance and canonical exercise identity intact.
 */
export function applyBoundedAtomicityRepairs(
  topics: Pass2TopicResult[],
  blocks: Pass1Block[],
  decisions: ReadonlyArray<AtomicityRepairDecision>,
): AtomicityRepairResult {
  const result: AtomicityRepairResult = {
    attempted: decisions.length > 0,
    appliedCount: 0,
    rejectedDecisionCount: 0,
    splitCandidateIds: [],
    splitReplacementCandidateIds: {},
    primaryExerciseIndices: [],
    primaryExerciseOwnerCandidateIds: {},
    integrativeExerciseIndices: [],
  };
  const isActivity = (index: number) => isValidBlockIndex(index, blocks) &&
    ACTIVITY_BLOCK_TYPES.has(blocks[index].blockType);
  const topicFor = (sequence: number) => topics.find((topic) => topic.sequence === sequence);
  const nodeFor = (topic: Pass2TopicResult | undefined, candidateId: string | undefined) =>
    candidateId ? topic?.microNodes.find((node) => node.candidateId === candidateId) : undefined;
  const attemptedSplitCandidateIds = new Set<string>();

  for (const decision of decisions) {
    const topic = topicFor(decision.topicSequence);
    if (!topic) {
      result.rejectedDecisionCount++;
      continue;
    }

    if (decision.action === "ASSIGN_PRIMARY_EXERCISE" || decision.action === "MARK_INTEGRATIVE") {
      const exerciseBlockIndex = decision.exerciseBlockIndex;
      if (!isActivity(exerciseBlockIndex ?? Number.NaN)) {
        result.rejectedDecisionCount++;
        continue;
      }
      if (decision.action === "ASSIGN_PRIMARY_EXERCISE") {
        const target = nodeFor(topic, decision.microNodeId);
        if (!target) {
          result.rejectedDecisionCount++;
          continue;
        }
        removeExerciseFromEveryDestination(topics, exerciseBlockIndex!);
        target.exercises.push({
          blockIndex: exerciseBlockIndex!,
          sourceParagraph: blocks[exerciseBlockIndex!].sourceParagraph ?? null,
        });
        result.primaryExerciseIndices.push(exerciseBlockIndex!);
        if (target.candidateId) {
          result.primaryExerciseOwnerCandidateIds[exerciseBlockIndex!] = [target.candidateId];
        }
      } else {
        removeExerciseFromEveryDestination(topics, exerciseBlockIndex!);
        topic.additionalExercises.push({
          blockIndex: exerciseBlockIndex!,
          sourceParagraph: blocks[exerciseBlockIndex!].sourceParagraph ?? null,
        });
        result.integrativeExerciseIndices.push(exerciseBlockIndex!);
      }
      result.appliedCount++;
      continue;
    }

    if (!decision.microNodeId || attemptedSplitCandidateIds.has(decision.microNodeId)) {
      result.rejectedDecisionCount++;
      continue;
    }
    // A candidate receives one split attempt at most. A rejected proposal is
    // still an attempt; accepting a later provider variation would turn this
    // bounded repair into an unbounded retry loop.
    attemptedSplitCandidateIds.add(decision.microNodeId);
    const target = nodeFor(topic, decision.microNodeId);
    const children = decision.splitMicroNodes ?? [];
    if (!target || children.length < 2) {
      result.rejectedDecisionCount++;
      continue;
    }
    const originalSource = [...new Set(target.sourceBlockIndices)].sort((a, b) => a - b);
    const claimedSource = children.flatMap((child) => child.sourceBlockIndices);
    const uniqueClaimed = [...new Set(claimedSource)].sort((a, b) => a - b);
    const exactPartition = claimedSource.length === uniqueClaimed.length &&
      uniqueClaimed.length === originalSource.length &&
      uniqueClaimed.every((index, position) => index === originalSource[position]);
    const validChildren = exactPartition && children.every((child) =>
      child.title.trim().length > 0 &&
      child.learningObjective.trim().length > 0 &&
      child.sourceBlockIndices.length > 0 &&
      child.sourceBlockIndices.every((index) =>
        originalSource.includes(index) && isAtomicityEligibleSource(blocks[index]),
      ) &&
      classifyMicroNodeSourceAlignment(
        child.learningObjective,
        child.sourceBlockIndices
          .map((index) => blocks[index])
          .filter((block): block is Pass1Block => !!block),
      ).status === "SUFFICIENT" &&
      child.exerciseBlockIndices.every(isActivity),
    );
    const exerciseIndices = children.flatMap((child) => child.exerciseBlockIndices);
    if (!validChildren || exerciseIndices.length !== new Set(exerciseIndices).size) {
      result.rejectedDecisionCount++;
      continue;
    }

    const previousExercises = target.exercises.map((exercise) => exercise.blockIndex);
    const childExercises = new Set(exerciseIndices);
    // A split is an authoritative re-assignment for these exercises. Remove
    // every old placement before the replacement children are inserted, so the
    // later canonical-normalization pass cannot retain an unrelated old owner.
    for (const exerciseIndex of childExercises) {
      removeExerciseFromEveryDestination(topics, exerciseIndex);
    }
    const targetIndex = topic.microNodes.indexOf(target);
    const originalCandidateId = target.candidateId ?? `t${topic.sequence}:n${targetIndex}`;
    const replacement = children.map((child, childIndex): Pass2MicroNode => ({
      candidateId: `${originalCandidateId}:split${childIndex}`,
      title: child.title.trim(),
      learningObjective: child.learningObjective.trim(),
      microNodeType: child.microNodeType,
      sourceBlockIndices: [...child.sourceBlockIndices],
      exercises: child.exerciseBlockIndices.map((blockIndex) => ({
        blockIndex,
        sourceParagraph: blocks[blockIndex].sourceParagraph ?? null,
      })),
      supportingMaterialIndices: [],
    }));
    topic.microNodes.splice(targetIndex, 1, ...replacement);
    for (const exerciseIndex of previousExercises) {
      if (!childExercises.has(exerciseIndex)) {
        topic.additionalExercises.push({
          blockIndex: exerciseIndex,
          sourceParagraph: blocks[exerciseIndex]?.sourceParagraph ?? null,
        });
      }
    }
    replacement.forEach((child) => {
      for (const exercise of child.exercises) {
        const expectedOwners = result.primaryExerciseOwnerCandidateIds[exercise.blockIndex] ?? [];
        if (child.candidateId && !expectedOwners.includes(child.candidateId)) {
          result.primaryExerciseOwnerCandidateIds[exercise.blockIndex] = [...expectedOwners, child.candidateId];
        }
      }
    });
    for (const exerciseIndex of childExercises) {
      if (!result.primaryExerciseIndices.includes(exerciseIndex)) {
        result.primaryExerciseIndices.push(exerciseIndex);
      }
    }
    result.splitCandidateIds.push(originalCandidateId);
    result.splitReplacementCandidateIds[originalCandidateId] = replacement
      .map((child) => child.candidateId)
      .filter((candidateId): candidateId is string => !!candidateId);
    result.appliedCount++;
  }
  return result;
}

/**
 * Finds semantic-review findings that are still structurally unresolved after
 * the single bounded repair pass. This deliberately checks final state rather
 * than trusting an action label: an integrative destination can never resolve a
 * source-supported missing-MicroNode finding.
 */
export function getUnresolvedAtomicityFindings(
  topics: ReadonlyArray<Pass2TopicResult>,
  findings: ReadonlyArray<GranularityFinding>,
  repair: AtomicityRepairResult,
  sourceAlignment: Pass2SourceAlignment,
): GranularityFinding[] {
  const nodeByCandidateId = new Map<string, Pass2MicroNode>();
  for (const topic of topics) {
    for (const node of topic.microNodes) {
      if (node.candidateId) nodeByCandidateId.set(node.candidateId, node);
    }
  }
  const hasPrimaryOwner = (blockIndex: number) =>
    topics.some((topic) => topic.microNodes.some((node) =>
      node.exercises.some((exercise) => exercise.blockIndex === blockIndex),
    ));

  return findings.flatMap((finding) => {
    if (finding.issue === "UNDER_SPLIT" || finding.issue === "MEGA_NODE") {
      if (!finding.microNodeId) return [finding];
      const replacementIds = repair.splitReplacementCandidateIds[finding.microNodeId];
      if (!replacementIds?.length) return [finding];
      return replacementIds.flatMap((candidateId) => {
        const replacement = nodeByCandidateId.get(candidateId);
        return !replacement || detectCompoundLO(replacement.learningObjective) !== null
          ? [{
              ...finding,
              microNodeId: candidateId,
              microNodeTitle: replacement?.title ?? finding.microNodeTitle,
            }]
          : [];
      });
    }
    if (finding.issue === "MISSING_ATOMIC_MICRONODE") {
      const expectedOwnerIds = repair.primaryExerciseOwnerCandidateIds[finding.exerciseBlockIndex ?? Number.NaN] ?? [];
      return !Number.isInteger(finding.exerciseBlockIndex) ||
        !repair.primaryExerciseIndices.includes(finding.exerciseBlockIndex!) ||
        !hasPrimaryOwner(finding.exerciseBlockIndex!) ||
        expectedOwnerIds.length === 0 ||
        !expectedOwnerIds.some((candidateId) =>
          nodeByCandidateId.get(candidateId)?.exercises.some(
            (exercise) => exercise.blockIndex === finding.exerciseBlockIndex,
          ),
        )
        ? [finding]
        : [];
    }
    if (finding.issue === "EXERCISE_MISMATCH") {
      return !Number.isInteger(finding.exerciseBlockIndex) ||
        (!repair.primaryExerciseIndices.includes(finding.exerciseBlockIndex!) &&
          !repair.integrativeExerciseIndices.includes(finding.exerciseBlockIndex!))
        ? [finding]
        : [];
    }
    if (finding.issue === "UNSUPPORTED_MICRONODE") {
      if (sourceAlignment.valid) return [];
      const replacementIds = finding.microNodeId
        ? repair.splitReplacementCandidateIds[finding.microNodeId]
        : undefined;
      if (!replacementIds?.length) return [finding];
      return replacementIds.flatMap((candidateId) => {
        const replacement = nodeByCandidateId.get(candidateId);
        const audit = sourceAlignment.nodes.find((entry) =>
          entry.microNodeId === candidateId,
        )?.audit;
        return audit?.status === "SUFFICIENT"
          ? []
          : [{
              ...finding,
              microNodeId: candidateId,
              microNodeTitle: replacement?.title ?? finding.microNodeTitle,
            }];
      });
    }
    // OVER_SPLIT is resolved by the separate duplicate-resolution gate.
    return [];
  });
}

export type Pass2SourceAlignment = {
  valid: boolean;
  sufficientCount: number;
  partialCount: number;
  insufficientCount: number;
  unreadableCount: number;
  /** Source-safe metadata only; never includes raw textbook excerpts or provider payloads. */
  nodes: Array<{
    topicSequence: number;
    topicTitle: string;
    microNodeIndex: number;
    microNodeId: string;
    microNodeTitle: string;
    learningObjective: string;
    sourceBlockIndices: number[];
    sourcePages: number[];
    missingObjectiveConceptLabels: string[];
    /** Bounded same-topic ownership repair outcome, when the node needed one. */
    reconciliationDisposition?: SourceAlignmentReconciliationDisposition;
    audit: SourceAlignmentAudit;
  }>;
};

export function validatePass2SourceAlignment(
  topics: ReadonlyArray<Pass2TopicResult>,
  blocks: ReadonlyArray<Pass1Block>,
): Pass2SourceAlignment {
  const nodes = topics.flatMap((topic) => topic.microNodes.map((node, microNodeIndex) => {
    const sourceBlockIndices = [...node.sourceBlockIndices];
    const sourceBlocks = sourceBlockIndices
      .map((index) => blocks[index])
      .filter((block): block is Pass1Block => !!block);
    return {
      topicSequence: topic.sequence,
      topicTitle: topic.title,
      microNodeIndex,
      microNodeId: node.candidateId ?? `t${topic.sequence}:n${microNodeIndex}`,
      microNodeTitle: node.title,
      learningObjective: node.learningObjective,
      sourceBlockIndices,
      sourcePages: [...new Set(sourceBlocks.map((block) => block.sourcePage))]
        .sort((a, b) => a - b),
      missingObjectiveConceptLabels: getMissingObjectiveConceptLabels(
        node.learningObjective,
        sourceBlocks,
      ),
      audit: classifyMicroNodeSourceAlignment(node.learningObjective, sourceBlocks),
    };
  }));
  const count = (status: SourceAlignmentAudit["status"]) => nodes.filter((node) => node.audit.status === status).length;
  return {
    valid: nodes.every((node) => node.audit.status === "SUFFICIENT"),
    sufficientCount: count("SUFFICIENT"),
    partialCount: count("PARTIAL"),
    insufficientCount: count("INSUFFICIENT"),
    unreadableCount: count("UNREADABLE"),
    nodes,
  };
}

export type SourceReallocationResult = {
  attempted: boolean;
  appliedCount: number;
  rejectedDecisionCount: number;
  actions: Array<{
    topicSequence: number;
    microNodeTitle: string;
    action: SourceReallocationAction;
    sourceBlockIndices: number[];
    reasonCode: "SEMANTIC_SOURCE_REVIEW";
  }>;
};

export type SourceAlignmentReconciliationDisposition = {
  topicSequence: number;
  microNodeId: string;
  microNodeTitle: string;
  status: "REPAIRED" | "NO_SAFE_SAME_TOPIC_REALLOCATION";
  sourceBlockIndices: number[];
};

export type SourceAlignmentReconciliationResult = {
  attempted: boolean;
  appliedCount: number;
  /** One deterministic disposition for every initially non-sufficient node. */
  dispositions: SourceAlignmentReconciliationDisposition[];
};

/**
 * One bounded, provider-free source-ownership reconciliation pass.
 *
 * A Pass 2B response can legitimately create a partial owner when a directly
 * supporting, verified block is held by a neighboring MicroNode. This routine
 * searches same-topic source ownership exactly once and moves at most one block
 * per non-sufficient node. A move is accepted only when the recipient and every
 * donor are both SUFFICIENT after the move. No source is duplicated, invented,
 * or taken from outside the verified topic input.
 */
export function reconcileSameTopicSourceAlignment(
  topics: Pass2TopicResult[],
  blocks: ReadonlyArray<Pass1Block>,
): SourceAlignmentReconciliationResult {
  const result: SourceAlignmentReconciliationResult = {
    attempted: false,
    appliedCount: 0,
    dispositions: [],
  };
  const isEligible = (index: number) => {
    const block = blocks[index];
    return Number.isInteger(index) && !!block &&
      !ACTIVITY_BLOCK_TYPES.has(block.blockType) &&
      !["IMAGE", "CAPTION", "TABLE"].includes(block.blockType) &&
      !isUnreadableSource(block.sourceText) &&
      !isLikelyStructuralHeading(block);
  };
  const auditNode = (node: Pass2MicroNode) => classifyMicroNodeSourceAlignment(
    node.learningObjective,
    node.sourceBlockIndices.map((index) => blocks[index]).filter((block): block is Pass1Block => !!block),
  );

  for (const topic of topics) {
    const initialTargets = topic.microNodes
      .filter((node) => auditNode(node).status !== "SUFFICIENT");
    for (const target of initialTargets) {
      result.attempted = true;
      const targetId = target.candidateId ??
        `t${topic.sequence}:n${topic.microNodes.indexOf(target)}`;
      let movedIndex: number | null = null;
      const candidateIndices = [...new Set(topic.inputBlockIndices)]
        .filter((index) => !target.sourceBlockIndices.includes(index) && isEligible(index))
        .sort((a, b) => a - b);

      for (const index of candidateIndices) {
        const donors = topic.microNodes.filter((node) =>
          node !== target && node.sourceBlockIndices.includes(index),
        );
        // The reconciliation is ownership-only. It never promotes an unmapped
        // block into evidence, and it never chooses a block with no current
        // same-topic source owner.
        if (donors.length === 0) continue;
        const targetAudit = classifyMicroNodeSourceAlignment(
          target.learningObjective,
          [...target.sourceBlockIndices, index]
            .map((sourceIndex) => blocks[sourceIndex])
            .filter((block): block is Pass1Block => !!block),
        );
        if (targetAudit.status !== "SUFFICIENT") continue;
        const donorsRemainSufficient = donors.every((donor) => classifyMicroNodeSourceAlignment(
          donor.learningObjective,
          donor.sourceBlockIndices
            .filter((sourceIndex) => sourceIndex !== index)
            .map((sourceIndex) => blocks[sourceIndex])
            .filter((block): block is Pass1Block => !!block),
        ).status === "SUFFICIENT");
        if (!donorsRemainSufficient) continue;

        for (const donor of donors) {
          donor.sourceBlockIndices = donor.sourceBlockIndices
            .filter((sourceIndex) => sourceIndex !== index);
        }
        target.sourceBlockIndices = [...new Set([...target.sourceBlockIndices, index])];
        movedIndex = index;
        result.appliedCount++;
        break;
      }

      result.dispositions.push({
        topicSequence: topic.sequence,
        microNodeId: targetId,
        microNodeTitle: target.title,
        status: movedIndex === null ? "NO_SAFE_SAME_TOPIC_REALLOCATION" : "REPAIRED",
        sourceBlockIndices: movedIndex === null ? [] : [movedIndex],
      });
    }
  }
  return result;
}

/**
 * Applies the one semantic-review result without making the reviewer an
 * authority. Every index must be a readable, non-activity block in this exact
 * validated Source Set; the target must still need support; and the canonical
 * single-owner invariant is preserved for moved blocks.
 */
export function applyBoundedSourceReallocation(
  topics: Pass2TopicResult[],
  blocks: ReadonlyArray<Pass1Block>,
  decisions: ReadonlyArray<SourceReallocationDecision>,
  options: { requireStableIds?: boolean } = {},
): SourceReallocationResult {
  const result: SourceReallocationResult = {
    attempted: decisions.length > 0,
    appliedCount: 0,
    rejectedDecisionCount: 0,
    actions: [],
  };
  const isEligible = (index: number) => {
    const block = blocks[index];
    return Number.isInteger(index) && !!block &&
      !["EXERCISE", "ACTIVITY", "HOMEWORK", "IMAGE"].includes(block.blockType) &&
      !isUnreadableSource(block.sourceText);
  };
  const ownerOf = (index: number) => topics.flatMap((topic) =>
    topic.microNodes.filter((node) => node.sourceBlockIndices.includes(index)),
  );

  for (const decision of decisions) {
    if (decision.action === "KEEP_CURRENT" || decision.action === "NO_VALID_SUPPORT_FOUND") continue;
    if (options.requireStableIds && (decision.topicSequence === undefined || !decision.microNodeId)) {
      result.rejectedDecisionCount++;
      continue;
    }
    const topic = decision.topicSequence !== undefined
      ? topics.find((candidate) => candidate.sequence === decision.topicSequence)
      : topics.find((candidate) => candidate.title === decision.topicTitle);
    const target = decision.microNodeId
      ? topic?.microNodes.find((node) => node.candidateId === decision.microNodeId)
      : topic?.microNodes.find((node) => node.title === decision.microNodeTitle);
    if (!topic || !target || classifyMicroNodeSourceAlignment(
      target.learningObjective,
      target.sourceBlockIndices.map((index) => blocks[index]).filter((block): block is Pass1Block => !!block),
    ).status === "SUFFICIENT") {
      result.rejectedDecisionCount++;
      continue;
    }
    if (decision.action === "NARROW_OBJECTIVE") {
      const revisedObjective = decision.learningObjective?.trim() ?? "";
      const revisedAudit = revisedObjective
        ? classifyMicroNodeSourceAlignment(
          revisedObjective,
          target.sourceBlockIndices.map((index) => blocks[index])
            .filter((block): block is Pass1Block => !!block),
        )
        : null;
      if (!revisedObjective || detectCompoundLO(revisedObjective) || revisedAudit?.status !== "SUFFICIENT") {
        result.rejectedDecisionCount++;
        continue;
      }
      target.learningObjective = revisedObjective;
      result.appliedCount++;
      result.actions.push({
        topicSequence: topic.sequence,
        microNodeTitle: target.title,
        action: decision.action,
        sourceBlockIndices: [],
        reasonCode: "SEMANTIC_SOURCE_REVIEW",
      });
      continue;
    }
    const indices = [...new Set(decision.sourceBlockIndices)].filter(isEligible);
    if (indices.length === 0 || indices.length !== new Set(decision.sourceBlockIndices).size) {
      result.rejectedDecisionCount++;
      continue;
    }
    if (decision.action === "ADD_SUPPORTING_BLOCKS" &&
      indices.some((index) => ownerOf(index).some((owner) => owner !== target))) {
      // Canonical coverage does not allow duplicate ownership. The reviewer
      // must choose MOVE_BLOCKS for an already-owned candidate.
      result.rejectedDecisionCount++;
      continue;
    }
    if (decision.action === "MOVE_BLOCKS" || decision.action === "MERGE_SOURCE_OWNERSHIP") {
      for (const index of indices) {
        for (const owner of ownerOf(index)) {
          if (owner !== target) owner.sourceBlockIndices = owner.sourceBlockIndices.filter((owned) => owned !== index);
        }
      }
    }
    target.sourceBlockIndices = [...new Set([...target.sourceBlockIndices, ...indices])];
    result.appliedCount++;
    result.actions.push({
      topicSequence: topic.sequence,
      microNodeTitle: target.title,
      action: decision.action,
      sourceBlockIndices: indices,
      reasonCode: "SEMANTIC_SOURCE_REVIEW",
    });
  }
  return result;
}

export interface Pass2Result {
  topics: Pass2TopicResult[];
  /** Block indices that were not placed in any MicroNode (page headers, etc.). */
  unmappedBlockIndices: number[];
  /** Readable instructional blocks retained for teacher review rather than
   * fabricated into a MicroNode source relation. */
  sourcePlacementReview: {
    preservedBlockIndices: number[];
  };
  /** Deterministic source-coverage validation result. Independent of AI self-report. */
  coverageValidation: CoverageValidationResult;
  /** Strict readable-instruction coverage; unlike placement coverage, an
   * `unmapped` block cannot satisfy this gate. */
  instructionalCoverage: InstructionalCoverageResult;
  /** Phase 4 semantic findings for teacher review. */
  granularityFindings: GranularityFinding[];
  /**
   * Semantic findings which remain after the one bounded repair pass. They are
   * pedagogical review requirements, not a reason to discard an otherwise
   * verified and structurally valid map.
   */
  unresolvedAtomicityFindings: GranularityFinding[];
  /** Bounded pre-persistence merges applied only to explicit HIGH decisions. */
  granularityConsolidation: GranularityConsolidation;
  /** Duplicate suspicion audit; unresolved pairs block persistence. */
  duplicateResolution: DuplicateResolutionAudit;
  sourceAlignment: Pass2SourceAlignment;
  sourceReallocation: SourceReallocationResult;
  /** One deterministic post-review ownership reconciliation pass. */
  sourceAlignmentReconciliation: SourceAlignmentReconciliationResult;
  /** One same-lesson, server-validated repair pass for atomicity/exercise ownership. */
  atomicityRepair: AtomicityRepairResult;
  /** Structured verification/retry/persistence trace for the atomicity boundary. */
  atomicityVerification: AtomicityVerificationDiagnostics;
  /** Count-only trace of Step 2 parsing, structural rejection, and normalization. */
  diagnostics: Pass2Diagnostics;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function fmtPass2Block(idx: number, b: Pass1Block): string {
  const para = b.sourceParagraph ? ` §${b.sourceParagraph}` : "";
  const text = (b.sourceText ?? "").replace(/\n/g, " ").slice(0, 200).trim();
  return `[${idx}] ${b.blockType} p${b.sourcePage}${para}: ${text}`;
}

function parsePass2JSON(raw: string): unknown {
  let s = raw.trim();
  if (s.startsWith("```json")) s = s.slice(7);
  else if (s.startsWith("```"))  s = s.slice(3);
  if (s.endsWith("```")) s = s.slice(0, -3).trim();
  // Primary repair: sanitize bare control characters inside COMPLETE JSON string
  // literals (handles \" escapes, dotAll flag). Unterminated strings (missing
  // closing quote) are not matched here and fall through to the secondary repair.
  s = s.replace(/"(?:[^"\\]|\\.)*"/gs, (str) =>
    str
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
  );

  try { return JSON.parse(s); } catch (firstErr: unknown) {
    const msg = String(firstErr);
    // Secondary repair: if the error is a bare control character inside a string
    // (including unterminated strings where the primary regex could not match),
    // walk the string char-by-char tracking quote state and escape any bare
    // newline/carriage-return found inside a string literal, then retry once.
    if (msg.includes("Unterminated string") || msg.includes("Invalid control character")) {
      let inStr = false, esc = false;
      const out: string[] = [];
      for (const c of s) {
        if (esc)        { out.push(c); esc = false; continue; }
        if (c === "\\") { out.push(c); esc = true;  continue; }
        if (c === '"')  { inStr = !inStr; out.push(c); continue; }
        if (inStr && c === "\n") { out.push("\\n"); continue; }
        if (inStr && c === "\r") { out.push("\\r"); continue; }
        if (inStr && c === "\t") { out.push("\\t"); continue; }
        if (inStr && c < " ")   { /* strip other control chars */ continue; }
        out.push(c);
      }
      return JSON.parse(out.join(""));
    }
    throw firstErr;
  }
}

// ── Step 1: detect topic boundaries ──────────────────────────────────────────

const PASS2_STEP1_SYSTEM = `You are a curriculum analyst. Given a flat list of textbook content blocks,
identify where topic boundaries occur and group the block indices into topics.

Output ONLY valid JSON, no markdown fences, no commentary:
{
  "groups": [
    {
      "topicTitle": "brief title",
      "topicType": "grammar | enrichment",
      "blockIndices": [0, 1, 2, ...]
    }
  ]
}

Rules:
- Every block index in the input must appear in exactly one group. None may be omitted.
- Identify boundaries by subject-matter shift, new section headings (OBJECTIVE blocks),
  or clear changes in content.
- Any cultural reading / enrichment passage (usually final pages) → topicType "enrichment".
- Aim for 4-6 groups totalling all provided block indices.
- Do NOT create MicroNodes yet — only groups of block indices per topic.
- LANGUAGE: All topicTitle values MUST be written in Armenian. Never use English for titles,
  even for internal or organisational categories such as "Introduction" or "Exercises".
  Write "Ներածություն" not "Introduction", "Վարժություններ" not "Exercises", etc.`;

async function detectTopicGroups(
  blocks: Pass1Block[],
  lessonTitle: string,
  pagesFrom: number,
  pagesTo: number
): Promise<{ title: string; topicType: string; indices: number[] }[]> {
  const allIndices = blocks.map((_, i) => i);
  const blockLines = blocks.map((b, i) => fmtPass2Block(i, b)).join("\n");

  const userPrompt = `Lesson: «${lessonTitle}», pages ${pagesFrom}–${pagesTo}.
These ${blocks.length} blocks must be grouped into topics.
ALL indices that must appear: [${allIndices.join(", ")}]

BLOCKS:
${blockLines}

Group every block index above into topics. Output JSON now.`;

  const r = await openrouter.chat.completions.create({
    model: PASS2_STEP1_MODEL,
    max_tokens: 4000,
    temperature: 0,
    messages: [
      { role: "system", content: PASS2_STEP1_SYSTEM },
      { role: "user",   content: userPrompt },
    ],
  });
  const raw = r.choices[0]?.message?.content ?? "";
  logger.info(
    { finish: r.choices[0]?.finish_reason },
    "pass2 step1: topic grouping complete"
  );

  const parsed = parsePass2JSON(raw) as {
    groups: { topicTitle: string; topicType: string; blockIndices: number[] }[]
  };
  return (parsed.groups ?? []).map((g) => ({
    title:     g.topicTitle,
    topicType: g.topicType ?? "grammar",
    indices:   Array.isArray(g.blockIndices) ? g.blockIndices : [],
  }));
}

// ── Step 1b: subdivide any group > PASS2_MAX_GROUP_SIZE ──────────────────────

const PASS2_SUBDIVIDE_SYSTEM = `You are a curriculum analyst. A topic group is too large and must be split into smaller sub-topics.

Output ONLY valid JSON, no markdown fences:
{
  "groups": [
    { "topicTitle": "...", "topicType": "grammar | enrichment", "blockIndices": [...] }
  ]
}

Rules:
- Split into 2-4 sub-topics of at most ${PASS2_MAX_GROUP_SIZE} blocks each.
- Every input block index must appear in exactly one sub-group. None may be omitted.
- Split at natural content boundaries (new rules, exercise blocks, section transitions).
- LANGUAGE: All topicTitle values MUST be written in Armenian. Never use English for titles,
  even for internal or organisational categories. Write "Ներածություն" not "Introduction", etc.`;

async function subdivideGroup(
  group: { title: string; topicType: string; indices: number[] },
  blocks: Pass1Block[]
): Promise<{ title: string; topicType: string; indices: number[] }[]> {
  const blockLines = group.indices.map((i) => fmtPass2Block(i, blocks[i])).join("\n");

  const userPrompt = `The following ${group.indices.length} blocks all belong to «${group.title}» but the group is too large (>${PASS2_MAX_GROUP_SIZE} blocks).
Split them into 2-4 sub-topics of ≤${PASS2_MAX_GROUP_SIZE} blocks each.
Block indices to distribute: [${group.indices.join(", ")}]

BLOCKS:
${blockLines}

Output JSON now.`;

  const r = await openrouter.chat.completions.create({
    model: PASS2_STEP1_MODEL,
    max_tokens: 2000,
    temperature: 0,
    messages: [
      { role: "system", content: PASS2_SUBDIVIDE_SYSTEM },
      { role: "user",   content: userPrompt },
    ],
  });
  const raw = r.choices[0]?.message?.content ?? "";
  logger.info(
    { originalGroup: group.title, finish: r.choices[0]?.finish_reason },
    "pass2 step1b: subdivision complete"
  );

  const parsed = parsePass2JSON(raw) as {
    groups: { topicTitle: string; topicType: string; blockIndices: number[] }[]
  };
  return (parsed.groups ?? []).map((g) => ({
    title:     g.topicTitle,
    topicType: g.topicType ?? group.topicType,
    indices:   Array.isArray(g.blockIndices) ? g.blockIndices : [],
  }));
}

// ── Step 2: organise one topic's blocks into MicroNodes ───────────────────────

const PASS2_STEP2_SYSTEM = `You are a curriculum architect for a grade-7 Armenian-language textbook.
You receive a list of content blocks belonging to ONE topic and must organize them into
MicroNodes with strict block-index traceability.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MICRONODE COUNT — driven by content, never by a numeric cap
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Produce exactly ONE MicroNode for each coherent, independently teachable learning
objective present in the source blocks.

MicroNode count MUST NOT be determined by a fixed numeric cap.

Procedure:
  1. First identify the distinct teachable concepts/skills represented by the blocks.
  2. Then group the blocks belonging to each concept/skill into one MicroNode.
  3. Produce one MicroNode per identified objective.

A MicroNode is the smallest independently teachable and independently assessable unit.
Typical topics contain 1–6 MicroNodes, but this is guidance only, NOT a hard limit.
Do NOT merge distinct learning objectives merely to reduce the MicroNode count.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CORRECT STRUCTURE — a MicroNode covers ONE objective and contains BOTH theory AND exercises:

{
  "title": "What is a Noun",
  "learningObjective": "Student can define what a noun is.",
  "microNodeType": "knowledge",
  "sourceBlockIndices": [0, 1, 2],
  "exercises": [
    {"blockIndex": 3, "sourceParagraph": "7"},
    {"blockIndex": 4, "sourceParagraph": "8"}
  ],
  "supportingMaterialIndices": []
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ILLEGAL ANTI-PATTERN 1 — standalone exercise MicroNode — never create this:
{
  "title": "Exercises on Nouns",
  "sourceBlockIndices": [],          ← ZERO source indices = INVALID
  "exercises": [{"blockIndex": 3}, ...]
}

ILLEGAL ANTI-PATTERN 2 — multiple independent objectives in one MicroNode:
Do NOT create one MicroNode like this:
{
  "title": "Number classes and reading",
  "learningObjective": "Student can decompose numbers AND read them aloud.",
  ...
}
This contains two independently teachable skills. Instead create TWO MicroNodes:
  MicroNode 1 — title: "Number class"
                learningObjective: "Student can define what a number class is."
  MicroNode 2 — title: "Reading multi-digit numbers"
                learningObjective: "Student can read a multi-digit number aloud by naming its classes."

Rule: if two skills can be taught and assessed independently, they MUST be separate
MicroNodes even when their source blocks are adjacent or appear on the same page.
Do NOT bundle multiple definitions, rules, procedures, or independently testable
outcomes into one MicroNode.

FINAL ATOMICITY CHECK — before returning a MicroNode:
  • Write exactly one observable action about one source-taught concept or procedure.
  • If the source teaches two concepts that could be assessed separately, create two
    MicroNodes only when each has its own direct instructional source support.
  • Do not turn historical, contextual, visual, or merely neighboring material into
    a learning objective unless its assigned source directly teaches that objective.
  • When no direct source supports a possible objective, do not invent a MicroNode;
    retain the relevant activity as additionalExercises or leave structural context
    in unmappedBlocks.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIELD DEFINITIONS:
• sourceBlockIndices  — block indices this MicroNode "owns": every DEFINITION, RULE, NOTE,
                        EXAMPLE, or OBJECTIVE block that contains an actual instructional
                        sentence or learning content.
                        MUST be non-empty. If you cannot find a non-activity source block,
                        merge with an adjacent MicroNode instead.

  SOURCE-ALIGNMENT GATE — apply before returning every MicroNode:
  1. The assigned source must directly teach the exact concept/action in learningObjective.
     Shared topical words alone are not enough.
  2. A short NOTE/OBJECTIVE that is only a lesson or section title is structural context,
     never instructional evidence. Put it in unmappedBlocks; never make it the sole
     sourceBlockIndices entry for a MicroNode.
  3. If the available source teaches a narrower idea than your draft objective, narrow the
     objective to that supported idea. Do not create an unsupported Outcome or MicroNode.
  4. Before final output, verify every MicroNode has at least one readable, non-heading
     source block that directly supports its objective. If not, merge it into the node that
     owns the supporting source or remove the unsupported draft node.

  STRICT RULE — EXERCISE blocks in sourceBlockIndices:
  An EXERCISE / ACTIVITY / HOMEWORK block may appear in sourceBlockIndices ONLY when it
  contains ZERO student-directed imperative verbs.
  A student-directed imperative is any word that tells the student to perform an action.

  Armenian imperatives (non-exhaustive): գտնել, հաշվել, լրացնել, բացատրել, համեմատել,
    գրել, որոշել, լուծել, դasакargel, կazmel, ընдғծel, ընtrel, ápatsutsel,
    Գtemʻ, Lutsʻ, Haшvarekʻ, Khosel, Kardalʻ, Nshagiremʻ, Veraprobelʻ.
  English imperatives (non-exhaustive): Find, Calculate, Fill in, Explain, Compare,
    Write, Determine, Solve, Classify, Compose, Underline, Circle, Choose, Prove,
    Complete, Match, Identify, Answer, Describe, Evaluate.

  If ANY such imperative is present in the block text → the block MUST go into
  exercises[], NEVER into sourceBlockIndices.

  PRODUCTION FAILURE TO AVOID — this was a confirmed real mistake:
    Block: "115 Լratsrw̄ʻ nahadadowt'yownnerǝ ev drantsʻ meknabanerʻ orinaknerov."
    ("115 Fill in the sentences and interpret them with examples.")
    This block contains the imperative "Fill in" → it MUST be in exercises[],
    NOT in sourceBlockIndices.  The MicroNode had exercise_count=0 as a result.
• exercises           — EXERCISE, ACTIVITY, HOMEWORK blocks that are student practice tasks.

  ── STEP 1 — ALWAYS inspect existing MicroNodes FIRST ────────────────────────
  For EVERY exercise block, before doing anything else, read the LO of every
  MicroNode you have already produced for this topic and ask:
    "Which existing MicroNode has the closest Learning Objective to the skill
     this exercise actually practices?"
  If there is a reasonable semantic match, assign the block to that MicroNode's
  exercises[]. Do NOT create a new MicroNode for it.

  ── STEP 2 — Exercise FORMAT does not determine MicroNode ownership ───────────
  Do NOT create a new MicroNode because an exercise is a word problem,
  interpretation task, multi-step problem, fill-in-the-blank, discussion
  question, computation drill, or real-world application.
  These are exercise FORMATS, not different learning objectives.

  Examples:
  • An exercise asking a student to interpret what a difference means → belongs
    to the existing MicroNode whose LO covers the subtraction relationship,
    NOT to a new "difference interpretation" MicroNode.
  • A word problem requiring the student to find an unknown component → belongs
    to the corresponding existing unknown-component MicroNode even if it
    involves several arithmetic operations.
  • An exercise with a narrative context (shopping, comparing quantities) →
    still belongs to the MicroNode whose LO matches the primary skill being
    assessed, regardless of the real-world wrapper.

  ── STEP 3 — Multi-skill exercises ───────────────────────────────────────────
  When an exercise uses multiple skills:
  1. Identify its PRIMARY learning objective — the one skill being primarily
     assessed.
  2. Assign it to the existing MicroNode whose LO best represents that primary
     objective.
  3. If several MicroNodes are relevant, choose the MicroNode representing
     the most central or most advanced prerequisite skill actually assessed.
  4. Do NOT create a new MicroNode solely because the exercise combines multiple
     operations.

  ── STEP 4 — NEVER create an exercise-type MicroNode ─────────────────────────
  NEVER create a MicroNode whose purpose is to group exercises by exercise type.
  NEVER create a MicroNode with empty sourceBlockIndices in order to house
  exercises. The following are activity categories, NOT learning objectives,
  and MUST NOT become MicroNode titles:
    ✗ "Բառային խնդիրներ" / "Word problems"
    ✗ "Մեկնաբանական վարժություններ" / "Interpretation exercises"
    ✗ "Գործնական վարժություններ" / "Practice exercises"
    ✗ "Դասարանային վարժություններ" / "Class exercises"
    ✗ "Խառը վարժություններ" / "Mixed exercises"
    ✗ "Կիրառական վարժություններ" / "Application exercises"
  If an exercise does not justify a new THEORY MicroNode, assign it to the
  closest existing MicroNode or, as a last resort, put it in additionalExercises[].

  ── WORKED EXAMPLE — Lesson 104 (apply this reasoning to every lesson) ───────
  Existing MicroNodes:
    MN-A «Անhayт nvazeli gtnelǝ»  LO: find unknown minuend from minuend=subtrahend+difference
    MN-B «Անhayт haneli gtnelǝ»   LO: find unknown subtrahend from subtrahend=minuend−difference
    MN-C «Անhayт gumareli gtnelǝ» LO: find unknown addend from addend=sum−other_addend
    MN-D «Gumarmani ev hanman baghаdrychknery» LO: reason about relationships among sum, difference and their components

  Exercise assignments using semantic reasoning:
    Ex 114 (computation drill — all three unknown types) → MN-A or the closest
      component MicroNode. A mixed drill covering all unknowns belongs to the
      primary/first concept MicroNode, NOT to a new "mixed drill" MicroNode.
    Ex 116 ("explain what the difference shows") → MN-B or MN-D — the exercise
      tests understanding of the subtrahend/minuend/difference relationship.
      NOT a new "difference interpretation" MicroNode.
    Ex 117 (find starting number after successive increases → reverse addend) →
      MN-C — the core task is recovering an unknown addend using inverse
      operations. NOT a new "reverse problem" MicroNode.
    Ex 119–121 (word problems / discussion about sum-difference relationships)
      → MN-D — if the primary skill is reasoning about sum/difference
      relationships, assign to the existing relationship MicroNode.
    Ex 122 (class presentation / cross-lesson reflection activity) →
      additionalExercises[] — genuinely cross-node, not owned by any single LO.

  These are demonstrations of the decision PRINCIPLE. Do not hardcode these
  block indices — apply the same semantic reasoning to every lesson's blocks.
• supportingMaterialIndices — IMAGE, CAPTION, TABLE blocks that illustrate the MicroNode.
• unmappedBlocks      — Place a block here ONLY when it is a pure structural/header element
                        with no instructional content AND no student task. Specifically:
                        1. A block whose text is approximately ≤30 characters and contains no
                           instructional predicate and introduces no teachable concept.
                        2. An OBJECTIVE block that is only a section/chapter heading such as
                           "ԴԱՍ: ՄԻԼԻՈՆՆԵՐԻ ԴԱՍ" — with no instructional sentence — goes here.
                        3. A page/chapter/book label with no instructional sentence goes here.
                        4. An OBJECTIVE block containing an actual instructional sentence or
                           learning content stays in sourceBlockIndices.
                        Do NOT place a block in unmappedBlocks merely because it is short, if
                        it clearly states a concept, term, or rule. Do NOT put a section heading
                        into sourceBlockIndices merely because it is non-empty.

  ABSOLUTE RULE — EXERCISE / ACTIVITY / HOMEWORK blocks MUST NEVER appear in unmappedBlocks.
  If an EXERCISE/ACTIVITY/HOMEWORK block has no matching MicroNode, it goes to
  additionalExercises[], NOT unmappedBlocks. Placing a student-facing task in unmappedBlocks
  causes it to be permanently lost — it will never be inserted into lesson_exercises and
  will never reach the AI Teacher.

LEARNING OBJECTIVE CONTRACT:
• Every MicroNode MUST have exactly ONE coherent learning objective.
• The objective must be expressible as: "Student can [one action] [one concept or skill]."
• The objective must describe ONE independently teachable and assessable outcome.

ABSOLUTE RULE — ONE ACTION PER LEARNING OBJECTIVE:
Every learningObjective MUST contain exactly ONE independently assessable action.
If an objective contains two independent actions, concepts, or outcomes connected by:
  • and / կամ / ու / եւ
  • or / or
  • then / after that
  • also / as well as
  • comma-separated independent actions
the objective MUST be split into separate MicroNodes.

ONE PROCEDURE WITH STEPS → ONE MicroNode (allowed):
  A procedure may contain multiple steps when those steps form ONE inseparable procedure
  with ONE final outcome. Example:
  VALID: "Student can decompose a multi-digit number into classes by grouping digits
          from right to left."
  (Here "grouping from right to left" is the METHOD of ONE procedure — not a separate skill.)

TWO INDEPENDENT OUTCOMES → TWO MicroNodes (required):
  When two outcomes can each be assessed independently — a student could succeed at one
  while failing the other — they are separate MicroNodes. Example:
  INVALID: "Student can decompose a multi-digit number into classes and read it aloud."
  (Decomposing and reading aloud are separately testable → must be split.)

DIAGNOSTIC TEST — apply before finalizing every MicroNode:
  Ask: "Could two separate test questions be written such that a student answers one
  correctly while failing the other?"
  If YES → split into two MicroNodes.
  If NO → one procedure, one MicroNode is correct.

Do NOT treat a prerequisite relationship as permission to combine two independently
assessable skills. Even if skill B requires skill A, if they are separately testable,
they MUST be separate MicroNodes.

BEFORE FINALIZING — cross-check all MicroNode LOs in this topic:
  — No two MicroNodes may describe the same skill using different wording.
  — If two MicroNodes have essentially the same objective, merge them.
  — If one MicroNode contains multiple independent objectives, split it.
  — Explicitly verify: does each LO have exactly one primary action and one concept?

VALID objective examples:
  "Student can define what a number class is."
  "Student can decompose a multi-digit number into classes from right to left."
  "Student can read a multi-digit number aloud by naming each class."

INVALID objective examples (MUST be split into separate MicroNodes):
  "Student can decompose numbers and read them aloud."      ← two independent outcomes
  "Student can define classes, explain their meaning, and identify them."  ← three actions

ABSOLUTE RULES:
1. Every block index provided must appear exactly once across sourceBlockIndices, exercises,
   supportingMaterialIndices, or unmappedBlocks.
2. Every MicroNode MUST have at least one entry in sourceBlockIndices.
3. If a block is an EXERCISE/ACTIVITY/HOMEWORK, add it to an existing theory MicroNode's
   exercises array — never isolate it in its own standalone MicroNode.
4. Do not invent content not present in the blocks.
5. LANGUAGE: All MicroNode titles and learningObjective fields MUST be written in Armenian.
   Never use English for titles, even for internal or organisational categories such as
   "Exercises and Activities" or "Introduction". Write "Վարժություններ" not "Exercises",
   "Ներածություն" not "Introduction", etc.

additionalExercises[] IS A LAST RESORT — not a default for uncertain ownership:
Before placing any exercise in additionalExercises[], explicitly check EVERY existing
MicroNode in the current topic and determine whether one has a defensible semantic match.

additionalExercises[] is ONLY appropriate when ALL of the following apply:
  1. The exercise is genuinely cross-node — it simultaneously practices the LOs of two
     or more MicroNodes with equal weight, so no single MicroNode can reasonably own it.
  OR
  2. It is genuinely metacognitive / reflective / presentation-oriented (e.g. a class
     activity comparing the lesson to something, or a group reflection task).
  OR
  3. It tests something entirely outside the learning objectives represented by the
     current topic's MicroNodes.

Uncertainty caused ONLY by the exercise format (word problem, multi-step, discussion
question, etc.) is NOT sufficient justification for additionalExercises[].

  → DO NOT create a MicroNode with sourceBlockIndices: [] just to house the exercise.
  → DO NOT put real textbook exercises in unmappedBlocks.
  → additionalExercises[] preserves the exercise as real textbook content without
    inventing a source-less MicroNode — but it is the fallback of last resort.

Decision tree for each EXERCISE/ACTIVITY/HOMEWORK block:
  1. Read every existing MicroNode's LO in this topic.
     Does any of them reasonably cover the PRIMARY skill this exercise practices?
     YES → assign it to that MicroNode's exercises[]. STOP.
  2. Is there more than one MicroNode that partially covers this exercise's skills?
     YES → identify the PRIMARY skill being assessed; assign to the MicroNode whose
     LO best represents that primary skill. STOP.
  3. Does a genuine instructional source block exist for a new, distinct skill not yet
     covered by any MicroNode's LO?
     YES → create a MicroNode from that source block, then assign the exercise. STOP.
  4. None of the above applies (exercise is genuinely cross-node, reflective, or out
     of scope for all existing MicroNode LOs)?
     → Place in additionalExercises[]. Never create a source-less MicroNode.

ABSOLUTE ACTIVITY PRESERVATION RULE:
Every EXERCISE, ACTIVITY, or HOMEWORK block listed in the input MUST appear in your output
in exactly one of:
  1. microNode.exercises[]   — with the EXACT Pass1 blockIndex from the "Block N:" label
  2. additionalExercises[]   — with the EXACT Pass1 blockIndex from the "Block N:" label

CRITICAL — blockIndex must be the Pass1 array index, nothing else:
  • NEVER output null, undefined, or omit blockIndex.
  • NEVER use the exercise/problem number printed in the textbook as blockIndex.
    (e.g. if the block text says "Exercise 117" and the label says "Block 12:", use 12, NOT 117)
  • NEVER use 0 as a default blockIndex when you are unsure.
  • blockIndex is the NUMBER after "Block" in the input label — copy it exactly.

PRODUCTION FAILURE EXAMPLE:
  Input: "Block 12: [EXERCISE, p39] 117 Mtapahel em mi tiv..."
  CORRECT:  {"blockIndex": 12, "reason": "..."}
  WRONG:    {"blockIndex": null}   ← causes the exercise to be permanently lost
  WRONG:    {"blockIndex": 117}    ← 117 is the exercise number, NOT the block index
  
If you are uncertain which MicroNode owns an exercise → re-read every existing MicroNode's
LO and pick the closest semantic match. Only use additionalExercises[] if, after that
re-check, no existing MicroNode provides a defensible owner.
Uncertainty about the owner is NEVER a reason to use null for blockIndex.

OUTPUT: respond with ONLY valid JSON — no markdown fences, no commentary before or after.
{
  "microNodes": [ <MicroNode objects as shown above> ],
  "unmappedBlocks": [ {"blockIndex": 0, "reason": "page header only — no instructional content"} ],
  "additionalExercises": [
    {"blockIndex": 11, "reason": "No instructional source block for arithmetic operations in this topic; does not match any existing MicroNode LO"},
    {"blockIndex": 12, "reason": "No instructional source block for arithmetic operations in this topic; does not match any existing MicroNode LO"}
  ]
}`;

async function organizeTopicMicroNodes(
  topicTitle: string,
  topicIndices: number[],
  blocks: Pass1Block[],
  topicSeq: number,
  curriculumConstraints: string,
): Promise<{
  microNodes: Pass2MicroNode[];
  unmappedIndices: number[];
  additionalExercises: Pass2Exercise[];
  diagnostics: Pass2TopicDiagnostics;
}> {
  const blockLines = topicIndices.map((i) => fmtPass2Block(i, blocks[i])).join("\n");

  const userPrompt = `Topic ${topicSeq}: «${topicTitle}»
Block indices to account for: [${topicIndices.join(", ")}]
(Every index above must appear in your output.)

${curriculumConstraints}

BLOCKS:
${blockLines}

Identify the distinct teachable concepts/skills in the blocks above, then produce
exactly one MicroNode per identified learning objective.
Remember: exercises attach to the MicroNode whose objective they practice — no standalone exercise MicroNodes.`;

  const messages: Parameters<typeof openrouter.chat.completions.create>[0]["messages"] = [
    { role: "system", content: PASS2_STEP2_SYSTEM },
    { role: "user",   content: userPrompt },
  ];

  let r = await openrouter.chat.completions.create({
    model: PASS2_STEP2_MODEL,
    max_tokens: 4000,
    temperature: 0,
    messages,
  });
  let raw    = r.choices[0]?.message?.content ?? "";
  let finish = r.choices[0]?.finish_reason;
  let retried = false;

  // Retry once on API error or empty response (Gemini occasionally returns finish_reason "error")
  if (!raw.trim() || (finish as string) === "error") {
    logger.warn({ topicTitle, topicSeq, finish }, "pass2 step2: empty/error response — retrying");
    r      = await openrouter.chat.completions.create({
      model: PASS2_STEP2_MODEL,
      max_tokens: 4000,
      temperature: 0,
      messages,
    });
    raw    = r.choices[0]?.message?.content ?? "";
    finish = r.choices[0]?.finish_reason;
    retried = true;
  }

  logger.info({ topicTitle, topicSeq, finish }, "pass2 step2: MicroNode org complete");

  const parseAttempt = safelyParsePass2Step2Response(raw, finish, retried);
  if (!parseAttempt.ok) {
    throw new Pass2Step2ParserError({
      topicSequence: topicSeq,
      inputBlockCount: topicIndices.length,
      response: parseAttempt.response,
      candidateMicroNodeCount: 0,
      acceptedMicroNodeCount: 0,
      rejectedMicroNodeCount: 0,
      rejectionCounts: {},
      postNormalizationMicroNodeCount: 0,
    });
  }
  const parsedValue = parseAttempt.parsedValue;
  const parsed = asRecord(parsedValue) ?? {};
  const response = parseAttempt.response;
  const rejectionCounts: Partial<Record<Pass2MicroNodeRejectionReason, number>> = {};
  const countRejection = (reason: Pass2MicroNodeRejectionReason) => {
    rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
  };
  if (!Array.isArray(parsed.microNodes)) countRejection("MISSING_MICRONODES_ARRAY");

  const rawMicroNodes: Pass2MicroNode[] = (Array.isArray(parsed.microNodes) ? parsed.microNodes : [])
    .map((value) => {
      const mn = asRecord(value) ?? {};
      const exercises = Array.isArray(mn.exercises) ? mn.exercises : [];
      return {
        title: typeof mn.title === "string" ? mn.title : "",
        learningObjective: typeof mn.learningObjective === "string" ? mn.learningObjective : "",
        microNodeType: mn.microNodeType === "skill" ? "skill" : "knowledge",
        sourceBlockIndices: Array.isArray(mn.sourceBlockIndices)
          ? mn.sourceBlockIndices.filter((index): index is number => typeof index === "number")
          : [],
        exercises: exercises.map((value) => {
          const exercise = asRecord(value) ?? {};
          return {
            blockIndex: typeof exercise.blockIndex === "number" ? exercise.blockIndex : Number.NaN,
            sourceParagraph: typeof exercise.sourceParagraph === "string" ? exercise.sourceParagraph : null,
          };
        }),
        supportingMaterialIndices: Array.isArray(mn.supportingMaterialIndices)
          ? mn.supportingMaterialIndices.filter((index): index is number => typeof index === "number")
          : [],
      };
    });

  // Collect additional exercises from model output first.
  const additionalExercises: Pass2Exercise[] = (
    Array.isArray(parsed.additionalExercises) ? parsed.additionalExercises : []
  ).map((value) => {
    const exercise = asRecord(value) ?? {};
    return {
      blockIndex: typeof exercise.blockIndex === "number" ? exercise.blockIndex : Number.NaN,
      sourceParagraph: null,
    };
  });

  // Server-side safety net: strip any MicroNode that violates a structural invariant.
  // Invariants (all three must hold):
  //   1. sourceBlockIndices is non-empty  (ABSOLUTE RULE 2)
  //   2. title is non-empty / non-whitespace
  //   3. learningObjective is non-empty / non-whitespace
  // Stripped MicroNode exercises are rescued into additionalExercises so no
  // textbook content is lost. Coverage logic is unaffected.
  const microNodes: Pass2MicroNode[] = [];
  for (const mn of rawMicroNodes) {
    const reasons = getPass2MicroNodeRejectionReasons(mn);
    if (reasons.length > 0) {
      for (const reason of reasons) countRejection(reason);
      logger.warn(
        { topicSeq, exerciseCount: mn.exercises.length, rejectionReasons: reasons },
        "pass2 step2: safety-net — invalid MicroNode stripped; exercises moved to additionalExercises"
      );
      additionalExercises.push(...mn.exercises);
    } else {
      microNodes.push(mn);
    }
  }

  const unmappedIndices = (Array.isArray(parsed.unmappedBlocks) ? parsed.unmappedBlocks : [])
    .map((value) => asRecord(value)?.blockIndex)
    .filter((index): index is number => typeof index === "number");
  return {
    microNodes,
    unmappedIndices,
    additionalExercises,
    diagnostics: {
      topicSequence: topicSeq,
      inputBlockCount: topicIndices.length,
      response,
      candidateMicroNodeCount: rawMicroNodes.length,
      acceptedMicroNodeCount: microNodes.length,
      rejectedMicroNodeCount: rawMicroNodes.length - microNodes.length,
      rejectionCounts,
      postNormalizationMicroNodeCount: microNodes.length,
    },
  };
}

type TopicRepairResult = {
  attempted: boolean;
  recoveredBlockCount: number;
  failed: boolean;
};

/**
 * One bounded repair pass for source blocks the initial response left without a
 * MicroNode owner. It receives only the affected blocks plus compact existing
 * objective labels, so it cannot become a second full-lesson mapping pass.
 */
async function repairTopicInstructionalCoverage(
  topic: Pass2TopicResult,
  blocks: Pass1Block[],
  topicSeq: number,
  curriculumConstraints: string,
): Promise<TopicRepairResult> {
  const before = validateInstructionalCoverage(blocks, [topic]);
  const unresolved = before.unresolvedInstructionalIndices
    .filter((index) => (topic.inputBlockIndices ?? []).includes(index));
  if (unresolved.length === 0) return { attempted: false, recoveredBlockCount: 0, failed: false };

  const existingNodes = topic.microNodes.map((node, index) =>
    `Existing MicroNode ${index}: ${node.title} — ${node.learningObjective}`,
  ).join("\n") || "(none)";
  const blockLines = unresolved.map((index) => fmtPass2Block(index, blocks[index])).join("\n");
  const prompt = `Repair ONE Topic's missing instructional ownership. This is a bounded repair, not a new lesson map.
Topic ${topicSeq}: «${topic.title}»

${curriculumConstraints}

Existing MicroNodes (you may add a missing source block to one of these):
${existingNodes}

Readable instructional blocks that still require exactly one MicroNode owner:
${blockLines}

Return ONLY JSON in this exact shape:
{
  "existingAssignments": [{"microNodeIndex": 0, "sourceBlockIndices": [12]}],
  "microNodes": [{
    "title": "Հայերեն ատոմային վերնագիր",
    "learningObjective": "Սովորողը կարող է կատարել մեկ չափելի գործողություն։",
    "microNodeType": "knowledge",
    "sourceBlockIndices": [13]
  }]
}

Use existingAssignments whenever an existing objective genuinely owns the source block.
Create a new MicroNode only for a distinct independently teachable objective.
Every listed block must appear exactly once. Do not return exercises, unmapped blocks,
supporting material, source text, or any indices not listed above.`;

  try {
    const response = await openrouter.chat.completions.create({
      model: PASS2_STEP2_MODEL,
      max_tokens: 2000,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You repair atomic curriculum source ownership. Return only valid JSON." },
        { role: "user", content: prompt },
      ],
    });
    const parsed = asRecord(parsePass2JSON(response.choices[0]?.message?.content ?? ""));
    if (!parsed) return { attempted: true, recoveredBlockCount: 0, failed: true };

    const eligible = new Set(unresolved);
    const accepted = new Set<number>();
    const assignments = Array.isArray(parsed.existingAssignments) ? parsed.existingAssignments : [];
    for (const candidate of assignments) {
      const value = asRecord(candidate);
      const target = value?.microNodeIndex;
      const indices = Array.isArray(value?.sourceBlockIndices) ? value!.sourceBlockIndices : [];
      if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target >= topic.microNodes.length) continue;
      for (const index of indices) {
        if (typeof index !== "number" || !eligible.has(index) || accepted.has(index)) continue;
        topic.microNodes[target].sourceBlockIndices.push(index);
        accepted.add(index);
      }
    }

    const newNodes = Array.isArray(parsed.microNodes) ? parsed.microNodes : [];
    for (const candidate of newNodes) {
      const value = asRecord(candidate) ?? {};
      const indices = Array.isArray(value.sourceBlockIndices)
        ? value.sourceBlockIndices.filter((index): index is number =>
          typeof index === "number" && eligible.has(index) && !accepted.has(index))
        : [];
      const node: Pass2MicroNode = {
        title: typeof value.title === "string" ? value.title.trim() : "",
        learningObjective: typeof value.learningObjective === "string" ? value.learningObjective.trim() : "",
        microNodeType: value.microNodeType === "skill" ? "skill" : "knowledge",
        sourceBlockIndices: indices,
        exercises: [],
        supportingMaterialIndices: [],
      };
      if (getPass2MicroNodeRejectionReasons(node).length > 0) continue;
      topic.microNodes.push(node);
      for (const index of indices) accepted.add(index);
    }
    if (accepted.size > 0) {
      topic.unmappedBlockIndices = topic.unmappedBlockIndices
        .filter((index) => !accepted.has(index));
    }
    return { attempted: true, recoveredBlockCount: accepted.size, failed: false };
  } catch (error) {
    logger.warn({ topicSeq, unresolvedBlockCount: unresolved.length, error }, "pass2 coverage repair failed");
    return { attempted: true, recoveredBlockCount: 0, failed: true };
  }
}

// ── Pass 2B: Semantic granularity review ──────────────────────────────────────
//
// A single AI call over ALL MicroNodes from ALL topics simultaneously.
// Cross-topic review is required so OVER_SPLIT candidates that span different
// topic calls are still detectable.
//
// RULES:
//   • Returns one bounded, server-validated repair proposal at most.
//   • Returns [] on review failure. Existing duplicate suspicions then fail closed
//     rather than being silently persisted.
//   • Runs AFTER Step 2 and BEFORE final coverage validation.

const PASS2B_REVIEW_SYSTEM = `You are a curriculum quality reviewer. You receive a compact
representation of all MicroNodes produced by a lesson mapping pipeline, along with
deterministic heuristic signals flagged before this call.

Your job is to detect granularity problems and produce one bounded repair proposal
using ONLY the provided same-lesson candidate IDs and validated block indices.
The server, not you, validates and applies every action.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. UNDER_SPLIT — a single MicroNode contains two or more INDEPENDENTLY ASSESSABLE objectives.

Flag ONLY when: a student could correctly answer a test question for skill A while
failing a test question for skill B, and both skills are contained in one MicroNode.

EXAMPLE — flag this:
  LO: "Student can define a verb and identify verbs in text."
  Reason: Defining (recall) and identifying in context (application) are separately testable.
  → UNDER_SPLIT

DO NOT flag this:
  LO: "Student can decompose a multi-digit number by grouping digits from right to left."
  Reason: "grouping from right to left" is the METHOD of one procedure — not a separate skill.
  → NOT an UNDER_SPLIT

CRITICAL: The presence of "and", "կամ", "և", "ու" alone is NOT enough to flag MEGA_NODE.
You must verify that both sides of the connector represent independently assessable skills.
When a connector simply continues one procedure or adds a sub-step, do NOT flag.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. OVER_SPLIT — two MicroNodes in the SAME TOPIC describe the same underlying objective.

Flag ONLY when: two MicroNodes are covering the same learning skill — one as procedure
and another as rule, or one as definition and another as immediate application of
the very same concept.

EXAMPLE — flag this pair:
  MN A: "Student can find the unknown addend using inverse operations."
  MN B: "Student can apply the rules for finding the unknown addend."
  Reason: The rule IS the procedure — the same cognitive skill described twice.
  → OVER_SPLIT (report microNodeTitle as the second node, suggest merging into the first)

DO NOT flag genuinely different objectives (even in the same topic):
  MN A: "Student can explain what addition means."
  MN B: "Student can solve subtraction word problems."
  → These are different skills, NOT an over-split.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. MISSING_ATOMIC_MICRONODE — a real verified exercise has no defensible primary
owner, but an independently teachable objective is directly supported by this
lesson's instructional source. Do not report this merely because an exercise
has an unusual format or combines several existing skills.

4. EXERCISE_MISMATCH — an exercise obviously requires a skill far outside the MicroNode's LO.

Flag ONLY when: the exercise's required primary skill is clearly not covered by or
prerequisite to the MicroNode's learning objective.

EXAMPLE — flag this:
  MicroNode LO: "Student can solve problems using addition and subtraction."
  Exercise requires: Calculate a unit price using division, then multiply by quantity.
  → EXERCISE_MISMATCH

DO NOT flag exercises that test the exact skill, a sub-skill, or a direct prerequisite.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. UNSUPPORTED_MICRONODE — a candidate lacks direct source support even after
considering the listed validated source blocks. Heading-only support is insufficient.

HEURISTIC SIGNALS PROVIDED:
The input includes pre-computed heuristic flags:
  • compoundLO: true  — regex detected a possible compound connector between two verb phrases
  • duplicateCandidates: [{candidateAId, candidateBId}] — server-identified possible duplicates

These signals are SUGGESTIONS. You must apply semantic judgment — do NOT automatically
report MEGA_NODE just because compoundLO is true, or OVER_SPLIT just because similarity > 0.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT: respond with ONLY valid JSON — no markdown fences, no commentary.
{
  "findings": [
    {
      "topicTitle": "exact topic title from input",
      "microNodeTitle": "exact MicroNode title from input",
      "microNodeId": "server candidateId from input",
      "issue": "UNDER_SPLIT",
      "confidence": "HIGH",
      "reason": "Armenian-language explanation for the teacher",
      "suggestedAction": "Split into 2: [Title A] / [Title B]",
      "mergeIntoMicroNodeTitle": "exact existing MicroNode title (OVER_SPLIT only)",
      "mergeIntoMicroNodeId": "server candidateId (OVER_SPLIT only)",
      "exerciseBlockIndex": 12
    }
  ],
  "duplicateResolutions": [
    {
      "candidateAId": "server candidateId from duplicateCandidates",
      "candidateBId": "server candidateId from duplicateCandidates",
      "decision": "DISTINCT",
      "confidence": "HIGH"
    }
  ]
}

findings may be an empty array [] if no issues found.
For EVERY duplicateCandidates pair, return exactly one duplicateResolutions entry:
  • DISTINCT only when the objectives are clearly independently assessable.
  • MERGE only for the SAME TOPIC and only when they are truly the same objective;
    include keepCandidateId for the one existing MicroNode that should remain.
  • REVIEW_REQUIRED when uncertain. Never use titles to identify an action.
Allowed issue values: "MEGA_NODE", "UNDER_SPLIT", "OVER_SPLIT", "EXERCISE_MISMATCH",
"MISSING_ATOMIC_MICRONODE", "UNSUPPORTED_MICRONODE".
Allowed confidence values: "HIGH", "MEDIUM" only.
reason MUST be in Armenian.
suggestedAction is optional.

atomicityRepairs may contain only these server-validated actions:
  • SPLIT_MICRONODE: replace one existing candidate with at least two atomic
    children. The children must use a disjoint exact partition of that candidate's
    CURRENT sourceBlockIndices. Do not add source blocks and do not duplicate them.
  • ASSIGN_PRIMARY_EXERCISE: move one exercise to one existing candidate ID.
  • MARK_INTEGRATIVE: keep a genuinely cross-node/reflection/out-of-scope exercise
    as Additional. Do not use this for an exercise whose obvious source-supported
    owner is merely missing.

Never create a source-less node. Never use text, IDs, or indices not supplied.
Return only valid JSON.`;

/** Compact per-MicroNode representation sent to Pass 2B. */
interface GranularityReviewMicroNode {
  candidateId: string;
  title: string;
  learningObjective: string;
  sourceBlockTypes: string[];
  exerciseCount: number;
  /** From detectCompoundLO heuristic. */
  compoundLO: boolean;
  compoundConnector?: string;
  sourceBlockIndices: number[];
  needsSourceRepair: boolean;
}

interface GranularityReviewTopic {
  sequence: number;
  title: string;
  microNodes: GranularityReviewMicroNode[];
  /** Heuristic signals within this topic; semantic review remains authoritative. */
  duplicateCandidates: Array<{ candidateAId: string; candidateBId: string; similarity: number }>;
}

export interface DuplicateSuspicion {
  candidateAId: string;
  candidateBId: string;
  topicASequence: number;
  topicBSequence: number;
}

export interface DuplicateResolution {
  candidateAId: string;
  candidateBId: string;
  decision: "DISTINCT" | "MERGE" | "REVIEW_REQUIRED";
  confidence: "HIGH" | "MEDIUM";
  /** Required only for a same-topic HIGH MERGE decision. */
  keepCandidateId?: string;
}

export interface MalformedDuplicateResolutionEntry {
  candidateAId: string;
  candidateBId: string;
}

export interface ParsedDuplicateResolutions {
  resolutions: DuplicateResolution[];
  malformedEntries: MalformedDuplicateResolutionEntry[];
}

/**
 * Preserve malformed provider entries as audit failures instead of dropping
 * them. The persistence gate must see any ambiguous duplicate-review output.
 */
export function parseDuplicateResolutions(value: unknown): ParsedDuplicateResolutions {
  const resolutions: DuplicateResolution[] = [];
  const malformedEntries: MalformedDuplicateResolutionEntry[] = [];
  if (!Array.isArray(value)) return { resolutions, malformedEntries };
  for (const item of value) {
    if (!item || typeof item !== "object") {
      malformedEntries.push({ candidateAId: "<missing>", candidateBId: "<missing>" });
      continue;
    }
    const entry = item as Record<string, unknown>;
    const candidateAId = typeof entry.candidateAId === "string" ? entry.candidateAId : "<missing>";
    const candidateBId = typeof entry.candidateBId === "string" ? entry.candidateBId : "<missing>";
    const decision = String(entry.decision);
    const confidence = String(entry.confidence);
    if (
      candidateAId === "<missing>" ||
      candidateBId === "<missing>" ||
      !["DISTINCT", "MERGE", "REVIEW_REQUIRED"].includes(decision) ||
      !["HIGH", "MEDIUM"].includes(confidence)
    ) {
      malformedEntries.push({ candidateAId, candidateBId });
      continue;
    }
    resolutions.push({
      candidateAId,
      candidateBId,
      decision: decision as DuplicateResolution["decision"],
      confidence: confidence as DuplicateResolution["confidence"],
      ...(typeof entry.keepCandidateId === "string" ? { keepCandidateId: entry.keepCandidateId } : {}),
    });
  }
  return { resolutions, malformedEntries };
}

export interface DuplicateResolutionAudit {
  candidatePairCount: number;
  resolvedDistinctCount: number;
  mergedCount: number;
  unresolvedPairIds: Array<{ candidateAId: string; candidateBId: string }>;
  rejectedDecisionCount: number;
  actions: GranularityConsolidation["actions"];
}

function candidatePairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/** Compact, complete duplicate-review contract, including cross-topic pairs. */
export function buildDuplicateReviewCandidates(
  suspicions: ReadonlyArray<DuplicateSuspicion>,
): Array<{
  candidateAId: string;
  candidateBId: string;
  topicASequence: number;
  topicBSequence: number;
}> {
  return suspicions.map((suspicion) => ({
    candidateAId: suspicion.candidateAId,
    candidateBId: suspicion.candidateBId,
    topicASequence: suspicion.topicASequence,
    topicBSequence: suspicion.topicBSequence,
  }));
}

/** Returns deterministic, title-independent candidates across every topic. */
export function collectDuplicateSuspicions(
  topics: ReadonlyArray<Pass2TopicResult>,
): DuplicateSuspicion[] {
  const nodes = topics.flatMap((topic) => topic.microNodes.map((node, microNodeIndex) => ({
    candidateId: node.candidateId ?? `t${topic.sequence}:n${microNodeIndex}`,
    topicSequence: topic.sequence,
    title: node.title,
    learningObjective: node.learningObjective,
  })));
  const suspicions: DuplicateSuspicion[] = [];
  for (let left = 0; left < nodes.length; left++) {
    for (let right = left + 1; right < nodes.length; right++) {
      if (!pedagogicalNearDuplicate(nodes[left], nodes[right])) continue;
      suspicions.push({
        candidateAId: nodes[left].candidateId,
        candidateBId: nodes[right].candidateId,
        topicASequence: nodes[left].topicSequence,
        topicBSequence: nodes[right].topicSequence,
      });
    }
  }
  return suspicions;
}

/**
 * Applies only explicit HIGH-confidence same-topic merges. Every other
 * candidate remains visible for teacher review; malformed or unknown decisions
 * are still rejected before persistence.
 */
export function resolveDuplicateSuspicions(
  topics: Pass2TopicResult[],
  suspicions: ReadonlyArray<DuplicateSuspicion>,
  resolutions: ReadonlyArray<DuplicateResolution>,
  explicitlyMergedPairs: ReadonlyArray<{ candidateAId: string; candidateBId: string }> = [],
  malformedEntries: ReadonlyArray<MalformedDuplicateResolutionEntry> = [],
): DuplicateResolutionAudit {
  const candidateKeys = new Set(suspicions.map((suspicion) =>
    candidatePairKey(suspicion.candidateAId, suspicion.candidateBId),
  ));
  const byPair = new Map<string, DuplicateResolution>();
  const invalidCandidateKeys = new Set<string>();
  const invalidEntries: Array<{ candidateAId: string; candidateBId: string }> = [];
  let rejectedDecisionCount = malformedEntries.length;
  for (const entry of malformedEntries) {
    const pairKey = candidatePairKey(entry.candidateAId, entry.candidateBId);
    invalidEntries.push(entry);
    if (candidateKeys.has(pairKey)) invalidCandidateKeys.add(pairKey);
  }
  for (const resolution of resolutions) {
    const pairKey = candidatePairKey(resolution.candidateAId, resolution.candidateBId);
    if (!candidateKeys.has(pairKey)) {
      rejectedDecisionCount++;
      invalidEntries.push({
        candidateAId: resolution.candidateAId,
        candidateBId: resolution.candidateBId,
      });
      continue;
    }
    if (byPair.has(pairKey)) {
      // Reversed IDs normalize to the same key. Any repeated response is
      // ambiguous untrusted output, even if its values happen to match.
      rejectedDecisionCount++;
      invalidCandidateKeys.add(pairKey);
      continue;
    }
    byPair.set(pairKey, resolution);
  }
  const audit: DuplicateResolutionAudit = {
    candidatePairCount: suspicions.length,
    resolvedDistinctCount: 0,
    mergedCount: 0,
    unresolvedPairIds: [],
    rejectedDecisionCount,
    actions: [],
  };
  const explicitMergeKeys = new Set(explicitlyMergedPairs.map((pair) =>
    candidatePairKey(pair.candidateAId, pair.candidateBId),
  ));
  const unresolvedKeys = new Set<string>();
  const addUnresolved = (candidateAId: string, candidateBId: string) => {
    const pairKey = candidatePairKey(candidateAId, candidateBId);
    if (unresolvedKeys.has(pairKey)) return;
    unresolvedKeys.add(pairKey);
    audit.unresolvedPairIds.push({ candidateAId, candidateBId });
  };
  const findNode = (candidateId: string) => {
    for (const topic of topics) {
      const index = topic.microNodes.findIndex((node) => node.candidateId === candidateId);
      if (index >= 0) return { topic, index, node: topic.microNodes[index] };
    }
    return null;
  };

  for (const suspicion of suspicions) {
    const pairKey = candidatePairKey(suspicion.candidateAId, suspicion.candidateBId);
    const left = findNode(suspicion.candidateAId);
    const right = findNode(suspicion.candidateBId);
    if (invalidCandidateKeys.has(pairKey)) {
      addUnresolved(suspicion.candidateAId, suspicion.candidateBId);
      continue;
    }
    // Consolidation resolves only the exact pair it merged. Any other edge
    // touching a removed candidate remains a hard review failure.
    if (!left || !right) {
      if (!explicitMergeKeys.has(pairKey)) {
        addUnresolved(suspicion.candidateAId, suspicion.candidateBId);
      }
      continue;
    }
    const resolution = byPair.get(pairKey);
    if (resolution?.decision === "DISTINCT" && resolution.confidence === "HIGH") {
      audit.resolvedDistinctCount++;
      continue;
    }
    if (
      resolution?.decision === "MERGE" &&
      resolution.confidence === "HIGH" &&
      left.topic === right.topic &&
      (resolution.keepCandidateId === left.node.candidateId || resolution.keepCandidateId === right.node.candidateId)
    ) {
      const target = resolution.keepCandidateId === left.node.candidateId ? left : right;
      const source = target === left ? right : left;
      target.node.sourceBlockIndices = [...new Set([...target.node.sourceBlockIndices, ...source.node.sourceBlockIndices])];
      target.node.exercises = [...target.node.exercises, ...source.node.exercises];
      target.node.supportingMaterialIndices = [...new Set([
        ...target.node.supportingMaterialIndices,
        ...source.node.supportingMaterialIndices,
      ])];
      target.topic.microNodes.splice(source.index, 1);
      audit.mergedCount++;
      audit.actions.push({
        topicSequence: target.topic.sequence,
        keptMicroNodeTitle: target.node.title,
        removedMicroNodeTitle: source.node.title,
        reason: "NEAR_DUPLICATE_OBJECTIVE",
      });
      continue;
    }
    if (resolution && resolution.decision !== "REVIEW_REQUIRED") {
      audit.rejectedDecisionCount++;
    }
    addUnresolved(suspicion.candidateAId, suspicion.candidateBId);
  }
  // Unknown IDs/pairs are untrusted provider output. Do not ignore them:
  // fail the entire review contract closed before any automatic persistence.
  for (const entry of invalidEntries) {
    addUnresolved(entry.candidateAId, entry.candidateBId);
  }
  return audit;
}

export type SourceReallocationAction =
  | "KEEP_CURRENT"
  | "ADD_SUPPORTING_BLOCKS"
  | "MOVE_BLOCKS"
  | "MERGE_SOURCE_OWNERSHIP"
  | "NARROW_OBJECTIVE"
  | "NO_VALID_SUPPORT_FOUND";

export interface SourceReallocationDecision {
  topicTitle: string;
  microNodeTitle: string;
  /** Server-issued topic identity for production semantic-review actions. */
  topicSequence?: number;
  /** Server-issued MicroNode identity for production semantic-review actions. */
  microNodeId?: string;
  action: SourceReallocationAction;
  sourceBlockIndices: number[];
  /** Only permitted when the retained source directly supports the revision. */
  learningObjective?: string;
  reason: string;
}

export interface SemanticReviewResult {
  status: "COMPLETE" | "UNAVAILABLE";
  unavailableReason?: "EMPTY_RESPONSE" | "INVALID_RESPONSE" | "REQUEST_FAILED";
  findings: GranularityFinding[];
  sourceReallocations: SourceReallocationDecision[];
  atomicityRepairs: AtomicityRepairDecision[];
  duplicateResolutions: DuplicateResolution[];
  malformedDuplicateResolutionEntries: MalformedDuplicateResolutionEntry[];
  verificationDiagnostics?: AtomicityVerificationDiagnostics;
}

export type AtomicityVerificationParseState = "SUCCEEDED" | "EMPTY_RESPONSE" | "INVALID_RESPONSE" | "REQUEST_FAILED";
export type AtomicityVerificationValidationState =
  | "NOT_RUN"
  | "PASSED"
  | "FAILED_NON_ATOMIC";

export interface AtomicityVerificationAttemptDiagnostics {
  attempt: number;
  requestAttempted: boolean;
  responseReceived: boolean;
  parseState: AtomicityVerificationParseState;
}

export interface AtomicityVerificationDiagnostics {
  lessonId?: number;
  generatedMicroNodeCount: number;
  requestAttempted: boolean;
  responseReceived: boolean;
  parseState: AtomicityVerificationParseState;
  validationState: AtomicityVerificationValidationState;
  repairAttempted: boolean;
  retryAttempted: boolean;
  retrySucceeded: boolean;
  persistenceEligible?: boolean;
  finalFailureCode?: "UNRESOLVED_NON_ATOMIC" | "TECHNICAL_RETRY_EXHAUSTED";
  attempts: AtomicityVerificationAttemptDiagnostics[];
}

/**
 * Pass 2B — semantic granularity review.
 *
 * Runs a single AI call over all MicroNodes from all topics after Step 2.
 * Returns advisory findings and at most one bounded source-reallocation plan.
 * The plan is only a set of existing block indices; the server applies and
 * deterministically validates it. Returns empty arrays on any review error.
 */
async function runGranularityReviewOnce(
  topics: Pass2TopicResult[],
  blocks: Pass1Block[],
  sourceAlignment: Pass2SourceAlignment,
  duplicateSuspicions: ReadonlyArray<DuplicateSuspicion>,
): Promise<SemanticReviewResult> {
  const duplicateReviewCandidates = buildDuplicateReviewCandidates(duplicateSuspicions);
  // Build compact topic representation with heuristic signals
  const reviewTopics: GranularityReviewTopic[] = topics.map((topic) => {
    const mnRepresentations: GranularityReviewMicroNode[] = topic.microNodes.map((mn) => {
      const compound = detectCompoundLO(mn.learningObjective);
      const sourceBlockTypes = mn.sourceBlockIndices
        .map((i) => blocks[i]?.blockType ?? "UNKNOWN")
        .filter(Boolean);
      return {
        candidateId:         mn.candidateId ?? `t${topic.sequence}:n${topic.microNodes.indexOf(mn)}`,
        title:              mn.title,
        learningObjective:  mn.learningObjective,
        sourceBlockTypes,
        exerciseCount:      mn.exercises.length,
        sourceBlockIndices: [...mn.sourceBlockIndices],
        needsSourceRepair: sourceAlignment.nodes.some((entry) =>
          entry.topicSequence === topic.sequence &&
          entry.microNodeIndex === topic.microNodes.indexOf(mn) &&
          entry.audit.status !== "SUFFICIENT"),
        compoundLO:         compound !== null,
        ...(compound ? { compoundConnector: compound.connector } : {}),
      };
    });

    return {
      sequence:           topic.sequence,
      title:              topic.title,
      microNodes:         mnRepresentations,
      duplicateCandidates: duplicateSuspicions
        // Per-topic signals retain same-topic context. The full flat contract
        // below includes every pair, including cross-topic candidates.
        .filter((candidate) => candidate.topicASequence === topic.sequence)
        .map((candidate) => ({
          candidateAId: candidate.candidateAId,
          candidateBId: candidate.candidateBId,
          similarity: 1,
        })),
    };
  });

  // Skip the AI call if there are no MicroNodes at all
  const totalMicroNodes = reviewTopics.reduce((s, t) => s + t.microNodes.length, 0);
  if (totalMicroNodes === 0) {
    return {
      status: "COMPLETE",
      findings: [],
      sourceReallocations: [],
      atomicityRepairs: [],
      duplicateResolutions: [],
      malformedDuplicateResolutionEntries: [],
    };
  }

  const repairTopics = reviewTopics
    .filter((topic) => topic.microNodes.some((node) => node.needsSourceRepair))
    .map((topic) => ({
      topicTitle: topic.title,
      nodes: topic.microNodes.filter((node) => node.needsSourceRepair).map((node) => ({
        title: node.title,
        learningObjective: node.learningObjective,
        currentSourceBlockIndices: node.sourceBlockIndices,
      })),
    }));
  const exerciseReviewInput = topics.flatMap((topic) => {
    const assigned = topic.microNodes.flatMap((node) => node.exercises.map((exercise) => ({
      blockIndex: exercise.blockIndex,
      currentOwnerCandidateId: node.candidateId ?? null,
    })));
    const additional = topic.additionalExercises.map((exercise) => ({
      blockIndex: exercise.blockIndex,
      currentOwnerCandidateId: null,
    }));
    return [...assigned, ...additional]
      .filter(({ blockIndex }) =>
        isValidBlockIndex(blockIndex, blocks) && ACTIVITY_BLOCK_TYPES.has(blocks[blockIndex].blockType),
      )
      .map(({ blockIndex, currentOwnerCandidateId }) => ({
        topicSequence: topic.sequence,
        blockIndex,
        currentOwnerCandidateId,
        block: fmtPass2Block(blockIndex, blocks[blockIndex]),
      }));
  });
  const eligibleSourceBlocks = blocks
    .map((block, index) => ({ index, block }))
    .filter(({ block }) =>
      !["EXERCISE", "ACTIVITY", "HOMEWORK", "IMAGE"].includes(block.blockType) &&
      !isUnreadableSource(block.sourceText),
    )
    .map(({ index, block }) => fmtPass2Block(index, block));

  const userPrompt = `Review the following lesson mapping for granularity issues.

TOPICS AND MICRONODES:
${JSON.stringify(reviewTopics, null, 2)}

DUPLICATE CANDIDATES (complete contract; includes cross-topic pairs):
${JSON.stringify(duplicateReviewCandidates, null, 2)}

Apply the UNDER_SPLIT, OVER_SPLIT, MISSING_ATOMIC_MICRONODE, UNSUPPORTED_MICRONODE,
and EXERCISE_MISMATCH criteria from the system prompt.
Pay special attention to MicroNodes where compoundLO=true and duplicate candidate pairs.

VERIFIED EXERCISES:
${JSON.stringify(exerciseReviewInput, null, 2)}

SOURCE REALLOCATION (only for nodes with needsSourceRepair=true):
The following are the only readable, validated source blocks from this same lesson Source Set
that may be selected. Lexical similarity is only candidate ranking; decide whether the block
actually teaches/supports the objective. A narrative may support context but not an unstated
rule. A heading-only block is not sufficient. Never invent source text or indices.
Return exactly one sourceReallocations decision for every node listed in the repair input:
• use ADD_SUPPORTING_BLOCKS / MOVE_BLOCKS only when the final source set directly supports
  the existing objective;
• use NARROW_OBJECTIVE only when the current retained source directly supports the proposed
  one-action objective. Include that revised text in learningObjective and use [] for
  sourceBlockIndices;
• otherwise use NO_VALID_SUPPORT_FOUND. Never use KEEP_CURRENT for a node marked
  needsSourceRepair=true.
${JSON.stringify(eligibleSourceBlocks, null, 2)}

${JSON.stringify(repairTopics, null, 2)}

Return only this JSON shape:
{
  "findings": [],
  "sourceReallocations": [{
    "topicTitle": "exact topic title",
    "microNodeTitle": "exact MicroNode title",
    "topicSequence": 1,
    "microNodeId": "t1:n0",
    "action": "NARROW_OBJECTIVE",
    "sourceBlockIndices": [],
    "learningObjective": "Սովորողը կարող է բացատրել աղբյուրում ներկայացված մեկ կանոնը։",
    "reason": "Հայերեն պատճառ"
  }],
  "atomicityRepairs": [{
    "action": "SPLIT_MICRONODE",
    "topicSequence": 1,
    "microNodeId": "t1:n0",
    "reason": "Հայերեն պատճառ",
    "splitMicroNodes": [{
      "title": "Հայերեն ատոմային վերնագիր",
      "learningObjective": "Սովորողը կարող է կատարել մեկ չափելի գործողություն։",
      "microNodeType": "knowledge",
      "sourceBlockIndices": [3],
      "exerciseBlockIndices": [12]
    }, {
      "title": "Երկրորդ ատոմային վերնագիր",
      "learningObjective": "Սովորողը կարող է կատարել երկրորդ չափելի գործողություն։",
      "microNodeType": "skill",
      "sourceBlockIndices": [4],
      "exerciseBlockIndices": []
    }]
  }],
  "duplicateResolutions": [{
    "candidateAId": "t1:n0",
    "candidateBId": "t1:n1",
    "decision": "DISTINCT",
    "confidence": "HIGH"
  }]
}
Allowed actions: KEEP_CURRENT, ADD_SUPPORTING_BLOCKS, MOVE_BLOCKS, MERGE_SOURCE_OWNERSHIP, NARROW_OBJECTIVE, NO_VALID_SUPPORT_FOUND.
Every sourceBlockIndices value must come from the listed validated source blocks.
Return one duplicateResolutions entry for every duplicateCandidates pair, including
cross-topic pairs. Do not infer actions from titles.
atomicityRepairs actions: SPLIT_MICRONODE, ASSIGN_PRIMARY_EXERCISE, MARK_INTEGRATIVE.
A split child source set must be an exact disjoint partition of the target's current
sourceBlockIndices. If source is also reallocated for that target in this response,
include every resulting source index in exactly one split child. Never create a
source-less child. Every split child learningObjective must be directly supported
by its own partitioned sourceBlockIndices: a heading, shared topic word, or broad
Outcome wording is not enough. If you cannot write a one-action objective with
direct support for every child, do not propose the split.`;

  try {
    const r = await openrouter.chat.completions.create({
      model:      PASS2B_REVIEW_MODEL,
      max_tokens: 2000,
      temperature: 0,
      messages: [
        { role: "system", content: PASS2B_REVIEW_SYSTEM },
        { role: "user",   content: userPrompt },
      ],
    });

    const raw = r.choices[0]?.message?.content ?? "";
    if (!raw.trim()) {
      logger.warn({ totalMicroNodes }, "pass2b granularity review: empty response — returning no findings");
      return {
        status: "UNAVAILABLE",
        unavailableReason: "EMPTY_RESPONSE",
        findings: [],
        sourceReallocations: [],
        atomicityRepairs: [],
        duplicateResolutions: [],
        malformedDuplicateResolutionEntries: [],
      };
    }

    const parsed = parsePass2JSON(raw) as {
      findings?: unknown[];
      sourceReallocations?: unknown[];
      atomicityRepairs?: unknown[];
      duplicateResolutions?: unknown[];
    };
    if (!parsed || !Array.isArray(parsed.findings)) {
      logger.warn({ totalMicroNodes }, "pass2b granularity review: invalid JSON schema — returning no findings");
      return {
        status: "UNAVAILABLE",
        unavailableReason: "INVALID_RESPONSE",
        findings: [],
        sourceReallocations: [],
        atomicityRepairs: [],
        duplicateResolutions: [],
        malformedDuplicateResolutionEntries: [],
      };
    }

    const VALID_ISSUES = new Set([
      "MEGA_NODE",
      "UNDER_SPLIT",
      "OVER_SPLIT",
      "EXERCISE_MISMATCH",
      "MISSING_ATOMIC_MICRONODE",
      "UNSUPPORTED_MICRONODE",
    ]);
    const VALID_CONFIDENCE = new Set(["HIGH", "MEDIUM"]);

    let malformedEntryCount = 0;
    const findings: GranularityFinding[] = [];
    for (const f of parsed.findings) {
      if (
        typeof f !== "object" || f === null ||
        !("topicTitle" in f) || !("microNodeTitle" in f) ||
        !("issue" in f) || !("confidence" in f) || !("reason" in f)
      ) {
        malformedEntryCount++;
        continue;
      }

      const item = f as Record<string, unknown>;
      if (
        typeof item.topicTitle !== "string" ||
        typeof item.microNodeTitle !== "string" ||
        !VALID_ISSUES.has(String(item.issue)) ||
        !VALID_CONFIDENCE.has(String(item.confidence)) ||
        typeof item.reason !== "string" ||
        !item.reason.trim() ||
        (item.microNodeId !== undefined && typeof item.microNodeId !== "string") ||
        (item.mergeIntoMicroNodeId !== undefined && typeof item.mergeIntoMicroNodeId !== "string") ||
        (item.exerciseBlockIndex !== undefined &&
          (typeof item.exerciseBlockIndex !== "number" || !Number.isInteger(item.exerciseBlockIndex)))
      ) {
        malformedEntryCount++;
        continue;
      }

      findings.push({
        topicTitle:       String(item.topicTitle),
        microNodeTitle:   String(item.microNodeTitle),
        issue:            item.issue as GranularityFinding["issue"],
        confidence:       item.confidence as GranularityFinding["confidence"],
        reason:           String(item.reason),
        ...(item.suggestedAction ? { suggestedAction: String(item.suggestedAction) } : {}),
        ...(item.mergeIntoMicroNodeTitle ? { mergeIntoMicroNodeTitle: String(item.mergeIntoMicroNodeTitle) } : {}),
        ...(item.microNodeId ? { microNodeId: String(item.microNodeId) } : {}),
        ...(item.mergeIntoMicroNodeId ? { mergeIntoMicroNodeId: String(item.mergeIntoMicroNodeId) } : {}),
        ...(typeof item.exerciseBlockIndex === "number" && Number.isInteger(item.exerciseBlockIndex)
          ? { exerciseBlockIndex: item.exerciseBlockIndex }
          : {}),
      });
    }

    const sourceReallocations: SourceReallocationDecision[] = [];
    if (parsed.sourceReallocations !== undefined && !Array.isArray(parsed.sourceReallocations)) {
      malformedEntryCount++;
    } else if (Array.isArray(parsed.sourceReallocations)) {
      for (const item of parsed.sourceReallocations) {
        if (!item || typeof item !== "object") {
          malformedEntryCount++;
          continue;
        }
        const value = item as Record<string, unknown>;
        const action = String(value.action) as SourceReallocationAction;
        if (![
          "KEEP_CURRENT",
          "ADD_SUPPORTING_BLOCKS",
          "MOVE_BLOCKS",
          "MERGE_SOURCE_OWNERSHIP",
          "NARROW_OBJECTIVE",
          "NO_VALID_SUPPORT_FOUND",
        ].includes(action) ||
          !Array.isArray(value.sourceBlockIndices) ||
          !value.sourceBlockIndices.every((index) => typeof index === "number" && Number.isInteger(index)) ||
          typeof value.topicTitle !== "string" ||
          typeof value.microNodeTitle !== "string" ||
          typeof value.reason !== "string" ||
          !value.reason.trim() ||
          typeof value.topicSequence !== "number" ||
          !Number.isInteger(value.topicSequence) ||
          typeof value.microNodeId !== "string"
        ) {
          malformedEntryCount++;
          continue;
        }
        const indices = value.sourceBlockIndices;
        sourceReallocations.push({
          topicTitle: value.topicTitle,
          microNodeTitle: value.microNodeTitle,
          ...(typeof value.topicSequence === "number" && Number.isInteger(value.topicSequence)
            ? { topicSequence: value.topicSequence }
            : {}),
          ...(typeof value.microNodeId === "string" ? { microNodeId: value.microNodeId } : {}),
          action,
          sourceBlockIndices: indices,
          ...(typeof value.learningObjective === "string"
            ? { learningObjective: value.learningObjective }
            : {}),
          reason: value.reason,
        });
      }
    }

    const atomicityRepairs: AtomicityRepairDecision[] = [];
    if (parsed.atomicityRepairs !== undefined && !Array.isArray(parsed.atomicityRepairs)) {
      malformedEntryCount++;
    } else if (Array.isArray(parsed.atomicityRepairs)) {
      for (const item of parsed.atomicityRepairs) {
        const value = asRecord(item);
        const action = String(value?.action ?? "");
        const topicSequence = value?.topicSequence;
        const reason = value?.reason;
        if (
          !value ||
          !["SPLIT_MICRONODE", "ASSIGN_PRIMARY_EXERCISE", "MARK_INTEGRATIVE"].includes(action) ||
          typeof topicSequence !== "number" || !Number.isInteger(topicSequence) ||
          typeof reason !== "string" || !reason.trim()
        ) {
          malformedEntryCount++;
          continue;
        }
        if (
          (action === "SPLIT_MICRONODE" || action === "ASSIGN_PRIMARY_EXERCISE") &&
          typeof value.microNodeId !== "string"
        ) {
          malformedEntryCount++;
          continue;
        }
        const decision: AtomicityRepairDecision = {
          action: action as AtomicityRepairAction,
          topicSequence,
          ...(typeof value.microNodeId === "string" ? { microNodeId: value.microNodeId } : {}),
          ...(typeof value.exerciseBlockIndex === "number" && Number.isInteger(value.exerciseBlockIndex)
            ? { exerciseBlockIndex: value.exerciseBlockIndex }
            : {}),
          reason,
        };
        if (decision.action === "SPLIT_MICRONODE") {
          if (!Array.isArray(value.splitMicroNodes)) {
            malformedEntryCount++;
            continue;
          }
          let malformedChild = false;
          decision.splitMicroNodes = value.splitMicroNodes.flatMap((candidate) => {
            const node = asRecord(candidate);
            if (
              !node ||
              typeof node.title !== "string" ||
              !node.title.trim() ||
              typeof node.learningObjective !== "string" ||
              !node.learningObjective.trim() ||
              !Array.isArray(node.sourceBlockIndices) ||
              !node.sourceBlockIndices.every((index) => typeof index === "number" && Number.isInteger(index)) ||
              !Array.isArray(node.exerciseBlockIndices) ||
              !node.exerciseBlockIndices.every((index) => typeof index === "number" && Number.isInteger(index))
            ) {
              malformedChild = true;
              return [];
            }
            return [{
              title: node.title,
              learningObjective: node.learningObjective,
              microNodeType: node.microNodeType === "skill" ? "skill" : "knowledge",
              sourceBlockIndices: node.sourceBlockIndices,
              exerciseBlockIndices: node.exerciseBlockIndices,
            }];
          });
          if (malformedChild) {
            malformedEntryCount++;
            continue;
          }
        }
        atomicityRepairs.push(decision);
      }
    }

    if (malformedEntryCount > 0) {
      logger.warn(
        { malformedEntryCount, totalMicroNodes },
        "pass2b granularity review: malformed semantic entry — failing closed",
      );
      return {
        status: "UNAVAILABLE",
        unavailableReason: "INVALID_RESPONSE",
        findings: [],
        sourceReallocations: [],
        atomicityRepairs: [],
        duplicateResolutions: [],
        malformedDuplicateResolutionEntries: [],
      };
    }

    const parsedDuplicateResolutions = parseDuplicateResolutions(parsed.duplicateResolutions);
    const duplicateResolutions = parsedDuplicateResolutions.resolutions;

    logger.info(
      {
        findingCount: findings.length,
        atomicityRepairCount: atomicityRepairs.length,
        duplicateResolutionCount: duplicateResolutions.length,
        malformedDuplicateResolutionCount: parsedDuplicateResolutions.malformedEntries.length,
        totalMicroNodes,
      },
      "pass2b granularity review: complete",
    );
    return {
      status: "COMPLETE",
      findings,
      sourceReallocations,
      atomicityRepairs,
      duplicateResolutions,
      malformedDuplicateResolutionEntries: parsedDuplicateResolutions.malformedEntries,
    };

  } catch (err) {
    logger.warn({ err }, "pass2b granularity review: AI call failed — duplicate candidates will fail closed");
    return {
      status: "UNAVAILABLE",
      unavailableReason: "REQUEST_FAILED",
      findings: [],
      sourceReallocations: [],
      atomicityRepairs: [],
      duplicateResolutions: [],
      malformedDuplicateResolutionEntries: [],
    };
  }
}

function buildAtomicityVerificationAttempt(
  review: SemanticReviewResult,
  attempt: number,
): AtomicityVerificationAttemptDiagnostics {
  const parseState = review.status === "COMPLETE"
    ? "SUCCEEDED"
    : review.unavailableReason ?? "REQUEST_FAILED";
  return {
    attempt,
    requestAttempted: true,
    responseReceived: review.status === "COMPLETE"
      || review.unavailableReason === "EMPTY_RESPONSE"
      || review.unavailableReason === "INVALID_RESPONSE",
    parseState,
  };
}

/**
 * A technical Pass 2B interruption is not evidence that the candidate is
 * non-atomic. Retry only the verification request once against the same
 * in-memory candidate. Pass 1, Pass 2, and the bounded repair pass are never
 * repeated here.
 */
export async function runBoundedAtomicityVerification<T extends SemanticReviewResult>(
  verify: () => Promise<T>,
  generatedMicroNodeCount: number,
): Promise<T & { verificationDiagnostics: AtomicityVerificationDiagnostics }> {
  const first = await verify();
  const attempts = [buildAtomicityVerificationAttempt(first, 1)];
  let final = first;
  let retrySucceeded = false;

  if (first.status === "UNAVAILABLE") {
    final = await verify();
    attempts.push(buildAtomicityVerificationAttempt(final, 2));
    retrySucceeded = final.status === "COMPLETE";
  }

  return {
    ...final,
    verificationDiagnostics: {
      generatedMicroNodeCount,
      requestAttempted: attempts.some((attempt) => attempt.requestAttempted),
      responseReceived: attempts.some((attempt) => attempt.responseReceived),
      parseState: final.status === "COMPLETE"
        ? "SUCCEEDED"
        : final.unavailableReason ?? "REQUEST_FAILED",
      validationState: "NOT_RUN",
      repairAttempted: false,
      retryAttempted: attempts.length > 1,
      retrySucceeded,
      attempts,
    },
  };
}

async function runGranularityReview(
  topics: Pass2TopicResult[],
  blocks: Pass1Block[],
  sourceAlignment: Pass2SourceAlignment,
  duplicateSuspicions: ReadonlyArray<DuplicateSuspicion>,
): Promise<SemanticReviewResult> {
  const generatedMicroNodeCount = topics.reduce((sum, topic) => sum + topic.microNodes.length, 0);
  let loggedRetry = false;
  return runBoundedAtomicityVerification(async () => {
    const result = await runGranularityReviewOnce(topics, blocks, sourceAlignment, duplicateSuspicions);
    if (result.status === "UNAVAILABLE" && !loggedRetry) {
      loggedRetry = true;
      logger.warn(
        { unavailableReason: result.unavailableReason, generatedMicroNodeCount },
        "pass2b atomicity verification interrupted — retrying existing candidate once",
      );
    }
    return result;
  }, generatedMicroNodeCount);
}

// ── Main exported Pass 2 function ─────────────────────────────────────────────

/**
 * Runs the full two-step Pass 2 pipeline on an in-memory block list.
 * Block indices are 0-based positions in the `blocks` array.
 * No DB interaction — purely AI orchestration. The caller stores the result.
 *
 * Validated on lesson 68 (83 blocks): 83/83 coverage, 0 empty sourceBlockIndices.
 */
export interface Pass2LessonInfo {
  lessonId?: number;
  lessonTitle: string;
  pagesFrom?: number | null;
  pagesTo?: number | null;
  teacherGoal?: string | null;
  teacherOutcomes?: readonly string[] | null;
}

export function buildPass2CurriculumConstraints(lessonInfo: Pass2LessonInfo): string {
  const goal = lessonInfo.teacherGoal?.trim() ?? "";
  const outcomes = (lessonInfo.teacherOutcomes ?? [])
    .map((outcome) => outcome.trim())
    .filter(Boolean);
  if (!goal && outcomes.length === 0) return "";
  return [
    "TEACHER-CONFIRMED CURRICULUM CONSTRAINTS:",
    goal ? `LESSON GOAL: ${goal}` : "",
    outcomes.length > 0
      ? `REQUIRED OUTCOMES:\n${outcomes.map((outcome, index) => `${index + 1}. ${outcome}`).join("\n")}`
      : "",
    "Use these constraints when naming and writing MicroNode learning objectives. Do not invent or alter them.",
  ].filter(Boolean).join("\n");
}

export type AutomaticOutcomeAlignmentProposal = {
  outcomeIndex: number;
  topicSequence: number;
  microNodeIndex: number;
  role: "REQUIRED" | "SUPPORTING";
  requiredCognitiveDepth: "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";
};

export type AutomaticOutcomeAlignmentPlan = {
  proposals: AutomaticOutcomeAlignmentProposal[];
  unresolvedOutcomeIndexes: number[];
};

const OUTCOME_STOP_WORDS = new Set([
  "սովորողը", "կարող", "կլինի", "պետք", "է", "են", "մասին", "հետ", "մեջ", "որ", "և", "ու",
]);

const OUTCOME_ACTION_STEMS = [
  "բացատր", "նկարագր", "մեկնաբան", "կիրառ", "լուծ", "օգտագործ", "որոշ",
  "վերլուծ", "համեմատ", "տարբերակ", "գնահատ", "հիմնավոր", "ստեղծ", "նախագծ",
  "կազմ", "կատար", "ճանաչ", "ցույց", "գտ",
];
const OUTCOME_GENERIC_CONCEPT_STEMS = [
  "կանոն", "թվ", "առաջադր", "վարժ", "դաս", "նյութ", "հասկաց",
  "օրինակ", "պատասխան", "եղանակ",
];

function normalizeArmenianConceptToken(token: string): string {
  const normalized = token.toLocaleLowerCase("hy-AM").trim();
  // Retain a conservative root alongside the original token so inflected forms
  // such as «համարակալման» and «համարակալում» can meet, while unrelated
  // short words cannot be collapsed into false matches.
  for (const suffix of ["ություններ", "ության", "ումներին", "ումների", "ման", "ումով", "ում", "ների", "ները", "երի", "ներ", "ը"]) {
    if (normalized.endsWith(suffix) && normalized.length - suffix.length >= 4) {
      return normalized.slice(0, -suffix.length);
    }
  }
  return normalized;
}

function outcomeTokens(value: string): Set<string> {
  const tokens = value
    .toLocaleLowerCase("hy-AM")
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !OUTCOME_STOP_WORDS.has(token));
  return new Set(tokens.flatMap((token) => [token, normalizeArmenianConceptToken(token)]));
}

function isOutcomeConceptToken(token: string): boolean {
  const normalized = normalizeArmenianConceptToken(token);
  if (OUTCOME_GENERIC_CONCEPT_STEMS.some(
    (stem) => token.startsWith(stem) || normalized.startsWith(stem),
  )) return false;
  // Armenian future forms often carry a leading «կ» (կբացատրի, կկիրառի).
  // Test both the original and that future-prefix form against action stems;
  // otherwise a shared verb could masquerade as the required shared concept.
  const forms = [token, normalized]
    .flatMap((value) => [value, value.startsWith("կ") ? value.slice(1) : value]);
  return !forms.some((value) => OUTCOME_ACTION_STEMS.some((stem) => value.startsWith(stem)));
}

function outcomeConceptTokens(value: string): Set<string> {
  return new Set([...outcomeTokens(value)].filter(isOutcomeConceptToken));
}

export function deriveOutcomeCognitiveDepth(
  outcome: string,
): AutomaticOutcomeAlignmentProposal["requiredCognitiveDepth"] {
  const normalized = outcome.toLocaleLowerCase("hy-AM");
  if (/(ստեղծ|նախագծ|կազմ)/u.test(normalized)) return "create";
  if (/(գնահատ|հիմնավոր|դատող)/u.test(normalized)) return "evaluate";
  if (/(վերլուծ|համեմատ|տարբերակ)/u.test(normalized)) return "analyze";
  if (/(կիրառ|լուծ|օգտագործ|որոշ)/u.test(normalized)) return "apply";
  if (/(բացատր|նկարագր|մեկնաբան)/u.test(normalized)) return "understand";
  return "remember";
}

/**
 * Deterministic first-pass alignment avoids treating ungrounded provider prose
 * as a curriculum decision. A proposal exists only when an Outcome and an
 * atomic objective share a specific source-language concept. Action verbs and
 * generic curriculum words cannot establish a REQUIRED relation by themselves.
 */
export function buildAutomaticOutcomeAlignmentPlan(
  outcomes: readonly string[],
  topics: ReadonlyArray<Pick<Pass2TopicResult, "sequence" | "microNodes">>,
): AutomaticOutcomeAlignmentPlan {
  const candidates = topics.flatMap((topic) => topic.microNodes.map((node, microNodeIndex) => ({
    topicSequence: topic.sequence,
    microNodeIndex,
    conceptTokens: outcomeConceptTokens(`${node.title} ${node.learningObjective}`),
  })));
  const proposals: AutomaticOutcomeAlignmentProposal[] = [];
  const unresolvedOutcomeIndexes: number[] = [];

  outcomes.forEach((outcome, outcomeIndex) => {
    const concepts = outcomeConceptTokens(outcome);
    const ranked = candidates
      .map((candidate) => ({
        ...candidate,
        score: [...concepts].filter((token) => candidate.conceptTokens.has(token)).length,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.topicSequence - b.topicSequence || a.microNodeIndex - b.microNodeIndex);
    if (ranked.length === 0) {
      unresolvedOutcomeIndexes.push(outcomeIndex);
      return;
    }
    const depth = deriveOutcomeCognitiveDepth(outcome);
    const strongest = ranked[0];
    proposals.push({
      outcomeIndex,
      topicSequence: strongest.topicSequence,
      microNodeIndex: strongest.microNodeIndex,
      role: "REQUIRED",
      requiredCognitiveDepth: depth,
    });
    for (const candidate of ranked.slice(1).filter((candidate) => candidate.score === strongest.score)) {
      proposals.push({
        outcomeIndex,
        topicSequence: candidate.topicSequence,
        microNodeIndex: candidate.microNodeIndex,
        role: "SUPPORTING",
        requiredCognitiveDepth: depth,
      });
    }
  });
  return { proposals, unresolvedOutcomeIndexes };
}

/**
 * The route deletes old Topics/MicroNodes only after runPass2Pipeline resolves.
 * Keeping source/provenance/structural gates in this pure assertion makes that
 * replacement boundary explicit and provider-free testable. Source-alignment
 * and completed-but-unresolved pedagogical atomicity findings are deliberately
 * not lesson-level hard gates: source-safe candidates persist as teacher-review
 * drafts with their audit while valid sibling nodes remain available.
 */
export function assertPass2PersistenceGates(input: {
  coverageValidation: CoverageValidationResult;
  instructionalCoverage: InstructionalCoverageResult;
  sourceAlignment: Pass2SourceAlignment;
  duplicateResolution: DuplicateResolutionAudit;
  diagnostics: Pass2Diagnostics;
  unresolvedAtomicityFindings?: GranularityFinding[];
  atomicityReviewUnavailableReason?: "EMPTY_RESPONSE" | "INVALID_RESPONSE" | "REQUEST_FAILED";
  atomicityVerificationDiagnostics?: AtomicityVerificationDiagnostics;
  /** A parsed semantic-review action that fails server validation is untrusted. */
  rejectedSemanticReviewDecisionCount?: number;
}): void {
  if (input.atomicityReviewUnavailableReason) {
    throw new MappingAtomicityReviewUnavailableError(
      input.atomicityReviewUnavailableReason,
      input.atomicityVerificationDiagnostics,
    );
  }
  if (!input.coverageValidation.valid) {
    throw new MappingSourcePlacementError(input.coverageValidation);
  }
  // A readable instructional block that remains without a MicroNode owner is
  // preserved as an unmapped, review-required source block. Activities are not
  // eligible for that escape hatch: they must still have a canonical exercise
  // destination before a replacement map can persist.
  if (input.instructionalCoverage.unresolvedActivityIndices.length > 0) {
    throw new MappingInstructionalCoverageError(input.instructionalCoverage, input.diagnostics);
  }
  if (input.duplicateResolution.rejectedDecisionCount > 0) {
    throw new MappingGranularityReviewError(input.duplicateResolution);
  }
  // Atomicity is enforced per candidate rather than all-or-nothing for the
  // lesson. The route turns these verified unresolved findings into
  // `needs_review` nodes, excludes them from canonical Outcome alignments, and
  // records the finding in mapping metadata. They never become approved data.
}

/**
 * Retains source-safe evidence when an instructional source block cannot be
 * assigned to a MicroNode after the single targeted repair. The block receives
 * the existing unmapped placement so structural coverage remains explicit,
 * while its unresolved or unreadable disposition stays in the teacher-review
 * audit. No source ownership or quote is fabricated here.
 */
export function preserveUnresolvedInstructionalBlocksForReview(
  topics: Pass2TopicResult[],
  blocks: ReadonlyArray<SourceCoverageBlock>,
): { preservedBlockIndices: number[] } {
  const instructionalCoverage = validateInstructionalCoverage(blocks, topics);
  const preservedBlockIndices: number[] = [];

  const reviewBlockIndices = instructionalCoverage.blocks
    .filter((record) =>
      record.disposition === "UNREADABLE"
      || (record.disposition === "UNRESOLVED"
        && record.reason === "INSTRUCTIONAL_BLOCK_NOT_MICRONODE_OWNED"),
    )
    .map((record) => record.blockIndex);

  for (const blockIndex of reviewBlockIndices) {
    const topic = topics.find((candidate) =>
      (candidate.inputBlockIndices ?? []).includes(blockIndex),
    );
    // A block outside every server-created Pass 2 topic is a structural
    // inconsistency. Leave it unplaced so the existing hard coverage gate
    // preserves the old map instead of attaching it to an arbitrary topic.
    if (!topic) continue;
    if (!topic.unmappedBlockIndices.includes(blockIndex)) {
      topic.unmappedBlockIndices.push(blockIndex);
    }
    preservedBlockIndices.push(blockIndex);
  }

  return { preservedBlockIndices: [...new Set(preservedBlockIndices)].sort((a, b) => a - b) };
}

/**
 * Produces the terminal atomicity trace before the destructive persistence
 * boundary. A review interruption is intentionally distinct from a completed
 * review that found broad nodes. Technical interruption remains ineligible for
 * persistence; completed non-atomic findings remain review-only until the
 * route persists their node-scoped disposition.
 */
export function finalizeAtomicityVerificationDiagnostics(input: {
  verification: AtomicityVerificationDiagnostics;
  lessonId?: number;
  repairAttempted: boolean;
  unresolvedFindingCount: number;
  technicalUnavailableReason?: "EMPTY_RESPONSE" | "INVALID_RESPONSE" | "REQUEST_FAILED";
}): AtomicityVerificationDiagnostics {
  const base: AtomicityVerificationDiagnostics = {
    ...input.verification,
    ...(input.lessonId === undefined ? {} : { lessonId: input.lessonId }),
    repairAttempted: input.repairAttempted,
    persistenceEligible: false,
  };
  if (input.technicalUnavailableReason) {
    return {
      ...base,
      validationState: "NOT_RUN",
      finalFailureCode: "TECHNICAL_RETRY_EXHAUSTED",
    };
  }
  if (input.unresolvedFindingCount > 0) {
    return {
      ...base,
      validationState: "FAILED_NON_ATOMIC",
      finalFailureCode: "UNRESOLVED_NON_ATOMIC",
    };
  }
  return {
    ...base,
    validationState: "PASSED",
  };
}

export async function runPass2Pipeline(
  blocks: Pass1Block[],
  lessonInfo: Pass2LessonInfo,
): Promise<Pass2Result> {
  logger.info({ lessonId: lessonInfo.lessonId, blockCount: blocks.length }, "pass2: starting pipeline");

  // Step 1: topic boundary detection
  let groups = await detectTopicGroups(
    blocks, lessonInfo.lessonTitle, lessonInfo.pagesFrom ?? 0, lessonInfo.pagesTo ?? 0
  );
  logger.info({ groupCount: groups.length }, "pass2 step1: initial topic groups");

  // Step 1b: size-cap guard — subdivide any group > PASS2_MAX_GROUP_SIZE
  const cappedGroups: typeof groups = [];
  for (const g of groups) {
    if (g.indices.length > PASS2_MAX_GROUP_SIZE) {
      logger.info(
        { group: g.title, size: g.indices.length },
        "pass2 step1b: group exceeds size cap, subdividing"
      );
      const subs = await subdivideGroup(g, blocks);
      cappedGroups.push(...subs);
    } else {
      cappedGroups.push(g);
    }
  }
  logger.info({ groupCount: cappedGroups.length }, "pass2 step1b: groups after size-cap");

  // Step 1c: hasRealTheory merge-pass ──────────────────────────────────────
  // A group is "hollow" when it contains zero DEFINITION/RULE/NOTE/EXAMPLE/
  // OBJECTIVE blocks whose sourceText is > 50 chars. These are pure exercise
  // dumps (e.g. 18 EXERCISE blocks with only a URL header), or stray task-
  // prompt groups. They cannot anchor a real MicroNode, so we merge them into
  // the nearest theory-bearing neighbour (prefer the preceding group so that
  // exercises that follow a theory section land in it; fall back to the next).
  // If NO neighbour has real theory the hollow group stays put — the Step 2
  // model's "never create standalone exercise MicroNode" rule handles it.

  const THEORY_TYPES = new Set(["DEFINITION", "RULE", "NOTE", "EXAMPLE", "OBJECTIVE"]);
  const MIN_THEORY_LEN = 50;

  function groupHasRealTheory(
    indices: number[],
    blocks: Pass1Block[]
  ): boolean {
    return indices.some((i) => {
      const b = blocks[i];
      return b && THEORY_TYPES.has(b.blockType) && b.sourceText.trim().length > MIN_THEORY_LEN;
    });
  }

  const mergedGroups: typeof cappedGroups = [];
  const mergeLog: { hollow: string; mergedInto: string; blocksMoved: number }[] = [];

  for (let gi = 0; gi < cappedGroups.length; gi++) {
    const g = cappedGroups[gi];
    if (groupHasRealTheory(g.indices, blocks)) {
      mergedGroups.push({ ...g });
      continue;
    }

    // Hollow group — find nearest real-theory neighbour
    // Search backwards through mergedGroups (already-committed groups)
    let merged = false;
    for (let bi = mergedGroups.length - 1; bi >= 0; bi--) {
      if (groupHasRealTheory(mergedGroups[bi].indices, blocks)) {
        mergeLog.push({
          hollow:      g.title,
          mergedInto:  mergedGroups[bi].title,
          blocksMoved: g.indices.length,
        });
        mergedGroups[bi] = {
          ...mergedGroups[bi],
          indices: [...mergedGroups[bi].indices, ...g.indices],
        };
        merged = true;
        break;
      }
    }
    if (!merged) {
      // Try forward lookahead in the remaining cappedGroups
      for (let fi = gi + 1; fi < cappedGroups.length; fi++) {
        if (groupHasRealTheory(cappedGroups[fi].indices, blocks)) {
          // Prepend the hollow group's indices into the future real group
          cappedGroups[fi] = {
            ...cappedGroups[fi],
            indices: [...g.indices, ...cappedGroups[fi].indices],
          };
          mergeLog.push({
            hollow:      g.title,
            mergedInto:  cappedGroups[fi].title,
            blocksMoved: g.indices.length,
          });
          merged = true;
          break;
        }
      }
    }
    if (!merged) {
      // No theory-bearing neighbour found at all — keep as-is, Step 2 handles it
      logger.warn(
        { group: g.title, blockCount: g.indices.length },
        "pass2 step1c: hollow group has no theory-bearing neighbour — keeping"
      );
      mergedGroups.push({ ...g });
    }
  }

  if (mergeLog.length > 0) {
    logger.info({ mergeLog }, "pass2 step1c: hollow groups merged");
  }
  logger.info({ groupCount: mergedGroups.length }, "pass2 step1c: groups after hasRealTheory merge");

  // Step 2: organise each topic into MicroNodes (all groups in parallel)
  const curriculumConstraints = buildPass2CurriculumConstraints(lessonInfo);
  let topicResults: Awaited<ReturnType<typeof organizeTopicMicroNodes>>[];
  try {
    topicResults = await Promise.all(
      mergedGroups.map((g, i) =>
        organizeTopicMicroNodes(g.title, g.indices, blocks, i + 1, curriculumConstraints)
      )
    );
  } catch (error) {
    if (error instanceof Pass2Step2ParserError) {
      const parserDiagnostics: Pass2Diagnostics = {
        detectedGroupCount: groups.length,
        groupsAfterTheoryMergeCount: mergedGroups.length,
        topics: [error.diagnostics],
        totals: {
          candidateMicroNodes: 0,
          acceptedBeforeNormalization: 0,
          acceptedAfterNormalization: 0,
          rejectedMicroNodes: 0,
        },
      };
      throw new MappingPass2ParserError(parserDiagnostics);
    }
    throw error;
  }

  const topics: Pass2TopicResult[] = mergedGroups.map((g, i) => ({
    sequence:              i + 1,
    title:                 g.title,
    topicType:             g.topicType,
    inputBlockIndices:     [...g.indices],
    microNodes:            topicResults[i].microNodes,
    unmappedBlockIndices:  topicResults[i].unmappedIndices,
    additionalExercises:   topicResults[i].additionalExercises,
  }));
  for (const topic of topics) {
    topic.microNodes.forEach((node, microNodeIndex) => {
      node.candidateId = `t${topic.sequence}:n${microNodeIndex}`;
    });
  }
  const topicDiagnostics = topicResults.map((result) => result.diagnostics);

  // ── Activity normalization: enforce "exactly one canonical placement" invariant ─
  //
  // INVARIANT: every EXERCISE / ACTIVITY / HOMEWORK block from Pass1 must appear
  // in exactly one valid activity destination after Pass2:
  //   1. microNode.exercises[]       — linked to a MicroNode (relatedNodeId set)
  //   2. topic.additionalExercises[] — unassigned (relatedNodeId = null)
  //
  // normalizeActivityPlacements() handles all known duplicate-creating paths:
  //  • Activity block in sourceBlockIndices (ACTIVITY_IN_THEORY) + Step C rescue
  //    → Evict from sourceBlockIndices first, then rescue.
  //  • Same block in exercises[] of two MicroNodes, or exercises[]+additionalExercises[]
  //    → exercises[] wins; duplicates removed.
  //  • Invalid blockIndex entries (null, out-of-range, non-integer)
  //    → Dropped before coverage validation.
  //  • Activity blocks in unmappedBlockIndices (AI misclassified as header)
  //    → Rescued to additionalExercises.
  //  • Activity blocks missing from all Pass2 output
  //    → Rescued to additionalExercises of last topic.
  {
    const norm = normalizeActivityPlacements(topics, blocks);
    recordPass2PostNormalizationCounts(topics, topicDiagnostics);
    if (norm.evictedFromSource.length > 0) {
      logger.warn(
        { evictedFromSource: norm.evictedFromSource },
        "pass2 normalize: activity blocks evicted from sourceBlockIndices (ACTIVITY_IN_THEORY fix)",
      );
    }
    if (norm.postEvictionStripped.length > 0) {
      logger.warn(
        { postEvictionStripped: norm.postEvictionStripped },
        "pass2 normalize: MicroNodes stripped after activity eviction (sourceBlockIndices became empty)",
      );
    }
    if (norm.dedupedExercises.length > 0 || norm.dedupedAdditional.length > 0) {
      logger.warn(
        { dedupedExercises: norm.dedupedExercises, dedupedAdditional: norm.dedupedAdditional },
        "pass2 normalize: duplicate activity placements resolved — canonical kept",
      );
    }
    if (norm.stepBRescued.length > 0) {
      logger.warn(
        { stepBRescued: norm.stepBRescued },
        "pass2 p5.4b: rescued EXERCISE/ACTIVITY/HOMEWORK from unmappedBlocks → additionalExercises",
      );
    }
    if (norm.stepCRescued.length > 0) {
      logger.warn(
        { stepCRescued: norm.stepCRescued, rescueTopicTitle: topics[topics.length - 1]?.title },
        "pass2 p5.4c: deterministic rescue of missing activity blocks → additionalExercises",
      );
    }
  }

  // A pure section heading can be correctly extracted by Pass 1 yet still be
  // invalid evidence for a MicroNode objective. Keep that structural source in
  // the mapping without allowing a heading-only MicroNode through to semantic
  // review or persistence.
  const structuralOwnershipRepair = removeStructuralHeadingSourceOwnership(topics, blocks);
  if (structuralOwnershipRepair.movedHeadingIndices.length > 0) {
    logger.info(
      {
        movedHeadingIndices: structuralOwnershipRepair.movedHeadingIndices,
        removedMicroNodeCount: structuralOwnershipRepair.removedMicroNodeTitles.length,
        rescuedExerciseIndices: structuralOwnershipRepair.rescuedExerciseIndices,
      },
      "pass2: structural heading ownership repaired before source alignment",
    );
  }
  normalizeActivityPlacements(topics, blocks);

  // Source coverage has a stricter meaning than placement coverage. Each
  // affected Topic receives exactly one narrow repair call; no repair can
  // broaden to another Topic.
  const repairResults = await Promise.all(
    topics.map((topic, index) =>
      repairTopicInstructionalCoverage(topic, blocks, index + 1, curriculumConstraints),
    ),
  );
  recordPass2PostNormalizationCounts(topics, topicDiagnostics);
  const instructionalCoverage = validateInstructionalCoverage(blocks, topics);
  for (let index = 0; index < topics.length; index++) {
    const topicIndices = new Set(topics[index].inputBlockIndices ?? []);
    const records = instructionalCoverage.blocks.filter((record) => topicIndices.has(record.blockIndex));
    const unresolvedInstructional = records.filter(
      (record) => record.disposition === "UNRESOLVED" &&
        record.reason === "INSTRUCTIONAL_BLOCK_NOT_MICRONODE_OWNED",
    ).length;
    topicDiagnostics[index].instructionalCoverage = {
      readableInstructionalBlocks: records.filter((record) =>
        record.disposition === "MICRONODE_OWNED" ||
        (record.disposition === "UNRESOLVED" &&
          record.reason === "INSTRUCTIONAL_BLOCK_NOT_MICRONODE_OWNED"),
      ).length,
      microNodeOwnedInstructionalBlocks: records.filter(
        (record) => record.disposition === "MICRONODE_OWNED",
      ).length,
      unresolvedInstructionalBlocks: unresolvedInstructional,
      targetedRepair: !repairResults[index].attempted
        ? "NOT_NEEDED"
        : repairResults[index].failed
          ? "FAILED"
          : unresolvedInstructional === 0
            ? "RESOLVED"
            : "UNRESOLVED",
      targetedRepairRecoveredBlocks: repairResults[index].recoveredBlockCount,
    };
  }

  const diagnostics: Pass2Diagnostics = {
    detectedGroupCount: groups.length,
    groupsAfterTheoryMergeCount: mergedGroups.length,
    topics: topicDiagnostics,
    totals: {
      candidateMicroNodes: topicDiagnostics.reduce((total, topic) => total + topic.candidateMicroNodeCount, 0),
      acceptedBeforeNormalization: topicDiagnostics.reduce((total, topic) => total + topic.acceptedMicroNodeCount, 0),
      acceptedAfterNormalization: topicDiagnostics.reduce((total, topic) => total + topic.postNormalizationMicroNodeCount, 0),
      rejectedMicroNodes: topicDiagnostics.reduce((total, topic) => total + topic.rejectedMicroNodeCount, 0),
    },
  };

  // Pass 2B produces semantic findings. A single bounded merge pass may apply
  // only explicit HIGH-confidence actions with a known server-issued target.
  const initialSourceAlignment = validatePass2SourceAlignment(topics, blocks);
  const duplicateSuspicions = collectDuplicateSuspicions(topics);
  const semanticReview = await runGranularityReview(
    topics,
    blocks,
    initialSourceAlignment,
    duplicateSuspicions,
  );
  const atomicityReviewUnavailableReason = semanticReview.status === "UNAVAILABLE"
    ? semanticReview.unavailableReason
    : undefined;
  const granularityFindings = semanticReview.findings;
  const explicitConsolidation = consolidateHighConfidenceOverSplits(
    topics,
    granularityFindings,
    { requireStableIds: true },
  );
  const duplicateResolution = resolveDuplicateSuspicions(
    topics,
    duplicateSuspicions,
    semanticReview.duplicateResolutions,
    explicitConsolidation.resolvedCandidatePairs,
    semanticReview.malformedDuplicateResolutionEntries,
  );
  const granularityConsolidation: GranularityConsolidation = {
    beforeMicroNodeCount: explicitConsolidation.beforeMicroNodeCount,
    afterMicroNodeCount: topics.reduce((sum, topic) => sum + topic.microNodes.length, 0),
    mergedMicroNodeCount: explicitConsolidation.mergedMicroNodeCount + duplicateResolution.mergedCount,
    rejectedDecisionCount: explicitConsolidation.rejectedDecisionCount,
    resolvedCandidatePairs: explicitConsolidation.resolvedCandidatePairs,
    actions: [...explicitConsolidation.actions, ...duplicateResolution.actions],
  };
  const sourceReallocation = applyBoundedSourceReallocation(
    topics,
    blocks,
    semanticReview.sourceReallocations,
    { requireStableIds: true },
  );
  // This is the only atomicity repair pass in a mapping run. Its split contract
  // requires an exact partition of existing same-lesson source ownership, while
  // exercise moves preserve one canonical activity destination.
  const atomicityRepair = applyBoundedAtomicityRepairs(
    topics,
    blocks,
    semanticReview.atomicityRepairs,
  );
  normalizeActivityPlacements(topics, blocks);
  const sourceAlignmentReconciliation = reconcileSameTopicSourceAlignment(topics, blocks);
  normalizeActivityPlacements(topics, blocks);
  recordPass2PostNormalizationCounts(topics, topicDiagnostics);

  // Deterministic ownership validation is rerun after consolidation. A merge is
  // safe only if it preserves one valid owner for every source and activity.
  const sourcePlacementReview = preserveUnresolvedInstructionalBlocksForReview(topics, blocks);
  const postConsolidationInstructionalCoverage = validateInstructionalCoverage(blocks, topics);
  const coverageValidation = validateSourceCoverage(blocks.length, topics);
  const allUnmapped = topics.flatMap((topic) => topic.unmappedBlockIndices);
  const sourceAlignment = validatePass2SourceAlignment(topics, blocks);
  const reconciliationByNodeId = new Map(
    sourceAlignmentReconciliation.dispositions.map((disposition) => [
      `${disposition.topicSequence}:${disposition.microNodeId}`,
      disposition,
    ]),
  );
  for (const entry of sourceAlignment.nodes) {
    const disposition = reconciliationByNodeId.get(`${entry.topicSequence}:${entry.microNodeId}`);
    if (disposition) entry.reconciliationDisposition = disposition;
  }
  const unresolvedAtomicityFindings = getUnresolvedAtomicityFindings(
    topics,
    granularityFindings,
    atomicityRepair,
    sourceAlignment,
  );
  const atomicityVerification = finalizeAtomicityVerificationDiagnostics({
    verification: semanticReview.verificationDiagnostics ?? {
      generatedMicroNodeCount: topics.reduce((sum, topic) => sum + topic.microNodes.length, 0),
      requestAttempted: false,
      responseReceived: false,
      parseState: "REQUEST_FAILED" as const,
      validationState: "NOT_RUN" as const,
      repairAttempted: false,
      retryAttempted: false,
      retrySucceeded: false,
      attempts: [],
    },
    lessonId: lessonInfo.lessonId,
    repairAttempted: atomicityRepair.attempted,
    unresolvedFindingCount: unresolvedAtomicityFindings.length,
    technicalUnavailableReason: atomicityReviewUnavailableReason,
  });

  logger.info(
    {
      coverage:        `${coverageValidation.coveredBlocks}/${coverageValidation.totalBlocks}`,
      coveragePercent: coverageValidation.coveragePercent,
      valid:           coverageValidation.valid,
       instructionalCoverageValid: postConsolidationInstructionalCoverage.valid,
       unresolvedInstructional: postConsolidationInstructionalCoverage.unresolvedInstructionalIndices.length,
       granularityConsolidation,
        duplicateResolution: {
          candidatePairCount: duplicateResolution.candidatePairCount,
          resolvedDistinctCount: duplicateResolution.resolvedDistinctCount,
          mergedCount: duplicateResolution.mergedCount,
          unresolvedPairCount: duplicateResolution.unresolvedPairIds.length,
          rejectedDecisionCount: duplicateResolution.rejectedDecisionCount,
        },
       sourceReallocation,
        sourceAlignmentReconciliation,
        atomicityRepair,
         atomicityVerification,
        unresolvedAtomicityFindingCount: unresolvedAtomicityFindings.length,
      missingIndices:  coverageValidation.missingIndices,
      duplicateIndices: coverageValidation.duplicateIndices,
      invalidIndices:  coverageValidation.invalidIndices,
      emptyMicroNodes: coverageValidation.emptyMicroNodeTitles,
      categoryCounts:  coverageValidation.categoryCounts,
      topicsCreated:   topics.length,
      microNodes:      topics.reduce((s, t) => s + t.microNodes.length, 0),
      diagnostics,
    },
    "pass2: pipeline complete"
  );

  if (coverageValidation.missingIndices.length > 0) {
    logger.warn({ missingIndices: coverageValidation.missingIndices }, "pass2: blocks not placed by pipeline");
  }
  if (coverageValidation.emptyMicroNodeTitles.length > 0) {
    logger.warn({ emptyMicroNodes: coverageValidation.emptyMicroNodeTitles }, "pass2: MicroNodes with empty sourceBlockIndices");
  }
  if (coverageValidation.duplicateIndices.length > 0) {
    logger.warn({ duplicateIndices: coverageValidation.duplicateIndices }, "pass2: duplicate block index assignments detected");
  }
  if (coverageValidation.invalidIndices.length > 0) {
    logger.warn({ invalidIndices: coverageValidation.invalidIndices }, "pass2: block indices outside Pass1 bounds detected");
  }
  if (!postConsolidationInstructionalCoverage.valid) {
    logger.warn(
      {
        unresolvedInstructional: postConsolidationInstructionalCoverage.unresolvedInstructionalIndices,
        unresolvedActivities: postConsolidationInstructionalCoverage.unresolvedActivityIndices,
      },
      "pass2: readable instructional source retained as review-required after bounded repair",
    );
  }
  assertPass2PersistenceGates({
    coverageValidation,
    instructionalCoverage: postConsolidationInstructionalCoverage,
    sourceAlignment,
    duplicateResolution,
    diagnostics,
    unresolvedAtomicityFindings,
    atomicityReviewUnavailableReason,
    atomicityVerificationDiagnostics: atomicityVerification,
    rejectedSemanticReviewDecisionCount:
      granularityConsolidation.rejectedDecisionCount
      + sourceReallocation.rejectedDecisionCount
      + atomicityRepair.rejectedDecisionCount,
  });

  atomicityVerification.persistenceEligible = true;

  return {
    topics,
    unmappedBlockIndices: allUnmapped,
    sourcePlacementReview,
    coverageValidation,
    instructionalCoverage: postConsolidationInstructionalCoverage,
    granularityFindings,
    granularityConsolidation,
    duplicateResolution,
    sourceAlignment,
    sourceReallocation,
    sourceAlignmentReconciliation,
    atomicityRepair,
    atomicityVerification,
    unresolvedAtomicityFindings,
    diagnostics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Teaching content generation (per MicroNode)
// ─────────────────────────────────────────────────────────────────────────────

const PHASE2_MODEL = "deepseek/deepseek-v4-flash";

export interface Phase2LinkedExercise {
  exerciseId:          string;
  exerciseTextVerbatim: string;
}

// Phase 2A R3: confirmed cognitive level summary passed to the teaching content generator.
export interface ConfirmedCogLevel {
  cognitiveLevel:       string;
  sequence:             number;
  isTargetCeiling:      boolean;
  performanceObjective: string | null;
  successCriterion:     string | null;
}

export interface Phase2Input {
  nodeId:            number;
  title:             string;
  learningObjective: string | null;
  theoryContent:     string | null;
  blockType:         string | null;
  /** Phase 2A R3: confirmed cognitive path — included when gate is open. */
  cogPath?: ConfirmedCogLevel[] | null;
}

export interface Phase2GenerationResult {
  nodeId:                    number;
  skipped:                   boolean;
  skipReason?:               string;
  childFriendlyExplanation:  string;
  basicExamples:             string[];
  commonMisconception:       string;
  nonExamples:               string[];
  groundingAudit?:          TeachingContentGroundingAudit;
}

const WEAK_SOURCE_PATTERNS = [
  /^https?:\/\//i,                          // bare URL
  /www\.[a-z0-9-]+\.[a-z]{2,}/i,           // domain reference
];

/**
 * Returns true when theoryContent is too thin to ground real teaching content.
 * Triggers: null, empty, < 50 chars, or matches a URL/domain pattern.
 */
export function isWeakSource(theoryContent: string | null | undefined): boolean {
  if (!theoryContent || theoryContent.trim().length < 50) return true;
  return WEAK_SOURCE_PATTERNS.some((re) => re.test(theoryContent.trim()));
}

const PHASE2_SYSTEM = `You are an expert Armenian curriculum designer generating teaching support content for a grade-7 Armenian math textbook app.

STRICT GROUNDING RULES — violating any rule is worse than leaving a field empty:
1. ALL four fields must be derived ONLY from the provided theoryContent. Do not add facts, rules, or examples not present in the source text.
2. childFriendlyExplanation: rephrase the core concept in 2–3 simple sentences a 12-year-old can understand. No jargon. No new information beyond what is in theoryContent.
3. basicExamples: extract or lightly simplify 2–4 concrete examples directly from the theory. Each example must be a complete, standalone statement or worked step. Preserve numbers and operations verbatim where possible.
4. commonMisconception: state the single most likely wrong belief a grade-7 student would hold about THIS specific concept. Ground it in the definition — do not invent generic misconceptions unrelated to the source.
5. nonExamples: provide 2–3 cases that look like they might fit the concept but do NOT satisfy its definition. Each must contrast directly with the definition in theoryContent.
6. Cognitive alignment: when a confirmed cognitive path is provided, calibrate depth and complexity so teaching content supports learning up to (and including) the TARGET CEILING level only. Do not generate content for cognitive levels beyond the target ceiling.

Return ONLY valid JSON. No markdown fences. No trailing commas.`;

function buildPhase2Prompt(
  input: Phase2Input,
  exercises: Phase2LinkedExercise[]
): string {
  const exList = exercises.length
    ? exercises.map((e) => `[${e.exerciseId}] ${e.exerciseTextVerbatim}`).join("\n")
    : "(none)";

  let cogSection = "";
  if (input.cogPath?.length) {
    const ceiling = input.cogPath.find((l) => l.isTargetCeiling);
    cogSection = `\nConfirmed Cognitive Path (${input.cogPath.length} level(s)):
${input.cogPath.map((l) =>
  `  [seq=${l.sequence}] ${l.cognitiveLevel.toUpperCase()}${l.isTargetCeiling ? " ← TARGET CEILING" : ""}` +
  (l.performanceObjective ? `\n    PO: ${l.performanceObjective}` : "") +
  (l.successCriterion     ? `\n    SC: ${l.successCriterion}`     : "")
).join("\n")}

COGNITIVE CALIBRATION: Target ceiling is "${ceiling?.cognitiveLevel ?? "unset"}". Generate teaching content that supports learners in reaching this level. Do NOT produce content aimed at higher cognitive levels.\n`;
  }

  return `MicroNode id=${input.nodeId}, title="${input.title}"
learningObjective: ${input.learningObjective ?? "(none)"}
${cogSection}
theoryContent:
${input.theoryContent}

Linked Exercises (${exercises.length}):
${exList}

Return JSON with exactly these 4 fields. All values must be in Armenian. Ground every field in the theoryContent above.
{
  "childFriendlyExplanation": "Armenian — 2–3 simple sentences explaining the core concept, no jargon",
  "basicExamples": ["Armenian concrete example 1", "Armenian concrete example 2"],
  "commonMisconception": "Armenian — one specific wrong belief a grade-7 student would hold about this concept",
  "nonExamples": ["Armenian non-example 1 that looks right but fails the definition", "Armenian non-example 2"]
}`;
}

function extractStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Generates Phase 2 teaching content for a single MicroNode.
 * Returns a skipped result (no AI call) if theoryContent is too thin.
 * Caller is responsible for writing the result to the DB.
 */
export async function generatePhase2Content(
  input: Phase2Input,
  exercises: Phase2LinkedExercise[]
): Promise<Phase2GenerationResult> {
  // Weak-source guard — do not generate placeholder content
  if (isWeakSource(input.theoryContent)) {
    return {
      nodeId:                   input.nodeId,
      skipped:                  true,
      skipReason:               "insufficient source content for teaching material",
      childFriendlyExplanation: "",
      basicExamples:            [],
      commonMisconception:      "",
      nonExamples:              [],
    };
  }

  async function callModel(): Promise<string> {
    const r = await openrouter.chat.completions.create({
      model:      PHASE2_MODEL,
      max_tokens: 4096,
      temperature: 0,
      messages: [
        { role: "system", content: PHASE2_SYSTEM },
        { role: "user",   content: buildPhase2Prompt(input, exercises) },
      ],
    });
    return r.choices[0]?.message?.content ?? "";
  }

  function tryParse(raw: string): Record<string, unknown> | null {
    let clean = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    clean = clean.replace(/,(\s*[}\]])/g, "$1");
    try { return JSON.parse(clean); } catch { return null; }
  }

  let parsed: Record<string, unknown> | null = tryParse(await callModel());

  // One retry on parse failure — model occasionally truncates or returns empty
  if (!parsed) {
    logger.warn({ nodeId: input.nodeId }, "phase2: JSON parse failed, retrying once");
    parsed = tryParse(await callModel());
  }

  if (!parsed) {
    logger.warn({ nodeId: input.nodeId }, "phase2: JSON parse failed after retry");
    return {
      nodeId:                   input.nodeId,
      skipped:                  true,
      skipReason:               "AI returned unparseable JSON after retry — re-run this node",
      childFriendlyExplanation: "",
      basicExamples:            [],
      commonMisconception:      "",
      nonExamples:              [],
    };
  }

  const candidate = {
    childFriendlyExplanation: typeof parsed.childFriendlyExplanation === "string" ? parsed.childFriendlyExplanation : "",
    basicExamples:            extractStringArray(parsed.basicExamples),
    commonMisconception:      typeof parsed.commonMisconception === "string" ? parsed.commonMisconception : "",
    nonExamples:              extractStringArray(parsed.nonExamples),
  };
  const groundingAudit = validateTeachingContentGrounding(input.theoryContent, candidate);
  if (!groundingAudit.valid) {
    logger.warn(
      { nodeId: input.nodeId, issueCounts: groundingAudit.issueCounts },
      "phase2: generated teaching content rejected by source-grounding boundary",
    );
    return {
      nodeId: input.nodeId,
      skipped: true,
      skipReason: "generated teaching content includes claims not supported by the source",
      ...candidate,
      groundingAudit,
    };
  }

  return {
    nodeId: input.nodeId,
    skipped: false,
    ...candidate,
    groundingAudit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2A R3: Cognitive Path Generation
// ─────────────────────────────────────────────────────────────────────────────

const COGNITIVE_PATH_MODEL = "deepseek/deepseek-v4-flash";

export interface CogPathExercise {
  exerciseId: string;
  exerciseText: string;
}

export interface CogPathInput {
  nodeId:            number;
  title:             string;
  /** Persisted C1 review state; known non-approved states must not enter C2. */
  nodeStatus?:       string | null;
  learningObjective: string | null;
  theoryContent:     string | null;
  blockType:         string | null;
  /**
   * Existing C1 ceiling, when one has been established. C2 generation may not
   * raise or replace this curriculum decision.
   */
  targetBloomLevel?: number | null;
  subjectName:       string;
  lessonTitle:       string;
  topicTitle:        string | null;
  // Phase 2 teaching content (if available — enriches the generation context)
  childFriendlyExplanation?: string | null;
  basicExamples?:             string[] | null;
  // Source exercises linked to this node
  exercises: CogPathExercise[];
  // Existing enrichment, provided only when regenerating (for context)
  existingLevels?: Array<{
    cognitiveLevel:       string;
    sequence:             number;
    isTargetCeiling:      boolean;
    performanceObjective: string | null;
    successCriterion:     string | null;
  }>;
}

export interface CogPathLevel {
  cognitiveLevel:             "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";
  sequence:                   number;
  isTargetCeiling:            boolean;
  performanceObjective:       string;
  successCriterion:           string;
  minimumIndependentEvidence: number;
  preferredInteractionTypes:  string[];
}

export interface CogPathGenerationResult {
  nodeId:      number;
  skipped:     boolean;
  skipCode?:   C2GenerationBlockCode | "C2_CEILING_VIOLATION" | "C2_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION" | "C2_PATH_STRUCTURE_REJECTED" | "C2_GROUNDING_REJECTED";
  skipReason?: string;
  levels:      CogPathLevel[];
  groundingAudit?: CognitivePathGroundingAudit;
}

import { z } from "zod";

export const cogPathLevelSchema = z.object({
  cognitiveLevel:             z.enum(["remember", "understand", "apply", "analyze", "evaluate", "create"]),
  sequence:                   z.number().int().min(1),
  isTargetCeiling:            z.boolean(),
  performanceObjective:       z.string(),
  successCriterion:           z.string(),
  minimumIndependentEvidence: z.number().int().min(1).max(5).default(3),
  preferredInteractionTypes:  z.array(z.string()).default([]),
});

const _cogPathResponseSchema = z.object({
  levels: z.array(cogPathLevelSchema).min(1),
});

const BLOOM_LEVEL_BY_INT = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;

export function preservesC1TargetCeiling(
  targetBloomLevel: number | null | undefined,
  levels: ReadonlyArray<Pick<CogPathLevel, "cognitiveLevel" | "isTargetCeiling">>,
): boolean {
  const requiredC1Ceiling =
    targetBloomLevel && targetBloomLevel >= 1 && targetBloomLevel <= 6
      ? BLOOM_LEVEL_BY_INT[targetBloomLevel - 1]
      : null;
  if (!requiredC1Ceiling) return true;

  const selectedCeiling = levels.find((level) => level.isTargetCeiling)?.cognitiveLevel;
  return selectedCeiling === requiredC1Ceiling
    && levels.every(
      (level) =>
        BLOOM_LEVEL_BY_INT.indexOf(level.cognitiveLevel) <=
        BLOOM_LEVEL_BY_INT.indexOf(requiredC1Ceiling),
    );
}

const LEGACY_COGNITIVE_PATH_SYSTEM = `Դու հայ ուսումնական ծրագրի փորձագետ ես, որը վերլուծում է MicroNode-ի ճանաչողական կառուցվածքը՝ Bloom-ի վերանայված տաքսոնոմիայի (2001) հիման վրա։

ԿԱՆՈՆՆԵՐ.
1. Որոշիր ԲՈLA unjust ճanachogakan макардакнеры, որոնք արдаrakunел են ուsuмnakan нправ-ovi и bovna ndakutYun-ov: Не добавляй уровни механически.
2. Большинство МикроНодов нуждается в 2–4 уровнях. НЕ добавляй все шесть автоматически.
3. Ֆyour последовательность ОБЯЗАТЕЛЬНО возрастает: remember < understand < apply < analyze < evaluate < create.
4. РОВНО ОДИН уровень должен иметь isTargetCeiling: true — наивысшее когнитивное требование, которое ожидает учебная программа.
5. Весь текст — АРМЯНСКИЙ Unicode. Никакой латиницы в тексте целей и критериев.
6. performanceObjective: что учащийся может ДЕЛАТЬ на этом уровне. Начни с глагола действия. Должно быть наблюдаемым. Формат: «Սovonoghy kar может…»
7. successCriterion: что считается приемлемым свидетельством. Конкретно.
8. minimumIndependentEvidence: цель проектирования (1–5). По умолчанию: 2 для remember, 3 для understand/apply, 3 для analyze и выше.
9. preferredInteractionTypes: выбери из: multiple_choice, multi_select, true_false, matching, classification, ordering, numeric_answer, short_answer, constructed_response, problem_solving.
10. Взаимодействие и когнитивное требование — РАЗНЫЕ измерения. multiple_choice может оценивать Apply; written_response — не обязательно означает высшее мышление.
11. Մի գրիր թվական, քանակ կամ թվային պնդում performanceObjective կամ successCriterion դաշտերում, եթե այն բառացիորեն տեսանելի չէ source-ում։ Եթե թիվ պետք չէ, այն մի օգտագործիր։
12. Եթե C1 target ceiling-ը 1 (remember) է, վերադարձիր ՄԻԱՅՆ մեկ remember մակարդակ՝ sequence=1 և isTargetCeiling=true։ C1-ի նշված ceiling-ից բարձր մակարդակ երբեք մի վերադարձիր։

ОРИЕНТИРЫ (следуй учебным целям и содержанию, а не этим примерам механически):
- определение/распознавание: remember → understand
- концептуальное понимание: remember → understand
- процедурное применение: remember → understand → apply
- сравнение/отношения: understand → apply → analyze
- суждение с критериями: understand → apply → analyze → evaluate
- создание/проектирование: understand → apply → analyze → evaluate → create

Верни ТОЛЬКО валидный JSON. Без markdown. Без прозы.`;

export const COGNITIVE_PATH_SYSTEM = `You design Cognitive Paths for an Armenian curriculum. Return only valid JSON.

SOURCE-GROUNDING CONTRACT:
1. Treat theoryContent as the sole authority for claims, examples, numbers, operations, and relationships. The learningObjective can set the intended action only when theoryContent supports it.
2. Every performanceObjective and successCriterion must name a learner action tied to a specific claim, representation, or procedure visible in theoryContent. Do not use generic Bloom boilerplate, unrelated scenarios, or unsupported stronger claims.
3. Preserve every number, notation, and operation exactly when you use it. Do not invent a number or a worked example.
4. Use the fewest meaningful levels. A single level is valid. Do not mechanically add REMEMBER, and a path may start at UNDERSTAND, APPLY, or another supported level.
5. Levels must be strictly increasing: remember < understand < apply < analyze < evaluate < create. Return exactly one target ceiling.
6. If a C1 target ceiling is specified, the target ceiling must equal it and no returned level may be higher. Do not lower, raise, or replace that C1 decision.
7. All performanceObjective and successCriterion text must be Armenian Unicode. Make the performance objective observable and the success criterion narrow, checkable evidence for that same source-backed action.
8. minimumIndependentEvidence must be an integer from 1 to 5. preferredInteractionTypes may contain only: multiple_choice, multi_select, true_false, matching, classification, ordering, numeric_answer, short_answer, constructed_response, problem_solving.

Return only the requested JSON object. No markdown and no prose.`;

export function buildCogPathPrompt(input: CogPathInput): string {
  const exList = input.exercises.length
    ? input.exercises.map((e) => `[${e.exerciseId}] ${e.exerciseText}`).join("\n")
    : "(no source exercises linked)";

  const phase2Section = input.childFriendlyExplanation
    ? `\nPhase 2 content (child-friendly explanation):\n${input.childFriendlyExplanation}${
        input.basicExamples?.length ? `\nBasic examples: ${input.basicExamples.join(" | ")}` : ""
      }`
    : "";

  const existingSection = input.existingLevels?.length
    ? `\n⚠️ REGENERATING — existing enrichment (for context; you may revise):\n${JSON.stringify(input.existingLevels, null, 2)}`
    : "";

  return `Subject: ${input.subjectName}
Lesson: "${input.lessonTitle}"
Topic: ${input.topicTitle ?? "(standalone node)"}
MicroNode id=${input.nodeId}: "${input.title}"
learningObjective: ${input.learningObjective ?? "(not set)"}
blockType: ${input.blockType ?? "(unknown)"}
C1 target ceiling: ${input.targetBloomLevel && input.targetBloomLevel >= 1 && input.targetBloomLevel <= 6
  ? `${input.targetBloomLevel} (${BLOOM_LEVEL_BY_INT[input.targetBloomLevel - 1]})`
  : "(not specified)"}

theoryContent:
${input.theoryContent ?? "(empty)"}
${phase2Section}

Linked Source Exercises (${input.exercises.length}):
${exList}
${existingSection}

Return a source-grounded cognitive path for this MicroNode. Include only levels
that the source and C1 target directly support.
{
  "levels": [
    {
      "cognitiveLevel": "apply",
      "sequence": 1,
      "isTargetCeiling": true,
      "performanceObjective": "Հայերեն՝ աղբյուրում տեսանելի գործողությամբ դիտարկելի նպատակ",
      "successCriterion": "Հայերեն՝ նույն գործողության նեղ, ստուգելի չափանիշ",
      "minimumIndependentEvidence": 3,
      "preferredInteractionTypes": ["short_answer"]
    }
  ]
}

CRITICAL: The example is shape-only. Do not copy its level, action, or wording. Return ONLY the JSON object above.`;
}

function tryParseCogPath(raw: string): Record<string, unknown> | null {
  let clean = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  clean = clean.replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(clean); } catch { return null; }
}

/**
 * Generates a Cognitive Path for a single MicroNode.
 * Returns skipped=true if theoryContent is too thin for grounded generation.
 * Does NOT write to the database — caller handles persistence.
 */
export async function generateCognitivePath(input: CogPathInput): Promise<CogPathGenerationResult> {
  const preflight = assessC2GenerationPreflight({
    nodeStatus: input.nodeStatus,
    learningObjective: input.learningObjective,
    theoryContent: input.theoryContent,
    blockType: input.blockType,
  });
  if (!preflight.eligible) {
    return {
      nodeId: input.nodeId,
      skipped: true,
      skipCode: preflight.reason ?? undefined,
      skipReason: "C1 MicroNode is not eligible for source-grounded Cognitive Path generation",
      levels: [],
    };
  }

  async function callModel(): Promise<string> {
    const r = await openrouter.chat.completions.create({
      model:       COGNITIVE_PATH_MODEL,
      max_tokens:  3000,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: COGNITIVE_PATH_SYSTEM },
        { role: "user",   content: buildCogPathPrompt(input) },
      ],
    });
    return r.choices[0]?.message?.content ?? "";
  }

  let parsed = tryParseCogPath(await callModel());
  if (!parsed) {
    logger.warn({ nodeId: input.nodeId }, "cog-path: parse failed, retrying once");
    parsed = tryParseCogPath(await callModel());
  }
  if (!parsed) {
    logger.warn({ nodeId: input.nodeId }, "cog-path: parse failed after retry");
    return { nodeId: input.nodeId, skipped: true, skipReason: "AI returned unparseable JSON after retry", levels: [] };
  }

  const validated = _cogPathResponseSchema.safeParse(parsed);
  if (!validated.success) {
    logger.warn({ nodeId: input.nodeId, error: validated.error }, "cog-path: Zod validation failed");
    return { nodeId: input.nodeId, skipped: true, skipReason: `AI output failed validation: ${validated.error.message}`, levels: [] };
  }

  const levels = validated.data.levels;

  // Enforce exactly-one ceiling (in case model produced 0 or >1)
  const ceilingCount = levels.filter((l) => l.isTargetCeiling).length;
  if (ceilingCount === 0) {
    // Make the last level the ceiling
    levels[levels.length - 1].isTargetCeiling = true;
  } else if (ceilingCount > 1) {
    // Keep only the highest-sequence ceiling
    const maxSeq = Math.max(...levels.filter((l) => l.isTargetCeiling).map((l) => l.sequence));
    for (const l of levels) {
      if (l.isTargetCeiling && l.sequence !== maxSeq) l.isTargetCeiling = false;
    }
  }
  const structuralReason = assessCognitivePathStructure(levels);
  if (structuralReason) {
    return {
      nodeId: input.nodeId,
      skipped: true,
      skipCode: "C2_PATH_STRUCTURE_REJECTED",
      skipReason: `generated Cognitive Path violates required structure: ${structuralReason}`,
      levels: [],
    };
  }
  if (!satisfiesLearningObjectiveCognitiveFloor(input.learningObjective, levels)) {
    return {
      nodeId: input.nodeId,
      skipped: true,
      skipCode: "C2_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION",
      skipReason: "generated Cognitive Path falls below the canonical Learning Objective cognitive floor",
      levels: [],
    };
  }
  if (!preservesC1TargetCeiling(input.targetBloomLevel, levels)) {
    const requiredC1Ceiling =
      input.targetBloomLevel && input.targetBloomLevel >= 1 && input.targetBloomLevel <= 6
        ? BLOOM_LEVEL_BY_INT[input.targetBloomLevel - 1]
        : "the recorded C1 ceiling";
      return {
        nodeId: input.nodeId,
        skipped: true,
        skipCode: "C2_CEILING_VIOLATION",
        skipReason: `generated Cognitive Path does not preserve C1 target ceiling ${requiredC1Ceiling}`,
        levels: [],
      };
  }
  const groundingAudit = validateCognitivePathGrounding(
    input.theoryContent,
    input.learningObjective,
    levels,
  );
  if (groundingAudit.status !== "GROUNDED") {
    return {
      nodeId: input.nodeId,
      skipped: true,
      skipCode: "C2_GROUNDING_REJECTED",
      skipReason: "generated Cognitive Path is not fully grounded in the MicroNode source",
      levels: [],
      groundingAudit,
    };
  }

  return {
    nodeId: input.nodeId,
    skipped: false,
    levels: levels as CogPathLevel[],
    groundingAudit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy Pass 2 material below — kept for future use; NOT called by the
// current mapping route (which now uses extractBlocksWithAI / extractBlocksWithVision).
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Դու կրթական բովանդակության վերլուծաբան ես (հիմնված P1 — Lesson Knowledge Package Generator սկզբունքների վրա)։ Քո խնդիրն է վերլուծել դասագրքի կոնկրետ դասի իրական տեքստը և կառուցել դասի քարտեզագրում։

ԱՇԽԱՏԱՆՔԻ ՀԱՋՈՐԴԱԿԱՆՈՒԹՅՈՒՆԸ.
(1) ՆՊԱՏԱԿ / ՎԵՐՋՆԱՐԴՅՈՒՆՔՆԵՐ — եթե ուսուցչի սևագիրը (տես label-երը ներքևում) տրված է, ճշգրտիր այն ըստ իրական դասագրքային տեքստի, ոչ թե հորինիր զրոյից. եթե բացակայում է, բխեցրու տեքստից։
(2) coreProblem — բացահայտիր այն էական հարցը/խնդիրը, որին այս դասը պատասխանում է (մեկ նախադասությամբ)։
(3) coreIdea — ձևակերպիր ՄԵԿ կենտրոնական գաղափար, որն ուղիղ պատասխանում է coreProblem-ին։
(3.5) essentialQuestion — մեկ հարց, որին ամբողջ դասը պատասխանում է, ուղղակիորեն ուղղված աշակերտին (ՈՉ սահմանման հարց՝ ինչպես «Ի՞նչ է X-ը»)։ Ոճը՝ «Ինչպե՞ս կարելի է...», «Ինչու՞...», «Ինչպե՞ս կարող ենք...»
(3.6) knowledgeBoundaries — 1-3 կարճ նշում, թե ինչ ԴԻՏԱՎՈՐՅԱԼ ՉԻ ընդգրկված այս դասում (հաջող դասերի կամ ավելի բարձր դասարանի նյութ), որ ուսուցումը չշեղվի սահմաններից դուրս։
(4) nodes — բաժանիր coreIdea-ն գիտելիքի node-երի, ինչպես նկարագրված է ներքևում. ամեն node պիտի ծառայի coreIdea-ին։ **IMPORTANT:** Identify EVERY distinct sub-topic boundary in the source pages (marked by a new section title/header in the textbook) and create ONE node per distinct sub-topic. Do NOT compress multiple distinct sub-topics into one node. Do NOT create one node per page.
(5) practicalTasks — Extract EVERY numbered exercise found in the page range into practicalTasks. Do NOT sample or select only a few. If the range has 18 exercises, produce 18 rows. Preference real verbatim textbook exercises over invented ones.
(5.5) textbook metadata — If the textbook pages contain the author name, textbook title, or chapter/section title, populate textbookAuthor, textbookTitle, and chapterTitle in the output. Never leave these null when the information is visible on the page.

Պատասխանիր ԲԱՑԱՌԱՊԵՍ վավեր JSON-ով, ոչինչ ավելին (ոչ մեկնաբանություն, ոչ markdown code fence), ուղիղ այս կառուցվածքով.

{
  "lessonGoal": "Դասի նպատակը, 1-2 նախադասություն.",
  "lessonOutcomes": ["Վerjalnardututyun 1", "Վerjalnardutyun 2", "..."],
  "textbookAuthor": "Author name extracted from page (null if not visible on the page)",
  "textbookTitle": "Textbook title extracted from page (null if not visible on the page)",
  "chapterTitle": "Chapter/section title (null if not visible on the page)",
  "coreProblem": "Այս դassi pataskharc'ac' esakan harce (mek naxadasatutyunov, hayeren)",
  "coreIdea": "Dasi kentronakan gagapare, hstakec'vac' jefakervov",
  "knowledgeBoundaries": ["Inch ditavoryaly durs e ays dasic' 1", "Inch ditavoryaly durs e ays dasic' 2"],
  "nodes": [
    {
      "title": "Ents'atemas'i karch' vernagirnor",
      "theoryContent": "Ays ents'atemas'i tesakan bovandakutyune",
      "verbatimTheoryAnchor": "BAR AR BAR dasagrk'i parberuts'yuné, vor'i vra himnatvac' e ays node-e (kam datarc' tol '' et'e chka mek hstaki hamapataskhan parberuts'yun)",
      "targetBloomLevel": 1,
      "estimatedMinutes": 5,
      "childFriendlyExplanation": "Inchpes AI usuc'ich'e piti bacatri ays node-e ashakertini parc' lezov (hayeren, 1-3 naxadasatutyun, ughi dimeloy)",
      "basicExamples": ["Karch' konkret orinak 1 (hayeren)", "Karch' konkret orinak 2 (hayeren)"],
      "realLifeExamples": ["Kyank'ic' orinak (hayeren, 0-2 hat)"],
      "commonMisconception": "Amenahavakanakan skhalv pataskhan kam shfot'e, vor ashakerte kunena (hayeren, 1 naxadasatutyun)",
      "nonExamples": ["Karch' hakadrutyun. sa CHHE ays hasc'ac'utyune, vorovhetev... (hayeren)"],
      "prerequisiteNodes": ["Karch' artsahaytutyun. pahanjvats' naxnayin giteliqk' 1", "Karch' artsahaytutyun. pahanjvats' naxnayin giteliqk' 2"]
    }
  ],
  "essentialQuestion": "Mek harc'ajev jefakervats' harc', vor'in amboghj dase pataskhanom e (hayeren, ughi dimeloy, VOCH' 'Inch' e X-e' ochov).",
  "nodeDependencies": [
    {
      "fromNodeTitle": "Naxapaymanor node-i chshgrit vernagirnor (piti hamzni verevy node-eric' meki het)",
      "toNodeTitle": "Kakhvats' node-i chshgrit vernagirnor (piti hamzni verevy node-eric' meki het)",
      "dependencyType": "REQUIRED",
      "requiredLevel": "CRITICAL",
      "reason": "Karch' patcharabanutyun (hayeren, 1 naxadasatutyun)"
    }
  ],
  "practicalTasks": [
    {
      "task": "Konkret varjutyun kam xndir dasagrk'ic' kam ogeshipnvats' dasagrk'ic' (hayeren)",
      "purpose": "Inchpes e ays varjutyunn amrapenum kentronakan gagapare (hayeren, 1 naxadasatutyun)",
      "exerciseTextVerbatim": "BAR AR BAR dasagrk'i tekst (patceniry ughi, voch' mi p'op'oxutyun tvin, nshani, kam banadzevi). Datarc' '' et'e sa AI-i horinavats' varjutyun e.",
      "exercisePurpose": "GUIDED_PRACTICE",
      "sourcePage": "10",
      "difficultyLevel": "MEDIUM",
      "successCriteria": "Chisht pataskhan@ kam inch e hashvvum chisht pataskhan (hayeren)",
      "relatedNodeTitle": "Ays varjutyunn amrapnoghe node-i chshgrit vernagirnor (piti hamzni verevy node-eric' meki het)",
      "assignment": "CLASS"
    }
  ]
}

ԿԱՆՈՆՆԵՐ.
- Ամen ints'n gri MIAYN iraakan hayerenv (hayatarj), voch' mi tarradarzutyun, voch' mi kirilitsa
- targetBloomLevel: 1-ic' 6 (1=Hishtarel, 2=Haskanal, 3=Kirarrel, 4=Verlucel, 5=Gnahatel, 6=Stegel)
- node-eri kanak'e t'ogh hamapataskhani iraakan teksti tsavalin (sovoravar 3-8 node)
- theoryContent-e piti himnatvats' lini trvats' iraakan teksti vra
- verbatimTheoryAnchor-i PAHANJK'. et'e node-i himk'um konkret, hstaki arrandznacvox dasagrk'ayin parberutyun/kanon ka, mejberir ayn ughi, bar ar bar (voch' mi p'op'oxutyun). et'e tekste tsrvats' e kam ughi mejberam hnravor chhe, t'ogh '' (datarc') — mi hornir keghc' mejberam
- practicalTasks: hanec'k' BOLOR hamarakaltsvats' varjutyunnere ayd ej'eric' — arantz' verin shemani (2-5 shemane CHEN GORTSUM). et'e dranc' 2 l, 10 kam 20, artec'k' BOLOR-e. naxapatvotyune iraakan dasagrk'ayin varjutyunnerin, voch' hornatvatsnerind
- exerciseTextVerbatim KANON (KHIST).
    * Et'e varjutyune dasagrk'ic' e → grir BAR AR BAR (mek tiv, mek bar, mek nishan mi p'op'oxes).
      exercisePurpose-e entrelu ays enum-ic'. CONCEPT_DISCOVERY, RULE_DISCOVERY, WORKED_EXAMPLE, GUIDED_PRACTICE, INDEPENDENT_PRACTICE, PROBLEM_SOLVING, REVIEW, ASSESSMENT
    * Et'e varjutyune AI-i stegagortsakann e (voch' dasagrk'ic') → exerciseTextVerbatim = "" (datarc' tekstadasht), exercisePurpose = "AI_ADAPTED"
    * sourcePage = chshgrit ej'i hamarn (1-10 nman), kam null et'e AI-inne
- exercisePurpose-i vaver artezhnerer. CONCEPT_DISCOVERY | RULE_DISCOVERY | WORKED_EXAMPLE | GUIDED_PRACTICE | INDEPENDENT_PRACTICE | PROBLEM_SOLVING | REVIEW | ASSESSMENT | AI_ADAPTED
- nodeDependencies KANON. MIAYN ays dasi node-eri mijew kakhvatsutjunner. REQUIRED=toNode-e anhaskanal e arantz' fromNode-i (requiredLevel=CRITICAL); SEQUENTIAL=bnakan herrakanutyun, bayts' voch' khist arghelafakox (SUPPORTING); CONCEPTUAL=kapvats', bayts' voch' hajordakan (SUPPORTING). Mi hornir kakhvatsutjun miayn node-eri c'ank'i karge artsarolelu hamar. Et'e node-ere ankax en mimc'ic', dir nodeDependencies=[]:
- knowledgeBoundaries-e piti irapes kapvats' lini ays dasi harakic' t'emaneri het (hajord das, aveli barts'r dasaran), voch' endhanur/anorosh nshum
- nonExamples-e piti hstaki hakadrvi node-i hasc'ac'utyune mi nman, bayts' tariber banei het (voch' parc'apes 'sa skhalv e' endhanur nshum)
- relatedNodeTitle-e piti chshgrit hamzni verevy node-eric' meki vernagreri het
- assignment. bolor tasks-ere arjahanoreluc' heto, gnahatel endhanur node-i jamanaake. class-um telavoroviognere nshir "CLASS", havelyalnere "HOMEWORK". Apahovetstser arnvazn 1-2 "CLASS" tasks. Chshgrit artezhn. "CLASS" kam "HOMEWORK"
- glukhi/bazhneri vernagirnor (GLUX 1, BAZHIN 2 ev nman) — mi entdni dranc' vorpes aghbyur
- NODE GRANULARITY (STRICT): Each distinct sub-topic with its own heading/title in the source text → ONE node. Never compress multiple distinct sub-topics into one node. Never create a node per page. The node count must reflect how many clearly delineated sub-topics exist in the textbook passage.
- EXHAUSTIVE EXERCISES (STRICT): Extract EVERY numbered exercise from the page range — do not sample or skip any. If there are 18 exercises, produce 18 practicalTask entries. exerciseTextVerbatim MUST NOT be blank when the textbook clearly shows exercise text.
- TEXTBOOK METADATA (STRICT): If the author name, textbook title, or chapter/section title appears anywhere in the page text or headers, populate textbookAuthor, textbookTitle, chapterTitle. Never output null for these when the information is present on the page.
- verbatimTheoryAnchor REINFORCE: If a node is grounded in a specific, clearly separable textbook paragraph or rule → quote it word-for-word (no changes). A blank verbatimTheoryAnchor is only acceptable when the textbook has no single clean matching passage.
- Node-ere, coreProblem-e, coreIdea-n ev practicalTasks-e piti bacarapesy hamapataskhhnen dasi sefiyin teksting u vernagrerd
`;


/**
 * Kahn's algorithm topological sort.
 * Only REQUIRED and SEQUENTIAL dependency types participate in the sort order;
 * CONCEPTUAL edges are informational only and do not affect sequence.
 * On cycle detection: logs a warning and falls back to the original order.
 */
export function topologicalSortNodes(
  nodeTitles: string[],
  dependencies: { fromNodeTitle: string; toNodeTitle: string; dependencyType: string }[]
): string[] {
  // Filter to ordering edges only
  const orderingDeps = dependencies.filter(
    (d) => d.dependencyType === "REQUIRED" || d.dependencyType === "SEQUENTIAL"
  );

  // Build adjacency and in-degree maps
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const t of nodeTitles) {
    inDegree.set(t, 0);
    adj.set(t, []);
  }
  for (const dep of orderingDeps) {
    const { fromNodeTitle: from, toNodeTitle: to } = dep;
    // Only include edges where both endpoints exist in this node set
    if (!inDegree.has(from) || !inDegree.has(to)) continue;
    adj.get(from)!.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  // Kahn's BFS
  const queue: string[] = [];
  for (const [title, deg] of inDegree) {
    if (deg === 0) queue.push(title);
  }
  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== nodeTitles.length) {
    // Cycle detected — warn and fall back to original order
    console.warn(
      "[lesson-mapping] topologicalSortNodes: cycle detected in node dependencies. " +
      "Falling back to original model order."
    );
    return [...nodeTitles];
  }

  return sorted;
}

export async function mapLessonWithAI(
  input: LessonMappingInput
): Promise<LessonMappingResult> {
  const userPromptParts: string[] = [

    `ԱՌARAKE: ${input.subjectName}`,
    `DASI VERNAGIRNOR: ${input.lessonTitle}`,
    input.chapterTitle ? `T'EMA/GLUX: ${input.chapterTitle}` : "",
    input.textbookTitle ? `DASAGRK': ${input.textbookTitle}` : "",
    input.textbookAuthor ? `HEGHINAK: ${input.textbookAuthor}` : "",
    input.pagesFrom && input.pagesTo
      ? `EJ'ER: ${input.pagesFrom}-${input.pagesTo}`
      : "",
    ``,
    `DASAGRK'I IRAAKAN TEKSTE AYS EJ'ERIC'.`,
    input.lessonText || "(tekst chi hajoghjvel ayd ej'eric')",

  ];
  if (input.teacherGoal) {
    // Normalize: replace literal newlines with spaces so they don't appear as
    // bare control characters when the AI echoes this text inside a JSON string.
    const goalNorm = input.teacherGoal.replace(/[\n\r]/g, " ").trim();
    userPromptParts.push("", `USUC'CHII SEvaGIR NPATAKE: ${goalNorm}`);
  }
  if (input.teacherOutcomes && input.teacherOutcomes.length > 0) {
    userPromptParts.push(`USUC'CHII SEvaGIR VERJALNARDUTYUNNER: ${input.teacherOutcomes.join("; ")}`);
  }
  const userPrompt = userPromptParts.filter(Boolean).join("\n");

  // ── Helper: attempt to extract valid JSON from raw model output ─────────
  function extractJSON(raw: string): LessonMappingResult | null {
    // 1. Strip markdown fences
    const stripped = raw.replace(/```json\s*|```/g, "").trim();
    // 2. Try direct parse
    try { return JSON.parse(stripped); } catch { /* fall through */ }
    // 3. Find the first {...} block — model sometimes wraps JSON in prose
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }

  // ── First attempt ────────────────────────────────────────────────────────
  const firstResponse = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 8000,
    temperature: 0.4,
    // Force JSON output at the model level (supported by DeepSeek v3 via OpenRouter)
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const firstRaw = firstResponse.choices[0]?.message?.content ?? "";
  let parsed: LessonMappingResult | null = extractJSON(firstRaw);

  // ── Retry once if first attempt did not return valid JSON ────────────────
  if (!parsed) {
    logger.warn({ raw: firstRaw.slice(0, 200) }, "lesson mapping: first attempt not valid JSON — retrying");
    const retryResponse = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 8000,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
        { role: "assistant", content: firstRaw },
        {
          role: "user",
          content:
            "Pataskhand vaver JSON che. Veradards'ru BACACAPYES vaver JSON objekt` arantz' voreve lratsuc'ich' teksti, bacatrut'yan kam markdown-i.",
        },
      ],
    });
    const retryRaw = retryResponse.choices[0]?.message?.content ?? "";
    parsed = extractJSON(retryRaw);
    if (!parsed) {
      logger.error({ raw: retryRaw.slice(0, 300) }, "lesson mapping: failed to parse AI JSON response after retry");
      throw new Error("AI mapping response was not valid JSON");
    }
  }

  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error("AI mapping response contained no nodes");
  }

  // Defensive defaults for node fields
  parsed.nodes = parsed.nodes.map((n) => ({
    ...n,
    verbatimTheoryAnchor: typeof n.verbatimTheoryAnchor === "string" ? n.verbatimTheoryAnchor : "",
    childFriendlyExplanation: n.childFriendlyExplanation ?? "",
    basicExamples: Array.isArray(n.basicExamples) ? n.basicExamples : [],
    realLifeExamples: Array.isArray(n.realLifeExamples) ? n.realLifeExamples : [],
    commonMisconception: n.commonMisconception ?? "",
    nonExamples: Array.isArray(n.nonExamples) ? n.nonExamples : [],
    prerequisiteNodes: Array.isArray(n.prerequisiteNodes) ? n.prerequisiteNodes : [],
  }));

  parsed.knowledgeBoundaries = Array.isArray(parsed.knowledgeBoundaries) ? parsed.knowledgeBoundaries : [];

  // Defensive defaults for extracted textbook metadata fields
  parsed.textbookAuthor = typeof parsed.textbookAuthor === "string" && parsed.textbookAuthor.trim()
    ? parsed.textbookAuthor.trim() : null;
  parsed.textbookTitle = typeof parsed.textbookTitle === "string" && parsed.textbookTitle.trim()
    ? parsed.textbookTitle.trim() : null;
  parsed.chapterTitle = typeof parsed.chapterTitle === "string" && parsed.chapterTitle.trim()
    ? parsed.chapterTitle.trim() : null;

  if (!Array.isArray(parsed.practicalTasks)) {
    parsed.practicalTasks = [];
  }

  parsed.essentialQuestion = typeof parsed.essentialQuestion === "string" ? parsed.essentialQuestion : "";
  if (!Array.isArray(parsed.nodeDependencies)) {
    parsed.nodeDependencies = [];
  }
  parsed.nodeDependencies = parsed.nodeDependencies.filter(
    (d: { fromNodeTitle: string; toNodeTitle: string; dependencyType: string; requiredLevel: string; reason: string }) =>
      d.fromNodeTitle && d.toNodeTitle &&
      ["REQUIRED", "SEQUENTIAL", "CONCEPTUAL"].includes(d.dependencyType) &&
      ["CRITICAL", "SUPPORTING"].includes(d.requiredLevel)
  );

  // Defensive defaults for practicalTask fields (including new P1 STEP 17 fields)
  parsed.practicalTasks = parsed.practicalTasks.map((t, i) => ({
    ...t,
    task: t.task ?? "",
    purpose: t.purpose ?? "",
    exerciseTextVerbatim: typeof t.exerciseTextVerbatim === "string" ? t.exerciseTextVerbatim : "",
    exercisePurpose: typeof t.exercisePurpose === "string" ? t.exercisePurpose : "AI_ADAPTED",
    sourcePage: t.sourcePage ?? null,
    difficultyLevel: (["LOW", "MEDIUM", "HIGH"].includes(t.difficultyLevel)
      ? t.difficultyLevel
      : "MEDIUM") as "LOW" | "MEDIUM" | "HIGH",
    successCriteria: t.successCriteria ?? "",
    relatedNodeTitle: t.relatedNodeTitle ?? "",
    assignment: (["CLASS", "HOMEWORK"].includes(t.assignment)
      ? t.assignment
      : "CLASS") as "CLASS" | "HOMEWORK",
    _idx: i,
  }));

  return parsed;
}
// ─── Garbled text detection ────────────────────────────────────────────────

/**
 * Returns true when extracted PDF text has a suspiciously low proportion of
 * Armenian Unicode chars — which signals a font-encoding mismatch (ArmSCII /
 * custom-font PDFs where pdf-parse returns garbled Latin codepoints).
 *
 * Threshold: Armenian chars make up < 15 % of all alphabetic chars.
 * Empty / very short text is NOT flagged (handled upstream as missing text).
 */
export function isGarbledText(text: string): boolean {
  if (!text || text.trim().length < 30) return false;
  const alphaChars    = (text.match(/[a-zA-Z\u0531-\u058F\u0559-\u055F]/g) ?? []).length;
  if (alphaChars === 0) return false;
  const armenianChars = (text.match(/[\u0531-\u058F\u0559-\u055F]/g) ?? []).length;
  return armenianChars / alphaChars < 0.15;
}

// ─── PDF rasterisation (vision fallback path) ──────────────────────────────

import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";

const _execFileAsync = promisify(execFile);

/**
 * Rasterises a page range of a PDF using pdftoppm and returns each page as a
 * base64-encoded PNG string.
 * pdftoppm accepts the same 1-based physical page numbers as the teacher UI;
 * no conversion is applied here.
 * 150 DPI provides sufficient resolution for a vision model without excessive
 * image token cost.
 */
export async function rasterizePdfPages(
  filePath: string,
  pagesFrom: number,
  pagesTo:   number,
  dpi = 150
): Promise<string[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-raster-"));
  try {
    await _execFileAsync("pdftoppm", [
      "-r", String(dpi),
      "-png",
      "-f", String(pagesFrom),
      "-l", String(pagesTo),
      filePath,
      path.join(tmpDir, "page"),
    ]);
    // pdftoppm names output files page-00001.png, page-00002.png, …
    // Lexicographic sort == page order.
    const files = fs.readdirSync(tmpDir)
      .filter((f) => f.endsWith(".png"))
      .sort();
    return files.map((f) =>
      fs.readFileSync(path.join(tmpDir, f)).toString("base64")
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Legacy vision mapping (Pass 2 candidate) ─────────────────────────────────

const VISION_MODEL = "google/gemini-2.5-flash";
/** Pages sent per vision API call.
 *  Sending all pages at once causes model hallucination on later pages
 *  (confirmed: independent runs produced degenerate/repeated content).
 *  3 pages keeps the model grounded on real visible content. */
const VISION_CHUNK_PAGES = 3;

/**
 * Identical structured output as mapLessonWithAI, but reads lesson content
 * from rasterised page images rather than extracted text.
 * NOTE: This function is preserved for future Pass 2 use. The current mapping
 * route uses extractBlocksWithVision (Pass 1) instead.
 */
export async function mapLessonWithVision(
  input: Omit<LessonMappingInput, "lessonText">,
  pageImages: string[]   // base64-encoded PNG, one element per page
): Promise<LessonMappingResult> {

  type TextPart  = { type: "text";      text: string };
  type ImagePart = { type: "image_url"; image_url: { url: string } };
  type ContentPart = TextPart | ImagePart;

  // ── Helper: strip markdown fences and parse JSON ─────────────────────────
  function extractJSON(raw: string): LessonMappingResult | null {
    const stripped = raw.replace(/```json\s*|```/g, "").trim();
    try { return JSON.parse(stripped); } catch { /* fall through */ }
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    return null;
  }

  // ── Split page images into chunks of VISION_CHUNK_PAGES ──────────────────
  const totalFrom = input.pagesFrom ?? 1;
  const totalTo   = input.pagesTo   ?? pageImages.length;
  const chunks: string[][] = [];
  for (let i = 0; i < pageImages.length; i += VISION_CHUNK_PAGES) {
    chunks.push(pageImages.slice(i, i + VISION_CHUNK_PAGES));
  }

  // ── Build multimodal content array for one chunk ─────────────────────────
  function buildChunkContent(
    chunkImages: string[],
    chunkFrom: number,
    chunkTo:   number,
    chunkIdx:  number,
  ): ContentPart[] {
    const headerText = [
      `ARRAAKE: ${input.subjectName}`,
      `DASI VERNAGIRNOR: ${input.lessonTitle}`,
      input.chapterTitle   ? `T'EMA/GLUX: ${input.chapterTitle}`   : "",
      input.textbookTitle  ? `DASAGRK': ${input.textbookTitle}`     : "",
      input.textbookAuthor ? `HEGHINAK: ${input.textbookAuthor}`     : "",
      `EJ'ER: ${chunkFrom}-${chunkTo} [batch ${chunkIdx + 1}/${chunks.length}, total ${totalFrom}-${totalTo}]`,
      "",
      `Kc'vats' en ${chunkImages.length} patker (ej' ${chunkFrom}–${chunkTo}). Karda AMEN inch' — amen tekst, vernagirnor, heghinak, varjutyun, aghjusak — u katarel kartezagrm ysts hrahangner.`,
      input.teacherGoal
      ? `USUC'CHII SEVAGIR NPATAKE: ${input.teacherGoal.replace(/[\n\r]/g, " ").trim()}` : "",
      input.teacherOutcomes && input.teacherOutcomes.length > 0
      ? `USUC'CHII SEVAGIR VERJALNARDUTYUNNER: ${input.teacherOutcomes.join("; ")}` : "",
    ].filter(Boolean).join("\n");

    return [
      { type: "text" as const, text: headerText },
      ...chunkImages.map((b64): ImagePart => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${b64}` },
      })),
    ];
  }

  // ── Process each chunk sequentially ──────────────────────────────────────
  const RETRY_MSG = "Pataskhand vaver JSON che. Veradards'ru BACACAPYES vaver JSON objekt` arantz' voreve lratsuc'ich' teksti, bacatrut'yan kam markdown-i.";

  const chunkResults: LessonMappingResult[] = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkImages = chunks[ci];
    const chunkFrom   = totalFrom + ci * VISION_CHUNK_PAGES;
    const chunkTo     = Math.min(chunkFrom + VISION_CHUNK_PAGES - 1, totalTo);
    const chunkLabel  = `chunk ${ci + 1}/${chunks.length} (pages ${chunkFrom}-${chunkTo})`;

    logger.info(
      { chunk: ci + 1, totalChunks: chunks.length, pagesFrom: chunkFrom, pagesTo: chunkTo },
      "vision mapping: processing chunk"
    );

    const content = buildChunkContent(chunkImages, chunkFrom, chunkTo, ci);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r1 = await openrouter.chat.completions.create({
      model: VISION_MODEL,
      max_tokens: 32000,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content } as any,
      ],
    });
    const raw1 = r1.choices[0]?.message?.content ?? "";
    let parsed = extractJSON(raw1);

    if (!parsed) {
      logger.warn(
        { chunkLabel, raw: raw1.slice(0, 200) },
        "vision mapping: chunk not valid JSON — retrying"
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r2 = await openrouter.chat.completions.create({
        model: VISION_MODEL,
        max_tokens: 32000,
        temperature: 0.1,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content } as any,
          { role: "assistant", content: raw1 },
          { role: "user", content: RETRY_MSG },
        ],
      });
      const raw2 = r2.choices[0]?.message?.content ?? "";
      parsed = extractJSON(raw2);
      if (!parsed) {
        logger.error(
          { chunkLabel, raw: raw2.slice(0, 300) },
          "vision mapping: failed to parse chunk JSON after retry"
        );
        throw new Error(`Vision mapping ${chunkLabel}: response was not valid JSON`);
      }
    }

    logger.info(
      { chunkLabel, nodeCount: parsed.nodes?.length ?? 0, taskCount: parsed.practicalTasks?.length ?? 0 },
      "vision mapping: chunk extracted"
    );
    chunkResults.push(parsed);
  }

  // ── Merge chunk results ───────────────────────────────────────────────────
  const merged: LessonMappingResult = { ...chunkResults[0] };

  // Textbook metadata: first non-null wins across chunks
  for (const chunk of chunkResults.slice(1)) {
    if (!merged.textbookAuthor && chunk.textbookAuthor) merged.textbookAuthor = chunk.textbookAuthor;
    if (!merged.textbookTitle  && chunk.textbookTitle)  merged.textbookTitle  = chunk.textbookTitle;
    if (!merged.chapterTitle   && chunk.chapterTitle)   merged.chapterTitle   = chunk.chapterTitle;
  }

  // Nodes: union, deduplicate by normalised title (keep first occurrence)
  const nodeMap = new Map<string, (typeof merged.nodes)[0]>();
  for (const chunk of chunkResults) {
    for (const node of (chunk.nodes ?? [])) {
      const key = node.title.trim().toLowerCase();
      if (!nodeMap.has(key)) nodeMap.set(key, node);
    }
  }
  merged.nodes = [...nodeMap.values()];

  // practicalTasks: union, deduplicate by verbatim text (safety check)
  const seenVerbatim = new Set<string>();
  const dedupedTasks: typeof merged.practicalTasks = [];
  const duplicateTexts: string[] = [];

  for (const chunk of chunkResults) {
    for (const task of (chunk.practicalTasks ?? [])) {
      const verbatim = (task.exerciseTextVerbatim ?? "").trim();
      if (verbatim && seenVerbatim.has(verbatim)) {
        duplicateTexts.push(verbatim.slice(0, 100));
        continue;
      }
      if (verbatim) seenVerbatim.add(verbatim);
      dedupedTasks.push(task);
    }
  }

  if (duplicateTexts.length > 0) {
    logger.warn(
      { duplicateCount: duplicateTexts.length, examples: duplicateTexts.slice(0, 3) },
      "vision mapping: duplicate exerciseTextVerbatim detected — degenerate generation excluded"
    );
  }
  merged.practicalTasks = dedupedTasks;

  logger.info(
    {
      chunkCount:         chunks.length,
      nodeCount:          merged.nodes.length,
      taskCount:          merged.practicalTasks.length,
      duplicatesExcluded: duplicateTexts.length,
    },
    "vision mapping: merge complete"
  );

  // ── Validate ─────────────────────────────────────────────────────────────
  if (!Array.isArray(merged.nodes) || merged.nodes.length === 0) {
    throw new Error("Vision AI mapping produced no nodes after chunk merge");
  }

  // ── Defensive defaults (identical to mapLessonWithAI) ────────────────────
  merged.nodes = merged.nodes.map((n) => ({
    ...n,
    verbatimTheoryAnchor:     typeof n.verbatimTheoryAnchor === "string" ? n.verbatimTheoryAnchor : "",
    childFriendlyExplanation: n.childFriendlyExplanation ?? "",
    basicExamples:            Array.isArray(n.basicExamples)    ? n.basicExamples    : [],
    realLifeExamples:         Array.isArray(n.realLifeExamples) ? n.realLifeExamples : [],
    commonMisconception:      n.commonMisconception ?? "",
    nonExamples:              Array.isArray(n.nonExamples)       ? n.nonExamples       : [],
    prerequisiteNodes:        Array.isArray(n.prerequisiteNodes) ? n.prerequisiteNodes : [],
  }));

  merged.knowledgeBoundaries = Array.isArray(merged.knowledgeBoundaries) ? merged.knowledgeBoundaries : [];

  merged.textbookAuthor = typeof merged.textbookAuthor === "string" && merged.textbookAuthor.trim()
    ? merged.textbookAuthor.trim() : null;
  merged.textbookTitle  = typeof merged.textbookTitle  === "string" && merged.textbookTitle.trim()
    ? merged.textbookTitle.trim()  : null;
  merged.chapterTitle   = typeof merged.chapterTitle   === "string" && merged.chapterTitle.trim()
    ? merged.chapterTitle.trim()   : null;

  if (!Array.isArray(merged.practicalTasks)) merged.practicalTasks = [];
  merged.essentialQuestion = typeof merged.essentialQuestion === "string" ? merged.essentialQuestion : "";
  if (!Array.isArray(merged.nodeDependencies)) merged.nodeDependencies = [];

  merged.nodeDependencies = merged.nodeDependencies.filter(
    (d: { fromNodeTitle: string; toNodeTitle: string; dependencyType: string; requiredLevel: string; reason: string }) =>
      d.fromNodeTitle && d.toNodeTitle &&
      ["REQUIRED", "SEQUENTIAL", "CONCEPTUAL"].includes(d.dependencyType) &&
      ["CRITICAL", "SUPPORTING"].includes(d.requiredLevel)
  );

  merged.practicalTasks = merged.practicalTasks.map((t) => ({
    ...t,
    task:                 t.task ?? "",
    purpose:              t.purpose ?? "",
    exerciseTextVerbatim: typeof t.exerciseTextVerbatim === "string" ? t.exerciseTextVerbatim : "",
    exercisePurpose:      typeof t.exercisePurpose === "string"      ? t.exercisePurpose      : "AI_ADAPTED",
    sourcePage:           t.sourcePage ?? null,
    difficultyLevel:      (["LOW", "MEDIUM", "HIGH"].includes(t.difficultyLevel)
      ? t.difficultyLevel : "MEDIUM") as "LOW" | "MEDIUM" | "HIGH",
    successCriteria:      t.successCriteria ?? "",
    relatedNodeTitle:     t.relatedNodeTitle ?? "",
    assignment:           (["CLASS", "HOMEWORK"].includes(t.assignment)
      ? t.assignment : "CLASS") as "CLASS" | "HOMEWORK",
  }));

  return merged;
}
