/**
 * Phase 2 Orchestration Refactor — Stage 0 contract baseline.
 *
 * This suite intentionally freezes CURRENT behavior. It does not propose the
 * Stage 1 contract. Tests use production validators/evaluators where a pure seam
 * exists and source snapshots where the current route has no injectable seam.
 *
 * Run: pnpm --filter @workspace/api-server test:phase2-stage0
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  aiStructuredResponseSchema,
  answerEvaluationSchema,
  canonicalizePhase2TheoryEnvelope,
  sourceFidelitySchema,
  validateServerOwnedPhase2TheoryEnvelope,
  validateStructuredResponse,
  validateTeachingCycle,
  type AIStructuredResponse,
} from "../../services/ai.js";
import {
  decideNextPedagogicalAction,
  type CognitiveLevelRow,
  type PedagogicalDecisionInput,
} from "../../services/pedagogicalDecisionEngine.js";
import { normalizeObjectiveMicroCheckAnswer } from "../../services/phase2/orchestration.js";
import { buildAuthorizedLevelTransitionUpdate } from "../../services/phase2/canonical-completion-authority.js";
import {
  enforceActiveSourceExercise,
  resolveEligibleSourceExercise,
} from "../exercise-delivery.js";
import {
  evaluateDeterministicSourceExerciseAnswer,
} from "../deterministic-source-exercise-evaluation.js";

const chatRouteSource = readFileSync(
  fileURLToPath(new URL("../../routes/chat.ts", import.meta.url)),
  "utf8",
);
const phase2OrchestrationSource = readFileSync(
  fileURLToPath(new URL("../../services/phase2/orchestration.ts", import.meta.url)),
  "utf8",
);
const lessonsRouteSource = readFileSync(
  fileURLToPath(new URL("../../routes/lessons.ts", import.meta.url)),
  "utf8",
);
const chatInputSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../lib/api-zod/src/generated/types/chatInput.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);
const generatedApiSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../lib/api-client-react/src/generated/api.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);

type ActiveObjectiveTaskPayload = {
  interactionType: "multiple_choice" | "true_false";
  options: Array<{ key: string; text: string }> | null;
  correctOption: string;
};

type FrozenSessionState = {
  currentPhase: number;
  currentNodeId: number | null;
  nodeTeachingStage: "THEORY" | "MICRO_CHECK" | "EXERCISE" | "VERIFIED";
  activeCognitiveLevelId: number | null;
  activeTaskProvenance: "micro_check" | "source_exercise" | null;
  activeLessonExerciseId: number | null;
  activeObjectiveTaskPayload: ActiveObjectiveTaskPayload | null;
  activeAttemptSequence: number;
  activeHelpCount: number;
  activeAssistanceLevel: string;
  evidenceCount: number;
};

const THEORY_STATE: FrozenSessionState = {
  currentPhase: 2,
  currentNodeId: 2107,
  nodeTeachingStage: "THEORY",
  activeCognitiveLevelId: 301,
  activeTaskProvenance: null,
  activeLessonExerciseId: null,
  activeObjectiveTaskPayload: null,
  activeAttemptSequence: 0,
  activeHelpCount: 0,
  activeAssistanceLevel: "none",
  evidenceCount: 0,
};

const eligibleExercises = [
  {
    id: 940,
    exerciseId: "EX-579-1",
    exerciseTextVerbatim: "Առաջադրանք 1",
    sourcePage: 12,
  },
  {
    id: 941,
    exerciseId: "EX-579-2",
    exerciseTextVerbatim: "Առաջադրանք 2",
    sourcePage: 12,
  },
];

function baseResponse(
  overrides: Partial<AIStructuredResponse> = {},
): AIStructuredResponse {
  return aiStructuredResponseSchema.parse({
    student_message: "Բացատրիր, թե ինչու են մոլեկուլները շարժվում՞",
    progress_indicator: {
      current_node_name: "Մոլեկուլներ",
      step: 1,
      total_steps: 3,
      completed_nodes: 0,
      total_nodes: 3,
    },
    teaching_mode: "TEACH",
    is_micro_check: true,
    interaction_type: "constructed_response",
    options: null,
    correct_option: null,
    answer_evaluation: {
      status: "NOT_APPLICABLE",
      evidence_quality: "NONE",
      error_family: null,
      error_stability: null,
      correct_parts: [],
      incorrect_parts: [],
    },
    node_decision: {
      action: "CONTINUE_SAME_NODE",
      reason: "Stage 0 fixture",
    },
    source_fidelity: {
      type: "AI_GENERATED",
      exercise_id: null,
    },
    redirect_needed: false,
    mentions_out_of_scope_topic: false,
    question_template: null,
    encouragement_used: false,
    encouragement_focus: null,
    ...overrides,
  });
}

function lessonContext(stage: FrozenSessionState["nodeTeachingStage"]): string {
  return [
    "CURRENT_NODE: «Մոլեկուլներ» | node_id=2107",
    "ALLOWED_NODES:",
    "  - «Մոլեկուլներ» (id=2107)",
    `STUDENT_STATE: phase=2 | node_stage=${stage} | node_attempts=0 | nodes_done=0/3`,
    "CLASS_EXERCISES: (none)",
  ].join("\n");
}

function activateGeneratedTask(
  state: FrozenSessionState,
  response: AIStructuredResponse,
): FrozenSessionState {
  assert.equal(response.is_micro_check, true);
  assert.ok(
    response.interaction_type === "multiple_choice" ||
      response.interaction_type === "true_false",
  );
  assert.ok(response.correct_option);
  return {
    ...state,
    nodeTeachingStage: "MICRO_CHECK",
    activeTaskProvenance: "micro_check",
    activeLessonExerciseId: null,
    activeObjectiveTaskPayload: {
      interactionType: response.interaction_type,
      options:
        response.interaction_type === "multiple_choice"
          ? response.options
          : null,
      correctOption: response.correct_option,
    },
    activeAttemptSequence: 1,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  };
}

function assertResponseStateParity(
  response: AIStructuredResponse | null,
  state: FrozenSessionState,
): void {
  const hasVisibleGeneratedTask =
    response?.is_micro_check === true &&
    response.interaction_type !== null;
  const hasPersistedTask =
    state.activeTaskProvenance !== null ||
    state.nodeTeachingStage === "MICRO_CHECK" ||
    state.nodeTeachingStage === "EXERCISE";
  assert.equal(
    hasVisibleGeneratedTask,
    hasPersistedTask,
    "visible answerable task and persisted active-task state must agree",
  );
}

function makeLevel(
  overrides: Partial<CognitiveLevelRow> = {},
): CognitiveLevelRow {
  return {
    id: 301,
    cognitiveLevel: "remember",
    sequence: 1,
    isTargetCeiling: false,
    isApplicable: true,
    minimumIndependentEvidence: 1,
    preferredInteractionTypes: ["micro_check"],
    performanceObjective: null,
    successCriterion: null,
    ...overrides,
  };
}

const COGNITIVE_PATH: CognitiveLevelRow[] = [
  makeLevel(),
  makeLevel({
    id: 302,
    cognitiveLevel: "understand",
    sequence: 2,
    isTargetCeiling: true,
  }),
];

function decisionInput(
  overrides: Partial<PedagogicalDecisionInput> = {},
): PedagogicalDecisionInput {
  return {
    lessonNodeId: 2107,
    lessonId: 579,
    sessionId: 51,
    userId: 7,
    nodeTeachingStage: "MICRO_CHECK",
    remediationStep: 0,
    activeCognitiveLevelId: 301,
    activeCognitiveLevelRow: COGNITIVE_PATH[0],
    cognitivePath: COGNITIVE_PATH,
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    errorFamily: null,
    errorStability: null,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    activeAttemptSequence: 1,
    activeTaskProvenance: "micro_check",
    levelEvidenceSummary: {
      independentCorrectCount: 0,
      totalCorrectCount: 0,
      bestQuality: null,
    },
    nextNodeId: null,
    nextNodeHasCriticalDependencyOnCurrentNode: false,
    sessionBudgetExhausted: false,
    localNodeBudgetExhausted: false,
    ...overrides,
  };
}

function routeSlice(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing route marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing route end marker: ${endMarker}`);
  return source.slice(start, end);
}

const tests: Array<{ name: string; run: () => void }> = [];
function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

test("S0.1 — legacy structured AI contract snapshot remains exact", () => {
  assert.deepEqual(
    [...aiStructuredResponseSchema.keyof().options].sort(),
    [
      "answer_evaluation",
      "correct_option",
      "encouragement_focus",
      "encouragement_used",
      "interaction_type",
      "is_micro_check",
      "mentions_out_of_scope_topic",
      "node_decision",
      "options",
      "progress_indicator",
      "question_template",
      "redirect_needed",
      "source_fidelity",
      "student_message",
      "teaching_mode",
    ].sort(),
  );
  assert.deepEqual(
    [...answerEvaluationSchema.keyof().options].sort(),
    [
      "correct_parts",
      "error_family",
      "error_stability",
      "evidence_quality",
      "incorrect_parts",
      "status",
    ].sort(),
  );
  assert.deepEqual(
    [...sourceFidelitySchema.keyof().options].sort(),
    ["exercise_id", "type"],
  );
});

test("S0.2 — thin-client POST /api/chat input remains message + lessonId", () => {
  const interfaceBody =
    chatInputSource.match(/export interface ChatInput\s*\{([\s\S]*?)\}/u)?.[1] ??
    "";
  const keys = [...interfaceBody.matchAll(/^\s*(\w+)\??:/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(keys.sort(), ["lessonId", "message"]);
  assert.match(
    generatedApiSource,
    /getSendChatMessageUrl[\s\S]*return `\/api\/chat`/u,
  );
  assert.match(generatedApiSource, /method:\s*'POST'/u);
  for (const forbidden of [
    "teachingMode",
    "currentNodeId",
    "activeLessonExerciseId",
    "correctAnswer",
    "cognitiveLevelDecision",
    "evidenceResult",
  ]) {
    assert.ok(!interfaceBody.includes(forbidden), `${forbidden} must stay server-owned`);
  }
});

test("Fixture A — THEORY rejects a generated MICRO_CHECK; task generation is a later server action", () => {
  const candidate = baseResponse({
    teaching_mode: "FEEDBACK",
    is_micro_check: false,
    interaction_type: "multiple_choice",
    options: [
      { key: "A", text: "Մոլեկուլները շարժվում են" },
      { key: "B", text: "Մոլեկուլները անշարժ են" },
    ],
    correct_option: "A",
    student_message:
      "Ո՞րն է ճիշտ.\nԱ) Մոլեկուլները շարժվում են\nԲ) Մոլեկուլները անշարժ են",
  });
  const canonical = canonicalizePhase2TheoryEnvelope(candidate, {
    currentPhase: 2,
    currentNodeId: 2107,
    nodeTeachingStage: "THEORY",
  });
  validateServerOwnedPhase2TheoryEnvelope(canonical, {
    currentPhase: 2,
    currentNodeId: 2107,
    nodeTeachingStage: "THEORY",
  });
  assert.equal(canonical.teaching_mode, "TEACH");
  assert.equal(canonical.is_micro_check, false);
  assert.equal(THEORY_STATE.activeTaskProvenance, null);
  assert.equal(THEORY_STATE.activeObjectiveTaskPayload, null);
});

test("Fixture B — invalid THEORY generation fails before any response/state pair can activate", () => {
  const invalid = canonicalizePhase2TheoryEnvelope(
    baseResponse({
      is_micro_check: false,
      interaction_type: null,
      options: null,
      correct_option: null,
      student_message:
        "Մեկ։ Երկու։ Երեք։ Չորս։ Հինգ։ Վեց։ Յոթ։",
    }),
    {
      currentPhase: 2,
      currentNodeId: 2107,
      nodeTeachingStage: "THEORY",
    },
  );
  assert.throws(
    () => validateStructuredResponse(invalid),
    /student_message has 7 sentences \(max 5\)/u,
  );
  const persisted = { ...THEORY_STATE };
  assert.deepEqual(persisted, THEORY_STATE);
  assert.equal(persisted.activeTaskProvenance, null);
  assert.equal(persisted.activeObjectiveTaskPayload, null);
  assert.equal(persisted.activeLessonExerciseId, null);
  assert.equal(persisted.evidenceCount, 0);
  assert.match(chatRouteSource, /STRUCTURED_AI_REQUIRED/u);
  assert.match(
    chatRouteSource,
    /structured response required for controlled Phase 2 teaching/u,
  );
});

test("Fixture C — feedback-only response cannot manufacture a new MICRO_CHECK", () => {
  const feedback = baseResponse({
    teaching_mode: "FEEDBACK",
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
    student_message: "Ճիշտ ուղղությամբ ես մտածում։ Փորձենք ևս մեկ օրինակ։",
    answer_evaluation: {
      status: "PARTIALLY_CORRECT",
      evidence_quality: "WEAK",
      error_family: "INCOMPLETE_COMMUNICATION",
      error_stability: "FIRST_OCCURRENCE",
      correct_parts: ["core idea"],
      incorrect_parts: ["missing explanation"],
    },
    node_decision: {
      action: "CONTINUE_SAME_NODE",
      reason: "Need more evidence",
    },
  });
  validateTeachingCycle(feedback, [], lessonContext("MICRO_CHECK"));
  const persisted = { ...THEORY_STATE };
  assert.equal(feedback.is_micro_check, false);
  assert.equal(persisted.activeTaskProvenance, null);
  assert.equal(persisted.activeCognitiveLevelId, 301);
  assertResponseStateParity(null, persisted);
});

test("Fixture D — active objective payload deterministically owns multiple-choice correctness", () => {
  const payload: ActiveObjectiveTaskPayload = {
    interactionType: "multiple_choice",
    options: [
      { key: "A", text: "Առաջին" },
      { key: "B", text: "Երկրորդ" },
    ],
    correctOption: "B",
  };
  const normalized = normalizeObjectiveMicroCheckAnswer(
    "բ",
    payload.interactionType,
  );
  const backendStatus =
    normalized === payload.correctOption ? "CORRECT" : "INCORRECT";
  assert.equal(normalized, "B");
  assert.equal(backendStatus, "CORRECT");
  assert.notEqual(backendStatus, "INCORRECT", "model disagreement cannot win");
  assert.match(
    chatRouteSource,
    /session\?\.activeTaskProvenance === "micro_check"[\s\S]*session\.activeObjectiveTaskPayload/u,
  );
  assert.match(
    chatRouteSource,
    /Objective MICRO_CHECK correctness overridden deterministically/u,
  );
});

test("Fixture E — persisted active source ID 940 owns delivery and deterministic scoring", () => {
  const selection = resolveEligibleSourceExercise(
    eligibleExercises,
    "EX-579-1",
  );
  assert.equal(selection.selected?.id, 940);
  const evaluation = evaluateDeterministicSourceExerciseAnswer({
    learnerIntent: "ANSWER",
    activeTaskProvenance: "source_exercise",
    activeLessonExerciseId: selection.selected?.id ?? null,
    exerciseId: selection.selected?.exerciseId ?? null,
    interactionType: "multiple_choice",
    correctAnswer: "B",
    studentAnswer: "բ",
  });
  assert.equal(evaluation?.lessonExerciseId, 940);
  assert.equal(evaluation?.exerciseId, "EX-579-1");
  assert.equal(evaluation?.status, "CORRECT");
});

test("Fixture F — explicit eligible EX-579-2 persists and renders ID 941, never the first row", () => {
  const selection = resolveEligibleSourceExercise(
    eligibleExercises,
    "EX-579-2",
  );
  assert.equal(selection.selected?.id, 941);
  const rendered = enforceActiveSourceExercise(
    `Շարունակենք։\n${eligibleExercises[0].exerciseTextVerbatim}`,
    selection.selected?.exerciseTextVerbatim,
    [eligibleExercises[0].exerciseTextVerbatim],
  );
  assert.ok(!rendered.includes(eligibleExercises[0].exerciseTextVerbatim));
  assert.equal(
    rendered.split(eligibleExercises[1].exerciseTextVerbatim).length - 1,
    1,
  );
});

test("Fixture G — cognitive-level advance keeps node/Phase 2 and clears stale task state", () => {
  const decision = decideNextPedagogicalAction(decisionInput());
  assert.equal(decision.metaAction, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(decision.newActiveCognitiveLevelId, 302);
  const update = buildAuthorizedLevelTransitionUpdate(
    decision.newActiveCognitiveLevelId!,
  );
  assert.equal(update.activeCognitiveLevelId, 302);
  assert.equal(update.nodeTeachingStage, "THEORY");
  assert.equal(update.activeTaskProvenance, null);
  assert.equal(update.activeTaskSnapshot, null);
});

test("Fixture H — confirmed target ceiling is the authority that allows MicroNode completion", () => {
  const ceiling = makeLevel({
    id: 302,
    cognitiveLevel: "understand",
    sequence: 1,
    isTargetCeiling: true,
  });
  const decision = decideNextPedagogicalAction(
    decisionInput({
      activeCognitiveLevelId: 302,
      activeCognitiveLevelRow: ceiling,
      cognitivePath: [ceiling],
      evidenceQuality: "STRONG",
    }),
  );
  assert.equal(decision.metaAction, "COMPLETE_NODE");
  assert.equal(decision.targetReached, true);
  assert.equal(decision.mayCompleteMicroNode, true);
});

test("Fixture I — legacy VERIFIED stage cannot bypass a false Cognitive Path completion decision", () => {
  const decision = decideNextPedagogicalAction(
    decisionInput({
      activeCognitiveLevelRow: makeLevel({
        minimumIndependentEvidence: 2,
      }),
      answerStatus: "CORRECT",
      evidenceQuality: "MODERATE",
      levelEvidenceSummary: {
        independentCorrectCount: 0,
        totalCorrectCount: 0,
        bestQuality: null,
      },
    }),
  );
  const stageBecomesVerified = true;
  assert.equal(decision.mayCompleteMicroNode, false);
  assert.equal(stageBecomesVerified, true);
  assert.match(
    phase2OrchestrationSource,
    /const cognitiveCompletionGate =\s*decisionSaysComplete && codeGate/u,
  );
  assert.match(
    phase2OrchestrationSource,
    /return\s*\(\s*!input\.hasActiveCognitivePath\s*&&/u,
  );
});

test("Fixture J — constructed response rejects transitions and accepts a visible task only in MICRO_CHECK", () => {
  const transitionOnly = baseResponse({
    interaction_type: "constructed_response",
    student_message: "Հիմա անցնենք հաջորդ քայլին։",
  });
  assert.throws(
    () =>
      validateTeachingCycle(
        transitionOnly,
        [],
        lessonContext("THEORY"),
      ),
    /TEACH must be theory-only/u,
  );
  const answerable = baseResponse({
    teaching_mode: "MICRO_CHECK",
    is_micro_check: true,
    interaction_type: "constructed_response",
    student_message: "Բացատրիր՝ ինչո՞ւ են մոլեկուլները շարժվում։",
  });
  validateTeachingCycle(answerable, [], lessonContext("MICRO_CHECK"));
});

test("Fixture K — legacy source rows preserve the existing AI-assisted evaluation path", () => {
  const result = evaluateDeterministicSourceExerciseAnswer({
    learnerIntent: "ANSWER",
    activeTaskProvenance: "source_exercise",
    activeLessonExerciseId: 940,
    exerciseId: "EX-LEGACY",
    interactionType: null,
    correctAnswer: null,
    studentAnswer: "Իմ բացատրությունը",
  });
  assert.equal(result, null);
});

test("Fixture L — student chat/session-state payloads expose no hidden answer metadata", () => {
  const normalResponse = routeSlice(
    chatRouteSource,
    "res.json({\n    response:       responseContent",
    "// ── Phase 2B Part 7: Fire-and-forget AI Teacher durable evidence",
  );
  const sessionStateResponse = routeSlice(
    chatRouteSource,
    'router.get("/chat/session-state"',
    "export default router",
  );
  for (const snippet of [normalResponse, sessionStateResponse]) {
    for (const hidden of [
      "correctAnswer:",
      "correctOption:",
      "activeObjectiveTaskPayload:",
    ]) {
      assert.ok(!snippet.includes(hidden), `${hidden} must not be exposed`);
    }
  }
  assert.match(
    sessionStateResponse,
    /hasActiveTask[\s\S]*nodeTeachingStage[\s\S]*currentNodeId/u,
  );
});

test("S0.3 — fresh/relearn reset clears task state, retains the C6 target, and never durable evidence/mastery", () => {
  const resetRoute = routeSlice(
    lessonsRouteSource,
    'router.post("/lessons/:lessonId/start-fresh"',
    "// ── V2-R4A.3: POST /lessons/:lessonId/session/finish",
  );
  for (const [field, value] of [
    ["activeLessonExerciseId", "null"],
    ["activeTaskProvenance", "null"],
    ["activeObjectiveTaskPayload", "null"],
    ["nodeTeachingStage", '"THEORY"'],
    ["remediationStep", "0"],
    ["activeLearningSeconds", "0"],
  ]) {
    assert.match(
      resetRoute,
      new RegExp(`${field}:\\s+${value}`, "u"),
      `fresh reset must retain ${field}: ${value}`,
    );
  }
  assert.match(
    resetRoute,
    /activeCognitiveLevelId:\s+c6Decision\.nextTargetCognitiveLevelId/u,
    "fresh reset must retain the server-selected C6 cognitive target",
  );
  assert.ok(!resetRoute.includes(".delete(evidenceEventsTable)"));
  assert.ok(!resetRoute.includes(".delete(knowledgeNodesTable)"));
  assert.match(
    lessonsRouteSource,
    /Persistent evidence\/mastery[\s\S]*NEVER touched/u,
  );
});

test("S0.4 — budget exhaustion remains a non-failure Decision Engine outcome", () => {
  const decision = decideNextPedagogicalAction(
    decisionInput({
      answerStatus: "INCORRECT",
      evidenceQuality: "NONE",
      remediationStep: 2,
      sessionBudgetExhausted: true,
    }),
  );
  assert.equal(decision.metaAction, "END_REQUIRED_SESSION");
  assert.equal(decision.newRemediationStep, 2);
  assert.equal(decision.levelConfirmed, false);
  assert.equal(decision.revisitRequired, false);
  assert.equal(decision.revisitReason, null);
});

let passed = 0;
let failed = 0;
const failures: string[] = [];

console.log("\n▶ Phase 2 Stage 0 Contract Baseline\n");
for (const { name, run } of tests) {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error: unknown) {
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}`);
    console.error(
      `    ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

console.log(
  `\nPhase 2 Stage 0 Contract Baseline: ${passed} passed, ${failed} failed (${tests.length} total)`,
);
if (failures.length > 0) {
  console.error("Failures:");
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}