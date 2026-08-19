import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalizePhase2TheoryEnvelope,
  validateServerOwnedPhase2TheoryEnvelope,
  validateStructuredResponse,
  validateTeachingCycle,
} from "../../services/ai.js";

const chatRouteSource = readFileSync(
  fileURLToPath(new URL("../../routes/chat.ts", import.meta.url)),
  "utf8"
);
const aiServiceSource = readFileSync(
  fileURLToPath(new URL("../../services/ai.ts", import.meta.url)),
  "utf8"
);

function baseResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    teaching_mode: "TEACH",
    is_micro_check: true,
    interaction_type: "constructed_response",
    options: null,
    correct_option: null,
    student_message: "Բացատրիր, թե ինչու են մոլեկուլները շարժվում՞",
    progress_indicator: {
      current_node_name: "Մոլեկուլներ",
      step: 1,
      total_steps: 3,
      completed_nodes: 0,
      total_nodes: 3,
    },
    answer_evaluation: {
      status: "NOT_APPLICABLE",
      evidence_quality: "NONE",
      error_family: null,
      error_stability: null,
      correct_parts: [],
      incorrect_parts: [],
    },
    node_decision: { action: "CONTINUE_SAME_NODE", reason: "test" },
    source_fidelity: { type: "AI_GENERATED", exercise_id: null },
    redirect_needed: false,
    mentions_out_of_scope_topic: false,
    question_template: null,
    encouragement_used: false,
    encouragement_focus: null,
    ...overrides,
  };
}

function lessonContext(stage = "THEORY"): string {
  return [
    "CURRENT_NODE: «Մոլեկուլներ» | node_id=42",
    "ALLOWED_NODES:",
    "  - «Մոլեկուլներ» (id=42)",
    `STUDENT_STATE: phase=2 | node_stage=${stage} | node_attempts=0 | nodes_done=0/3`,
    "CLASS_EXERCISES: (none)",
  ].join("\n");
}

function assertValidationPass(response: Record<string, unknown>): void {
  validateTeachingCycle(response as any, [], lessonContext());
}

const phase2TheoryState = {
  currentPhase: 2,
  currentNodeId: 42,
  nodeTeachingStage: "THEORY",
};

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test("A: Phase-2 THEORY canonicalizes TEACH/false around valid task content", () => {
  const response = baseResponse({
    is_micro_check: false,
    interaction_type: "multiple_choice",
    options: [
      { key: "A", text: "Մոլեկուլները շարժվում են" },
      { key: "B", text: "Մոլեկուլները անշարժ են" },
    ],
    correct_option: "A",
    student_message: "Ո՞րն է ճիշտ.\nԱ) Մոլեկուլները շարժվում են\nԲ) Մոլեկուլները անշարժ են",
  });
  const canonical = canonicalizePhase2TheoryEnvelope(response as any, phase2TheoryState);
  assert.equal(canonical.teaching_mode, "TEACH");
  assert.equal(canonical.is_micro_check, true);
  assertValidationPass(canonical as any);
  assert.ok(
    aiServiceSource.indexOf("aiStructuredResponseSchema.parse") <
      aiServiceSource.lastIndexOf("canonicalizePhase2TheoryEnvelope") &&
      aiServiceSource.lastIndexOf("canonicalizePhase2TheoryEnvelope") <
      aiServiceSource.lastIndexOf("validateStructuredResponse"),
    "canonicalization must occur after Zod and before semantic validators"
  );
});

test("B: canonical envelope still rejects feedback-only content", () => {
  const canonical = canonicalizePhase2TheoryEnvelope(
    baseResponse({
      is_micro_check: false,
      interaction_type: null,
      options: null,
      correct_option: null,
      student_message: "Շատ լավ, սկսենք։",
    }) as any,
    phase2TheoryState
  );
  assert.equal(canonical.teaching_mode, "TEACH");
  assert.equal(canonical.is_micro_check, true);
  assert.throws(() => assertValidationPass(canonical as any), /requires a non-null interaction_type/u);
});

test("C: valid task remains valid when model returned FEEDBACK/false", () => {
  const canonical = canonicalizePhase2TheoryEnvelope(
    baseResponse({
      teaching_mode: "FEEDBACK",
      is_micro_check: false,
      interaction_type: "multiple_choice",
      options: [
        { key: "A", text: "Մոլեկուլները շարժվում են" },
        { key: "B", text: "Մոլեկուլները անշարժ են" },
      ],
      correct_option: "A",
      student_message: "Ո՞րն է ճիշտ.\nԱ) Մոլեկուլները շարժվում են\nԲ) Մոլեկուլները անշարժ են",
    }) as any,
    phase2TheoryState
  );
  assert.equal(canonical.teaching_mode, "TEACH");
  assert.equal(canonical.is_micro_check, true);
  assertValidationPass(canonical as any);
});

test("D: sentence-limit validation remains authoritative", () => {
  const canonical = canonicalizePhase2TheoryEnvelope(
    baseResponse({
      is_micro_check: false,
      student_message:
        "Մեկ նախադասություն։ Երկու նախադասություն։ Երեք նախադասություն։ Չորս նախադասություն։ Հինգ նախադասություն։ Վեց նախադասություն։ Յոթ նախադասություն։ Ութ նախադասություն։",
    }) as any,
    phase2TheoryState
  );
  assert.throws(
    () => validateStructuredResponse(canonical as any),
    /student_message has 8 sentences \(max 5\)/u
  );
});

test("E: MICRO_CHECK stage is not affected by THEORY canonicalization", () => {
  const response = baseResponse({ is_micro_check: false });
  const unchanged = canonicalizePhase2TheoryEnvelope(response as any, {
    ...phase2TheoryState,
    nodeTeachingStage: "MICRO_CHECK",
  });
  assert.equal(unchanged, response);
  assert.throws(() => assertValidationPass(unchanged as any), /is_micro_check is not true/u);
});

test("F: Phase 1 is not affected by THEORY canonicalization", () => {
  const response = baseResponse({
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
  });
  const unchanged = canonicalizePhase2TheoryEnvelope(response as any, {
    currentPhase: 1,
    currentNodeId: 42,
    nodeTeachingStage: "THEORY",
  });
  assert.equal(unchanged, response);
  validateTeachingCycle(unchanged as any, [], lessonContext("THEORY").replace("phase=2", "phase=1"));
});

test("G: existing validated activation path and objective payload remain in place", () => {
  assert.match(
    chatRouteSource,
    /if \(!wasEval && .*session\?\.nodeTeachingStage.*THEORY.*aiResult\.is_micro_check\)/su
  );
  assert.match(
    chatRouteSource,
    /activeObjectiveTaskPayload:\s*objectivePayloadFromMicroCheck\(aiResult\)/u
  );
  assert.doesNotMatch(
    chatRouteSource,
    /if \(currentStage === "THEORY"\)\s*\{\s*newTeachingStage = "MICRO_CHECK";/u
  );
});

test("H: candidate-header exercises block COMPLETE_NODE during MICRO_CHECK", () => {
  const response = baseResponse({
    teaching_mode: "FEEDBACK",
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
    answer_evaluation: {
      status: "CORRECT",
      evidence_quality: "MODERATE",
      error_family: null,
      error_stability: null,
      correct_parts: [],
      incorrect_parts: [],
    },
    node_decision: { action: "COMPLETE_NODE", reason: "test" },
  });
  const candidateContext = [
    "CURRENT_NODE: «Մոլեկուլներ» | node_id=42",
    "ALLOWED_NODES:",
    "  - «Մոլեկուլներ» (id=42)",
    "STUDENT_STATE: phase=2 | node_stage=MICRO_CHECK | node_attempts=2 | nodes_done=0/3",
    "CLASS_EXERCISE_CANDIDATES (backend owns exact text delivery):",
    "[EX-1] page=1 difficulty=easy",
  ].join("\n");
  assert.throws(
    () => validateTeachingCycle(response as any, [], candidateContext),
    /\[R5\]/u
  );
});

test("I: evaluated THEORY task is rejected before it can write phantom evidence", () => {
  const canonical = canonicalizePhase2TheoryEnvelope(
    baseResponse({
      teaching_mode: "FEEDBACK",
      is_micro_check: false,
      interaction_type: "multiple_choice",
      options: [
        { key: "A", text: "Մոլեկուլները շարժվում են" },
        { key: "B", text: "Մոլեկուլները անշարժ են" },
      ],
      correct_option: "A",
      student_message: "Ո՞րն է ճիշտ.\nԱ) Մոլեկուլները շարժվում են\nԲ) Մոլեկուլները անշարժ են",
      answer_evaluation: {
        status: "CORRECT",
        evidence_quality: "MODERATE",
        error_family: null,
        error_stability: null,
        correct_parts: ["incorrectly evaluated before task delivery"],
        incorrect_parts: [],
      },
    }) as any,
    phase2TheoryState
  );
  assert.throws(
    () => validateServerOwnedPhase2TheoryEnvelope(canonical as any, phase2TheoryState),
    /requires a non-evaluated answer_evaluation/u
  );
  assert.ok(
    aiServiceSource.lastIndexOf("validateServerOwnedPhase2TheoryEnvelope(validated, turnState)") <
      aiServiceSource.indexOf("return validated"),
    "evaluated THEORY output must fail before the route can consume it"
  );
});

console.log(`\n${passed} micro-check activation-fix tests passed\n`);