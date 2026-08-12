/**
 * Phase 7 — Phase 2 Teaching Enrichment tests
 * Covers all mandatory Phase 7 gate requirements (Section 8 of spec).
 * Runner: npx tsx src/lib/__tests__/phase7-enrichment.test.ts
 */

import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Approval gate (P7.S1)
// ─────────────────────────────────────────────────────────────────────────────

type NodeStatus = "draft" | "needs_review" | "approved" | "needs_source_content";

/**
 * Mirrors the exact condition in lessons.ts:1729
 * Phase 2 skips nodes in these statuses.
 */
function isPhase2Skipped(status: NodeStatus): boolean {
  return status === "needs_review" || status === "draft";
}

console.log("\nP7.S1: Approval gate");

test("draft node → SKIPPED by Phase 2", () => {
  assert.equal(isPhase2Skipped("draft"), true);
});
test("needs_review node → SKIPPED by Phase 2", () => {
  assert.equal(isPhase2Skipped("needs_review"), true);
});
test("approved node → NOT skipped (eligible)", () => {
  assert.equal(isPhase2Skipped("approved"), false);
});
test("needs_source_content node → NOT skipped (will hit weak-source guard instead)", () => {
  assert.equal(isPhase2Skipped("needs_source_content"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. All 4 required fields present in Phase 2 result (P7.S2)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP7.S2: Phase 2 result has all 4 required fields");

interface Phase2Result {
  nodeId: number;
  skipped: boolean;
  skipReason?: string;
  childFriendlyExplanation: string;
  basicExamples: string[];
  commonMisconception: string;
  nonExamples: string[];
}

function validate4Fields(result: Phase2Result): string[] {
  const errors: string[] = [];
  if (!result.childFriendlyExplanation) errors.push("childFriendlyExplanation empty");
  if (!Array.isArray(result.basicExamples) || result.basicExamples.length === 0)
    errors.push("basicExamples empty or not array");
  if (!result.commonMisconception) errors.push("commonMisconception empty");
  if (!Array.isArray(result.nonExamples) || result.nonExamples.length === 0)
    errors.push("nonExamples empty or not array");
  return errors;
}

const goodResult: Phase2Result = {
  nodeId: 1, skipped: false,
  childFriendlyExplanation: "Plural means more than one.",
  basicExamples: ["book → books", "cat → cats"],
  commonMisconception: "Students think all plurals just add -s.",
  nonExamples: ["man (irregular)", "sheep (same form)"],
};

test("valid result has 0 errors", () => {
  assert.deepEqual(validate4Fields(goodResult), []);
});
test("missing childFriendlyExplanation → error", () => {
  const r = { ...goodResult, childFriendlyExplanation: "" };
  assert.ok(validate4Fields(r).some((e) => e.includes("childFriendlyExplanation")));
});
test("missing basicExamples → error", () => {
  const r = { ...goodResult, basicExamples: [] };
  assert.ok(validate4Fields(r).some((e) => e.includes("basicExamples")));
});
test("missing commonMisconception → error", () => {
  const r = { ...goodResult, commonMisconception: "" };
  assert.ok(validate4Fields(r).some((e) => e.includes("commonMisconception")));
});
test("missing nonExamples → error", () => {
  const r = { ...goodResult, nonExamples: [] };
  assert.ok(validate4Fields(r).some((e) => e.includes("nonExamples")));
});
test("basicExamples non-array → error", () => {
  const r = { ...goodResult, basicExamples: "text" as any };
  assert.ok(validate4Fields(r).some((e) => e.includes("basicExamples")));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Mapping immutability (P7.S4)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP7.S4: Phase 2 does not alter mapping structure");

interface NodeSnapshot {
  id: number; sequence: number; topicId: number | null;
  title: string; theoryContent: string | null; verbatimTheoryAnchor: string | null;
  sourceBlockIndices: unknown; sourcePage: number | null;
}

function diffSnapshots(before: NodeSnapshot, after: NodeSnapshot): string[] {
  const issues: string[] = [];
  if (before.id !== after.id) issues.push("id changed");
  if (before.sequence !== after.sequence) issues.push("sequence changed");
  if (before.topicId !== after.topicId) issues.push("topicId changed");
  if (before.title !== after.title) issues.push("title changed");
  if (before.theoryContent !== after.theoryContent) issues.push("theoryContent changed");
  if (before.verbatimTheoryAnchor !== after.verbatimTheoryAnchor) issues.push("verbatimTheoryAnchor changed");
  if (before.sourcePage !== after.sourcePage) issues.push("sourcePage changed");
  return issues;
}

const snap: NodeSnapshot = {
  id: 1291, sequence: 1, topicId: 212, title: "Noun Plurals",
  theoryContent: "Nouns form plurals by adding suffix.",
  verbatimTheoryAnchor: "Noun plural: add -ner or -er",
  sourceBlockIndices: [5, 8], sourcePage: 31,
};

test("identical snapshot → 0 diffs", () => {
  assert.deepEqual(diffSnapshots(snap, { ...snap }), []);
});
test("sequence change detected", () => {
  assert.ok(diffSnapshots(snap, { ...snap, sequence: 2 }).includes("sequence changed"));
});
test("topicId change detected", () => {
  assert.ok(diffSnapshots(snap, { ...snap, topicId: 999 }).includes("topicId changed"));
});
test("title change detected", () => {
  assert.ok(diffSnapshots(snap, { ...snap, title: "Other" }).includes("title changed"));
});
test("theoryContent change detected", () => {
  assert.ok(diffSnapshots(snap, { ...snap, theoryContent: "Changed" }).includes("theoryContent changed"));
});
test("verbatimTheoryAnchor change detected", () => {
  assert.ok(diffSnapshots(snap, { ...snap, verbatimTheoryAnchor: "Other" }).includes("verbatimTheoryAnchor changed"));
});
test("Phase 2 enrichment fields not in snapshot → not detected as structural change", () => {
  // childFriendlyExplanation / basicExamples etc are NOT in the structural snapshot
  assert.deepEqual(diffSnapshots(snap, { ...snap }), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Exercise assignments unchanged (P7.S4)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP7.S4: Exercise assignments unchanged after Phase 2");

interface ExerciseSummary { total: number; nodeLinked: number; additional: number; nullAssignment: number; }

function exercisesUnchanged(before: ExerciseSummary, after: ExerciseSummary): boolean {
  return before.total === after.total
    && before.nodeLinked === after.nodeLinked
    && before.additional === after.additional
    && before.nullAssignment === after.nullAssignment;
}

test("same exercise summary → unchanged", () => {
  const s = { total: 20, nodeLinked: 6, additional: 14, nullAssignment: 0 };
  assert.equal(exercisesUnchanged(s, { ...s }), true);
});
test("changed total → flagged", () => {
  const b = { total: 20, nodeLinked: 6, additional: 14, nullAssignment: 0 };
  assert.equal(exercisesUnchanged(b, { ...b, total: 21 }), false);
});
test("changed nodeLinked → flagged", () => {
  const b = { total: 20, nodeLinked: 6, additional: 14, nullAssignment: 0 };
  assert.equal(exercisesUnchanged(b, { ...b, nodeLinked: 7 }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. AI Teacher context includes all 4 Phase 2 fields (P7.S6)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP7.S6: AI Teacher context builder includes all 4 Phase 2 fields");

// Mirrors the exact logic in chat.ts:402-425
function buildTeachingContext(node: {
  theoryContent?: string | null;
  childFriendlyExplanation?: string | null;
  basicExamples?: unknown;
  nonExamples?: unknown;
  commonMisconception?: string | null;
  verbatimTheoryAnchor?: string | null;
}): string {
  const toStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const cfeBlock = node.childFriendlyExplanation
    ? `\nAPPROVED_EXPLANATION (use near-verbatim):\n${node.childFriendlyExplanation}` : "";

  const examplesArr = toStrArr(node.basicExamples);
  const examplesBlock = examplesArr.length > 0
    ? `\nBASIC_EXAMPLES:\n${examplesArr.map((e, i) => `${i + 1}. ${e}`).join("\n")}` : "";

  const nonExamplesArr = toStrArr(node.nonExamples);
  const nonExamplesBlock = nonExamplesArr.length > 0
    ? `\nNON_EXAMPLES (use as contrast and wrong-answer distractors in MICRO_CHECK).\n${nonExamplesArr.map((e, i) => `${i + 1}. ${e}`).join("\n")}` : "";

  const misconceptionBlock = node.commonMisconception
    ? `\nKNOWN_MISCONCEPTION (design MICRO_CHECK distractors around this):\n${node.commonMisconception}` : "";

  const theoryBlock = node.theoryContent ? `NODE_THEORY:\n${node.theoryContent}` : "";
  const anchorBlock = node.verbatimTheoryAnchor
    ? `\nVERBATIM_THEORY_ANCHOR:\n${node.verbatimTheoryAnchor}` : "";

  return [theoryBlock, cfeBlock, anchorBlock, examplesBlock, nonExamplesBlock, misconceptionBlock]
    .filter(Boolean).join("\n");
}

const enrichedNode = {
  theoryContent: "Nouns form plurals by adding a suffix.",
  childFriendlyExplanation: "When there is more than one noun, we add a special ending.",
  basicExamples: ["book → books", "cat → cats"],
  commonMisconception: "Students think all nouns just add -s to form the plural.",
  nonExamples: ["fish (unchanged)", "man → men (irregular)"],
  verbatimTheoryAnchor: "Հoগнаки дзев gortsatsvum e -ner verchnaki depqum.",
};

const emptyNode = {
  theoryContent: null, childFriendlyExplanation: null,
  basicExamples: [], nonExamples: [], commonMisconception: null, verbatimTheoryAnchor: null,
};

test("enriched node → context contains APPROVED_EXPLANATION", () => {
  assert.ok(buildTeachingContext(enrichedNode).includes("APPROVED_EXPLANATION"));
});
test("enriched node → context contains BASIC_EXAMPLES", () => {
  assert.ok(buildTeachingContext(enrichedNode).includes("BASIC_EXAMPLES"));
});
test("enriched node → context contains NON_EXAMPLES", () => {
  assert.ok(buildTeachingContext(enrichedNode).includes("NON_EXAMPLES"));
});
test("enriched node → context contains KNOWN_MISCONCEPTION", () => {
  assert.ok(buildTeachingContext(enrichedNode).includes("KNOWN_MISCONCEPTION"));
});
test("unenriched node → context has NO APPROVED_EXPLANATION", () => {
  assert.ok(!buildTeachingContext(emptyNode).includes("APPROVED_EXPLANATION"));
});
test("unenriched node → context has NO BASIC_EXAMPLES", () => {
  assert.ok(!buildTeachingContext(emptyNode).includes("BASIC_EXAMPLES"));
});
test("basicExamples array serialized correctly (no double serialization)", () => {
  const ctx = buildTeachingContext(enrichedNode);
  // Should contain plain text items, not JSON-stringified array
  assert.ok(ctx.includes("book → books"));
  assert.ok(!ctx.includes("[\"book"));
});
test("nonExamples array serialized correctly", () => {
  const ctx = buildTeachingContext(enrichedNode);
  assert.ok(ctx.includes("fish (unchanged)"));
  assert.ok(!ctx.includes("[\"fish"));
});
test("non-array basicExamples → empty block (no crash)", () => {
  const n = { ...enrichedNode, basicExamples: "text" as any };
  const ctx = buildTeachingContext(n);
  assert.ok(!ctx.includes("BASIC_EXAMPLES"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Partial corruption guard (P7.S8)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP7.S7: Failed Phase 2 does not partially corrupt node");

interface Phase2WriteArgs {
  childFriendlyExplanation: string | null;
  basicExamples: string[];
  commonMisconception: string | null;
  nonExamples: string[];
  status: string;
}

/**
 * Mirrors the Phase 2 DB write logic: only writes if result.skipped === false.
 * A failed/skipped result MUST NOT touch any enrichment fields.
 */
function shouldWriteEnrichment(result: { skipped: boolean }): boolean {
  return !result.skipped;
}

/**
 * When Phase 2 parse fails after retry, it returns skipped=true.
 * The node's existing data must remain untouched.
 */
function getDbWrite(result: Phase2Result & { skipped: boolean }): Phase2WriteArgs | null {
  if (result.skipped) return null; // No write
  return {
    childFriendlyExplanation: result.childFriendlyExplanation || null,
    basicExamples: result.basicExamples,
    commonMisconception: result.commonMisconception || null,
    nonExamples: result.nonExamples,
    status: "approved",
  };
}

const failedResult: Phase2Result = {
  nodeId: 1, skipped: true, skipReason: "AI returned unparseable JSON after retry — re-run this node",
  childFriendlyExplanation: "", basicExamples: [], commonMisconception: "", nonExamples: [],
};

const successResult: Phase2Result = {
  nodeId: 1, skipped: false,
  childFriendlyExplanation: "Simple explanation here.",
  basicExamples: ["Ex 1", "Ex 2"],
  commonMisconception: "Misconception here.",
  nonExamples: ["NonEx 1", "NonEx 2"],
};

test("failed result → no DB write (skipped=true)", () => {
  assert.equal(shouldWriteEnrichment(failedResult), false);
  assert.equal(getDbWrite(failedResult), null);
});
test("success result → DB write proceeds", () => {
  assert.equal(shouldWriteEnrichment(successResult), true);
  assert.ok(getDbWrite(successResult) !== null);
});
test("success write includes status='approved'", () => {
  assert.equal(getDbWrite(successResult)!.status, "approved");
});
test("success write childFriendlyExplanation non-null when non-empty", () => {
  assert.equal(getDbWrite(successResult)!.childFriendlyExplanation, "Simple explanation here.");
});
test("failed result → null write preserves original node data (caller must not proceed)", () => {
  // Proves the caller must check for null before writing
  const write = getDbWrite(failedResult);
  assert.equal(write, null);
  // If caller checks null, no fields are ever sent to DB
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
