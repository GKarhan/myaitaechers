/**
 * Phase 9 — Knowledge Base Validation Tests
 *
 * Tests P9.1–P9.20 as specified.
 * Pure gate functions are tested with in-memory fixture data (no DB needed).
 * P9.17–P9.20 use the real DB for Lesson 105.
 */

import assert from "node:assert/strict";
import {
  gateSourceCoverage,
  gateActivityIntegrity,
  gateMicroNodeIntegrity,
  gatePhase2Enrichment,
  gateDependencies,
  assembleResult,
  validateKnowledgeBaseLesson,
} from "../kb-validator";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e: any) => { console.error(`  ✗ ${name}: ${e.message}`); failed++; });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const VALID_META = {
  quality: {
    coverageValidation: { valid: true, coveragePercent: 100 },
    activityIssues: 0,
  },
  counts: { exercisesCreated: 3, topicsCreated: 1, microNodesCreated: 3 },
};

const NODES_DRAFT = [
  { id: 1, title: "Node A", theoryContent: "Theory A content", sequence: 1 },
  { id: 2, title: "Node B", theoryContent: "Theory B content", sequence: 2 },
  { id: 3, title: "Node C", theoryContent: "Theory C content", sequence: 3 },
];

const NODES_APPROVED_FULL = [
  {
    id: 1, status: "approved", title: "Node A", theoryContent: "Theory A",
    sequence: 1,
    childFriendlyExplanation: "Simple explanation A",
    basicExamples: ["example1"],
    commonMisconception: "People think X but really Y",
    nonExamples: ["not this"],
  },
  {
    id: 2, status: "approved", title: "Node B", theoryContent: "Theory B",
    sequence: 2,
    childFriendlyExplanation: "Simple explanation B",
    basicExamples: ["example2"],
    commonMisconception: "People think P but really Q",
    nonExamples: ["not that"],
  },
  {
    id: 3, status: "approved", title: "Node C", theoryContent: "Theory C",
    sequence: 3,
    childFriendlyExplanation: "Simple explanation C",
    basicExamples: ["example3"],
    commonMisconception: "People think M but really N",
    nonExamples: ["nor this"],
  },
];

const EXERCISES_VALID = [
  { id: 10, relatedNodeId: 1, sourceBlockIndex: 5 },
  { id: 11, relatedNodeId: 2, sourceBlockIndex: 6 },
  { id: 12, relatedNodeId: null, sourceBlockIndex: 7 },  // additional — valid
];

const DEPS_VALID = [
  { id: 100, lessonId: 99, fromNodeId: 1, toNodeId: 2 },
  { id: 101, lessonId: 99, fromNodeId: 2, toNodeId: 3 },
];

const NODE_IDS_99 = new Set([1, 2, 3]);

// ─────────────────────────────────────────────────────────────────────────────
// P9.1 — Healthy lesson → PASS
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.1 — Healthy lesson → PASS");

await test("healthy lesson: all gates pass, readyForAiTeacher=true", () => {
  const cov = gateSourceCoverage(VALID_META);
  const act = gateActivityIntegrity(EXERCISES_VALID, 3);
  const mn  = gateMicroNodeIntegrity(NODES_DRAFT);
  const p2  = gatePhase2Enrichment(NODES_APPROVED_FULL);
  const dep = gateDependencies(DEPS_VALID, 99, NODE_IDS_99);
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.ok(r.valid, `Should be valid; errors: ${r.errors.join("; ")}`);
  assert.ok(r.readyForAiTeacher, "Should be ready for AI Teacher");
  assert.equal(r.errors.length, 0, `No errors expected: ${r.errors.join("; ")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.2 — Missing source block → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.2 — Missing source block → FAIL");

await test("invalid coverage → coverage gate invalid", () => {
  const meta = { quality: { coverageValidation: { valid: false, coveragePercent: 80 } }, counts: {} };
  const cov = gateSourceCoverage(meta);
  assert.equal(cov.valid, false);
  assert.equal(cov.coveragePercent, 80);
});

await test("null metadata → coverage gate invalid with note", () => {
  const cov = gateSourceCoverage(null);
  assert.equal(cov.valid, false);
  assert.ok(cov.note && cov.note.length > 0);
});

await test("missing coverageValidation key → invalid with note", () => {
  const cov = gateSourceCoverage({ counts: {} });
  assert.equal(cov.valid, false);
  assert.ok(cov.note && cov.note.includes("absent"));
});

await test("invalid coverage → assembleResult produces error", () => {
  const cov = gateSourceCoverage({ quality: { coverageValidation: { valid: false, coveragePercent: 90 } }, counts: {} });
  const act = gateActivityIntegrity(EXERCISES_VALID, 3);
  const mn  = gateMicroNodeIntegrity(NODES_DRAFT);
  const p2  = gatePhase2Enrichment([]);
  const dep = gateDependencies([], 99, NODE_IDS_99);
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("[COVERAGE]")));
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.3 — Lost activity → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.3 — Lost activity → FAIL");

await test("sourceCount > storedCount → lostCount > 0 → invalid", () => {
  // Pipeline created 5, but only 3 remain in DB
  const act = gateActivityIntegrity(EXERCISES_VALID, 5);
  assert.equal(act.lostCount, 2);
  assert.equal(act.valid, false);
});

await test("lost activity → assembleResult produces error", () => {
  const cov = gateSourceCoverage(VALID_META);
  const act = gateActivityIntegrity(EXERCISES_VALID, 5);
  const mn  = gateMicroNodeIntegrity(NODES_DRAFT);
  const p2  = gatePhase2Enrichment([]);
  const dep = gateDependencies([], 99, NODE_IDS_99);
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("[ACTIVITY]") && e.includes("lost")));
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.4 — Duplicate activity → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.4 — Duplicate activity → FAIL");

await test("two exercises share same sourceBlockIndex → duplicateCount > 0 → invalid", () => {
  const dupExercises = [
    { id: 10, relatedNodeId: 1, sourceBlockIndex: 5 },
    { id: 11, relatedNodeId: 2, sourceBlockIndex: 5 },  // duplicate sourceBlockIndex!
    { id: 12, relatedNodeId: null, sourceBlockIndex: 7 },
  ];
  const act = gateActivityIntegrity(dupExercises, 3);
  assert.equal(act.duplicateCount, 1);
  assert.equal(act.valid, false);
});

await test("duplicate activity → assembleResult produces error", () => {
  const dupExercises = [
    { id: 10, relatedNodeId: 1, sourceBlockIndex: 5 },
    { id: 11, relatedNodeId: 2, sourceBlockIndex: 5 },
  ];
  const cov = gateSourceCoverage(VALID_META);
  const act = gateActivityIntegrity(dupExercises, 2);
  const mn  = gateMicroNodeIntegrity(NODES_DRAFT);
  const p2  = gatePhase2Enrichment([]);
  const dep = gateDependencies([], 99, NODE_IDS_99);
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("[ACTIVITY]") && e.includes("duplicate")));
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.5 — Additional Exercise preserved → PASS (not an error)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.5 — Additional Exercise preserved → PASS");

await test("exercise with relatedNodeId=null → additional, valid", () => {
  const exercises = [
    { id: 10, relatedNodeId: 1, sourceBlockIndex: 5 },
    { id: 11, relatedNodeId: null, sourceBlockIndex: 6 },  // additional
    { id: 12, relatedNodeId: null, sourceBlockIndex: 7 },  // additional
  ];
  const act = gateActivityIntegrity(exercises, 3);
  assert.equal(act.additionalCount, 2);
  assert.equal(act.lostCount, 0);
  assert.equal(act.duplicateCount, 0);
  assert.ok(act.valid);
});

await test("additional exercises → assembleResult: no error, only warning", () => {
  const exercises = [{ id: 10, relatedNodeId: null, sourceBlockIndex: 5 }];
  const cov = gateSourceCoverage(VALID_META);
  const act = gateActivityIntegrity(exercises, 1);
  const mn  = gateMicroNodeIntegrity(NODES_DRAFT);
  const p2  = gatePhase2Enrichment([]);
  const dep = gateDependencies([], 99, NODE_IDS_99);
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.ok(!r.errors.some((e) => e.includes("additional")),
    "Additional exercises must NOT be errors");
  assert.ok(r.warnings.some((w) => w.includes("Additional")),
    "Additional exercises should appear as warning");
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.6 — Zero MicroNodes → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.6 — Zero MicroNodes → FAIL");

await test("empty nodes array → microNodes gate invalid", () => {
  const mn = gateMicroNodeIntegrity([]);
  assert.equal(mn.total, 0);
  assert.equal(mn.valid, false);
});

await test("zero nodes → assembleResult produces error", () => {
  const cov = gateSourceCoverage(VALID_META);
  const act = gateActivityIntegrity([], 0);
  const mn  = gateMicroNodeIntegrity([]);
  const p2  = gatePhase2Enrichment([]);
  const dep = gateDependencies([], 99, new Set());
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("[MICRONODE]") && e.includes("No MicroNodes")));
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.7 — Empty MicroNode theory → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.7 — Empty MicroNode theory → FAIL");

await test("null theoryContent → emptyCount > 0 → invalid", () => {
  const nodes = [{ id: 1, title: "Node A", theoryContent: null, sequence: 1 }];
  const mn = gateMicroNodeIntegrity(nodes);
  assert.equal(mn.emptyCount, 1);
  assert.equal(mn.valid, false);
});

await test("whitespace-only theoryContent → emptyCount > 0 → invalid", () => {
  const nodes = [{ id: 1, title: "Node A", theoryContent: "   \n\t  ", sequence: 1 }];
  const mn = gateMicroNodeIntegrity(nodes);
  assert.equal(mn.emptyCount, 1);
  assert.equal(mn.valid, false);
});

await test("empty theory → assembleResult produces error", () => {
  const nodes = [{ id: 1, title: "Node A", theoryContent: null, sequence: 1 }];
  const cov = gateSourceCoverage(VALID_META);
  const act = gateActivityIntegrity([], 0);
  const mn  = gateMicroNodeIntegrity(nodes);
  const p2  = gatePhase2Enrichment([]);
  const dep = gateDependencies([], 99, new Set([1]));
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("[MICRONODE]") && e.toLowerCase().includes("empty")));
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.8 — Invalid sequence → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.8 — Invalid sequence → FAIL");

await test("sequence = 0 → invalidSequenceCount > 0 → invalid", () => {
  const nodes = [
    { id: 1, title: "A", theoryContent: "Theory A", sequence: 0 },  // invalid: 0
    { id: 2, title: "B", theoryContent: "Theory B", sequence: 1 },
  ];
  const mn = gateMicroNodeIntegrity(nodes);
  assert.ok(mn.invalidSequenceCount > 0);
  assert.equal(mn.valid, false);
});

await test("negative sequence → invalidSequenceCount > 0 → invalid", () => {
  const nodes = [{ id: 1, title: "A", theoryContent: "Theory A", sequence: -5 }];
  const mn = gateMicroNodeIntegrity(nodes);
  assert.ok(mn.invalidSequenceCount > 0);
  assert.equal(mn.valid, false);
});

await test("duplicate sequence within lesson → invalidSequenceCount > 0 → invalid", () => {
  const nodes = [
    { id: 1, title: "A", theoryContent: "Theory A", sequence: 1 },
    { id: 2, title: "B", theoryContent: "Theory B", sequence: 1 },  // duplicate!
  ];
  const mn = gateMicroNodeIntegrity(nodes);
  assert.ok(mn.invalidSequenceCount > 0);
  assert.equal(mn.valid, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.9–P9.12 — Approved node missing Phase 2 fields → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.9–P9.12 — Approved node missing Phase 2 fields → FAIL");

const baseApproved = {
  id: 1,
  status: "approved",
  childFriendlyExplanation: "Simple explanation",
  basicExamples: ["example1"],
  commonMisconception: "Common mistake X",
  nonExamples: ["not this"],
};

await test("P9.9 — missing childFriendlyExplanation → missingEnrichmentCount > 0", () => {
  const node = { ...baseApproved, childFriendlyExplanation: null };
  const p2 = gatePhase2Enrichment([node]);
  assert.equal(p2.approvedNodeCount, 1);
  assert.equal(p2.missingEnrichmentCount, 1);
  assert.equal(p2.valid, false);
});

await test("P9.10 — missing basicExamples (empty array) → missingEnrichmentCount > 0", () => {
  const node = { ...baseApproved, basicExamples: [] };
  const p2 = gatePhase2Enrichment([node]);
  assert.equal(p2.missingEnrichmentCount, 1);
  assert.equal(p2.valid, false);
});

await test("P9.10 — missing basicExamples (empty JSON string) → missingEnrichmentCount > 0", () => {
  const node = { ...baseApproved, basicExamples: "[]" };
  const p2 = gatePhase2Enrichment([node]);
  assert.equal(p2.missingEnrichmentCount, 1);
  assert.equal(p2.valid, false);
});

await test("P9.11 — missing commonMisconception → missingEnrichmentCount > 0", () => {
  const node = { ...baseApproved, commonMisconception: null };
  const p2 = gatePhase2Enrichment([node]);
  assert.equal(p2.missingEnrichmentCount, 1);
  assert.equal(p2.valid, false);
});

await test("P9.12 — missing nonExamples (empty array) → missingEnrichmentCount > 0", () => {
  const node = { ...baseApproved, nonExamples: [] };
  const p2 = gatePhase2Enrichment([node]);
  assert.equal(p2.missingEnrichmentCount, 1);
  assert.equal(p2.valid, false);
});

await test("draft node with missing enrichment → NOT an error (only approved nodes checked)", () => {
  const node = {
    id: 1, status: "draft",
    childFriendlyExplanation: null,
    basicExamples: [],
    commonMisconception: null,
    nonExamples: [],
  };
  const p2 = gatePhase2Enrichment([node]);
  assert.equal(p2.approvedNodeCount, 0);
  assert.equal(p2.missingEnrichmentCount, 0);
  assert.ok(p2.valid);
});

await test("missing enrichment → assembleResult produces error", () => {
  const node = { ...baseApproved, childFriendlyExplanation: null };
  const cov = gateSourceCoverage(VALID_META);
  const act = gateActivityIntegrity([], 0);
  const mn  = gateMicroNodeIntegrity([{ id: 1, title: "A", theoryContent: "T", sequence: 1 }]);
  const p2  = gatePhase2Enrichment([node]);
  const dep = gateDependencies([], 99, new Set([1]));
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("[PHASE2]")));
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.13 — Valid A→B→C dependencies → PASS
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.13 — Valid A→B→C dependencies → PASS");

await test("A→B→C chain: no invalid refs, no cycles, no self-deps", () => {
  const dep = gateDependencies(DEPS_VALID, 99, NODE_IDS_99);
  assert.ok(dep.valid, `Should be valid; ${JSON.stringify(dep)}`);
  assert.equal(dep.cycleDetected, false);
  assert.equal(dep.invalidReferenceCount, 0);
  assert.equal(dep.selfDependencyCount, 0);
  assert.equal(dep.duplicateEdgeCount, 0);
});

await test("no dependencies → dep gate valid (dependencies are optional)", () => {
  const dep = gateDependencies([], 99, NODE_IDS_99);
  assert.ok(dep.valid);
  assert.equal(dep.total, 0);
  assert.equal(dep.cycleDetected, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.14 — Dependency references nonexistent node → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.14 — Nonexistent node reference → FAIL");

await test("fromNodeId not in lesson → invalidReferenceCount > 0 → invalid", () => {
  const badDeps = [{ id: 100, lessonId: 99, fromNodeId: 999, toNodeId: 2 }];
  const dep = gateDependencies(badDeps, 99, NODE_IDS_99);
  assert.ok(dep.invalidReferenceCount > 0);
  assert.equal(dep.valid, false);
});

await test("toNodeId not in lesson → invalidReferenceCount > 0 → invalid", () => {
  const badDeps = [{ id: 100, lessonId: 99, fromNodeId: 1, toNodeId: 999 }];
  const dep = gateDependencies(badDeps, 99, NODE_IDS_99);
  assert.ok(dep.invalidReferenceCount > 0);
  assert.equal(dep.valid, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.15 — Self dependency → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.15 — Self dependency → FAIL");

await test("fromNodeId === toNodeId → selfDependencyCount > 0 → invalid", () => {
  const selfDeps = [{ id: 100, lessonId: 99, fromNodeId: 1, toNodeId: 1 }];
  const dep = gateDependencies(selfDeps, 99, NODE_IDS_99);
  assert.equal(dep.selfDependencyCount, 1);
  assert.equal(dep.valid, false);
});

await test("self dependency → assembleResult produces error", () => {
  const selfDeps = [{ id: 100, lessonId: 99, fromNodeId: 1, toNodeId: 1 }];
  const cov = gateSourceCoverage(VALID_META);
  const act = gateActivityIntegrity([], 0);
  const mn  = gateMicroNodeIntegrity(NODES_DRAFT);
  const p2  = gatePhase2Enrichment([]);
  const dep = gateDependencies(selfDeps, 99, NODE_IDS_99);
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("[DEPS]") && e.includes("self-dependency")));
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.16 — A→B→A cycle → FAIL
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.16 — A→B→A cycle → FAIL");

await test("A→B, B→A → cycleDetected=true → invalid", () => {
  const cycleDeps = [
    { id: 100, lessonId: 99, fromNodeId: 1, toNodeId: 2 },
    { id: 101, lessonId: 99, fromNodeId: 2, toNodeId: 1 },
  ];
  const dep = gateDependencies(cycleDeps, 99, NODE_IDS_99);
  assert.equal(dep.cycleDetected, true);
  assert.equal(dep.valid, false);
});

await test("A→B→C→A three-node cycle → cycleDetected=true → invalid", () => {
  const cycleDeps = [
    { id: 100, lessonId: 99, fromNodeId: 1, toNodeId: 2 },
    { id: 101, lessonId: 99, fromNodeId: 2, toNodeId: 3 },
    { id: 102, lessonId: 99, fromNodeId: 3, toNodeId: 1 },
  ];
  const dep = gateDependencies(cycleDeps, 99, NODE_IDS_99);
  assert.equal(dep.cycleDetected, true);
  assert.equal(dep.valid, false);
});

await test("cycle → assembleResult produces error", () => {
  const cycleDeps = [
    { id: 100, lessonId: 99, fromNodeId: 1, toNodeId: 2 },
    { id: 101, lessonId: 99, fromNodeId: 2, toNodeId: 1 },
  ];
  const cov = gateSourceCoverage(VALID_META);
  const act = gateActivityIntegrity([], 0);
  const mn  = gateMicroNodeIntegrity(NODES_DRAFT);
  const p2  = gatePhase2Enrichment([]);
  const dep = gateDependencies(cycleDeps, 99, NODE_IDS_99);
  const r   = assembleResult(99, cov, act, mn, p2, dep);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("[DEPS]") && e.includes("cycle")));
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.17 — Zero AI calls
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.17 — Zero AI calls");

await test("kb-validator.ts has no AI SDK imports (zero AI calls)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../kb-validator.ts", import.meta.url).pathname,
    "utf8",
  );
  const aiImports = [
    "openai", "anthropic", "openrouter", "gemini",
    "AI_INTEGRATIONS", "createCompletion", "chat.completions",
  ];
  for (const pattern of aiImports) {
    assert.ok(
      !src.toLowerCase().includes(pattern.toLowerCase()),
      `kb-validator.ts must not import or use "${pattern}"`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.18 — Zero DB writes
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.18 — Zero DB writes");

await test("kb-validator.ts has no DB write operations (insert/update/delete)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../kb-validator.ts", import.meta.url).pathname,
    "utf8",
  );
  // These are the write method names in Drizzle
  const writeMethods = [".insert(", ".update(", ".delete("];
  for (const method of writeMethods) {
    assert.ok(
      !src.includes(method),
      `kb-validator.ts must not call ${method} (DB write detected)`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.19 — Same unchanged input → same validation result (idempotency)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.19 — Idempotency");

await test("same input twice → identical results", () => {
  function runOnce() {
    const cov = gateSourceCoverage(VALID_META);
    const act = gateActivityIntegrity(EXERCISES_VALID, 3);
    const mn  = gateMicroNodeIntegrity(NODES_DRAFT);
    const p2  = gatePhase2Enrichment(NODES_APPROVED_FULL);
    const dep = gateDependencies(DEPS_VALID, 99, NODE_IDS_99);
    return assembleResult(99, cov, act, mn, p2, dep);
  }
  const r1 = runOnce();
  const r2 = runOnce();
  assert.deepEqual(r1, r2, "Two runs with same input must produce identical results");
});

await test("gate functions are pure — no state mutation between calls", () => {
  const mn1 = gateMicroNodeIntegrity(NODES_DRAFT);
  const mn2 = gateMicroNodeIntegrity(NODES_DRAFT);
  assert.deepEqual(mn1, mn2);

  const act1 = gateActivityIntegrity(EXERCISES_VALID, 3);
  const act2 = gateActivityIntegrity(EXERCISES_VALID, 3);
  assert.deepEqual(act1, act2);
});

// ─────────────────────────────────────────────────────────────────────────────
// P9.20 — Lesson 105 GOLD STANDARD → PASS (real DB)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP9.20 — Lesson 105 GOLD STANDARD (real DB)");

const lesson105 = await validateKnowledgeBaseLesson(105);

await test("Lesson 105: validator runs without throwing", () => {
  assert.ok(lesson105, "validator must return a result object");
  assert.equal(lesson105.lessonId, 105);
});

await test("Lesson 105: source coverage gate passes (100%, valid=true)", () => {
  assert.ok(lesson105.sourceCoverage.valid,
    `Coverage should be valid; ${lesson105.sourceCoverage.note ?? ""}`);
  assert.equal(lesson105.sourceCoverage.coveragePercent, 100);
});

await test("Lesson 105: activity integrity passes (15 stored, 0 lost, 0 duplicates)", () => {
  const act = lesson105.activities;
  assert.equal(act.storedCount, 15, `Expected 15 stored, got ${act.storedCount}`);
  assert.equal(act.lostCount, 0, `Expected 0 lost, got ${act.lostCount}`);
  assert.equal(act.duplicateCount, 0, `Expected 0 duplicates, got ${act.duplicateCount}`);
  assert.equal(act.assignedCount + act.additionalCount, 15,
    `Assigned(${act.assignedCount}) + Additional(${act.additionalCount}) must = 15`);
  assert.ok(act.valid);
});

await test("Lesson 105: microNode integrity passes (≥1 node, no empty theory, valid sequences)", () => {
  const mn = lesson105.microNodes;
  assert.ok(mn.total >= 1, `Expected ≥1 node, got ${mn.total}`);
  assert.equal(mn.emptyCount, 0, `Expected 0 empty theory nodes, got ${mn.emptyCount}`);
  assert.equal(mn.emptyTitleCount, 0);
  assert.equal(mn.invalidSequenceCount, 0);
  assert.ok(mn.valid);
});

await test("Lesson 105: phase2 gate passes (draft nodes exempt; 0 approved → 0 missing)", () => {
  const p2 = lesson105.phase2;
  assert.equal(p2.missingEnrichmentCount, 0);
  assert.ok(p2.valid);
});

await test("Lesson 105: dependency gate passes (0 deps, no cycles, no invalid refs)", () => {
  const dep = lesson105.dependencies;
  assert.equal(dep.cycleDetected, false);
  assert.equal(dep.invalidReferenceCount, 0);
  assert.equal(dep.selfDependencyCount, 0);
  assert.ok(dep.valid);
});

await test("Lesson 105: overall valid = true (all structural gates pass)", () => {
  assert.ok(lesson105.valid,
    `Should be structurally valid; errors: ${lesson105.errors.join("; ")}`);
  assert.equal(lesson105.errors.length, 0,
    `Expected 0 errors; got: ${lesson105.errors.join("; ")}`);
});

await test("Lesson 105: readyForAiTeacher = false (nodes are draft, not yet teacher-approved)", () => {
  // Lesson 105 nodes are all draft — no approved nodes with Phase 2 enrichment.
  // This is a VALID mapping that is not yet teacher-reviewed, which is correct.
  assert.equal(lesson105.readyForAiTeacher, false,
    "Draft-only lesson should not be AI Teacher ready (expected — nodes need teacher approval first)");
  // The warning should explain this
  assert.ok(lesson105.warnings.some((w) => w.includes("approved")),
    "Should warn about no approved nodes");
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
