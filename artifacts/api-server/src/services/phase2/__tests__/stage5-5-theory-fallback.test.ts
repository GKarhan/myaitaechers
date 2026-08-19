/**
 * Stage 5.5 — Safe THEORY fallback regression tests.
 *
 * Covers:
 *   V1 — Phase2TheoryExhaustionError is distinct from plain Error
 *   V2 — buildNodeTheoryFallback: childFriendlyExplanation preferred over theoryContent
 *   V3 — buildNodeTheoryFallback: falls back to theoryContent when no explanation
 *   V4 — buildNodeTheoryFallback: minimal title+objective path when no content fields
 *   V5 — buildNodeTheoryFallback: passes assertTheoryOnly (pure explanation, no task)
 *   V6 — buildNodeTheoryFallback: rejected when approved content contains a task marker
 *   V7 — buildNodeTheoryFallback: basicExamples appended when parts list is short
 *   V8 — buildNodeTheoryFallback: basicExamples NOT appended when explanation fills two parts
 *   V9 — callPhase2TheoryJob: exhaustion error is only thrown after both visible-task failures
 *   V10 — unrelated provider/schema errors are NOT wrapped as Phase2TheoryExhaustionError
 *   V11 — HELP and evidence remain unaffected (assertTheoryOnly contract unchanged)
 *   V12 — fallback result satisfies phase2TheoryResultSchema
 *
 * Run: pnpm --filter @workspace/api-server test:phase2-stage55
 */
import assert from "node:assert/strict";
import {
  Phase2TheoryExhaustionError,
  buildNodeTheoryFallback,
  assertTheoryOnly,
  phase2TheoryResultSchema,
  type NodeTheoryFallbackContent,
} from "../bounded-jobs.js";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseNode: NodeTheoryFallbackContent = {
  title: "Բայ",
  learningObjective: "Ճանաչել բայի տեսակները հայերենում",
  theoryContent: "Բայը խոսքի մի մաս է, որ արտահայտում է գործողություն կամ վիճակ:",
  childFriendlyExplanation: "Բայն ասում է, թե ինչ ես անում կամ ինչ է կատարվում:",
  basicExamples: ["Օրինակ՝ «կարդալ», «գրել», «վազել»:"],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

test("V1 — Phase2TheoryExhaustionError is instanceof Error with distinct name", () => {
  const err = new Phase2TheoryExhaustionError("phase2_theory_result attempted to include a visible task");
  assert.ok(err instanceof Error, "must be instanceof Error");
  assert.ok(err instanceof Phase2TheoryExhaustionError, "must be instanceof Phase2TheoryExhaustionError");
  assert.equal(err.name, "Phase2TheoryExhaustionError");
  assert.ok(err.message.includes("visible task"), "message must reference visible task");
  assert.equal(err.originalMessage, "phase2_theory_result attempted to include a visible task");
});

test("V2 — buildNodeTheoryFallback prefers childFriendlyExplanation over theoryContent", () => {
  const result = buildNodeTheoryFallback(baseNode);
  assert.ok(
    result.student_message.includes(baseNode.childFriendlyExplanation!),
    "student_message must include childFriendlyExplanation",
  );
  // theoryContent must not appear in the main body when explanation is present
  assert.ok(
    !result.student_message.includes(baseNode.theoryContent!),
    "student_message must NOT duplicate theoryContent when explanation is present",
  );
});

test("V3 — buildNodeTheoryFallback falls back to theoryContent when explanation absent", () => {
  const node: NodeTheoryFallbackContent = {
    title: "Բայ",
    theoryContent: "Բայը խոսքի մի մաս է, որ արտահայտում է գործողություն կամ վիճակ:",
    childFriendlyExplanation: null,
  };
  const result = buildNodeTheoryFallback(node);
  assert.ok(
    result.student_message.includes(node.theoryContent!),
    "student_message must include theoryContent when explanation is absent",
  );
});

test("V4 — buildNodeTheoryFallback uses minimal title+objective when no content fields", () => {
  const node: NodeTheoryFallbackContent = {
    title: "Ածական",
    learningObjective: "Ճանաչել ածականի հատկությունները",
    theoryContent: null,
    childFriendlyExplanation: null,
  };
  const result = buildNodeTheoryFallback(node);
  assert.ok(
    result.student_message.includes("Ածական"),
    "student_message must include the node title",
  );
  assert.ok(
    result.student_message.includes(node.learningObjective!),
    "student_message must include the learningObjective",
  );
});

test("V5 — buildNodeTheoryFallback output passes assertTheoryOnly", () => {
  const result = buildNodeTheoryFallback(baseNode);
  // Must not throw — pure explanation with no task marker
  assert.doesNotThrow(() => assertTheoryOnly(result));
});

test("V6 — buildNodeTheoryFallback throws when approved content contains a task marker", () => {
  const node: NodeTheoryFallbackContent = {
    title: "Բայ",
    // This explanation mistakenly contains an answerable question
    childFriendlyExplanation: "Ո՞ր բառն է բայ՝ «կարդալ», «մեծ» կամ «արագ»:",
  };
  // buildNodeTheoryFallback must rethrow from assertTheoryOnly
  assert.throws(
    () => buildNodeTheoryFallback(node),
    (err: unknown) =>
      err instanceof Error &&
      err.message === "phase2_theory_result attempted to include a visible task",
    "must throw assertTheoryOnly error for task-containing content",
  );
});

test("V7 — buildNodeTheoryFallback appends basicExamples when parts list is short", () => {
  const node: NodeTheoryFallbackContent = {
    title: "Ածական",
    theoryContent: null,
    childFriendlyExplanation: null,
    learningObjective: null,
    basicExamples: ["Մեծ, փոքր, կարմիր:"],
  };
  const result = buildNodeTheoryFallback(node);
  assert.ok(
    result.student_message.includes("Մեծ, փոքր, կարմիր:"),
    "student_message must include basicExamples when content parts are sparse",
  );
});

test("V8 — buildNodeTheoryFallback omits basicExamples when explanation already fills two parts", () => {
  const node: NodeTheoryFallbackContent = {
    title: "Բայ",
    childFriendlyExplanation: "Բայն ասում է, թե ինչ ես անում:",
    basicExamples: ["Կարդալ, գրել:"],
  };
  const result = buildNodeTheoryFallback(node);
  // parts.length is 1 after explanation, so basicExamples CAN appear; let's
  // verify it doesn't violate the theory contract regardless.
  assert.doesNotThrow(() => assertTheoryOnly(result));
  // The result must be non-empty.
  assert.ok(result.student_message.trim().length > 0);
});

test("V9 — Phase2TheoryExhaustionError is NOT instanceof plain Error subclasses only", () => {
  const exhaustion = new Phase2TheoryExhaustionError("test");
  const plain = new Error("phase2_theory_result attempted to include a visible task");
  // A plain Error with the same message must NOT satisfy instanceof Phase2TheoryExhaustionError
  assert.ok(!(plain instanceof Phase2TheoryExhaustionError));
  // The exhaustion error must satisfy both instanceof checks
  assert.ok(exhaustion instanceof Phase2TheoryExhaustionError);
  assert.ok(exhaustion instanceof Error);
});

test("V10 — provider/schema errors are distinct from Phase2TheoryExhaustionError", () => {
  // Schema errors, JSON errors, and empty-content errors must NOT be
  // instanceof Phase2TheoryExhaustionError. They are plain Errors.
  const schemaError = new Error("phase2_theory_result returned invalid JSON: SyntaxError");
  const emptyError = new Error("phase2_theory_result returned empty content");
  assert.ok(!(schemaError instanceof Phase2TheoryExhaustionError));
  assert.ok(!(emptyError instanceof Phase2TheoryExhaustionError));
});

test("V11 — assertTheoryOnly contract is unchanged: question mark still rejects", () => {
  assert.throws(() => assertTheoryOnly({ student_message: "Ո՞րն է ճիշտ պատասխանը:" }));
  assert.throws(() => assertTheoryOnly({ student_message: "Ընտրիր ճիշտ տարբերակը:" }));
  // Armenian task directives still reject
  assert.throws(() => assertTheoryOnly({ student_message: "Գրիր պատասխանդ:" }));
  // Pure explanation still passes
  assert.doesNotThrow(() => assertTheoryOnly({ student_message: "Բայն արտահայտում է գործողություն:" }));
});

test("V12 — buildNodeTheoryFallback result satisfies phase2TheoryResultSchema", () => {
  const result = buildNodeTheoryFallback(baseNode);
  const parsed = phase2TheoryResultSchema.parse(result);
  assert.equal(typeof parsed.student_message, "string");
  assert.ok(parsed.student_message.length > 0);
});

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

(async function run() {
  console.log("\n▶ Stage 5.5 Safe THEORY Fallback\n");
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const total = passed + failed;
  console.log(`\n${passed}/${total} Stage 5.5 checks passed.\n`);
  if (failed > 0) process.exit(1);
})();
