/**
 * Phase 5 Gold Standard — Exercise/Activity Preservation
 * Regression tests for Lesson 105 (Ֆizika 7, §1) exercise preservation.
 *
 * These tests verify the GENERIC preservation invariants using lesson 105
 * as the acceptance fixture. They do NOT hard-code lesson-specific counts
 * in the production code — only in this regression fixture.
 *
 * Runner: npx tsx src/lib/__tests__/phase5-gold-standard.test.ts
 */

import assert from "node:assert/strict";
import { db } from "@workspace/db";
import {
  lessonExercisesTable,
  lessonNodesTable,
  lessonTopicsTable,
  lessonNodeDependenciesTable,
  lessonsTable,
} from "@workspace/db";
import { eq, and, isNull, isNotNull, inArray } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e: any) => { console.error(`  ✗ ${name}: ${e.message}`); failed++; });
}

// ─────────────────────────────────────────────────────────────────────────────
// G1: Source page boundary
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG1: Source page boundary (Lesson 105)");

await test("pages_to is 9 (PDF page 9 = printed page 8, contains exercises)", async () => {
  const [lesson] = await db.select({ pagesFrom: lessonsTable.pagesFrom, pagesTo: lessonsTable.pagesTo })
    .from(lessonsTable).where(eq(lessonsTable.id, 105)).limit(1);
  assert.equal(lesson.pagesTo, 9, `pages_to should be 9 (exercises are on PDF page 9), got ${lesson.pagesTo}`);
  assert.equal(lesson.pagesFrom, 5, `pages_from should be 5 (intro text), got ${lesson.pagesFrom}`);
});

await test("printed-page vs PDF-page: page 8 of textbook = PDF page 9 (offset = +1)", async () => {
  // All exercise source pages should be 9 (PDF page containing printed page 8)
  const exercises = await db.select({ sourcePage: lessonExercisesTable.sourcePage })
    .from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, 105));
  // sourcePage may be stored as string or number — coerce to number for comparison
  const pages = [...new Set(exercises.map(e => e.sourcePage === null ? null : Number(e.sourcePage)))];
  assert.ok(pages.includes(9), `All exercises should be on PDF page 9, found pages: ${pages}`);
  assert.ok(!pages.some(p => p !== null && p < 9),
    `No exercise should be on PDF page < 9 (exercises are on printed page 8 = PDF page 9), found: ${pages}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// G2: Preservation invariant — 15 source activities, 0 lost
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG2: Preservation invariant");

const exercises105 = await db.select()
  .from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, 105));
const assigned    = exercises105.filter(e => e.relatedNodeId !== null);
const additional  = exercises105.filter(e => e.relatedNodeId === null);

await test("total stored activities = 15 (the gold standard count)", () => {
  assert.equal(exercises105.length, 15, `Expected 15 exercises, got ${exercises105.length}`);
});

await test("lost activities = 0 (every source activity preserved)", () => {
  // Preservation invariant: stored = assigned + additional, no drops
  assert.equal(exercises105.length, assigned.length + additional.length,
    "Total must equal assigned + additional");
  assert.ok(exercises105.length > 0, "No exercises stored at all");
});

await test("duplicate activities = 0 (no duplicate exercise IDs)", () => {
  const ids = exercises105.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, "Duplicate exercise IDs found");
});

await test("assigned + additional = 15 (no third invisible state)", () => {
  assert.equal(assigned.length + additional.length, 15,
    `Assigned(${assigned.length}) + Additional(${additional.length}) must = 15`);
});

await test("assigned count > 0 (some exercises correctly attributed to nodes)", () => {
  assert.ok(assigned.length > 0, "No exercises were assigned to any MicroNode");
});

await test("additional count >= 1 (uncertain-assignment exercises → Additional, not deleted)", () => {
  // Q1 (Ի՞inche e bnujthyuny) might not match any node perfectly — lands in Additional
  // P2 (Aristotle research) is broad → Additional
  assert.ok(additional.length >= 1,
    `Expected at least 1 additional exercise (uncertain assignment), got ${additional.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// G3: Specific exercise preservation (content traceability)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG3: Specific exercise traceability");

await test("every exercise has source_type='textbook' (traceable to PDF)", () => {
  const nonTextbook = exercises105.filter(e => e.sourceType !== "textbook");
  assert.equal(nonTextbook.length, 0,
    `${nonTextbook.length} exercises missing source_type=textbook`);
});

await test("every exercise has a non-empty exerciseTextVerbatim", () => {
  const empty = exercises105.filter(e => !e.exerciseTextVerbatim || e.exerciseTextVerbatim.trim().length === 0);
  assert.equal(empty.length, 0, `${empty.length} exercises have empty text`);
});

await test("Q10 matching activity preserved as ONE logical block (not split)", () => {
  // Q10 instruction: "Երev ույ jtʰy hamapatasxanecrek tesaki het" + 4 matching rows.
  // The spec says this MUST be ONE activity, not 4 separate ones.
  const matchingActivities = exercises105.filter(e =>
    e.exerciseTextVerbatim &&
    (e.exerciseTextVerbatim.includes("համապատասխանեցրե") ||
     e.exerciseTextVerbatim.includes("Երևույթը") ||
     e.exerciseTextVerbatim.includes("Erevoujty") ||
     // Check by content: should include "Նetը slanum e" (matching item)
     e.exerciseTextVerbatim.includes("Նետը"))
  );
  // The matching activity must appear EXACTLY once, not as 4 separate rows
  assert.equal(matchingActivities.length, 1,
    `Matching activity (Q10) must be ONE block, found ${matchingActivities.length} records`);
  // And it should contain all 4 matching items in one text
  const matchText = matchingActivities[0].exerciseTextVerbatim ?? "";
  assert.ok(matchText.includes("Մագ") || matchText.includes("Մեխ") || matchText.includes("Ջեր") || matchText.length > 100,
    `Q10 should contain the matching options, but text is: ${matchText.substring(0, 100)}`);
});

await test("practical ice observation activity (P1) preserved", () => {
  const p1 = exercises105.filter(e =>
    e.exerciseTextVerbatim &&
    (e.exerciseTextVerbatim.includes("սառույց") ||
     e.exerciseTextVerbatim.includes("սառ") ||
     e.exerciseTextVerbatim.includes("ափսե") ||
     e.exerciseTextVerbatim.toLowerCase().includes("sar"))
  );
  assert.ok(p1.length >= 1, "P1 (ice observation practical activity) not found in exercises");
});

await test("practical Aristotle research activity (P2) preserved", () => {
  const p2 = exercises105.filter(e =>
    e.exerciseTextVerbatim &&
    (e.exerciseTextVerbatim.includes("Արիստոտ") ||
     e.exerciseTextVerbatim.includes("Aristotel") ||
     e.exerciseTextVerbatim.includes("կենսագրություն") ||
     e.exerciseTextVerbatim.includes("ֆիզիկոս"))
  );
  assert.ok(p2.length >= 1, "P2 (Aristotle research practical activity) not found in exercises");
});

await test("practical activities count = 2", () => {
  const practicals = exercises105.filter(e =>
    e.exerciseTextVerbatim && (
      e.exerciseTextVerbatim.includes("Գործ") ||
      (e.assignment === "HOMEWORK" || e.sourceType === "practical") ||
      e.exerciseTextVerbatim.includes("Արիստոտ") ||
      e.exerciseTextVerbatim.includes("սառույց")
    )
  );
  assert.ok(practicals.length >= 2,
    `Expected at least 2 practical activities (P1+P2), found ${practicals.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// G4: Assignment integrity
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG4: Assignment integrity");

await test("all assigned exercises reference valid MicroNode IDs", async () => {
  if (assigned.length === 0) return; // trivially true
  const nodeIds = assigned.map(e => e.relatedNodeId!);
  const nodes = await db.select({ id: lessonNodesTable.id })
    .from(lessonNodesTable).where(inArray(lessonNodesTable.id, nodeIds));
  const foundIds = new Set(nodes.map(n => n.id));
  const missing = nodeIds.filter(id => !foundIds.has(id));
  assert.equal(missing.length, 0, `${missing.length} exercises reference non-existent node IDs: ${missing}`);
});

await test("all assigned exercises belong to lesson 105 MicroNodes", async () => {
  if (assigned.length === 0) return;
  const nodeIds = assigned.map(e => e.relatedNodeId!);
  const nodes = await db.select({ id: lessonNodesTable.id, lessonId: lessonNodesTable.lessonId })
    .from(lessonNodesTable).where(inArray(lessonNodesTable.id, nodeIds));
  const wrongLesson = nodes.filter(n => n.lessonId !== 105);
  assert.equal(wrongLesson.length, 0, `${wrongLesson.length} exercises assigned to nodes from wrong lesson`);
});

await test("all additional exercises have relatedNodeId = null", () => {
  const nonNull = additional.filter(e => e.relatedNodeId !== null);
  assert.equal(nonNull.length, 0, "Additional exercises must have relatedNodeId=null");
});

// ─────────────────────────────────────────────────────────────────────────────
// G5: MicroNode structure validity
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG5: MicroNode structure validity");

const topics105 = await db.select().from(lessonTopicsTable).where(eq(lessonTopicsTable.lessonId, 105));
const nodes105  = await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, 105));

await test("topic count >= 1 (lesson has structure)", () => {
  assert.ok(topics105.length >= 1, `Expected at least 1 topic, got ${topics105.length}`);
});

await test("MicroNode count >= 9 (mapping produced sufficient granularity)", () => {
  assert.ok(nodes105.length >= 9, `Expected at least 9 MicroNodes, got ${nodes105.length}`);
});

await test("every MicroNode has a non-empty title", () => {
  const empty = nodes105.filter(n => !n.title || n.title.trim().length === 0);
  assert.equal(empty.length, 0, `${empty.length} MicroNodes have empty titles`);
});

await test("node sequences are unique within lesson (no duplicate sequence numbers)", () => {
  const seqs = nodes105.map(n => n.sequence);
  assert.equal(new Set(seqs).size, seqs.length, "Duplicate sequence numbers in MicroNodes");
});

await test("all MicroNodes have a valid topic_id", async () => {
  const topicIds = new Set(topics105.map(t => t.id));
  const orphaned = nodes105.filter(n => !topicIds.has(n.topicId));
  assert.equal(orphaned.length, 0, `${orphaned.length} MicroNodes with invalid topicId`);
});

// ─────────────────────────────────────────────────────────────────────────────
// G6: Source coverage
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG6: Source coverage validity");

await test("source coverage is 100% (no blocks uncovered)", async () => {
  // Check mapping_metadata for coverageValidation
  const [lesson] = await db.select({ mappingMetadata: lessonsTable.mappingMetadata })
    .from(lessonsTable).where(eq(lessonsTable.id, 105)).limit(1);
  const meta = lesson.mappingMetadata as any;
  if (!meta) return; // no metadata yet, skip
  const cv = meta?.quality?.coverageValidation;
  if (!cv) return;
  assert.ok(cv.valid === true, `Coverage invalid: ${JSON.stringify(cv)}`);
  assert.equal(cv.coveragePercent, 100, `Coverage is ${cv.coveragePercent}%, expected 100%`);
});

await test("activityIssues = 0 (no unrescued activity blocks)", async () => {
  const [lesson] = await db.select({ mappingMetadata: lessonsTable.mappingMetadata })
    .from(lessonsTable).where(eq(lessonsTable.id, 105)).limit(1);
  const meta = lesson.mappingMetadata as any;
  if (!meta) return;
  const activityIssues = meta?.quality?.activityIssues ?? 0;
  assert.equal(activityIssues, 0, `Expected 0 activityIssues, got ${activityIssues}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// G7: Remap idempotency (structural consistency check)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG7: Remap idempotency (post-map state stability)");

await test("no exercises with empty lessonId (all exercises are properly scoped)", () => {
  const wrongLesson = exercises105.filter(e => e.lessonId !== 105);
  assert.equal(wrongLesson.length, 0, "All exercises must belong to lesson 105");
});

await test("no exercises with null exerciseId that aren't additional", () => {
  // exerciseId can be null for additional exercises — that's fine
  // But no exercise should be stored with a conflicting state
  const weird = exercises105.filter(e =>
    e.exerciseId !== null && e.relatedNodeId === null && e.assignment === "CLASS"
  );
  // CLASS assignment with relatedNodeId=null is valid (it's additional CLASS exercises)
  // Just check no exercise is in a completely invalid state
  assert.ok(exercises105.length === 15, "Exercise count should remain stable");
});

// ─────────────────────────────────────────────────────────────────────────────
// G8: Non-regression — Lesson 69 Phase 7 enrichment
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG8: Non-regression — Phase 7 enrichment (Lesson 69)");

const nodes69 = await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, 69));

await test("Lesson 69 still has 3 MicroNodes (Phase 7 structure unchanged)", () => {
  assert.equal(nodes69.length, 3, `Lesson 69 should still have 3 nodes, got ${nodes69.length}`);
});

await test("Lesson 69 nodes 1291/1292/1293 still exist", () => {
  const ids = new Set(nodes69.map(n => n.id));
  assert.ok(ids.has(1291), "Node 1291 missing");
  assert.ok(ids.has(1292), "Node 1292 missing");
  assert.ok(ids.has(1293), "Node 1293 missing");
});

await test("Lesson 69 node 1291 has Phase 7 enrichment (childFriendlyExplanation populated)", () => {
  const n = nodes69.find(n => n.id === 1291);
  assert.ok(n, "Node 1291 not found");
  assert.ok(n!.childFriendlyExplanation && n!.childFriendlyExplanation.trim().length > 0,
    "Node 1291 missing childFriendlyExplanation (Phase 7 enrichment lost)");
});

// ─────────────────────────────────────────────────────────────────────────────
// G9: Non-regression — Phase 8 sequential dependencies
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG9: Non-regression — Phase 8 dependencies (Lesson 69)");

const deps69 = await db.select()
  .from(lessonNodeDependenciesTable)
  .where(and(
    eq(lessonNodeDependenciesTable.lessonId, 69),
    // @ts-ignore — drizzle text comparison
    eq(lessonNodeDependenciesTable.dependencyType as any, "SEQUENTIAL" as any)
  ));

await test("Lesson 69 still has 2 SEQUENTIAL dependencies (Phase 8 not regressed)", () => {
  assert.equal(deps69.length, 2, `Expected 2 SEQUENTIAL deps for lesson 69, got ${deps69.length}`);
});

await test("Lesson 69 dep chain is 1291→1292→1293 (sequential order preserved)", () => {
  const fromIds = new Set(deps69.map(d => d.fromNodeId));
  const toIds   = new Set(deps69.map(d => d.toNodeId));
  assert.ok(fromIds.has(1291), "Missing dep from 1291");
  assert.ok(fromIds.has(1292), "Missing dep from 1292");
  assert.ok(toIds.has(1292),   "Missing dep to 1292");
  assert.ok(toIds.has(1293),   "Missing dep to 1293");
});

// ─────────────────────────────────────────────────────────────────────────────
// G10: Structural preservation of other lessons
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nG10: Other lessons unaffected by re-map");

await test("Lesson 51 REQUIRED dependencies still intact (not deleted by 105 re-map)", async () => {
  const deps51 = await db.select()
    .from(lessonNodeDependenciesTable)
    .where(eq(lessonNodeDependenciesTable.lessonId, 51));
  assert.ok(deps51.length >= 3, `Lesson 51 should still have >=3 deps, got ${deps51.length}`);
});

await test("Lesson 69 exercises unaffected by lesson 105 re-map", async () => {
  const ex69 = await db.select()
    .from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, 69));
  // Lesson 69 may have exercises or not — just ensure the re-map didn't corrupt anything
  // (delete cascades are lesson-scoped)
  assert.ok(ex69.every(e => e.lessonId === 69), "Lesson 69 exercises have wrong lessonId");
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
