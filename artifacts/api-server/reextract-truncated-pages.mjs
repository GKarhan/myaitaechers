#!/usr/bin/env node
/**
 * Targeted re-extraction of pages 22, 23, 26, 27 from lesson 68.
 * Those two chunks hit max_tokens in the original Pass 1 run and used truncation
 * recovery (losing some exercises).  This script re-extracts them at 1-page
 * granularity and merges the result with the already-correct blocks from pages
 * 24-25 and 28-29 that are already in the DB.
 *
 * Usage (from workspace root):
 *   node artifacts/api-server/reextract-truncated-pages.mjs
 */

import { execFileSync }                from "child_process";
import { mkdtempSync, readFileSync,
         rmSync, readdirSync }         from "fs";
import { join }                        from "path";
import { tmpdir }                      from "os";
import { createRequire }               from "module";

const _require = createRequire(import.meta.url);
// pnpm virtual store — pg is not symlinked into workspace root node_modules
const { Pool } = _require("/home/runner/workspace/node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

// ── Config ────────────────────────────────────────────────────────────────────
const DB_URL    = process.env.DATABASE_URL;
const OR_KEY    = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
const OR_BASE   = (process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL
                   ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
const PDF_PATH  = "/home/runner/workspace/artifacts/api-server/uploads/1785924752566-281629242.pdf";
const LESSON_ID = 68;
const MODEL     = "google/gemini-2.5-flash";
const MAX_TOK   = 32000;
const DPI       = 150;

// ── Pass 1 system prompt (must stay in sync with lesson-mapping.ts) ───────────
const SYSTEM_PROMPT = `You are a textbook content extraction engine. Your ONLY task: read the given page(s) and output a flat JSON array of every content block you see, in reading order.

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_TYPES = new Set([
  "DEFINITION","RULE","EXAMPLE","EXERCISE","OBJECTIVE",
  "WARNING","EXCEPTION","TABLE","IMAGE","CAPTION","NOTE","ACTIVITY","HOMEWORK",
]);

function extractJSON(raw, truncated = false) {
  const s = raw.replace(/```json\s*|```\s*/g, "").trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  if (truncated) {
    const bi = s.indexOf('"blocks"');
    if (bi >= 0) {
      const ai = s.indexOf("[", bi);
      if (ai >= 0) {
        const blocks = [];
        let depth = 0, start = -1;
        for (let i = ai; i < s.length; i++) {
          if (s[i] === "{") { if (depth === 0) start = i; depth++; }
          else if (s[i] === "}") {
            depth--;
            if (depth === 0 && start >= 0) {
              try { blocks.push(JSON.parse(s.slice(start, i + 1))); } catch {}
              start = -1;
            }
          }
        }
        if (blocks.length > 0) { console.warn(`  ↳ truncation recovery: ${blocks.length} blocks`); return { blocks }; }
      }
    }
  }
  return null;
}

function normalise(raw) {
  return (Array.isArray(raw?.blocks) ? raw.blocks : [])
    .map(b => ({
      blockType:        VALID_TYPES.has(String(b.blockType ?? "")) ? String(b.blockType) : "NOTE",
      sourceText:       typeof b.sourceText === "string" ? b.sourceText.trim() : "",
      sourcePage:       typeof b.sourcePage === "number" && b.sourcePage > 0 ? Math.round(b.sourcePage) : 0,
      sourceParagraph:  typeof b.sourceParagraph === "string" && b.sourceParagraph.trim()
                          ? b.sourceParagraph.trim() : null,
      sourceBoundingBox: b.sourceBoundingBox && typeof b.sourceBoundingBox === "object"
                          && !Array.isArray(b.sourceBoundingBox) ? b.sourceBoundingBox : null,
    }))
    .filter(b => b.sourceText.length > 0);
}

function rasterizePage(pdfPath, page) {
  const dir = mkdtempSync(join(tmpdir(), "p1-page-"));
  try {
    execFileSync("pdftoppm", ["-r", String(DPI), "-png", "-f", String(page), "-l", String(page), pdfPath, join(dir, "pg")]);
    const files = readdirSync(dir).filter(f => f.endsWith(".png")).sort();
    if (!files.length) throw new Error(`pdftoppm produced no PNG for page ${page}`);
    return readFileSync(join(dir, files[0])).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function extractPage(pageNum, b64) {
  const header = [
    "SUBJECT: Հayoc Lezu",
    "LESSON TITLE: Հatuk Anun (Proper Nouns)",
    "TEXTBOOK: Հayoc Lezu 7",
    `PAGE: ${pageNum}  [1-page extraction, full lesson range 22–29]`,
    "",
    `You are looking at 1 page image (page ${pageNum}).`,
    "Extract EVERY content block visible on this page in reading order.",
    "IMPORTANT: Output ONLY the raw JSON object — no markdown fences, no ```json, no explanation.",
    "For sourceBoundingBox, provide pixel coordinates {x, y, w, h} measured from the top-left.",
  ].join("\n");

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOK,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: header },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
  });

  const resp = await fetch(`${OR_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body,
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data    = await resp.json();
  const raw     = data.choices?.[0]?.message?.content ?? "";
  const trunc   = data.choices?.[0]?.finish_reason === "length";
  if (trunc) console.warn(`  ⚠️  page ${pageNum}: finish_reason=length (very dense page)`);
  const parsed = extractJSON(raw, trunc);
  if (!parsed) throw new Error(`page ${pageNum}: model response not valid JSON`);
  return normalise(parsed);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!DB_URL)  throw new Error("DATABASE_URL not set");
  if (!OR_KEY)  throw new Error("AI_INTEGRATIONS_OPENROUTER_API_KEY not set");

  const pool = new Pool({ connectionString: DB_URL });

  try {
    // 1. Load the already-correct blocks from DB (pages 24, 25, 28, 29)
    console.log("Step 1: Loading correct blocks (pages 24-25, 28-29) from DB...");
    const kept = await pool.query(
      `SELECT block_type, source_text, source_page, source_paragraph, source_bounding_box
       FROM lesson_nodes WHERE lesson_id = $1 AND source_page IN (24,25,28,29)
       ORDER BY sequence`,
      [LESSON_ID],
    );
    const keptBlocks = kept.rows.map(r => ({
      blockType:        r.block_type,
      sourceText:       r.source_text,
      sourcePage:       r.source_page,
      sourceParagraph:  r.source_paragraph,
      sourceBoundingBox: r.source_bounding_box,
    }));
    console.log(`  → ${keptBlocks.length} blocks kept`);

    // 2. Extract pages 22, 23, 26, 27 at 1-page granularity
    const pagesTarget = [22, 23, 26, 27];
    const newByPage   = {};
    for (const pg of pagesTarget) {
      console.log(`\nStep 2: Rasterising page ${pg}...`);
      const b64    = rasterizePage(PDF_PATH, pg);
      console.log(`  → Calling vision model for page ${pg}...`);
      const blocks = await extractPage(pg, b64);
      console.log(`  → ${blocks.length} blocks from page ${pg}`);
      newByPage[pg] = blocks;
    }

    // 3. Assemble all blocks in page order
    const all = [
      ...( newByPage[22] ?? [] ),
      ...( newByPage[23] ?? [] ),
      ...keptBlocks.filter(b => b.sourcePage === 24),
      ...keptBlocks.filter(b => b.sourcePage === 25),
      ...( newByPage[26] ?? [] ),
      ...( newByPage[27] ?? [] ),
      ...keptBlocks.filter(b => b.sourcePage === 28),
      ...keptBlocks.filter(b => b.sourcePage === 29),
    ];
    console.log(`\nStep 3: Total blocks to store: ${all.length}`);

    // 4. Replace lesson_nodes in a transaction
    console.log("Step 4: Replacing lesson_nodes in DB...");
    await pool.query("BEGIN");
    try {
      await pool.query("DELETE FROM lesson_nodes WHERE lesson_id = $1", [LESSON_ID]);

      for (let i = 0; i < all.length; i++) {
        const b   = all[i];
        const seq = i + 1;
        const title = (b.sourceText ?? "").slice(0, 50).trim() || `Block ${seq}`;
        await pool.query(
          `INSERT INTO lesson_nodes
             (lesson_id, sequence, title, block_type, source_text,
              source_page, source_paragraph, source_bounding_box,
              status, created_by, topic_id, target_bloom_level, estimated_minutes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft','ai',NULL,1,5)`,
          [
            LESSON_ID, seq, title,
            b.blockType, b.sourceText, b.sourcePage, b.sourceParagraph ?? null,
            b.sourceBoundingBox ? JSON.stringify(b.sourceBoundingBox) : null,
          ],
        );
      }

      await pool.query("COMMIT");
      console.log(`\n✅  Committed ${all.length} blocks for lesson ${LESSON_ID}`);
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }

    // 5. Quick summary by page
    const summary = await pool.query(
      `SELECT source_page, COUNT(*)::int AS n
       FROM lesson_nodes WHERE lesson_id = $1
       GROUP BY source_page ORDER BY source_page`,
      [LESSON_ID],
    );
    console.log("\nBlocks by page:");
    for (const r of summary.rows) console.log(`  page ${r.source_page}: ${r.n} blocks`);

  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error("FAILED:", err.message); process.exit(1); });
