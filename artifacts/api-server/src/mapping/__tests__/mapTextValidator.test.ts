// ────────────────────────────────────────────────────────────────────────────
// Contract v1.2 — Validator test cases (Round 1.5 safety tests)
// Test A: UNREADABLE → ERROR
// Run: pnpm --filter @workspace/api-server exec tsx src/mapping/__tests__/mapTextValidator.test.ts
// ────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { parseMappingText }      from "../mapTextParser.js";
import { validateParsedMapping } from "../mapTextValidator.js";
import { E_UNREADABLE_BLOCK_REF } from "../mapTextErrors.js";

const tests: Array<[string, () => void]> = [];
function it(name: string, fn: () => void): void { tests.push([name, fn]); }

// ─────────────────────────────────────────────────────────────────────────────
// TEST A-1 — MN references UNREADABLE block via sourceBlockIds → ERROR (not warning)
// ─────────────────────────────────────────────────────────────────────────────
it("A-1: UNREADABLE sourceBlock via sourceBlockIds → validation.ok=false, E_UNREADABLE_BLOCK_REF error", () => {
  const txt = `
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
sourceText: Some extracted text.
sourcePage: 10
status: UNREADABLE
`.trim();

  const parsed     = parseMappingText(txt);
  const validation = validateParsedMapping(parsed);

  // Must be invalid
  assert.equal(validation.ok, false, "validation.ok must be false when MN refs UNREADABLE block");

  // Must contain the UNREADABLE error, not merely a warning
  const unreadableErrors = validation.errors.filter(e => e.issueType === E_UNREADABLE_BLOCK_REF);
  assert.ok(
    unreadableErrors.length >= 1,
    `Expected at least 1 error with issueType="${E_UNREADABLE_BLOCK_REF}", got errors: ${JSON.stringify(validation.errors)}`,
  );

  // The same issue must NOT appear only as a warning
  const unreadableWarnings = validation.warnings.filter(w => w.issueType === E_UNREADABLE_BLOCK_REF);
  assert.equal(
    unreadableWarnings.length, 0,
    `UNREADABLE ref must be an ERROR, not a warning. Found ${unreadableWarnings.length} warning(s) with that code.`,
  );

  // Confirm severity label on the error itself
  assert.equal(unreadableErrors[0].severity, "error");
  assert.ok(
    unreadableErrors[0].description.includes("UNREADABLE"),
    "Error description must mention UNREADABLE",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST A-2 — MN references UNREADABLE block via sourceRef → ERROR
// ─────────────────────────────────────────────────────────────────────────────
it("A-2: UNREADABLE sourceBlock via sourceRef → validation.ok=false, E_UNREADABLE_BLOCK_REF error", () => {
  const txt = `
LESSON
title: Test
subject: Math
grade: 5
textbook: TB
author: A
section: §1
pages: 1-5

NODE N1
title: Topic

MICRONODE MN-1.1
title: Test MN
microNodeType: SKILL
learningObjective: obj
sourceBlockIds:
confidenceScore: 80
sourceCoverage: PARTIAL
status: draft
sourceRef: B1 | Some quote here.

SOURCE BLOCK B1
blockType: RULE
sourceText: Some quote here.
sourcePage: 2
status: UNREADABLE
`.trim();

  const parsed     = parseMappingText(txt);
  const validation = validateParsedMapping(parsed);

  assert.equal(validation.ok, false, "validation.ok must be false");

  const unreadableErrors = validation.errors.filter(e => e.issueType === E_UNREADABLE_BLOCK_REF);
  assert.ok(unreadableErrors.length >= 1, `Expected E_UNREADABLE_BLOCK_REF error via sourceRef`);
  assert.equal(unreadableErrors[0].severity, "error");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST A-3 — EXTRACTED block (not UNREADABLE) → ok=true, no UNREADABLE error
// (Baseline: NEEDS_REVIEW → warning only, not error; EXTRACTED → clean)
// ─────────────────────────────────────────────────────────────────────────────
it("A-3: EXTRACTED sourceBlock → validation.ok=true, zero UNREADABLE errors", () => {
  const txt = `
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
`.trim();

  const parsed     = parseMappingText(txt);
  const validation = validateParsedMapping(parsed);

  assert.equal(validation.ok, true, "validation.ok must be true for EXTRACTED block");
  const unreadableErrors = validation.errors.filter(e => e.issueType === E_UNREADABLE_BLOCK_REF);
  assert.equal(unreadableErrors.length, 0, "No UNREADABLE errors for EXTRACTED block");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST A-4 — NEEDS_REVIEW block → WARNING only, not ERROR
// ─────────────────────────────────────────────────────────────────────────────
it("A-4: NEEDS_REVIEW sourceBlock → warning only, validation.ok=true (no UNREADABLE error)", () => {
  const txt = `
LESSON
title: Test
subject: Math
grade: 5
textbook: TB
author: A
section: §1
pages: 10-12

NODE N1
title: Topic

MICRONODE MN-1.1
title: MN
microNodeType: KNOWLEDGE
learningObjective: obj
sourceBlockIds: B1
confidenceScore: 75
sourceCoverage: FULL
status: draft

SOURCE BLOCK B1
blockType: FACT
sourceText: Something to review.
sourcePage: 10
status: NEEDS_REVIEW
`.trim();

  const parsed     = parseMappingText(txt);
  const validation = validateParsedMapping(parsed);

  // NEEDS_REVIEW is a warning, not a blocking error
  assert.equal(validation.ok, true, "NEEDS_REVIEW block should produce only a warning, not block import");
  const unreadableErrors = validation.errors.filter(e => e.issueType === E_UNREADABLE_BLOCK_REF);
  assert.equal(unreadableErrors.length, 0, "No UNREADABLE errors for NEEDS_REVIEW block");
  // But there SHOULD be a warning
  const reviewWarnings = validation.warnings.filter(w => w.description.includes("NEEDS_REVIEW"));
  assert.ok(reviewWarnings.length >= 1, "Expected a NEEDS_REVIEW warning");
});

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failedNames: string[] = [];

console.log("\n  mapTextValidator — UNREADABLE rule tests (Test A)\n");

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
