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

    if (wasTruncated1) {
      // ── 1-page fallback: discard the truncated 2-page result and retry each
      // page individually.  This costs one extra API call per page but guarantees
      // every block is captured on dense pages (pages 22-23 and 26-27 of
      // Հայoц Lex 7 reliably exceed 32k tokens when combined). ──────────────
      logger.warn({ chunkLabel }, "pass1 vision: truncated — falling back to 1-page sub-chunks");
      const subBlocks: Pass1Block[] = [];

      for (let pi = 0; pi < chunkImages.length; pi++) {
        const subPage  = chunkFrom + pi;
        const subLabel = `page ${subPage} (1-page sub-chunk of ${chunkLabel})`;
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
        const rawSub      = rSub.choices[0]?.message?.content ?? "";
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
          logger.error({ subLabel, raw: rawSub.slice(0, 200) }, "pass1 vision: 1-page sub-chunk failed — skipping page");
        }
      }

      if (subBlocks.length === 0) {
        throw new Error(`Pass 1 vision ${chunkLabel}: 1-page fallback produced no blocks`);
      }
      parsed = { blocks: subBlocks };

    } else {
      // ── Normal path: try direct JSON parse ──────────────────────────────
      parsed = extractJSON(raw1, false);

      if (!parsed) {
        // Not truncated but invalid JSON — use existing retry prompt
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
        const raw2        = r2.choices[0]?.message?.content ?? "";
        const wasTruncated2 = r2.choices[0]?.finish_reason === "length";
        if (wasTruncated2) {
          logger.warn({ chunkLabel }, "pass1 vision: retry also hit max_tokens — attempting partial recovery");
        }
        parsed = extractJSON(raw2, wasTruncated2);
        if (!parsed) {
          logger.error({ chunkLabel, raw: raw2.slice(0, 300) }, "pass1 vision: failed to parse chunk after retry");
          throw new Error(`Pass 1 vision ${chunkLabel}: response not valid JSON after retry`);
        }
      }
    }

    const chunkBlocks = normalisePass1(parsed).blocks;
    logger.info({ chunkLabel, blockCount: chunkBlocks.length }, "pass1 vision: chunk extracted");
    allBlocks.push(...chunkBlocks);
  }

  if (allBlocks.length === 0) {
    throw new Error("Pass 1 vision extraction produced no blocks after all chunks");
  }

  logger.info(
    { chunkCount: chunks.length, totalBlocks: allBlocks.length },
    "pass1 vision: all chunks merged"
  );

  return { blocks: allBlocks };
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
