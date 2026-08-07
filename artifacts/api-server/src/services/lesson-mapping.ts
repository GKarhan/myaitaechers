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

  const allBlocks: Pass1Block[] = [];
  // Ranges that failed extraction even after 1-page fallback — never throw mid-loop;
  // instead collect these and surface them in the mapping report.
  const skippedPageRanges: { from: number; to: number; reason: string }[] = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkImages = chunks[ci];
    const chunkFrom   = totalFrom + ci * PASS1_CHUNK_PAGES;
    const chunkTo     = Math.min(chunkFrom + PASS1_CHUNK_PAGES - 1, totalTo);
    const chunkLabel  = `chunk ${ci + 1}/${chunks.length} (pages ${chunkFrom}–${chunkTo})`;

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
    const raw1 = r1.choices[0]?.message?.content ?? "";
    const wasTruncated1 = r1.choices[0]?.finish_reason === "length";
    let parsed: Pass1Result | null = null;

    // ── Shared 1-page fallback helper ─────────────────────────────────────────
    // Retries each page in this chunk individually.  Returns the collected
    // blocks; per-page failures are added to skippedPageRanges (no throw).
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
          // One page failed — record it, never write error text as a block
          logger.error(
            { subPage, chunkLabel, raw: rawSub.slice(0, 200) },
            "pass1 vision: 1-page sub-chunk failed — skipping page"
          );
          skippedPageRanges.push({
            from:   subPage,
            to:     subPage,
            reason: `Page ${subPage} failed extraction (${triggerReason}) — needs manual review or re-run`,
          });
        }
      }
      return subBlocks;
    };

    if (wasTruncated1) {
      // ── Truncation: discard 2-page result, retry each page individually ─────
      logger.warn({ chunkLabel }, "pass1 vision: truncated — falling back to 1-page sub-chunks");
      const subBlocks = await run1PageFallback("truncated response");
      if (subBlocks.length === 0) {
        // All pages in this chunk failed — skip the whole chunk, don't throw
        logger.error({ chunkLabel }, "pass1 vision: truncation 1-page fallback produced no blocks — skipping chunk");
        skippedPageRanges.push({
          from:   chunkFrom,
          to:     chunkTo,
          reason: `Pages ${chunkFrom}–${chunkTo} failed extraction even at 1-page granularity (truncated) — needs manual review or re-run`,
        });
        continue;
      }
      parsed = { blocks: subBlocks };

    } else {
      // ── Normal path: try direct JSON parse ──────────────────────────────────
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
          // Both attempts failed — apply 1-page fallback instead of throwing.
          // CRITICAL: never write the error string as block content or a node title.
          logger.warn(
            { chunkLabel, raw: raw2.slice(0, 300) },
            "pass1 vision: chunk failed after retry — applying 1-page fallback to avoid output corruption"
          );
          const subBlocks = await run1PageFallback("JSON parse failed after retry");
          if (subBlocks.length > 0) {
            // At least some pages recovered — include them
            parsed = { blocks: subBlocks };
          } else {
            // Every page in this chunk failed even at 1-page granularity —
            // skip the chunk entirely; a review item was added per failed page
            logger.error(
              { chunkLabel },
              "pass1 vision: chunk completely skipped — all 1-page fallbacks failed"
            );
            // Consolidate per-page items already added into one chunk-level item
            // (per-page ones were already pushed by run1PageFallback above)
            continue;
          }
        }
      }
    }

    const chunkBlocks = normalisePass1(parsed).blocks;
    logger.info({ chunkLabel, blockCount: chunkBlocks.length }, "pass1 vision: chunk extracted");
    allBlocks.push(...chunkBlocks);
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
}

export interface Pass2Result {
  topics: Pass2TopicResult[];
  /** Block indices that were not placed in any MicroNode (page headers, etc.). */
  unmappedBlockIndices: number[];
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
  return JSON.parse(s);
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
- Do NOT create MicroNodes yet — only groups of block indices per topic.`;

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
    max_tokens: 2000,
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
- Split at natural content boundaries (new rules, exercise blocks, section transitions).`;

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
    max_tokens: 1000,
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
1–3 MicroNodes with strict block-index traceability.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CORRECT STRUCTURE — a MicroNode contains BOTH theory AND exercises:

{
  "title": "What is a Noun",
  "learningObjective": "Student can define a noun and identify nouns in text",
  "microNodeType": "knowledge",
  "sourceBlockIndices": [0, 1, 2],
  "exercises": [
    {"blockIndex": 3, "sourceParagraph": "7"},
    {"blockIndex": 4, "sourceParagraph": "8"}
  ],
  "supportingMaterialIndices": []
}

ILLEGAL ANTI-PATTERN — never create this:
{
  "title": "Exercises on Nouns",
  "sourceBlockIndices": [],          ← ZERO source indices = INVALID
  "exercises": [{"blockIndex": 3}, ...]
}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIELD DEFINITIONS:
• sourceBlockIndices  — block indices this MicroNode "owns": every DEFINITION, RULE, NOTE,
                        EXAMPLE, or OBJECTIVE-with-body-text block. Also EXERCISE blocks that
                        form a theoretical list/enumeration rather than a student practice task.
                        MUST be non-empty. If you cannot find a non-exercise block to put here,
                        merge with an adjacent MicroNode instead.
• exercises           — EXERCISE, ACTIVITY, HOMEWORK blocks that are student practice tasks.
                        Add to the nearest theory MicroNode's exercises array — never create
                        a standalone exercise-only MicroNode.
• supportingMaterialIndices — IMAGE, CAPTION, TABLE blocks that illustrate the MicroNode.
• unmappedBlocks      — ONLY for pure page/textbook headers (e.g. "ՀAYOC LEZU - 7") with
                        no body text. OBJECTIVE blocks with real content go into sourceBlockIndices.

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

OUTPUT: respond with ONLY valid JSON — no markdown fences, no commentary before or after.
{
  "microNodes": [ <MicroNode objects as shown above> ],
  "unmappedBlocks": [ {"blockIndex": 0, "reason": "page header"} ]
}`;

async function organizeTopicMicroNodes(
  topicTitle: string,
  topicIndices: number[],
  blocks: Pass1Block[],
  topicSeq: number
): Promise<{ microNodes: Pass2MicroNode[]; unmappedIndices: number[] }> {
  const blockLines = topicIndices.map((i) => fmtPass2Block(i, blocks[i])).join("\n");

  const userPrompt = `Topic ${topicSeq}: «${topicTitle}»
Block indices to account for: [${topicIndices.join(", ")}]
(Every index above must appear in your output.)

BLOCKS:
${blockLines}

Organize these ${topicIndices.length} blocks into 1-3 MicroNodes now.
Remember: exercises attach to theory MicroNodes — no standalone exercise MicroNodes.`;

  const r = await openrouter.chat.completions.create({
    model: PASS2_STEP2_MODEL,
    max_tokens: 4000,
    temperature: 0,
    messages: [
      { role: "system", content: PASS2_STEP2_SYSTEM },
      { role: "user",   content: userPrompt },
    ],
  });
  const raw    = r.choices[0]?.message?.content ?? "";
  const finish = r.choices[0]?.finish_reason;
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
  };

  const microNodes: Pass2MicroNode[] = (parsed.microNodes ?? []).map((mn) => ({
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

  const unmappedIndices = (parsed.unmappedBlocks ?? []).map((u) => u.blockIndex);
  return { microNodes, unmappedIndices };
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
  lessonInfo: { lessonTitle: string; pagesFrom: number; pagesTo: number }
): Promise<Pass2Result> {
  logger.info({ blockCount: blocks.length }, "pass2: starting pipeline");

  // Step 1: topic boundary detection
  let groups = await detectTopicGroups(
    blocks, lessonInfo.lessonTitle, lessonInfo.pagesFrom, lessonInfo.pagesTo
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
  }));

  const allUnmapped = topics.flatMap((t) => t.unmappedBlockIndices);

  // Coverage validation (logged — caller may choose to error or warn)
  const seen = new Set<number>();
  for (const t of topics) {
    for (const mn of t.microNodes) {
      mn.sourceBlockIndices.forEach((i) => seen.add(i));
      mn.exercises.forEach((e) => seen.add(e.blockIndex));
      mn.supportingMaterialIndices.forEach((i) => seen.add(i));
    }
    t.unmappedBlockIndices.forEach((i) => seen.add(i));
  }
  const missing       = blocks.map((_, i) => i).filter((i) => !seen.has(i));
  const emptySourceMNs = topics.flatMap((t) =>
    t.microNodes.filter((mn) => mn.sourceBlockIndices.length === 0).map((mn) => mn.title)
  );

  logger.info(
    {
      coverage:      `${seen.size}/${blocks.length}`,
      missing,
      emptySourceMNs,
      topicsCreated: topics.length,
      microNodes:    topics.reduce((s, t) => s + t.microNodes.length, 0),
    },
    "pass2: pipeline complete"
  );

  if (missing.length > 0) {
    logger.warn({ missing }, "pass2: blocks not placed by pipeline");
  }
  if (emptySourceMNs.length > 0) {
    logger.warn({ emptySourceMNs }, "pass2: MicroNodes with empty sourceBlockIndices");
  }

  return { topics, unmappedBlockIndices: allUnmapped };
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
  nodeId:                     number;
  skipped:                    boolean;
  skipReason?:                string;
  explanationSteps:           object[];
  beginnerExplanation:        string;
  advancedExplanation:        string;
  analogy:                    string;
  commonErrors:               object[];
  recallQuestions:            object[];
  understandingQuestions:     object[];
  applicationQuestions:       object[];
  faqEntries:                 object[];
  contentSourceType:          "textbook" | "mixed" | "ai_generated";
  teachingContentConfidence:  number;
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

const PHASE2_SYSTEM = `You are an expert Armenian language curriculum designer generating structured teaching content for a grade-7 Armenian textbook app.

STRICT GROUNDING RULES — violating these is worse than leaving a field empty:
1. explanationSteps, beginnerExplanation, advancedExplanation, recallQuestions, understandingQuestions: derived ONLY from the provided theoryContent — rephrase, sequence, or simplify what is already there; do NOT add facts not in the source.
2. commonErrors: build from linked exercises (what wrong answers to those exercises look like). Stay grounded in the theory.
3. applicationQuestions: reference actual linked exercises where possible.
4. analogy: the ONE field allowed to be freely creative.
5. teachingContentConfidence (0–100): 85–100 = grounded in verbatim text; 60–84 = inferred; <60 = AI-generated.

Keep each text field concise (2 sentences max). Return ONLY valid JSON. No markdown fences. No trailing commas.`;

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

Return JSON:
{
  "explanationSteps": [{"step":1,"heading":"Armenian","body":"Armenian (1 sentence)"},{"step":2,"heading":"Armenian","body":"Armenian (1 sentence)"}],
  "beginnerExplanation": "Armenian (2 sentences max)",
  "advancedExplanation": "Armenian (2 sentences max)",
  "analogy": "Armenian (1 sentence, creative)",
  "commonErrors": [{"error":"Armenian","correction":"Armenian","sourceType":"exercise_based|ai_generated","relatedExerciseId":"EX-XX-N or null"}],
  "recallQuestions": [{"question":"Armenian","expectedAnswer":"Armenian (1 sentence)"},{"question":"Armenian","expectedAnswer":"Armenian (1 sentence)"}],
  "understandingQuestions": [{"question":"Armenian","expectedAnswer":"Armenian (1 sentence)"}],
  "applicationQuestions": [{"question":"Armenian","relatedExerciseId":"EX-XX-N or null","hint":"Armenian or null"}],
  "faqEntries": [],
  "contentSourceType": "textbook",
  "teachingContentConfidence": 85
}`;
}

function applyPhase2Adjustments(parsed: Record<string, unknown>): void {
  // A1: analogy present → mixed
  if (typeof parsed.analogy === "string" && parsed.analogy.trim().length > 0) {
    parsed.contentSourceType = "mixed";
  }
  // A2: mixed → cap confidence at 90
  if (parsed.contentSourceType === "mixed") {
    const conf = typeof parsed.teachingContentConfidence === "number"
      ? parsed.teachingContentConfidence : 100;
    parsed.teachingContentConfidence = Math.min(conf, 90);
  }
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
      nodeId:                    input.nodeId,
      skipped:                   true,
      skipReason:                "insufficient source content for teaching material",
      explanationSteps:          [],
      beginnerExplanation:       "",
      advancedExplanation:       "",
      analogy:                   "",
      commonErrors:              [],
      recallQuestions:           [],
      understandingQuestions:    [],
      applicationQuestions:      [],
      faqEntries:                [],
      contentSourceType:         "textbook",
      teachingContentConfidence: 0,
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
      nodeId:                    input.nodeId,
      skipped:                   true,
      skipReason:                "AI returned unparseable JSON after retry — re-run this node",
      explanationSteps:          [],
      beginnerExplanation:       "",
      advancedExplanation:       "",
      analogy:                   "",
      commonErrors:              [],
      recallQuestions:           [],
      understandingQuestions:    [],
      applicationQuestions:      [],
      faqEntries:                [],
      contentSourceType:         "textbook",
      teachingContentConfidence: 0,
    };
  }

  applyPhase2Adjustments(parsed);

  return {
    nodeId:                    input.nodeId,
    skipped:                   false,
    explanationSteps:          Array.isArray(parsed.explanationSteps) ? parsed.explanationSteps : [],
    beginnerExplanation:       typeof parsed.beginnerExplanation === "string" ? parsed.beginnerExplanation : "",
    advancedExplanation:       typeof parsed.advancedExplanation === "string" ? parsed.advancedExplanation : "",
    analogy:                   typeof parsed.analogy === "string" ? parsed.analogy : "",
    commonErrors:              Array.isArray(parsed.commonErrors) ? parsed.commonErrors : [],
    recallQuestions:           Array.isArray(parsed.recallQuestions) ? parsed.recallQuestions : [],
    understandingQuestions:    Array.isArray(parsed.understandingQuestions) ? parsed.understandingQuestions : [],
    applicationQuestions:      Array.isArray(parsed.applicationQuestions) ? parsed.applicationQuestions : [],
    faqEntries:                Array.isArray(parsed.faqEntries) ? parsed.faqEntries : [],
    contentSourceType:         (parsed.contentSourceType as "textbook" | "mixed" | "ai_generated") ?? "textbook",
    teachingContentConfidence: typeof parsed.teachingContentConfidence === "number" ? parsed.teachingContentConfidence : 80,
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
    userPromptParts.push("", `USUC'CHII SEvaGIR NPATAKE: ${input.teacherGoal}`);
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
      ? `USUC'CHII SEVAGIR NPATAKE: ${input.teacherGoal}` : "",
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
