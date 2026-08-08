// ────────────────────────────────────────────────────────────────────────────
// Contract v1.2 — HTTP/Route integration tests (Round 1.5 safety tests)
// Test B: dryRun=true → ZERO DB writes
// Test D: Validation errors + dryRun=false → 422, ZERO DB writes
// Test E: Format field validation (missing/invalid → 400; valid → TEXT/JSON path)
//
// Run: pnpm --filter @workspace/api-server exec tsx src/mapping/__tests__/mapTextHttp.test.ts
// Requires: API server running on http://localhost:8080
//           DATABASE_URL env var (set by Replit)
// ────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { pool } from "@workspace/db";

const BASE_URL = "http://localhost:8080";

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getTeacherToken(): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/auth/login`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ username: "teacher1", password: "teacher123" }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);
  const data = await resp.json() as { token?: string };
  if (!data.token) throw new Error("No token in login response");
  return data.token;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function countMappingRows(lessonId: number): Promise<{
  topics: number; nodes: number; exercises: number;
  deps: number; reviewItems: number; importLog: number;
}> {
  const q = (table: string) =>
    pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE lesson_id = $1`, [lessonId])
        .then(r => Number(r.rows[0].n));

  const [topics, nodes, exercises, deps, reviewItems, importLog] = await Promise.all([
    q("lesson_topics"),
    q("lesson_nodes"),
    q("lesson_exercises"),
    q("lesson_node_dependencies"),
    q("mapping_review_items"),
    q("mapping_import_log"),
  ]);
  return { topics, nodes, exercises, deps, reviewItems, importLog };
}

function assertZeroCounts(label: string, counts: Awaited<ReturnType<typeof countMappingRows>>): void {
  const total = counts.topics + counts.nodes + counts.exercises +
                counts.deps + counts.reviewItems + counts.importLog;
  assert.equal(
    total, 0,
    `${label}: expected 0 total mapping rows, got ${total}. Detail: ${JSON.stringify(counts)}`,
  );
}

async function createTestLesson(tag: string): Promise<number> {
  const { rows: subjRows } = await pool.query("SELECT id FROM subjects LIMIT 1");
  if (!subjRows.length) throw new Error("No subjects in DB — cannot create test lesson");
  const { rows } = await pool.query(
    `INSERT INTO lessons (subject_id, title, status)
     VALUES ($1, $2, 'draft') RETURNING id`,
    [subjRows[0].id, `__TEST__ round-1.5 ${tag} ${Date.now()}`],
  );
  return rows[0].id;
}

async function cleanupLesson(lessonId: number): Promise<void> {
  await pool.query("DELETE FROM lessons WHERE id = $1", [lessonId]);
}

// ── Text fixtures ─────────────────────────────────────────────────────────────

const VALID_TEXT = `
LESSON
title: Arithmetic
subject: Math
grade: 5
textbook: Elementary Math
author: A. Author
section: Ch. 1
pages: 10-12

NODE N1
title: Addition

MICRONODE MN-1.1
title: Basic addition
microNodeType: KNOWLEDGE
learningObjective: Student can add two numbers
sourceBlockIds: B1
confidenceScore: 90
sourceCoverage: FULL
status: draft

SOURCE BLOCK B1
blockType: DEFINITION
sourceText: Addition is the process of combining two numbers.
sourcePage: 10
status: EXTRACTED

EXERCISE EX-1
text: What is 2 + 3?
exerciseType: RECALL
difficulty: EASY
sequence: 1
relatedMicroNodes: MN-1.1
`.trim();

// Invalid: MN-1.1 references an UNREADABLE block → validation ERROR
const INVALID_TEXT_UNREADABLE = `
LESSON
title: Arithmetic
subject: Math
grade: 5
textbook: Elementary Math
author: A. Author
section: Ch. 1
pages: 10-12

NODE N1
title: Addition

MICRONODE MN-1.1
title: Basic addition
microNodeType: KNOWLEDGE
learningObjective: Student can add
sourceBlockIds: B1
confidenceScore: 90
sourceCoverage: FULL
status: draft

SOURCE BLOCK B1
blockType: DEFINITION
sourceText: Cannot read this page.
sourcePage: 10
status: UNREADABLE
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// TEST B — dryRun=true → ZERO DB writes
// ─────────────────────────────────────────────────────────────────────────────
async function testB_dryRunZeroWrites(token: string): Promise<void> {
  const lessonId = await createTestLesson("B-dryrun");
  try {
    const before = await countMappingRows(lessonId);
    assertZeroCounts("B precondition", before);

    const resp = await fetch(`${BASE_URL}/api/lessons/${lessonId}/manual-map`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ rawText: VALID_TEXT, format: "text", dryRun: true }),
    });

    assert.equal(resp.status, 200, `Expected 200, got ${resp.status}`);
    const body = await resp.json() as Record<string, unknown>;

    // Response must contain preview
    assert.ok(body.preview, "Response must have .preview");
    const preview = body.preview as Record<string, unknown>;
    assert.equal(body.hasErrors, false, "hasErrors must be false for valid text");
    assert.ok(preview.counts, "preview.counts must be present");

    const counts = preview.counts as Record<string, number>;
    assert.ok(counts.nodes >= 1, `preview.counts.nodes must be ≥ 1, got ${counts.nodes}`);
    assert.ok(counts.microNodes >= 1, `preview.counts.microNodes ≥ 1, got ${counts.microNodes}`);
    assert.ok(counts.sourceBlocks >= 1, `preview.counts.sourceBlocks ≥ 1`);

    // DB must still be empty
    const after = await countMappingRows(lessonId);
    assertZeroCounts("B post-dryRun", after);

    console.log(`    ✓ Response: hasErrors=false, nodes=${counts.nodes}, microNodes=${counts.microNodes}, sourceBlocks=${counts.sourceBlocks}`);
    console.log(`    ✓ DB rows after dryRun=true: topics=0, nodes=0, exercises=0, deps=0, reviewItems=0, importLog=0`);
    console.log("    → dryRun=true performs parse+validate+preview ONLY. ZERO database mutations.");
  } finally {
    await cleanupLesson(lessonId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST D — Validation errors + dryRun=false → 422, ZERO DB writes
// ─────────────────────────────────────────────────────────────────────────────
async function testD_errorsBlockCommit(token: string): Promise<void> {
  const lessonId = await createTestLesson("D-block-commit");
  try {
    const before = await countMappingRows(lessonId);
    assertZeroCounts("D precondition", before);

    // Attempt commit with text that has a validation ERROR (UNREADABLE block ref)
    const resp = await fetch(`${BASE_URL}/api/lessons/${lessonId}/manual-map`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ rawText: INVALID_TEXT_UNREADABLE, format: "text", dryRun: false }),
    });

    assert.equal(resp.status, 422, `Expected 422 (validation blocked commit), got ${resp.status}`);
    const body = await resp.json() as { error?: string; errors?: unknown[] };
    assert.ok(body.error, "Response must have .error message");
    assert.ok(Array.isArray(body.errors) && body.errors.length >= 1, "Response must have .errors array");

    // DB must still be empty — no partial import
    const after = await countMappingRows(lessonId);
    assertZeroCounts("D post-failed-commit", after);

    console.log(`    ✓ HTTP 422: "${body.error}"`);
    console.log(`    ✓ errors array length: ${(body.errors as unknown[]).length}`);
    console.log("    ✓ DB rows after failed commit: topics=0, nodes=0, exercises=0, deps=0, reviewItems=0, importLog=0");
    console.log("    → Backend validation blocks commit server-side. Frontend button state is NOT the only guard.");
  } finally {
    await cleanupLesson(lessonId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST E — Format field validation
// E-1: format missing → 400
// E-2: format="auto" → 400
// E-3: format="text" → TEXT path (not 400; reaches lesson lookup → 404 for non-existent lesson)
// E-4: format="json" → LEGACY path (not 400; reaches lesson lookup → 404 or JSON parse behavior)
// ─────────────────────────────────────────────────────────────────────────────
async function testE_formatValidation(token: string): Promise<void> {
  // Use a non-existent lesson ID to isolate routing — if format check passes,
  // the handler reaches the lesson lookup and returns 404, not 400.
  const FAKE_LESSON_ID = 999999999;

  // E-1: format field absent → 400
  {
    const resp = await fetch(`${BASE_URL}/api/lessons/${FAKE_LESSON_ID}/manual-map`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ rawText: "LESSON\ntitle: T\n" }),
    });
    assert.equal(resp.status, 400, `E-1: missing format must be 400, got ${resp.status}`);
    const body = await resp.json() as { error?: string };
    assert.ok(body.error?.includes("format is required"), `E-1: error message must mention "format is required": "${body.error}"`);
    console.log(`    ✓ E-1: format absent → 400: "${body.error}"`);
  }

  // E-2: format="auto" (invalid string) → 400
  {
    const resp = await fetch(`${BASE_URL}/api/lessons/${FAKE_LESSON_ID}/manual-map`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ rawText: "LESSON\ntitle: T\n", format: "auto" }),
    });
    assert.equal(resp.status, 400, `E-2: format="auto" must be 400, got ${resp.status}`);
    const body = await resp.json() as { error?: string };
    assert.ok(body.error?.includes("format is required"), `E-2: "${body.error}"`);
    console.log(`    ✓ E-2: format="auto" → 400: "${body.error}"`);
  }

  // E-3: format="text" → NOT 400 (reaches TEXT handler → 404 lesson not found)
  {
    const resp = await fetch(`${BASE_URL}/api/lessons/${FAKE_LESSON_ID}/manual-map`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ rawText: "LESSON\ntitle: T\n", format: "text", dryRun: true }),
    });
    // Must NOT be 400 (format error). Will be 404 because lesson doesn't exist.
    assert.notEqual(resp.status, 400, `E-3: format="text" must NOT return 400 (format check passed)`);
    assert.equal(resp.status, 404, `E-3: format="text" must reach TEXT handler → 404, got ${resp.status}`);
    const body = await resp.json() as { error?: string };
    assert.ok(body.error?.toLowerCase().includes("lesson"), `E-3: error must be lesson-related: "${body.error}"`);
    console.log(`    ✓ E-3: format="text" → 404 (passed format check, reached TEXT handler → lesson not found)`);
  }

  // E-4: format="json" → NOT 400 (reaches LEGACY JSON handler)
  {
    const resp = await fetch(`${BASE_URL}/api/lessons/${FAKE_LESSON_ID}/manual-map`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ rawText: '{"lesson":{"title":"T"},"nodes":[]}', format: "json" }),
    });
    // Must NOT be 400 (format error). Reaches LEGACY handler.
    assert.notEqual(resp.status, 400, `E-4: format="json" must NOT return 400 (format check passed)`);
    console.log(`    ✓ E-4: format="json" → ${resp.status} (passed format check, reached LEGACY JSON handler)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────

const asyncTests: Array<[string, (token: string) => Promise<void>]> = [
  ["B: dryRun=true → ZERO DB writes across all mapping tables", testB_dryRunZeroWrites],
  ["D: validation errors + dryRun=false → HTTP 422, ZERO DB writes", testD_errorsBlockCommit],
  ["E: format field — missing→400, auto→400, text→TEXT path, json→LEGACY path", testE_formatValidation],
];

let passed = 0;
let failed = 0;
const failedNames: string[] = [];

console.log("\n  mapTextHttp — dry-run (B), error-blocking (D), format-validation (E)\n");

let token: string;
try {
  token = await getTeacherToken();
  console.log("  ✓ Auth: teacher1 token acquired\n");
} catch (err) {
  console.error(`  ✗ Cannot obtain auth token: ${(err as Error).message}`);
  console.error("    Ensure the API server is running on http://localhost:8080");
  await pool.end();
  process.exit(1);
}

for (const [name, fn] of asyncTests) {
  try {
    await fn(token);
    passed++;
    process.stdout.write(`  \u001b[32m\u2713\u001b[0m ${name}\n`);
  } catch (err) {
    failed++;
    failedNames.push(name);
    process.stdout.write(`  \u001b[31m\u2717\u001b[0m ${name}\n`);
    if (err instanceof Error) {
      console.error(`      ${err.message}`);
      if (err.stack) {
        const lines = err.stack.split("\n").slice(1, 4);
        for (const l of lines) console.error(`      ${l.trim()}`);
      }
    }
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
await pool.end();
if (failed > 0) {
  console.error(`  Failed: ${failedNames.join(", ")}\n`);
  process.exit(1);
}
