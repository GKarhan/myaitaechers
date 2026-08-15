import fs from "fs";
import path from "path";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const { PDFParse } = _require("pdf-parse") as {
  PDFParse: new (opts: { data: Buffer }) => {
    getText(opts?: { partial?: number[] }): Promise<{ text: string }>;
    destroy(): Promise<void>;
  };
};
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { logger } from "../lib/logger";
import { validateSourceCoverage, type CoverageValidationResult } from "../lib/coverage-validator.js";
import { detectCompoundLO, detectDuplicateLOs } from "../lib/granularity-heuristics.js";
import { ACTIVITY_BLOCK_TYPES } from "../lib/activity-validator.js";

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

  return { evictedFromSource, postEvictionStripped, dedupedExercises, dedupedAdditional, stepBRescued, stepCRescued };
}

const MODEL = "deepseek/deepseek-chat-v3-0324";

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
  const dataBuffer = fs.readFileSync(filePath);
  const pageNumbers: number[] = [];
  for (let p = pagesFrom; p <= pagesTo; p++) pageNumbers.push(p);

  const parser = new PDFParse({ data: dataBuffer });
  try {
    const result = await parser.getText({ partial: pageNumbers });
    return result.text.trim();
  } finally {
    await parser.destroy();
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

function normalisePass1(raw: unknown): Pass1Result {
  const obj = raw as { blocks?: unknown[] };
  const blocks: Pass1Block[] = (Array.isArray(obj?.blocks) ? obj.blocks : [])
    .map((b) => {
      const block = b as Record<string, unknown>;
      const bt = String(block.blockType ?? "");
      return {
        blockType: VALID_BLOCK_TYPES.has(bt)
          ? (bt as Pass1Block["blockType"])
          : "NOTE",
        sourceText: typeof block.sourceText === "string"
          ? block.sourceText.trim() : "",
        sourcePage: typeof block.sourcePage === "number" && block.sourcePage > 0
          ? Math.round(block.sourcePage) : 0,
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

  return { blocks };
}

// ── Pass 1 text path ──────────────────────────────────────────────────────────

export async function extractBlocksWithAI(
  input: LessonMappingInput
): Promise<Pass1Result> {
  const userPrompt = [
    `SUBJECT: ${input.subjectName}`,
    `LESSON TITLE: ${input.lessonTitle}`,
    input.chapterTitle   ? `CHAPTER: ${input.chapterTitle}`     : "",
    input.textbookTitle  ? `TEXTBOOK: ${input.textbookTitle}`   : "",
    input.textbookAuthor ? `AUTHOR: ${input.textbookAuthor}`    : "",
    input.pagesFrom && input.pagesTo
      ? `PAGES: ${input.pagesFrom}–${input.pagesTo}` : "",
    "",
    "TEXTBOOK TEXT FROM THESE PAGES:",
    input.lessonText || "(no text extracted from PDF)",
  ].filter(Boolean).join("\n");

  function extractJSON(raw: string): Pass1Result | null {
    const stripped = raw.replace(/```json\s*|```/g, "").trim();
    try { return JSON.parse(stripped); } catch { /* fall through */ }
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    return null;
  }

  const r1 = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 8000,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PASS1_SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
  });
  const raw1 = r1.choices[0]?.message?.content ?? "";
  let parsed = extractJSON(raw1);

  if (!parsed) {
    logger.warn({ raw: raw1.slice(0, 200) }, "pass1 text: first attempt not valid JSON — retrying");
    const r2 = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 8000,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PASS1_SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
        { role: "assistant", content: raw1 },
        { role: "user",   content: 'Your response was not valid JSON. Return ONLY a valid JSON object with a "blocks" array, nothing else.' },
      ],
    });
    const raw2 = r2.choices[0]?.message?.content ?? "";
    parsed = extractJSON(raw2);
    if (!parsed) throw new Error("Pass 1 text extraction: response not valid JSON after retry");
  }

  const result = normalisePass1(parsed);
  logger.info({ blockCount: result.blocks.length }, "pass1 text: extraction complete");
  return result;
}

// ── Pass 1 vision path ────────────────────────────────────────────────────────

/** Pass 1 uses smaller page chunks than legacy vision mapping.
 *  Armenian language textbook pages have many verbatim exercises, so even
 *  16 000 tokens weren't enough for 3 pages.  2 pages keeps output comfortably
 *  below the 32 000-token ceiling. */
const PASS1_CHUNK_PAGES = 2;
const PASS1_MAX_TOKENS  = 32000;

export async function extractBlocksWithVision(
  input: Omit<LessonMappingInput, "lessonText">,
  pageImages: string[]   // base64-encoded PNG, one element per page
): Promise<Pass1Result> {
  type TextPart  = { type: "text"; text: string };
  type ImagePart = { type: "image_url"; image_url: { url: string } };
  type ContentPart = TextPart | ImagePart;

  /** Strip markdown fences, try direct parse, then bracket-search.
   *  When `truncated=true` (model hit max_tokens), also attempts to recover
   *  any complete block objects before the cut-off point. */
  function extractJSON(raw: string, truncated = false): Pass1Result | null {
    const stripped = raw.replace(/```json\s*|```\s*/g, "").trim();

    // 1. Direct parse
    try { return JSON.parse(stripped); } catch { /* fall through */ }

    // 2. First {...} block (handles leading prose)
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }

    // 3. Truncation recovery: scan for individually complete block objects
    if (truncated) {
      const blocksIdx = stripped.indexOf('"blocks"');
      if (blocksIdx >= 0) {
        const arrStart = stripped.indexOf('[', blocksIdx);
        if (arrStart >= 0) {
          const blocks: unknown[] = [];
          let depth = 0;
          let blockStart = -1;
          for (let i = arrStart; i < stripped.length; i++) {
            if (stripped[i] === '{') {
              if (depth === 0) blockStart = i;
              depth++;
            } else if (stripped[i] === '}') {
              depth--;
              if (depth === 0 && blockStart >= 0) {
                try { blocks.push(JSON.parse(stripped.slice(blockStart, i + 1))); } catch { /* skip */ }
                blockStart = -1;
              }
            }
          }
          if (blocks.length > 0) {
            logger.warn({ recoveredBlocks: blocks.length, chunkTruncated: true },
              "pass1 vision: recovered partial blocks from truncated response");
            return { blocks } as Pass1Result;
          }
        }
      }
    }

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
          const subParsed = extractJSON(rawSub, subTruncated);
          if (subParsed) {
            const subNorm = normalisePass1(subParsed);
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
        parsed = extractJSON(raw1, false);

        if (!parsed) {
          // Not truncated but invalid JSON — retry once with correction prompt
          logger.warn({ chunkLabel, raw: raw1.slice(0, 200) }, "pass1 vision: chunk not valid JSON — retrying");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r2 = await openrouter.chat.completions.create({
            model: VISION_MODEL,
            max_tokens: PASS1_MAX_TOKENS,
            temperature: 0,
            messages: [
              { role: "system", content: PASS1_SYSTEM_PROMPT },
              { role: "user",   content } as any,
              { role: "assistant", content: raw1 },
              { role: "user",   content: 'Output ONLY a raw JSON object with a "blocks" array — no markdown fences, no ```json, no text before or after the JSON.' },
            ],
          });
          const raw2          = r2.choices[0]?.message?.content ?? "";
          const wasTruncated2 = r2.choices[0]?.finish_reason === "length";
          if (wasTruncated2) {
            logger.warn({ chunkLabel }, "pass1 vision: retry also hit max_tokens — attempting partial recovery");
          }
          parsed = extractJSON(raw2, wasTruncated2);

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

      const chunkBlocks = normalisePass1(parsed).blocks;
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
  microNodes: Pass2MicroNode[];
  unmappedBlockIndices: number[];
  /** Exercises that practice a skill for which no instructional source block exists in
   *  this topic, and no existing MicroNode's LO genuinely covers that skill.
   *  Persisted in lesson_exercises with relatedNodeId = null.
   *  Never creates a source-less MicroNode. Never placed in unmappedBlocks. */
  additionalExercises: Pass2Exercise[];
}

// ── Phase 4: Granularity review types ────────────────────────────────────────

/**
 * A single finding from the Pass 2B semantic granularity review.
 * These are advisory — they never block the mapping or change any node.
 */
export interface GranularityFinding {
  topicTitle: string;
  microNodeTitle: string;
  issue: "MEGA_NODE" | "OVER_SPLIT" | "EXERCISE_MISMATCH";
  confidence: "HIGH" | "MEDIUM";
  /** Armenian-language explanation for the teacher. */
  reason: string;
  /** Optional concrete recommendation (e.g. "Split into 2: … / …" or "Merge with: …"). */
  suggestedAction?: string;
}

export interface Pass2Result {
  topics: Pass2TopicResult[];
  /** Block indices that were not placed in any MicroNode (page headers, etc.). */
  unmappedBlockIndices: number[];
  /** Deterministic source-coverage validation result. Independent of AI self-report. */
  coverageValidation: CoverageValidationResult;
  /**
   * Phase 4 — semantic granularity findings from Pass 2B.
   * Advisory only: do NOT gate the mapping status on these.
   * Empty when review AI call fails or finds no issues.
   */
  granularityFindings: GranularityFinding[];
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
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIELD DEFINITIONS:
• sourceBlockIndices  — block indices this MicroNode "owns": every DEFINITION, RULE, NOTE,
                        EXAMPLE, or OBJECTIVE block that contains an actual instructional
                        sentence or learning content.
                        MUST be non-empty. If you cannot find a non-activity source block,
                        merge with an adjacent MicroNode instead.

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
  topicSeq: number
): Promise<{ microNodes: Pass2MicroNode[]; unmappedIndices: number[]; additionalExercises: Pass2Exercise[] }> {
  const blockLines = topicIndices.map((i) => fmtPass2Block(i, blocks[i])).join("\n");

  const userPrompt = `Topic ${topicSeq}: «${topicTitle}»
Block indices to account for: [${topicIndices.join(", ")}]
(Every index above must appear in your output.)

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
  }

  logger.info({ topicTitle, topicSeq, finish }, "pass2 step2: MicroNode org complete");

  const parsed = parsePass2JSON(raw) as {
    microNodes: {
      title: string;
      learningObjective: string;
      microNodeType: string;
      sourceBlockIndices: number[];
      exercises: { blockIndex: number; sourceParagraph?: string | null }[];
      supportingMaterialIndices: number[];
    }[];
    unmappedBlocks: { blockIndex: number; reason: string }[];
    additionalExercises?: { blockIndex: number; reason?: string }[];
  };

  const rawMicroNodes: Pass2MicroNode[] = (parsed.microNodes ?? []).map((mn) => ({
    title:                   mn.title ?? "",
    learningObjective:       mn.learningObjective ?? "",
    microNodeType:           mn.microNodeType === "skill" ? "skill" : "knowledge",
    sourceBlockIndices:      Array.isArray(mn.sourceBlockIndices) ? mn.sourceBlockIndices : [],
    exercises:               (mn.exercises ?? []).map((e) => ({
      blockIndex:     e.blockIndex,
      sourceParagraph: e.sourceParagraph ?? null,
    })),
    supportingMaterialIndices: Array.isArray(mn.supportingMaterialIndices)
      ? mn.supportingMaterialIndices : [],
  }));

  // Collect additional exercises from model output first
  const additionalExercises: Pass2Exercise[] = (parsed.additionalExercises ?? []).map((e) => ({
    blockIndex:      e.blockIndex,
    sourceParagraph: null,
  }));

  // Server-side safety net: strip any MicroNode that violates a structural invariant.
  // Invariants (all three must hold):
  //   1. sourceBlockIndices is non-empty  (ABSOLUTE RULE 2)
  //   2. title is non-empty / non-whitespace
  //   3. learningObjective is non-empty / non-whitespace
  // Stripped MicroNode exercises are rescued into additionalExercises so no
  // textbook content is lost. Coverage logic is unaffected.
  const microNodes: Pass2MicroNode[] = [];
  for (const mn of rawMicroNodes) {
    const emptySourceBlocks  = mn.sourceBlockIndices.length === 0;
    const emptyTitle         = !mn.title.trim();
    const emptyLO            = !mn.learningObjective.trim();

    if (emptySourceBlocks || emptyTitle || emptyLO) {
      const violated = [
        emptySourceBlocks  && "sourceBlockIndices",
        emptyTitle         && "title",
        emptyLO            && "learningObjective",
      ].filter(Boolean);
      logger.warn(
        { title: mn.title, exerciseCount: mn.exercises.length, violated },
        "pass2 step2: safety-net — invalid MicroNode stripped; exercises moved to additionalExercises"
      );
      additionalExercises.push(...mn.exercises);
    } else {
      microNodes.push(mn);
    }
  }

  const unmappedIndices = (parsed.unmappedBlocks ?? []).map((u) => u.blockIndex);
  return { microNodes, unmappedIndices, additionalExercises };
}

// ── Pass 2B: Semantic granularity review ──────────────────────────────────────
//
// A single AI call over ALL MicroNodes from ALL topics simultaneously.
// Cross-topic review is required so OVER_SPLIT candidates that span different
// topic calls are still detectable.
//
// RULES:
//   • Never modifies topics[], nodes, sourceBlockIndices, or coverageValidation.
//   • Returns [] on any failure — mapping must never be blocked by this step.
//   • Runs AFTER Step 2 and BEFORE coverageValidation (purely additive).

const PASS2B_REVIEW_SYSTEM = `You are a curriculum quality reviewer. You receive a compact
representation of all MicroNodes produced by a lesson mapping pipeline, along with
deterministic heuristic signals flagged before this call.

Your ONLY job is to detect three types of granularity problems and report them as
structured JSON findings. You do NOT change any node, split anything, or merge anything.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. MEGA_NODE — a single MicroNode contains two or more INDEPENDENTLY ASSESSABLE objectives.

Flag ONLY when: a student could correctly answer a test question for skill A while
failing a test question for skill B, and both skills are contained in one MicroNode.

EXAMPLE — flag this:
  LO: "Student can define a verb and identify verbs in text."
  Reason: Defining (recall) and identifying in context (application) are separately testable.
  → MEGA_NODE

DO NOT flag this:
  LO: "Student can decompose a multi-digit number by grouping digits from right to left."
  Reason: "grouping from right to left" is the METHOD of one procedure — not a separate skill.
  → NOT a MEGA_NODE

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
3. EXERCISE_MISMATCH — an exercise obviously requires a skill far outside the MicroNode's LO.

Flag ONLY when: the exercise's required primary skill is clearly not covered by or
prerequisite to the MicroNode's learning objective.

EXAMPLE — flag this:
  MicroNode LO: "Student can solve problems using addition and subtraction."
  Exercise requires: Calculate a unit price using division, then multiply by quantity.
  → EXERCISE_MISMATCH

DO NOT flag exercises that test the exact skill, a sub-skill, or a direct prerequisite.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HEURISTIC SIGNALS PROVIDED:
The input includes pre-computed heuristic flags:
  • compoundLO: true  — regex detected a possible compound connector between two verb phrases
  • duplicateCandidates: [{titleA, titleB, similarity}] — token-overlap detected possible duplicates

These signals are SUGGESTIONS. You must apply semantic judgment — do NOT automatically
report MEGA_NODE just because compoundLO is true, or OVER_SPLIT just because similarity > 0.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT: respond with ONLY valid JSON — no markdown fences, no commentary.
{
  "findings": [
    {
      "topicTitle": "exact topic title from input",
      "microNodeTitle": "exact MicroNode title from input",
      "issue": "MEGA_NODE",
      "confidence": "HIGH",
      "reason": "Armenian-language explanation for the teacher",
      "suggestedAction": "Split into 2: [Title A] / [Title B]"
    }
  ]
}

findings may be an empty array [] if no issues found.
Allowed issue values: "MEGA_NODE", "OVER_SPLIT", "EXERCISE_MISMATCH" only.
Allowed confidence values: "HIGH", "MEDIUM" only.
reason MUST be in Armenian.
suggestedAction is optional.`;

/** Compact per-MicroNode representation sent to Pass 2B. */
interface GranularityReviewMicroNode {
  title: string;
  learningObjective: string;
  sourceBlockTypes: string[];
  exerciseCount: number;
  /** From detectCompoundLO heuristic. */
  compoundLO: boolean;
  compoundConnector?: string;
}

interface GranularityReviewTopic {
  title: string;
  microNodes: GranularityReviewMicroNode[];
  /** Pairs flagged by detectDuplicateLOs within this topic. */
  duplicateCandidates: Array<{ titleA: string; titleB: string; similarity: number }>;
}

/**
 * Pass 2B — semantic granularity review.
 *
 * Runs a single AI call over all MicroNodes from all topics after Step 2.
 * Returns an array of advisory findings (never blocks the mapping).
 * Returns [] on any error.
 */
async function runGranularityReview(
  topics: Pass2TopicResult[],
  blocks: Pass1Block[],
): Promise<GranularityFinding[]> {
  // Build compact topic representation with heuristic signals
  const reviewTopics: GranularityReviewTopic[] = topics.map((topic) => {
    const mnRepresentations: GranularityReviewMicroNode[] = topic.microNodes.map((mn) => {
      const compound = detectCompoundLO(mn.learningObjective);
      const sourceBlockTypes = mn.sourceBlockIndices
        .map((i) => blocks[i]?.blockType ?? "UNKNOWN")
        .filter(Boolean);
      return {
        title:              mn.title,
        learningObjective:  mn.learningObjective,
        sourceBlockTypes,
        exerciseCount:      mn.exercises.length,
        compoundLO:         compound !== null,
        ...(compound ? { compoundConnector: compound.connector } : {}),
      };
    });

    const duplicateCandidates = detectDuplicateLOs(
      topic.microNodes.map((mn) => ({ title: mn.title, learningObjective: mn.learningObjective })),
    );

    return {
      title:              topic.title,
      microNodes:         mnRepresentations,
      duplicateCandidates: duplicateCandidates.map((c) => ({
        titleA:     c.titleA,
        titleB:     c.titleB,
        similarity: c.similarity,
      })),
    };
  });

  // Skip the AI call if there are no MicroNodes at all
  const totalMicroNodes = reviewTopics.reduce((s, t) => s + t.microNodes.length, 0);
  if (totalMicroNodes === 0) return [];

  const userPrompt = `Review the following lesson mapping for granularity issues.

TOPICS AND MICRONODES:
${JSON.stringify(reviewTopics, null, 2)}

Apply the MEGA_NODE, OVER_SPLIT, and EXERCISE_MISMATCH criteria from the system prompt.
Pay special attention to MicroNodes where compoundLO=true and duplicate candidate pairs.
Return only the findings array — empty array if no issues.`;

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
      return [];
    }

    const parsed = parsePass2JSON(raw) as { findings?: unknown[] };
    if (!parsed || !Array.isArray(parsed.findings)) {
      logger.warn({ raw: raw.slice(0, 200) }, "pass2b granularity review: invalid JSON schema — returning no findings");
      return [];
    }

    const VALID_ISSUES   = new Set(["MEGA_NODE", "OVER_SPLIT", "EXERCISE_MISMATCH"]);
    const VALID_CONFIDENCE = new Set(["HIGH", "MEDIUM"]);

    const findings: GranularityFinding[] = [];
    for (const f of parsed.findings) {
      if (
        typeof f !== "object" || f === null ||
        !("topicTitle" in f) || !("microNodeTitle" in f) ||
        !("issue" in f) || !("confidence" in f) || !("reason" in f)
      ) continue;

      const item = f as Record<string, unknown>;
      if (!VALID_ISSUES.has(String(item.issue))) continue;
      if (!VALID_CONFIDENCE.has(String(item.confidence))) continue;
      if (!String(item.reason).trim()) continue;

      findings.push({
        topicTitle:       String(item.topicTitle),
        microNodeTitle:   String(item.microNodeTitle),
        issue:            item.issue as GranularityFinding["issue"],
        confidence:       item.confidence as GranularityFinding["confidence"],
        reason:           String(item.reason),
        ...(item.suggestedAction ? { suggestedAction: String(item.suggestedAction) } : {}),
      });
    }

    logger.info(
      { findingCount: findings.length, totalMicroNodes },
      "pass2b granularity review: complete",
    );
    return findings;

  } catch (err) {
    logger.warn({ err }, "pass2b granularity review: AI call failed — returning no findings (mapping unaffected)");
    return [];
  }
}

// ── Main exported Pass 2 function ─────────────────────────────────────────────

/**
 * Runs the full two-step Pass 2 pipeline on an in-memory block list.
 * Block indices are 0-based positions in the `blocks` array.
 * No DB interaction — purely AI orchestration. The caller stores the result.
 *
 * Validated on lesson 68 (83 blocks): 83/83 coverage, 0 empty sourceBlockIndices.
 */
export async function runPass2Pipeline(
  blocks: Pass1Block[],
  lessonInfo: { lessonTitle: string; pagesFrom?: number | null; pagesTo?: number | null }
): Promise<Pass2Result> {
  logger.info({ blockCount: blocks.length }, "pass2: starting pipeline");

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
  const topicResults = await Promise.all(
    mergedGroups.map((g, i) =>
      organizeTopicMicroNodes(g.title, g.indices, blocks, i + 1)
    )
  );

  const topics: Pass2TopicResult[] = mergedGroups.map((g, i) => ({
    sequence:              i + 1,
    title:                 g.title,
    topicType:             g.topicType,
    microNodes:            topicResults[i].microNodes,
    unmappedBlockIndices:  topicResults[i].unmappedIndices,
    additionalExercises:   topicResults[i].additionalExercises,
  }));

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

  const allUnmapped = topics.flatMap((t) => t.unmappedBlockIndices);

  // Pass 2B — semantic granularity review (Phase 4).
  // Runs AFTER Step 2, BEFORE coverage validation.
  // Returns [] on any failure — never blocks the mapping.
  const granularityFindings = await runGranularityReview(topics, blocks);

  // Deterministic source-coverage validation (independent of AI self-report)
  const coverageValidation = validateSourceCoverage(blocks.length, topics);

  logger.info(
    {
      coverage:        `${coverageValidation.coveredBlocks}/${coverageValidation.totalBlocks}`,
      coveragePercent: coverageValidation.coveragePercent,
      valid:           coverageValidation.valid,
      missingIndices:  coverageValidation.missingIndices,
      duplicateIndices: coverageValidation.duplicateIndices,
      invalidIndices:  coverageValidation.invalidIndices,
      emptyMicroNodes: coverageValidation.emptyMicroNodeTitles,
      categoryCounts:  coverageValidation.categoryCounts,
      topicsCreated:   topics.length,
      microNodes:      topics.reduce((s, t) => s + t.microNodes.length, 0),
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

  return { topics, unmappedBlockIndices: allUnmapped, coverageValidation, granularityFindings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Teaching content generation (per MicroNode)
// ─────────────────────────────────────────────────────────────────────────────

const PHASE2_MODEL = "deepseek/deepseek-v4-flash";

export interface Phase2LinkedExercise {
  exerciseId:          string;
  exerciseTextVerbatim: string;
}

export interface Phase2Input {
  nodeId:            number;
  title:             string;
  learningObjective: string | null;
  theoryContent:     string | null;
  blockType:         string | null;
}

export interface Phase2GenerationResult {
  nodeId:                    number;
  skipped:                   boolean;
  skipReason?:               string;
  childFriendlyExplanation:  string;
  basicExamples:             string[];
  commonMisconception:       string;
  nonExamples:               string[];
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

Return ONLY valid JSON. No markdown fences. No trailing commas.`;

function buildPhase2Prompt(
  input: Phase2Input,
  exercises: Phase2LinkedExercise[]
): string {
  const exList = exercises.length
    ? exercises.map((e) => `[${e.exerciseId}] ${e.exerciseTextVerbatim}`).join("\n")
    : "(none)";
  return `MicroNode id=${input.nodeId}, title="${input.title}"
learningObjective: ${input.learningObjective ?? "(none)"}

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

  return {
    nodeId:                   input.nodeId,
    skipped:                  false,
    childFriendlyExplanation: typeof parsed.childFriendlyExplanation === "string" ? parsed.childFriendlyExplanation : "",
    basicExamples:            extractStringArray(parsed.basicExamples),
    commonMisconception:      typeof parsed.commonMisconception === "string" ? parsed.commonMisconception : "",
    nonExamples:              extractStringArray(parsed.nonExamples),
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
  learningObjective: string | null;
  theoryContent:     string | null;
  blockType:         string | null;
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
  skipReason?: string;
  levels:      CogPathLevel[];
}

import { z } from "zod";

const _cogPathLevelSchema = z.object({
  cognitiveLevel:             z.enum(["remember", "understand", "apply", "analyze", "evaluate", "create"]),
  sequence:                   z.number().int().min(1),
  isTargetCeiling:            z.boolean(),
  performanceObjective:       z.string(),
  successCriterion:           z.string(),
  minimumIndependentEvidence: z.number().int().min(1).default(3),
  preferredInteractionTypes:  z.array(z.string()).default([]),
});

const _cogPathResponseSchema = z.object({
  levels: z.array(_cogPathLevelSchema).min(1),
});

const COGNITIVE_PATH_SYSTEM = `Դու հայ ուսումնական ծրագրի փորձագետ ես, որը վերլուծում է MicroNode-ի ճանաչողական կառուցվածքը՝ Bloom-ի վերանայված տաքսոնոմիայի (2001) հիման վրա։

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

ОРИЕНТИРЫ (следуй учебным целям и содержанию, а не этим примерам механически):
- определение/распознавание: remember → understand
- концептуальное понимание: remember → understand
- процедурное применение: remember → understand → apply
- сравнение/отношения: understand → apply → analyze
- суждение с критериями: understand → apply → analyze → evaluate
- создание/проектирование: understand → apply → analyze → evaluate → create

Верни ТОЛЬКО валидный JSON. Без markdown. Без прозы.`;

function buildCogPathPrompt(input: CogPathInput): string {
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

theoryContent:
${input.theoryContent ?? "(empty)"}
${phase2Section}

Linked Source Exercises (${input.exercises.length}):
${exList}
${existingSection}

Analyze this MicroNode and return a pedagogically valid cognitive path.
{
  "levels": [
    {
      "cognitiveLevel": "remember",
      "sequence": 1,
      "isTargetCeiling": false,
      "performanceObjective": "Armenian — observable action: Սovonoghy kare....",
      "successCriterion": "Armenian — what counts as valid evidence...",
      "minimumIndependentEvidence": 2,
      "preferredInteractionTypes": ["multiple_choice", "matching"]
    }
  ]
}

CRITICAL: return ONLY the JSON object above. Exactly one level must have isTargetCeiling: true.`;
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
  if (isWeakSource(input.theoryContent)) {
    return { nodeId: input.nodeId, skipped: true, skipReason: "insufficient source content for cognitive enrichment", levels: [] };
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

  return {
    nodeId: input.nodeId,
    skipped: false,
    levels: levels as CogPathLevel[],
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
