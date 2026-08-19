// ────────────────────────────────────────────────────────────────────────────
// Contract v1.2 — 22 parser test cases (contract §27)
// Run with: pnpm --filter @workspace/api-server exec tsx src/mapping/__tests__/mapTextParser.test.ts
// No external test framework — uses node:assert/strict + exit code.
// ────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { parseMappingText } from "../mapTextParser.js";

const tests: Array<[string, () => void]> = [];
function it(name: string, fn: () => void): void { tests.push([name, fn]); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function allMns(result: ReturnType<typeof parseMappingText>) {
  return result.nodes.flatMap(n => n.microNodes);
}

// ── Minimal valid document fixture ───────────────────────────────────────────

const MINIMAL = `
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

DEPENDENCY D1
from: MN-1.1
to: MN-1.1
dependencyType: PREREQUISITE
reason: Self-reference test
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — minimal valid TEXT parses without errors
// ─────────────────────────────────────────────────────────────────────────────
it("Test 1: minimal valid TEXT → ParsedMappingResult", () => {
  const r = parseMappingText(MINIMAL);
  assert.ok(r.lesson, "lesson should be present");
  assert.equal(r.lesson!.title, "Arithmetic");
  assert.equal(r.nodes.length, 1);
  assert.equal(allMns(r).length, 1);
  assert.equal(r.sourceBlocks.length, 1);
  assert.equal(r.exercises.length, 1);
  assert.equal(r.dependencies.length, 1);
  assert.equal(r._orphanMicroNodes.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — missing LESSON section
// ─────────────────────────────────────────────────────────────────────────────
it("Test 2: missing LESSON section → lesson is null", () => {
  const r = parseMappingText("NODE N1\ntitle: Addition\n");
  assert.equal(r.lesson, null);
  assert.equal(r.nodes.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — MicroNode placed under correct NODE
// ─────────────────────────────────────────────────────────────────────────────
it("Test 3: MN placed under correct parent NODE", () => {
  const txt = `
LESSON
title: T
subject: S
grade: 1
textbook: TB
author: A
section: §1
pages: 1-2

NODE N2
title: Fractions

MICRONODE MN-2.1
title: Basic fractions
microNodeType: KNOWLEDGE
learningObjective: Understands halves
sourceBlockIds:
confidenceScore: 80
sourceCoverage: FULL
status: draft
`.trim();
  const r = parseMappingText(txt);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].id, "N2");
  assert.equal(r.nodes[0].microNodes.length, 1);
  assert.equal(r.nodes[0].microNodes[0].id, "MN-2.1");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — MICRONODE before NODE still placed under correct parent
// ─────────────────────────────────────────────────────────────────────────────
it("Test 4: MICRONODE before NODE → still placed correctly (order-independent)", () => {
  const txt = `
MICRONODE MN-1.1
title: Early MN
microNodeType: KNOWLEDGE
learningObjective: obj
sourceBlockIds:
confidenceScore: 50
sourceCoverage: UNCERTAIN
status: draft

NODE N1
title: Topic One
`.trim();
  const r = parseMappingText(txt);
  assert.equal(r.nodes.length, 1, "N1 should be created");
  assert.equal(r.nodes[0].microNodes.length, 1, "MN-1.1 should be placed under N1");
  assert.equal(r._orphanMicroNodes.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5 — orphan MICRONODE (no matching NODE)
// ─────────────────────────────────────────────────────────────────────────────
it("Test 5: orphan MICRONODE (no matching NODE) → _orphanMicroNodes", () => {
  const txt = `
MICRONODE MN-99.1
title: Orphan
microNodeType: KNOWLEDGE
learningObjective: obj
sourceBlockIds:
confidenceScore: 50
sourceCoverage: UNCERTAIN
status: draft
`.trim();
  const r = parseMappingText(txt);
  assert.equal(r.nodes.length, 0);
  assert.equal(r._orphanMicroNodes.length, 1);
  assert.equal(r._orphanMicroNodes[0].id, "MN-99.1");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6 — multi-line sourceText via 4-space continuation
// ─────────────────────────────────────────────────────────────────────────────
it("Test 6: 4-space continuation joins multi-line sourceText", () => {
  const txt = [
    "SOURCE BLOCK B5",
    "blockType: RULE",
    "sourcePage: 22",
    "status: EXTRACTED",
    "sourceText: First line of text.",
    "    Second line continues here.",
    "    Third line too.",
  ].join("\n");
  const r = parseMappingText(txt);
  assert.equal(r.sourceBlocks.length, 1);
  const expected = "First line of text.\nSecond line continues here.\nThird line too.";
  assert.equal(r.sourceBlocks[0].sourceText, expected);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7 — blank line ends continuation; next field is separate
// ─────────────────────────────────────────────────────────────────────────────
it("Test 7: blank line ends 4-space continuation", () => {
  const txt = [
    "SOURCE BLOCK B7",
    "blockType: FACT",
    "sourcePage: 1",
    "status: EXTRACTED",
    "sourceText: Line one.",
    "",
    "    This should NOT be continuation.",
    "sourceParagraph: para1",
  ].join("\n");
  const r = parseMappingText(txt);
  assert.equal(r.sourceBlocks.length, 1);
  // After blank line, continuation resets — "    This should NOT..." is ignored (unrecognised line)
  assert.equal(r.sourceBlocks[0].sourceText, "Line one.");
  assert.equal(r.sourceBlocks[0].sourceParagraph, "para1");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 8 — pages "22-24" parsed correctly
// ─────────────────────────────────────────────────────────────────────────────
it("Test 8: pages hyphen range '22-24' → pagesFrom=22 pagesTo=24", () => {
  const txt = "LESSON\ntitle: T\nsubject: S\ngrade: 3\ntextbook: TB\nauthor: A\nsection: §1\npages: 22-24\n";
  const r = parseMappingText(txt);
  assert.equal(r.lesson?.pagesFrom, 22);
  assert.equal(r.lesson?.pagesTo, 24);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9 — pages "22–24" (en-dash) parsed correctly
// ─────────────────────────────────────────────────────────────────────────────
it("Test 9: pages en-dash range '22\u201324' → pagesFrom=22 pagesTo=24", () => {
  const txt = "LESSON\ntitle: T\nsubject: S\ngrade: 3\ntextbook: TB\nauthor: A\nsection: §1\npages: 22\u201324\n";
  const r = parseMappingText(txt);
  assert.equal(r.lesson?.pagesFrom, 22);
  assert.equal(r.lesson?.pagesTo, 24);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 10 — EXERCISE parsed correctly
// ─────────────────────────────────────────────────────────────────────────────
it("Test 10: EXERCISE section parsed correctly", () => {
  const txt = [
    "EXERCISE EX-3",
    "text: What is 5 × 6?",
    "exerciseType: RECALL",
    "difficulty: MEDIUM",
    "interactionType: multiple_choice",
    "correctAnswer: Բ)",
    "sequence: 3",
    "sourcePage: 15",
    "confidenceScore: 85",
    "relatedMicroNodes: MN-2.1, MN-2.2",
  ].join("\n");
  const r = parseMappingText(txt);
  assert.equal(r.exercises.length, 1);
  const ex = r.exercises[0];
  assert.equal(ex.id, "EX-3");
  assert.equal(ex.text, "What is 5 × 6?");
  assert.equal(ex.exerciseType, "RECALL");
  assert.equal(ex.difficulty, "MEDIUM");
  assert.equal(ex.interactionType, "multiple_choice");
  assert.equal(ex.correctAnswer, "Բ)");
  assert.equal(ex.sequence, 3);
  assert.equal(ex.sourcePage, 15);
  assert.equal(ex.confidenceScore, 85);
  assert.deepEqual(ex.relatedMicroNodes, ["MN-2.1", "MN-2.2"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 11 — DEPENDENCY parsed correctly
// ─────────────────────────────────────────────────────────────────────────────
it("Test 11: DEPENDENCY section parsed correctly", () => {
  const txt = [
    "DEPENDENCY D2",
    "from: MN-1.1",
    "to: MN-1.2",
    "dependencyType: PREREQUISITE",
    "reason: Must learn addition before subtraction",
    "confidenceScore: 95",
  ].join("\n");
  const r = parseMappingText(txt);
  assert.equal(r.dependencies.length, 1);
  const dep = r.dependencies[0];
  assert.equal(dep.id, "D2");
  assert.equal(dep.from, "MN-1.1");
  assert.equal(dep.to, "MN-1.2");
  assert.equal(dep.dependencyType, "PREREQUISITE");
  assert.equal(dep.reason, "Must learn addition before subtraction");
  assert.equal(dep.confidenceScore, 95);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 12 — FIDELITY AUDIT section parsed (not null)
// ─────────────────────────────────────────────────────────────────────────────
it("Test 12: FIDELITY AUDIT section → fidelityAudit not null", () => {
  const txt = "FIDELITY AUDIT\nThis is an audit note.\n";
  const r = parseMappingText(txt);
  assert.ok(r.fidelityAudit !== null, "fidelityAudit should be non-null");
  assert.equal(r.fidelityAudit!._line, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 13 — blank lines between sections are ignored
// ─────────────────────────────────────────────────────────────────────────────
it("Test 13: blank lines between sections ignored", () => {
  const txt = "\n\nNODE N1\ntitle: T\n\n\nNODE N2\ntitle: U\n\n";
  const r = parseMappingText(txt);
  assert.equal(r.nodes.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 14 — comment lines (# prefix) are ignored
// ─────────────────────────────────────────────────────────────────────────────
it("Test 14: comment lines starting with # are ignored", () => {
  const txt = [
    "# This is a comment",
    "LESSON",
    "# Another comment",
    "title: My Lesson",
    "subject: Physics",
    "grade: 8",
    "textbook: Physics for Kids",
    "author: B",
    "section: §2",
    "pages: 30-35",
  ].join("\n");
  const r = parseMappingText(txt);
  assert.ok(r.lesson);
  assert.equal(r.lesson!.title, "My Lesson");
  assert.equal(r.lesson!.subject, "Physics");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 15 — multiple 4-space continuation lines accumulate correctly
// ─────────────────────────────────────────────────────────────────────────────
it("Test 15: multiple continuation lines accumulate with newlines", () => {
  const txt = [
    "SOURCE BLOCK B10",
    "blockType: EXPLANATION",
    "sourcePage: 5",
    "status: EXTRACTED",
    "sourceText: Line A.",
    "    Line B.",
    "    Line C.",
    "    Line D.",
  ].join("\n");
  const r = parseMappingText(txt);
  assert.equal(r.sourceBlocks[0].sourceText, "Line A.\nLine B.\nLine C.\nLine D.");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 16 — multiple sourceRef lines accumulated correctly
// ─────────────────────────────────────────────────────────────────────────────
it("Test 16: multiple sourceRef lines → multiple sourceRefs array entries", () => {
  const txt = [
    "MICRONODE MN-1.2",
    "title: Advanced",
    "microNodeType: SKILL",
    "learningObjective: obj",
    "sourceBlockIds: B1, B2",
    "confidenceScore: 70",
    "sourceCoverage: PARTIAL",
    "status: draft",
    "sourceRef: B1 | Quote from block one.",
    "sourceRef: B2 | Another quote from block two.",
  ].join("\n");
  const r = parseMappingText(txt);
  const mn = r._orphanMicroNodes[0] ?? allMns(r)[0];
  assert.equal(mn.sourceRefs.length, 2);
  assert.equal(mn.sourceRefs[0].sourceBlockId, "B1");
  assert.equal(mn.sourceRefs[0].sourceQuote, "Quote from block one.");
  assert.equal(mn.sourceRefs[1].sourceBlockId, "B2");
  assert.equal(mn.sourceRefs[1].sourceQuote, "Another quote from block two.");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 17 — confidenceScore parsed as integer
// ─────────────────────────────────────────────────────────────────────────────
it("Test 17: confidenceScore field → parsed as integer", () => {
  const txt = [
    "MICRONODE MN-1.3",
    "title: T",
    "microNodeType: KNOWLEDGE",
    "learningObjective: obj",
    "sourceBlockIds:",
    "confidenceScore: 77",
    "sourceCoverage: FULL",
    "status: draft",
  ].join("\n");
  const r = parseMappingText(txt);
  const mn = r._orphanMicroNodes[0] ?? allMns(r)[0];
  assert.equal(typeof mn.confidenceScore, "number");
  assert.equal(mn.confidenceScore, 77);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 18 — invalid (non-numeric) confidenceScore → null
// ─────────────────────────────────────────────────────────────────────────────
it("Test 18: non-numeric confidenceScore → null", () => {
  const txt = [
    "MICRONODE MN-1.4",
    "title: T",
    "microNodeType: KNOWLEDGE",
    "learningObjective: obj",
    "sourceBlockIds:",
    "confidenceScore: high",
    "sourceCoverage: FULL",
    "status: draft",
  ].join("\n");
  const r = parseMappingText(txt);
  const mn = r._orphanMicroNodes[0] ?? allMns(r)[0];
  assert.equal(mn.confidenceScore, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 19 — sourceBlockIds CSV parsed into array
// ─────────────────────────────────────────────────────────────────────────────
it("Test 19: sourceBlockIds 'B1, B2, B3' → string array", () => {
  const txt = [
    "MICRONODE MN-1.5",
    "title: T",
    "microNodeType: KNOWLEDGE",
    "learningObjective: obj",
    "sourceBlockIds: B1, B2, B3",
    "confidenceScore: 60",
    "sourceCoverage: FULL",
    "status: draft",
  ].join("\n");
  const r = parseMappingText(txt);
  const mn = r._orphanMicroNodes[0] ?? allMns(r)[0];
  assert.deepEqual(mn.sourceBlockIds, ["B1", "B2", "B3"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 20 — prerequisites CSV parsed into array
// ─────────────────────────────────────────────────────────────────────────────
it("Test 20: prerequisites 'MN-1.1, MN-1.2' → string array", () => {
  const txt = [
    "MICRONODE MN-2.1",
    "title: T",
    "microNodeType: KNOWLEDGE",
    "learningObjective: obj",
    "sourceBlockIds:",
    "confidenceScore: 50",
    "sourceCoverage: UNCERTAIN",
    "status: draft",
    "prerequisites: MN-1.1, MN-1.2",
  ].join("\n");
  const r = parseMappingText(txt);
  const mn = r._orphanMicroNodes[0] ?? allMns(r)[0];
  assert.deepEqual(mn.prerequisites, ["MN-1.1", "MN-1.2"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 21 — empty field value → empty string / empty array
// ─────────────────────────────────────────────────────────────────────────────
it("Test 21: empty field value → empty string (or empty CSV array)", () => {
  const txt = [
    "SOURCE BLOCK B20",
    "blockType: NOTE",
    "sourcePage: 3",
    "status: EXTRACTED",
    "sourceText: Some text",
    "sourceParagraph:",
    "sourcePosition:",
  ].join("\n");
  const r = parseMappingText(txt);
  assert.equal(r.sourceBlocks[0].sourceParagraph, "");
  assert.equal(r.sourceBlocks[0].sourcePosition, "");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 22 — LESSON section after NODE section still parsed
// ─────────────────────────────────────────────────────────────────────────────
it("Test 22: LESSON after NODE → lesson still parsed (order-independent)", () => {
  const txt = [
    "NODE N1",
    "title: First Node",
    "",
    "LESSON",
    "title: Late Lesson",
    "subject: Bio",
    "grade: 7",
    "textbook: Biology",
    "author: C",
    "section: §3",
    "pages: 5-10",
  ].join("\n");
  const r = parseMappingText(txt);
  assert.ok(r.lesson);
  assert.equal(r.lesson!.title, "Late Lesson");
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].id, "N1");
});

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failedNames: string[] = [];

console.log("\n  mapTextParser — 22 contract test cases\n");

for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    process.stdout.write(`  \u001b[32m\u2713\u001b[0m ${name}\n`);
  } catch (err) {
    failed++;
    failedNames.push(name);
    process.stdout.write(`  \u001b[31m\u2717\u001b[0m ${name}\n`);
    if (err instanceof Error) {
      console.error(`      ${err.message}`);
      if (err.stack) {
        const lines = err.stack.split("\n").slice(1, 3);
        for (const l of lines) console.error(`      ${l.trim()}`);
      }
    }
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error(`  Failed: ${failedNames.join(", ")}\n`);
  process.exit(1);
}
