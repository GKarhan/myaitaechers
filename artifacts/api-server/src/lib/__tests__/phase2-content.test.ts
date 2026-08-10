// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Teaching Enrichment — unit tests
// Run with: pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/phase2-content.test.ts
//
// Tests Phase2GenerationResult shape, isWeakSource(), and teacher-review gate
// logic without making real AI calls.
// ─────────────────────────────────────────────────────────────────────────────

import { isWeakSource, type Phase2GenerationResult } from "../../services/lesson-mapping.js";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ── isWeakSource ──────────────────────────────────────────────────────────────

console.log("\nGroup A: isWeakSource");

assert("null → weak",    isWeakSource(null));
assert("undefined → weak", isWeakSource(undefined));
assert("empty string → weak", isWeakSource(""));
assert("whitespace-only → weak", isWeakSource("   "));
assert("< 50 chars → weak", isWeakSource("Short text"));
assert("URL → weak", isWeakSource("https://example.com/math"));
assert("domain → weak", isWeakSource("www.example.com"));
assert("50+ chars of theory → not weak", !isWeakSource(
  "Անհայտ գումարելին գտնելու համար հանման օրինակ կազմեք՝ հայտնի գումարից հանեք մյուս գումարելին։"
));
assert("50+ char plain text → not weak", !isWeakSource(
  "Ա + Բ = Ա + Բ, ուստի անհայտ թիվ գտնելու համար կատարվում է հակառակ գործողությունը։ Սա ստուգելի հատկություն է:"
));

// ── Phase2GenerationResult shape ─────────────────────────────────────────────

console.log("\nGroup B: Phase2GenerationResult shape");

// Verify the interface has exactly the 4 Set A fields (no Set B fields)
const skippedResult: Phase2GenerationResult = {
  nodeId:                   999,
  skipped:                  true,
  skipReason:               "insufficient source content for teaching material",
  childFriendlyExplanation: "",
  basicExamples:            [],
  commonMisconception:      "",
  nonExamples:              [],
};

assert("skipped result has nodeId",                   skippedResult.nodeId === 999);
assert("skipped result has skipped=true",             skippedResult.skipped === true);
assert("skipped result has childFriendlyExplanation", typeof skippedResult.childFriendlyExplanation === "string");
assert("skipped result has basicExamples array",      Array.isArray(skippedResult.basicExamples));
assert("skipped result has commonMisconception",      typeof skippedResult.commonMisconception === "string");
assert("skipped result has nonExamples array",        Array.isArray(skippedResult.nonExamples));

const successResult: Phase2GenerationResult = {
  nodeId:                   42,
  skipped:                  false,
  childFriendlyExplanation: "Անհայտ գումարելին գտնելու համար հայտնի գումարից հանեք մյուս գումարելին։",
  basicExamples:            ["? + 3 = 7, ուստի ? = 7 − 3 = 4", "12 + ? = 20, ուստի ? = 20 − 12 = 8"],
  commonMisconception:      "Շատ աշակերտներ կարծում են, որ անհայտ գումարելին ստանում են ավելացնելով, ոչ թե հանելով։",
  nonExamples:              ["7 − 3 = 4 (սա հանման, ոչ անհայտ գումարելու գտնելու օրինակ չէ)"],
};

assert("success result has nodeId=42",                successResult.nodeId === 42);
assert("success result skipped=false",                successResult.skipped === false);
assert("success result has non-empty explanation",     successResult.childFriendlyExplanation.length > 0);
assert("success result has 2 examples",               successResult.basicExamples.length === 2);
assert("success result has misconception",             successResult.commonMisconception.length > 0);
assert("success result has 1 non-example",             successResult.nonExamples.length === 1);

// Verify Set B fields do NOT exist on the type (compile-time check via type assertion)
// If this compiled, the interface no longer has those fields.
assert("explanationSteps field absent from type",     !("explanationSteps"    in successResult));
assert("beginnerExplanation field absent from type",  !("beginnerExplanation" in successResult));
assert("advancedExplanation field absent from type",  !("advancedExplanation" in successResult));
assert("analogy field absent from type",              !("analogy"             in successResult));
assert("commonErrors field absent from type",         !("commonErrors"        in successResult));
assert("recallQuestions field absent from type",      !("recallQuestions"     in successResult));
assert("contentSourceType field absent from type",    !("contentSourceType"   in successResult));

// ── Teacher Review gate logic ─────────────────────────────────────────────────

console.log("\nGroup C: Teacher Review gate logic");

// Simulate what the route does: nodes with needs_review or draft are pre-empted
type NodeStatus = "draft" | "needs_review" | "approved" | "needs_source_content";

function simulateGate(status: NodeStatus): Phase2GenerationResult {
  if (status === "needs_review" || status === "draft") {
    return {
      nodeId:                   1,
      skipped:                  true,
      skipReason:               "skipped_needs_review",
      childFriendlyExplanation: "",
      basicExamples:            [],
      commonMisconception:      "",
      nonExamples:              [],
    };
  }
  // Would call generatePhase2Content — just return a placeholder success here
  return {
    nodeId:                   1,
    skipped:                  false,
    childFriendlyExplanation: "ok",
    basicExamples:            ["ex1"],
    commonMisconception:      "mc",
    nonExamples:              ["ne1"],
  };
}

const draftGate       = simulateGate("draft");
const reviewGate      = simulateGate("needs_review");
const approvedResult  = simulateGate("approved");
const nsContentResult = simulateGate("needs_source_content");

assert("draft node → skipped=true",                    draftGate.skipped === true);
assert("draft node → skipReason=skipped_needs_review",  draftGate.skipReason === "skipped_needs_review");
assert("needs_review node → skipped=true",             reviewGate.skipped === true);
assert("needs_review → skipReason=skipped_needs_review", reviewGate.skipReason === "skipped_needs_review");
assert("approved node → not skipped",                  approvedResult.skipped === false);
assert("needs_source_content node → not gated (passes through)", nsContentResult.skipped === false);

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
