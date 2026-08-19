import assert from "node:assert/strict";
import {
  assertFeedbackOnly,
  assertFeedbackDoesNotRevealHiddenContent,
  phase2EvaluationResultSchema,
  phase2FeedbackResultSchema,
  phase2TaskCandidateSchema,
  phase2TheoryResultSchema,
} from "../../services/phase2/bounded-jobs.js";
import {
  derivePhase2ServerAction,
  type Phase2ServerActionInput,
} from "../../services/phase2/orchestration.js";

function input(
  overrides: Partial<Phase2ServerActionInput> = {},
): Phase2ServerActionInput {
  return {
    currentPhase: 2,
    currentNodeId: 41,
    activeCognitiveLevelId: 101,
    nodeTeachingStage: "TASK_REQUIRED",
    activeTaskProvenance: null,
    activeLessonExerciseId: null,
    activeObjectiveTaskPayload: null,
    learnerIntent: "READY",
    evaluated: false,
    decision: null,
    progressionPlan: null,
    eligibleSourceExerciseAvailable: false,
    ...overrides,
  };
}

let passed = 0;
function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log("\n▶ Phase 2 Stage 3 Bounded Jobs\n");

test("Stage 4 — FEEDBACK rejects evaluator-only criteria disclosure", () => {
  assert.throws(() => assertFeedbackDoesNotRevealHiddenContent(
    { student_message: "Լավ սկիզբ։ Պատասխանը պետք է ներառի մոլեկուլների անկանոն շարժումը։" },
    ["Պատասխանը պետք է ներառի մոլեկուլների անկանոն շարժումը։"],
  ));
});

test("A — THEORY contract carries explanation text only", () => {
  const result = phase2TheoryResultSchema.parse({
    student_message: "Բացատրությունը հակիրճ է և վերաբերում է միայն տվյալ կանոնին։",
    ignored_task_field: "must not become part of the result",
  });
  assert.deepEqual(Object.keys(result), ["student_message"]);
});

test("B — TASK contract rejects a multiple-choice key absent from options", () => {
  assert.throws(() => phase2TaskCandidateSchema.parse({
    student_message: "Ընտրիր ճիշտ տարբերակը։",
    interaction_type: "multiple_choice",
    options: [{ key: "A", text: "Տարբերակ" }],
    correct_option: "B",
    question_template: null,
  }));
});

test("C — TASK contract rejects deterministic keys for constructed response", () => {
  assert.throws(() => phase2TaskCandidateSchema.parse({
    student_message: "Բացատրիր քո պատասխանը։",
    interaction_type: "constructed_response",
    options: null,
    correct_option: "A",
    question_template: null,
  }));
});

test("D — TASK contract rejects an unsupported interaction type before activation", () => {
  assert.throws(() => phase2TaskCandidateSchema.parse({
    student_message: "Ընտրիր բոլոր համապատասխան տարբերակները։",
    interaction_type: "multi_select",
    options: null,
    correct_option: null,
    question_template: null,
  }));
});

test("E — TASK contract rejects a non-answerable constructed explanation", () => {
  assert.throws(() => phase2TaskCandidateSchema.parse({
    student_message: "Մոլեկուլները մշտապես շարժվում են։",
    interaction_type: "constructed_response",
    options: null,
    correct_option: null,
    question_template: null,
  }));
});

test("F — FEEDBACK rejects a new imperative exercise without question punctuation", () => {
  assert.throws(() => assertFeedbackOnly({
    student_message: "Հաշվիր 2 + 2-ը և գրիր պատասխանը։",
  }));
});

test("G — constructed response has distinct authoritative task provenance", () => {
  const plan = derivePhase2ServerAction(input({
    nodeTeachingStage: "MICRO_CHECK",
    activeTaskProvenance: "constructed_response",
    learnerIntent: "ANSWER",
  }));
  assert.equal(plan.action, "EVALUATE_ACTIVE_TASK");
  assert.equal(plan.taskAuthority, "active_constructed_response");
  assert.equal(plan.compatibilityKind, null);
});

test("H — pending task selects backend source delivery when an eligible row exists", () => {
  const plan = derivePhase2ServerAction(input({
    eligibleSourceExerciseAvailable: true,
  }));
  assert.equal(plan.action, "DELIVER_SOURCE_EXERCISE");
  assert.equal(plan.aiGenerationNeeded, false);
  assert.equal(plan.taskAuthority, "active_source_exercise");
});

test("I — pending task selects bounded generation without an eligible source row", () => {
  const plan = derivePhase2ServerAction(input());
  assert.equal(plan.action, "GENERATE_TASK");
  assert.equal(plan.aiGenerationNeeded, true);
  assert.equal(plan.responseTeachingMode, "MICRO_CHECK");
});

test("J — EVALUATION accepts canonical downstream fields without feedback text", () => {
  const result = phase2EvaluationResultSchema.parse({
    status: "INCORRECT",
    evidence_quality: "NONE",
    error_family: "CONCEPTUAL",
    error_stability: "FIRST_OCCURRENCE",
    correct_parts: [],
    incorrect_parts: ["կանոնը սխալ է կիրառվել"],
  });
  assert.equal(result.status, "INCORRECT");
  assert.equal("student_message" in result, false);
});

test("K — FEEDBACK contract accepts learner wording only", () => {
  const result = phase2FeedbackResultSchema.parse({
    student_message: "Լավ փորձ էր։ Վերանայիր կանոնը և շարունակիր նույն առաջադրանքով։",
    answer_evaluation: { status: "CORRECT" },
  });
  assert.deepEqual(Object.keys(result), ["student_message"]);
});

console.log(`\n${passed}/11 Stage 3 bounded-job checks passed.\n`);