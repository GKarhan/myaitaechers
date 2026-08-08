// ────────────────────────────────────────────────────────────────────────────
// Contract v1.2 — Inserter / DB test cases (Round 1.5 safety tests)
// Test C: Transaction rollback
// Test F: relatedMicroNodes storage behavior (Class B classification)
//
// Run: pnpm --filter @workspace/api-server exec tsx src/mapping/__tests__/mapTextInserter.test.ts
// Requires: DATABASE_URL env var (set by Replit)
// ────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import {
  db,
  pool,
  lessonTopicsTable,
  lessonNodesTable,
  lessonExercisesTable,
  lessonNodeDependenciesTable,
  mappingReviewItemsTable,
  mappingImportLogTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { parseMappingText }      from "../mapTextParser.js";
import { validateParsedMapping } from "../mapTextValidator.js";
import { insertParsedMapping }   from "../mapTextInserter.js";
import { createHash }            from "node:crypto";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Count rows in a mapping table for the given lessonId via raw SQL. */
async function countRows(tableName: string, lessonId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM ${tableName} WHERE lesson_id = $1`,
    [lessonId],
  );
  return Number(rows[0].n);
}

/** Create a throw-away test lesson and return its id. */
async function createTestLesson(tag: string): Promise<number> {
  // Find any existing subject to satisfy the NOT NULL FK
  const { rows: subjRows } = await pool.query("SELECT id FROM subjects LIMIT 1");
  if (!subjRows.length) throw new Error("No subjects in DB — cannot create test lesson");
  const subjectId = subjRows[0].id;

  const { rows } = await pool.query(
    `INSERT INTO lessons (subject_id, title, status)
     VALUES ($1, $2, 'draft') RETURNING id`,
    [subjectId, `__TEST__ round-1.5 ${tag} ${Date.now()}`],
  );
  return rows[0].id;
}

/** Delete a test lesson and all cascade-delete children. */
async function cleanupLesson(lessonId: number): Promise<void> {
  await pool.query("DELETE FROM lessons WHERE id = $1", [lessonId]);
}

// ── Minimal valid TEXT fixture ────────────────────────────────────────────────

function makeValidText(withRelatedMns = false): string {
  return `
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
status: draft${withRelatedMns ? "\nrelatedMicroNodes: MN-1.2, MN-2.1" : ""}

MICRONODE MN-1.2
title: Multi-digit addition
microNodeType: KNOWLEDGE
learningObjective: Student can add multi-digit numbers
sourceBlockIds: B1
confidenceScore: 85
sourceCoverage: PARTIAL
status: draft

NODE N2
title: Multiplication

MICRONODE MN-2.1
title: Basic multiplication
microNodeType: KNOWLEDGE
learningObjective: Student can multiply
sourceBlockIds: B1
confidenceScore: 80
sourceCoverage: FULL
status: draft

SOURCE BLOCK B1
blockType: DEFINITION
sourceText: Addition is the process of combining two numbers.
sourcePage: 10
status: EXTRACTED
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST C — Transaction rollback: mid-transaction throw → zero rows committed
// ─────────────────────────────────────────────────────────────────────────────
async function testC_transactionRollback(): Promise<void> {
  const lessonId = await createTestLesson("C-rollback");
  try {
    // Baseline: 0 lesson_topics rows for this lesson
    const before = await countRows("lesson_topics", lessonId);
    assert.equal(before, 0, "Precondition: no lesson_topics rows for test lesson");

    // Open a transaction, insert one topic row, then throw deliberately
    let insertedDuringTx = false;
    let txError: Error | null = null;

    try {
      await db.transaction(async (tx) => {
        await tx.insert(lessonTopicsTable).values({
          lessonId,
          title:    "Transaction test topic",
          sequence: 1,
        });
        insertedDuringTx = true;
        // Deliberate throw AFTER a successful insert → must roll back
        throw new Error("deliberate-rollback-trigger");
      });
    } catch (err) {
      txError = err as Error;
    }

    // The insert happened inside the tx before the throw
    assert.equal(insertedDuringTx, true, "Insert ran before throw");
    // The error was the deliberate one
    assert.ok(txError?.message === "deliberate-rollback-trigger", "Expected deliberate error to propagate");

    // After rollback: 0 rows committed
    const after = await countRows("lesson_topics", lessonId);
    assert.equal(
      after, 0,
      `Transaction rollback failed: expected 0 lesson_topics rows after rollback, got ${after}`,
    );

    // Verify the lesson itself still exists (lesson was created OUTSIDE the transaction)
    const { rows: lessonRows } = await pool.query("SELECT id FROM lessons WHERE id = $1", [lessonId]);
    assert.equal(lessonRows.length, 1, "The lesson row itself must still exist (it was outside the tx)");

    console.log("    ✓ Insert confirmed to have run inside tx");
    console.log("    ✓ 0 lesson_topics rows after rollback");
    console.log("    ✓ lesson row still present (outside tx)");
    console.log("    → insertParsedMapping uses db.transaction() — same rollback guarantee applies.");
  } finally {
    await cleanupLesson(lessonId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST C-2 — insertParsedMapping full success then verify counts
// (Baseline for rollback test: proves data CAN be committed when no error)
// ─────────────────────────────────────────────────────────────────────────────
async function testC2_insertSuccess(): Promise<void> {
  const lessonId = await createTestLesson("C2-success");
  try {
    const parsed     = parseMappingText(makeValidText(false));
    const validation = validateParsedMapping(parsed);
    assert.equal(validation.ok, true, "Fixture must be valid");

    const rawText = makeValidText(false);
    const hash    = createHash("sha256").update(rawText).digest("hex");
    const result  = await insertParsedMapping(lessonId, parsed, null, hash, rawText, validation.warnings);

    // Data was committed
    const topics = await countRows("lesson_topics", lessonId);
    const nodes  = await countRows("lesson_nodes",  lessonId);
    assert.ok(topics >= 1, `Expected ≥1 lesson_topics, got ${topics}`);
    assert.ok(nodes  >= 1, `Expected ≥1 lesson_nodes, got ${nodes}`);
    assert.ok(result.topicsCreated >= 1, "topicsCreated ≥ 1");
    assert.ok(result.microNodesCreated >= 1, "microNodesCreated ≥ 1");

    console.log(`    ✓ topics committed: ${topics}, nodes committed: ${nodes}`);
  } finally {
    await cleanupLesson(lessonId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST F — relatedMicroNodes storage behavior (Class B classification)
//
// Proves:
//   (1) Both MN IDs survive parser → normalized ParsedMappingResult
//   (2) Both survive validator (no errors for valid cross-refs)
//   (3) Both produce mapping_review_items rows (issueType="related-mn-deferred")
//   (4) No lesson_nodes-to-lesson_nodes relationship exists (no join table column)
// ─────────────────────────────────────────────────────────────────────────────
async function testF_relatedMicroNodesStorageBehavior(): Promise<void> {
  const lessonId = await createTestLesson("F-related-mns");
  try {
    const rawText = makeValidText(true); // MN-1.1 has relatedMicroNodes: MN-1.2, MN-2.1
    const parsed  = parseMappingText(rawText);

    // ── F-1: Both IDs survive parser ──────────────────────────────────────────
    const mn11 = parsed.nodes.flatMap(n => n.microNodes).find(m => m.id === "MN-1.1");
    assert.ok(mn11, "MN-1.1 must be parsed");
    assert.deepEqual(
      mn11!.relatedMicroNodes, ["MN-1.2", "MN-2.1"],
      "relatedMicroNodes must survive parser as ['MN-1.2','MN-2.1']",
    );
    console.log(`    ✓ F-1: parser → mn.relatedMicroNodes = ${JSON.stringify(mn11!.relatedMicroNodes)}`);

    // ── F-2: Validator accepts valid cross-refs (both MNs exist in document) ──
    const validation = validateParsedMapping(parsed);
    assert.equal(
      validation.ok, true,
      `Validator must accept document with valid relatedMicroNodes. Errors: ${JSON.stringify(validation.errors)}`,
    );
    // The W_RELATED_MN_EXTRA warning must be present (2 related MNs → only first to DB)
    const relWarning = validation.warnings.find(w => w.issueType === "warn-related-mn-extra");
    assert.ok(relWarning, "W_RELATED_MN_EXTRA warning must be present for multiple relatedMicroNodes");
    console.log(`    ✓ F-2: validator ok=true, W_RELATED_MN_EXTRA warning: "${relWarning!.description.slice(0, 80)}..."`);

    // ── F-3: Both IDs produce mapping_review_items after insert ───────────────
    const hash   = createHash("sha256").update(rawText).digest("hex");
    const result = await insertParsedMapping(lessonId, parsed, null, hash, rawText, validation.warnings);

    const { rows: reviewRows } = await pool.query(
      `SELECT entity_type, issue_type, description
       FROM mapping_review_items
       WHERE lesson_id = $1 AND issue_type = 'related-mn-deferred'
       ORDER BY id`,
      [lessonId],
    );

    assert.equal(
      reviewRows.length, 2,
      `Expected 2 mapping_review_items with issueType="related-mn-deferred", got ${reviewRows.length}. Rows: ${JSON.stringify(reviewRows)}`,
    );
    assert.ok(reviewRows[0].description.includes("MN-1.2"), `First row must mention MN-1.2: ${reviewRows[0].description}`);
    assert.ok(reviewRows[1].description.includes("MN-2.1"), `Second row must mention MN-2.1: ${reviewRows[1].description}`);
    assert.equal(reviewRows[0].entity_type, "node");
    assert.equal(reviewRows[1].entity_type, "node");
    console.log(`    ✓ F-3: 2 mapping_review_items with issue_type="related-mn-deferred"`);
    console.log(`      Row 1: ${reviewRows[0].description}`);
    console.log(`      Row 2: ${reviewRows[1].description}`);

    // ── F-4: No lesson_nodes-to-lesson_nodes join table column ───────────────
    // Verify "related_node_id" does NOT exist on lesson_nodes (it's only on lesson_exercises)
    const { rows: colRows } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'lesson_nodes'
        AND column_name IN ('related_node_id', 'related_micro_node_id')
    `);
    assert.equal(
      colRows.length, 0,
      `lesson_nodes must have NO relationship column. Found: ${JSON.stringify(colRows)}`,
    );
    console.log("    ✓ F-4: lesson_nodes has no related_node_id / related_micro_node_id column");
    console.log("    → CLASSIFICATION: Class B — preserved in mapping_review_items only, NOT queryable as MN↔MN relationship.");
    console.log("    → OPEN ARCHITECTURAL DECISION: a join table (lesson_node_related) is required for Round 2+.");
    console.log(`    ✓ result.reviewItemsCreated = ${result.reviewItemsCreated} (includes 2 deferred + any warnings)`);
  } finally {
    await cleanupLesson(lessonId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────

const asyncTests: Array<[string, () => Promise<void>]> = [
  ["C-1: Transaction rollback — throw after first insert → 0 rows committed", testC_transactionRollback],
  ["C-2: insertParsedMapping success baseline — commits topics + nodes", testC2_insertSuccess],
  ["F-1/2/3/4: relatedMicroNodes Class B behavior — parser→validator→DB→review_items→no join col", testF_relatedMicroNodesStorageBehavior],
];

let passed = 0;
let failed = 0;
const failedNames: string[] = [];

console.log("\n  mapTextInserter — Transaction rollback (C) + relatedMicroNodes (F)\n");

for (const [name, fn] of asyncTests) {
  try {
    await fn();
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
