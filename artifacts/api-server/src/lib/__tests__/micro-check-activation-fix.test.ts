import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateTeachingCycle } from "../../services/ai.js";

const chatRouteSource = readFileSync(
  fileURLToPath(new URL("../../routes/chat.ts", import.meta.url)),
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

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test("A: feedback-only evaluated answer cannot activate MICRO_CHECK from THEORY", () => {
  assert.doesNotMatch(
    chatRouteSource,
    /if \(currentStage === "THEORY"\)\s*\{\s*newTeachingStage = "MICRO_CHECK";/u
  );
  assert.match(
    chatRouteSource,
    /if \(!wasEval && .*session\?\.nodeTeachingStage.*THEORY.*aiResult\.is_micro_check\)/su
  );
});

test("B: valid TEACH multiple-choice micro-check remains validator-approved", () => {
  assertValidationPass(
    baseResponse({
      interaction_type: "multiple_choice",
      options: [
        { key: "A", text: "Մոլեկուլները շարժվում են" },
        { key: "B", text: "Մոլեկուլները անշարժ են" },
      ],
      correct_option: "A",
      student_message: "Ո՞րն է ճիշտ.\nԱ) Մոլեկուլները շարժվում են\nԲ) Մոլեկուլները անշարժ են",
    })
  );
});

test("C: constructed-response transition sentence is rejected", () => {
  assert.throws(
    () =>
      assertValidationPass(
        baseResponse({
          student_message: "Հիմա փորձենք ավելի խորը հասկանալ այս երևույթը",
        })
      ),
    /constructed_response requires a visible question or answerable task/u
  );
});

test("D: constructed-response explicit question/task is accepted", () => {
  assertValidationPass(
    baseResponse({
      student_message: "Նկարագրիր, թե ինչպես է պղնձարջասպը խառնվում ջրի հետ։",
    })
  );
});

test("E: feedback-only path retains the ready state until a later task delivery", () => {
  assert.doesNotMatch(
    chatRouteSource,
    /if \(currentStage === "THEORY"\)\s*\{\s*newTeachingStage = "MICRO_CHECK";/u
  );
  assert.match(chatRouteSource, /activeTaskProvenance:\s*"micro_check"/u);
});

console.log(`\n${passed} micro-check activation-fix tests passed\n`);