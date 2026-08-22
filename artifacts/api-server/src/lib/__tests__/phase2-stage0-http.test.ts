/**
 * Provider-free HTTP coverage for the Phase 2 orchestration baseline.
 *
 * The real Express POST /api/chat route and the isolated test database are used.
 * OpenRouter requests are intercepted in-process with deterministic,
 * OpenAI-compatible responses; no provider or model is called.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import {
  chatMessagesTable,
  evidenceEventsTable,
  lessonExercisesTable,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
  lessonSessionsTable,
  teachersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

import { createFactory } from "./helpers/fixture-factory.js";
import { makeRunId } from "./helpers/run-id.js";
import {
  assertTestDb,
  closeTestDb,
  getTestDb,
} from "./helpers/test-db.js";

type StructuredResponse = {
  student_message: string;
  progress_indicator: {
    current_node_name: string;
    step: number;
    total_steps: number;
    completed_nodes: number;
    total_nodes: number;
  };
  teaching_mode: "TEACH" | "MICRO_CHECK" | "FEEDBACK" | "TRANSITION";
  is_micro_check: boolean;
  interaction_type:
    | "multiple_choice"
    | "multi_select"
    | "true_false"
    | "matching"
    | "classification"
    | "ordering"
    | "numeric_answer"
    | "short_answer"
    | "constructed_response"
    | "problem_solving"
    | null;
  options: Array<{ key: string; text: string }> | null;
  correct_option: string | null;
  answer_evaluation: {
    status:
      | "CORRECT"
      | "PARTIALLY_CORRECT"
      | "INCORRECT"
      | "UNCLEAR"
      | "NO_RESPONSE"
      | "OFF_TOPIC"
      | "NOT_APPLICABLE";
    evidence_quality:
      | "NONE"
      | "WEAK"
      | "MODERATE"
      | "STRONG"
      | "CONCLUSIVE";
    error_family:
      | "CONCEPTUAL"
      | "PREREQUISITE"
      | "PROCEDURAL"
      | "CALCULATION_EXECUTION"
      | "READING_LANGUAGE"
      | "ATTENTION_RESPONSE"
      | "GUESSING_CONFIDENCE"
      | "INCOMPLETE_COMMUNICATION"
      | "TRANSFER_BLOOM"
      | "COGNITIVE_LOAD_PACE"
      | null;
    error_stability: "FIRST_OCCURRENCE" | "PERSISTENT" | null;
    correct_parts: string[];
    incorrect_parts: string[];
  };
  node_decision: {
    action:
      | "CONTINUE_SAME_NODE"
      | "COMPLETE_NODE"
      | "GUIDED_QUESTION"
      | "HINT"
      | "EXTRA_EXAMPLE"
      | "CONTRAST_EXAMPLE"
      | "CHANGE_REPRESENTATION"
      | "STEP_BY_STEP"
      | "SIMPLIFY_LANGUAGE"
      | "LOWER_DIFFICULTY"
      | "RAISE_DIFFICULTY"
      | "RETURN_TO_PREREQUISITE"
      | "VERIFY_SELECTION"
      | "REQUIRE_REASONING";
    reason: string;
  };
  source_fidelity: {
    type:
      | "SOURCE_EXACT"
      | "SOURCE_PARAPHRASED"
      | "AI_ADAPTED"
      | "AI_GENERATED";
    exercise_id: string | null;
  };
  redirect_needed: boolean;
  mentions_out_of_scope_topic: boolean;
  question_template: string | null;
  encouragement_used: boolean;
  encouragement_focus: string | null;
};

type ProviderQueueItem = {
  label: string;
  response: StructuredResponse;
};

const providerQueue: ProviderQueueItem[] = [];
const boundedJobCalls: string[] = [];
const boundedFeedbackContexts: string[] = [];
const originalFetch = globalThis.fetch;
let providerCallCount = 0;
let classifierCallCount = 0;

process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL =
  "http://127.0.0.1:9/v1";
process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY =
  "provider-free-stage0-test-key";
process.env.SESSION_SECRET ??= "phase2-stage0-http-test-secret";

function openAiEnvelope(content: string, idSuffix: string) {
  return {
    id: `chatcmpl-provider-free-stage0-${idSuffix}`,
    object: "chat.completion",
    created: 1_700_000_000,
    model: "provider-free-stage0-stub",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content,
        },
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("http://127.0.0.1:9/v1/")) {
    return originalFetch(input, init);
  }

  providerCallCount += 1;
  assert.equal(
    url,
    "http://127.0.0.1:9/v1/chat/completions",
    `unexpected provider URL: ${url}`,
  );
  assert.equal(
    input instanceof Request ? input.method : init?.method,
    "POST",
  );

  const rawBody = input instanceof Request
    ? await input.clone().text()
    : typeof init?.body === "string"
      ? init.body
      : "";
  const requestBody = JSON.parse(rawBody) as Record<string, unknown>;
  if (!("response_format" in requestBody)) {
    classifierCallCount += 1;
    return new Response(
      JSON.stringify(openAiEnvelope("ANSWER", "intent")),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  const next = providerQueue.shift();
  assert.ok(
    next,
    `unexpected structured AI call #${providerCallCount}; queue exhausted`,
  );
  const schemaName = (
    requestBody.response_format as {
      json_schema?: { name?: string };
    }
  ).json_schema?.name;
  if (schemaName?.startsWith("phase2_")) {
    boundedJobCalls.push(schemaName);
  }
  if (schemaName === "phase2_feedback_result") {
    const systemMessage = (
      requestBody.messages as Array<{ role?: string; content?: string }>
    ).find((message) => message.role === "system");
    boundedFeedbackContexts.push(systemMessage?.content ?? "");
  }
  const boundedResponse = (() => {
    switch (schemaName) {
      case "phase2_theory_result":
      case "phase2_feedback_result":
        return { student_message: next.response.student_message };
      case "phase2_task_candidate":
        return {
          student_message: next.response.student_message,
          interaction_type: next.response.interaction_type,
          options: next.response.options,
          correct_option: next.response.correct_option,
          question_template: next.response.question_template,
        };
      case "phase2_evaluation_result":
        return next.response.answer_evaluation;
      default:
        return next.response;
    }
  })();

  return new Response(
    JSON.stringify(
      openAiEnvelope(JSON.stringify(boundedResponse), next.label),
    ),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}) as typeof globalThis.fetch;

function multipleChoiceTask(label: string): StructuredResponse {
  return {
    student_message: [
      `${label} Ընտրիր ճիշտ պատասխանը։`,
      "Ա) Մասնիկները միշտ անշարժ են",
      "Բ) Մասնիկները մշտապես շարժվում են",
      "Գ) Մասնիկները գոյություն չունեն",
      "Դ) Շարժվում են միայն լույսի ներքո",
    ].join("\n"),
    progress_indicator: {
      current_node_name: "Մոլեկուլների շարժում",
      step: 1,
      total_steps: 1,
      completed_nodes: 0,
      total_nodes: 1,
    },
    teaching_mode: "TEACH",
    is_micro_check: true,
    interaction_type: "multiple_choice",
    options: [
      { key: "A", text: "Մասնիկները միշտ անշարժ են" },
      { key: "B", text: "Մասնիկները մշտապես շարժվում են" },
      { key: "C", text: "Մասնիկները գոյություն չունեն" },
      { key: "D", text: "Շարժվում են միայն լույսի ներքո" },
    ],
    correct_option: "B",
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
      reason: "Ask one visible objective micro-check",
    },
    source_fidelity: {
      type: "AI_GENERATED",
      exercise_id: null,
    },
    redirect_needed: false,
    mentions_out_of_scope_topic: false,
    question_template: "particle motion multiple choice",
    encouragement_used: false,
    encouragement_focus: null,
  };
}

function prematureCompletionFeedback(label: string): StructuredResponse {
  return {
    student_message: `${label} Պատասխանը գրանցվեց։`,
    progress_indicator: {
      current_node_name: "Մոլեկուլների շարժում",
      step: 1,
      total_steps: 1,
      completed_nodes: 0,
      total_nodes: 1,
    },
    teaching_mode: "FEEDBACK",
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
    answer_evaluation: {
      status: "CORRECT",
      evidence_quality: "STRONG",
      error_family: null,
      error_stability: null,
      correct_parts: ["selected the correct option"],
      incorrect_parts: [],
    },
    node_decision: {
      action: "COMPLETE_NODE",
      reason: "Synthetic model asks to complete the node",
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
  };
}

function invalidTheory(label: string): StructuredResponse {
  return {
    ...multipleChoiceTask(label),
    student_message: `${label} Սա միայն բացատրություն է։`,
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
  };
}

function sourceTransition(exerciseId: string): StructuredResponse {
  return {
    ...multipleChoiceTask("Դասագրքի առաջադրանք։"),
    student_message:
      "Աղբյուրային շարժում թեմայով անցնենք դասագրքի հաջորդ առաջադրանքին։",
    progress_indicator: {
      current_node_name: "Աղբյուրային շարժում",
      step: 1,
      total_steps: 1,
      completed_nodes: 0,
      total_nodes: 1,
    },
    teaching_mode: "TRANSITION",
    is_micro_check: false,
    interaction_type: null,
    options: null,
    correct_option: null,
    answer_evaluation: {
      status: "CORRECT",
      evidence_quality: "MODERATE",
      error_family: null,
      error_stability: null,
      correct_parts: ["answered the prior micro-check"],
      incorrect_parts: [],
    },
    source_fidelity: {
      type: "SOURCE_EXACT",
      exercise_id: exerciseId,
    },
    question_template: null,
  };
}

function conflictingSourceFeedback(): StructuredResponse {
  return {
    ...prematureCompletionFeedback("Աղբյուրային պատասխանը։"),
    progress_indicator: {
      current_node_name: "Աղբյուրային շարժում",
      step: 1,
      total_steps: 1,
      completed_nodes: 0,
      total_nodes: 1,
    },
    node_decision: {
      action: "CONTINUE_SAME_NODE",
      reason: "Synthetic model incorrectly marks the typed answer wrong",
    },
    answer_evaluation: {
      status: "INCORRECT",
      evidence_quality: "NONE",
      error_family: "CONCEPTUAL",
      error_stability: "FIRST_OCCURRENCE",
      correct_parts: [],
      incorrect_parts: ["synthetic conflicting evaluation"],
    },
  };
}

function enqueue(label: string, response: StructuredResponse): void {
  providerQueue.push({ label, response });
}

function assertNoPrivateAnswerMetadata(
  payload: Record<string, unknown>,
  context: string,
): void {
  const serialized = JSON.stringify(payload);
  for (const forbiddenKey of [
    "correctOption",
    "correct_option",
    "correctAnswer",
    "interactionType",
    "interaction_type",
    "options",
    "activeObjectiveTaskPayload",
    "answer_evaluation",
    "node_decision",
    "source_fidelity",
    "systemPrompt",
    "lessonContext",
  ]) {
    assert.equal(
      serialized.includes(`"${forbiddenKey}"`),
      false,
      `${context} leaked private field ${forbiddenKey}`,
    );
  }
}

async function requestJson(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const response = await originalFetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const json = await response.json() as Record<string, unknown>;
  return { response, json };
}

async function postChat(
  baseUrl: string,
  token: string,
  lessonId: number,
  message: string,
) {
  return requestJson(`${baseUrl}/api/chat`, token, {
    method: "POST",
    body: JSON.stringify({ message, lessonId }),
  });
}

async function getSession(
  lessonId: number,
  userId: number,
) {
  const [session] = await getTestDb()
    .select()
    .from(lessonSessionsTable)
    .where(and(
      eq(lessonSessionsTable.lessonId, lessonId),
      eq(lessonSessionsTable.userId, userId),
    ))
    .limit(1);
  assert.ok(session, `missing lesson session for user ${userId}`);
  return session;
}

async function waitForEvidenceCount(
  sessionId: number,
  expected: number,
): Promise<typeof evidenceEventsTable.$inferSelect[]> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const rows = await getTestDb()
      .select()
      .from(evidenceEventsTable)
      .where(eq(evidenceEventsTable.lessonSessionId, sessionId));
    if (rows.length === expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const rows = await getTestDb()
    .select()
    .from(evidenceEventsTable)
    .where(eq(evidenceEventsTable.lessonSessionId, sessionId));
  assert.equal(rows.length, expected, `expected ${expected} evidence rows`);
  return rows;
}

assertTestDb();

const db = getTestDb();
const factory = createFactory(makeRunId());
let server: import("node:http").Server | undefined;

try {
  const teacher = await factory.teacher();
  const successfulStudent = await factory.student();
  const failingStudent = await factory.student();
  const sourceStudent = await factory.student();
  const constructedStudent = await factory.student();
  const [teacherProfile] = await db
    .insert(teachersTable)
    .values({ userId: teacher.userId })
    .returning({ id: teachersTable.id });
  const cls = await factory.class_(teacherProfile.id);
  await factory.enrollStudent(cls.id, successfulStudent.userId);
  await factory.enrollStudent(cls.id, failingStudent.userId);
  await factory.enrollStudent(cls.id, sourceStudent.userId);
  await factory.enrollStudent(cls.id, constructedStudent.userId);

  const lesson = await factory.lesson(
    teacher.userId,
    cls.id,
    18,
    { status: "active" },
  );
  const node = await factory.node(lesson.id, {
    sequence: 1,
    status: "approved",
    title: "Մոլեկուլների շարժում",
    learningObjective:
      "Աշակերտը կարող է բացատրել, որ մոլեկուլները մշտապես շարժվում են։",
    theoryContent: "Մոլեկուլները մշտապես շարժվում են։",
  });
  await db
    .update(lessonNodesTable)
    .set({ cogPathStatus: "confirmed" })
    .where(eq(lessonNodesTable.id, node.id));

  const [rememberLevel, understandLevel] = await db
    .insert(lessonNodeCognitiveLevelsTable)
    .values([
      {
        lessonNodeId: node.id,
        cognitiveLevel: "remember",
        sequence: 1,
        isApplicable: true,
        isTargetCeiling: false,
        performanceObjective: "Աշակերտը բացատրում է, որ մոլեկուլները մշտապես շարժվում են։",
        successCriterion: "Ճիշտ է նշում, որ մոլեկուլները մշտապես շարժվում են։",
        provenance: "teacher_authored",
        minimumIndependentEvidence: 1,
        preferredInteractionTypes: ["multiple_choice"],
      },
      {
        lessonNodeId: node.id,
        cognitiveLevel: "understand",
        sequence: 2,
        isApplicable: true,
        isTargetCeiling: true,
        performanceObjective: "Աշակերտը բացատրում է, որ մոլեկուլները մշտապես շարժվում են։",
        successCriterion: "Ճիշտ է նշում, որ մոլեկուլները մշտապես շարժվում են։",
        provenance: "teacher_authored",
        minimumIndependentEvidence: 1,
        preferredInteractionTypes: ["multiple_choice"],
      },
    ])
    .returning();

  const sourceLesson = await factory.lesson(
    teacher.userId,
    cls.id,
    18,
    { status: "active" },
  );
  const sourceNode = await factory.node(sourceLesson.id, {
    sequence: 1,
    status: "approved",
    title: "Աղբյուրային շարժում",
    learningObjective:
      "Աշակերտը կարող է ընտրել դասագրքի ճիշտ պատասխանը։",
    theoryContent: "Դասագրքի առաջադրանքը ստուգում է մասնիկների շարժումը։",
  });
  await db
    .update(lessonNodesTable)
    .set({ cogPathStatus: "confirmed" })
    .where(eq(lessonNodesTable.id, sourceNode.id));
  const [sourceLevel] = await db
    .insert(lessonNodeCognitiveLevelsTable)
    .values({
      lessonNodeId: sourceNode.id,
      cognitiveLevel: "apply",
      sequence: 1,
      isApplicable: true,
      isTargetCeiling: true,
      performanceObjective: "Աշակերտը ընտրում է դասագրքի ճիշտ պատասխանը մասնիկների շարժման վերաբերյալ։",
      successCriterion: "Ընտրում է դասագրքի ճիշտ տարբերակը։",
      provenance: "teacher_authored",
      minimumIndependentEvidence: 3,
      preferredInteractionTypes: ["multiple_choice"],
    })
    .returning();

  const sourceExercise1Text = [
    "Աղբյուր 1. Ո՞ր պնդումն է ճիշտ։",
    "Ա) Առաջին տարբերակ",
    "Բ) Երկրորդ տարբերակ",
  ].join("\n");
  const sourceExercise2Text = [
    "Աղբյուր 2. Ընտրիր մասնիկների շարժման ճիշտ պնդումը։",
    "Ա) Մասնիկները միշտ անշարժ են",
    "Բ) Մասնիկները մշտապես շարժվում են",
  ].join("\n");
  const sourceExercise1 = await factory.exercise(
    sourceLesson.id,
    sourceNode.id,
    { exerciseText: sourceExercise1Text, assignment: "CLASS" },
  );
  const sourceExercise2 = await factory.exercise(
    sourceLesson.id,
    sourceNode.id,
    { exerciseText: sourceExercise2Text, assignment: "CLASS" },
  );
  const sourceExercise1ExternalId = `S0-${sourceLesson.id}-EX-1`;
  const sourceExercise2ExternalId = `S0-${sourceLesson.id}-EX-2`;
  await db
    .update(lessonExercisesTable)
    .set({
      exerciseId: sourceExercise1ExternalId,
      sequence: 1,
      status: "approved",
      interactionType: "multiple_choice",
      correctAnswer: "A",
    })
    .where(eq(lessonExercisesTable.id, sourceExercise1.id));
  await db
    .update(lessonExercisesTable)
    .set({
      exerciseId: sourceExercise2ExternalId,
      sequence: 2,
      status: "approved",
      interactionType: "multiple_choice",
      correctAnswer: "B",
    })
    .where(eq(lessonExercisesTable.id, sourceExercise2.id));

  await db.insert(lessonSessionsTable).values([
    {
      userId: successfulStudent.userId,
      lessonId: lesson.id,
      currentPhase: 2,
      status: "active",
      currentNodeId: node.id,
      nodeStartedAt: new Date(),
      nodeTeachingStage: "THEORY",
      introConfirmed: false,
    },
    {
      userId: failingStudent.userId,
      lessonId: lesson.id,
      currentPhase: 2,
      status: "active",
      currentNodeId: node.id,
      nodeStartedAt: new Date(),
      nodeTeachingStage: "THEORY",
      introConfirmed: false,
    },
    {
      userId: sourceStudent.userId,
      lessonId: sourceLesson.id,
      currentPhase: 2,
      status: "active",
      currentNodeId: sourceNode.id,
      nodeStartedAt: new Date(),
      nodeTeachingStage: "MICRO_CHECK",
      introConfirmed: true,
      lastQuestionAsked: "Բացատրի՛ր մասնիկների շարժումը։",
      activeCognitiveLevelId: sourceLevel.id,
      activeTaskProvenance: "micro_check",
      activeAttemptSequence: 1,
    },
    {
      userId: constructedStudent.userId,
      lessonId: lesson.id,
      currentPhase: 2,
      status: "active",
      currentNodeId: node.id,
      nodeStartedAt: new Date(),
      nodeTeachingStage: "MICRO_CHECK",
      introConfirmed: true,
      lastQuestionAsked: "Բացատրի՛ր, թե ինչու են մոլեկուլները շարժվում։",
      activeCognitiveLevelId: rememberLevel.id,
      activeTaskProvenance: "constructed_response",
      activeAttemptSequence: 1,
    },
  ]);

  const appModule = await import("../../app.js");
  const authModule = await import("../../middlewares/auth.js");
  const app = appModule.default;
  server = app.listen(0);
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const successfulToken = authModule.signToken(
    successfulStudent.userId,
    "student",
  );
  const failingToken = authModule.signToken(
    failingStudent.userId,
    "student",
  );
  const sourceToken = authModule.signToken(
    sourceStudent.userId,
    "student",
  );
  const constructedToken = authModule.signToken(
    constructedStudent.userId,
    "student",
  );

  console.log("\n▶ Phase 2 Stage 0 provider-free HTTP baseline\n");

  const intro = await postChat(
    baseUrl,
    successfulToken,
    lesson.id,
    "Բարև",
  );
  assert.equal(intro.response.status, 200);
  assert.equal(providerCallCount, 0);
  console.log("  ✓ deterministic intro creates no provider request");

  const theoryOnly = multipleChoiceTask("Հիշելու մակարդակ։");
  theoryOnly.student_message = "Մոլեկուլները մշտապես շարժվում են, և այդ շարժումն է բացատրում շատ երևույթներ։";
  theoryOnly.teaching_mode = "TEACH";
  theoryOnly.is_micro_check = false;
  theoryOnly.interaction_type = null;
  theoryOnly.options = null;
  theoryOnly.correct_option = null;
  enqueue("remember theory only", theoryOnly);
  enqueue("remember bounded task", multipleChoiceTask("Հիշելու մակարդակ։"));
  const firstTheory = await postChat(
    baseUrl,
    successfulToken,
    lesson.id,
    "պատրաստ",
  );
  assert.equal(firstTheory.response.status, 200);
  assert.equal(providerCallCount, 2);
  assert.equal(firstTheory.json.teachingMode, "MICRO_CHECK");
  assert.equal(firstTheory.json.hasActiveTask, true);
  assert.equal(typeof firstTheory.json.messageId, "number");
  assertNoPrivateAnswerMetadata(firstTheory.json, "POST /api/chat");

  const publicResponseKeys = [
    "activeHelpCount",
    "activeLearningSeconds",
    "hasActiveTask",
    "messageId",
    "optionalContinuation",
    "progressIndicator",
    "remainingRequiredSeconds",
    "requiredSessionCompleted",
    "requiredSessionCompletedAt",
    "requiredSessionMinutes",
    "response",
    "sessionBudgetExhausted",
    "sessionDecision",
    "teachingMode",
  ];
  assert.deepEqual(Object.keys(firstTheory.json).sort(), publicResponseKeys);

  let session = await getSession(lesson.id, successfulStudent.userId);
  assert.equal(session.currentPhase, 2);
  assert.equal(session.currentNodeId, node.id);
  assert.equal(session.nodeTeachingStage, "MICRO_CHECK");
  assert.equal(session.activeTaskProvenance, "micro_check");
  assert.equal(session.activeCognitiveLevelId, rememberLevel.id);
  assert.equal(session.activeAttemptSequence, 1);
  assert.deepEqual(session.activeObjectiveTaskPayload, {
    interactionType: "multiple_choice",
    options: [
      { key: "A", text: "Մասնիկները միշտ անշարժ են" },
      { key: "B", text: "Մասնիկները մշտապես շարժվում են" },
      { key: "C", text: "Մասնիկները գոյություն չունեն" },
      { key: "D", text: "Շարժվում են միայն լույսի ներքո" },
    ],
    correctOption: "B",
  });
  assert.equal((await waitForEvidenceCount(session.id, 0)).length, 0);
  console.log("  ✓ READY persists THEORY then automatically delivers exactly one bounded task");

  const sessionState = await requestJson(
    `${baseUrl}/api/chat/session-state?lessonId=${lesson.id}`,
    successfulToken,
  );
  assert.equal(sessionState.response.status, 200);
  assert.equal(sessionState.json.currentNodeId, node.id);
  assert.equal(sessionState.json.currentPhase, 2);
  assert.equal(sessionState.json.nodeTeachingStage, "MICRO_CHECK");
  assert.equal(sessionState.json.hasActiveTask, true);
  assertNoPrivateAnswerMetadata(
    sessionState.json,
    "GET /api/chat/session-state",
  );
  const lessonDetails = await requestJson(
    `${baseUrl}/api/lessons/${lesson.id}`,
    successfulToken,
  );
  assert.equal(lessonDetails.response.status, 200);
  assertNoPrivateAnswerMetadata(
    lessonDetails.json,
    "GET /api/lessons/:lessonId",
  );
  const studentPackage = await requestJson(
    `${baseUrl}/api/lessons/${lesson.id}/student-package`,
    successfulToken,
  );
  assert.equal(studentPackage.response.status, 200);
  assertNoPrivateAnswerMetadata(
    studentPackage.json,
    "GET /api/lessons/:lessonId/student-package",
  );
  console.log("  ✓ bounded TASK response creates exactly one persisted task");
  console.log("  ✓ chat and session-state payloads hide answer metadata");
  console.log("  ✓ student lesson/session payloads hide answer metadata");

  enqueue(
    "remember premature completion",
    prematureCompletionFeedback("Առաջին պատասխանը։"),
  );
  const understandTheory = multipleChoiceTask("Հասկանալու մակարդակ։");
  understandTheory.student_message = "Մասնիկների շարժումը կախված է նրանց ջերմային էներգիայից։";
  understandTheory.teaching_mode = "TEACH";
  understandTheory.is_micro_check = false;
  understandTheory.interaction_type = null;
  understandTheory.options = null;
  understandTheory.correct_option = null;
  enqueue("understand theory after evaluation", understandTheory);
  enqueue("understand bounded task after evaluation", multipleChoiceTask("Հասկանալու մակարդակ։"));
  const objectiveJobsBeforeAnswer = boundedJobCalls.length;
  const firstAnswer = await postChat(
    baseUrl,
    successfulToken,
    lesson.id,
    "Բ",
  );
  assert.equal(firstAnswer.response.status, 200);
  assert.equal(firstAnswer.json.sessionDecision, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(firstAnswer.json.hasActiveTask, true);
  assert.deepEqual(
    boundedJobCalls.slice(objectiveJobsBeforeAnswer),
    ["phase2_feedback_result", "phase2_theory_result", "phase2_task_candidate"],
    "objective MICRO_CHECK must use deterministic scoring, then continue through separate FEEDBACK, THEORY, and TASK jobs",
  );
  const objectiveFeedbackContext = boundedFeedbackContexts.at(-1) ?? "";
  assert.match(objectiveFeedbackContext, /"status":"CORRECT"/u);
  assert.match(
    objectiveFeedbackContext,
    /Decision Engine meta action: ADVANCE_COGNITIVE_LEVEL/u,
  );
  assert.match(
    objectiveFeedbackContext,
    /Server action: ADVANCE_COGNITIVE_LEVEL/u,
  );

  session = await getSession(lesson.id, successfulStudent.userId);
  assert.equal(session.currentPhase, 2);
  assert.equal(session.currentNodeId, node.id);
  assert.equal(session.nodeTeachingStage, "MICRO_CHECK");
  assert.equal(session.activeCognitiveLevelId, understandLevel.id);
  assert.equal(session.activeTaskProvenance, "micro_check");
  assert.notEqual(session.activeObjectiveTaskPayload, null);
  const firstEvidence = await waitForEvidenceCount(session.id, 1);
  assert.equal(firstEvidence[0]?.wasCorrect, true);
  assert.equal(firstEvidence[0]?.cognitiveLevel, "remember");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    (await waitForEvidenceCount(session.id, 1)).length,
    1,
    "evaluated task must not create duplicate evidence",
  );
  console.log("  ✓ deterministic objective scoring overrides model authority");
  console.log("  ✓ feedback persists separately; Cognitive Path then auto-continues through THEORY and TASK");
  console.log("  ✓ Cognitive Path advances without entering Phase 3");
  console.log("  ✓ evaluated task creates exactly one evidence event");

  enqueue(
    "requested second source exercise",
    sourceTransition(sourceExercise2ExternalId),
  );
  const sourceDelivery = await postChat(
    baseUrl,
    sourceToken,
    sourceLesson.id,
    "նախորդ պատասխանը",
  );
  assert.equal(sourceDelivery.response.status, 200);
  assert.equal(sourceDelivery.json.teachingMode, "TRANSITION");
  assert.equal(sourceDelivery.json.hasActiveTask, true);
  const deliveredText = String(sourceDelivery.json.response);
  assert.equal(deliveredText.includes(sourceExercise1Text), false);
  assert.equal(deliveredText.includes(sourceExercise2Text), true);
  assert.equal(
    deliveredText.split(sourceExercise2Text).length - 1,
    1,
    "selected source exercise must be delivered exactly once",
  );

  let sourceSession = await getSession(
    sourceLesson.id,
    sourceStudent.userId,
  );
  assert.equal(sourceSession.currentPhase, 2);
  assert.equal(sourceSession.currentNodeId, sourceNode.id);
  assert.equal(sourceSession.nodeTeachingStage, "EXERCISE");
  assert.equal(
    sourceSession.activeLessonExerciseId,
    sourceExercise2.id,
  );
  assert.equal(sourceSession.activeTaskProvenance, "source_exercise");
  assert.equal(sourceSession.activeObjectiveTaskPayload, null);
  const deliveryEvidence = await waitForEvidenceCount(sourceSession.id, 1);
  assert.equal(deliveryEvidence[0]?.lessonExerciseId, null);
  console.log("  ✓ requested eligible source row wins over first-row fallback");
  console.log("  ✓ persisted source ID owns exactly-once verbatim delivery");

  const sourceState = await requestJson(
    `${baseUrl}/api/chat/session-state?lessonId=${sourceLesson.id}`,
    sourceToken,
  );
  assert.equal(sourceState.response.status, 200);
  assert.equal(sourceState.json.hasActiveTask, true);
  assertNoPrivateAnswerMetadata(
    sourceState.json,
    "source GET /api/chat/session-state",
  );
  const sourceLessonDetails = await requestJson(
    `${baseUrl}/api/lessons/${sourceLesson.id}`,
    sourceToken,
  );
  assert.equal(sourceLessonDetails.response.status, 200);
  assertNoPrivateAnswerMetadata(
    sourceLessonDetails.json,
    "source GET /api/lessons/:lessonId",
  );
  const sourceStudentPackage = await requestJson(
    `${baseUrl}/api/lessons/${sourceLesson.id}/student-package`,
    sourceToken,
  );
  assert.equal(sourceStudentPackage.response.status, 200);
  assertNoPrivateAnswerMetadata(
    sourceStudentPackage.json,
    "source GET /api/lessons/:lessonId/student-package",
  );
  const publicExercises = sourceStudentPackage.json.exercises;
  assert.ok(Array.isArray(publicExercises));
  assert.deepEqual(
    publicExercises.map((exercise) => (
      exercise as Record<string, unknown>
    ).effectiveExerciseText),
    [sourceExercise1Text, sourceExercise2Text],
  );
  console.log("  ✓ typed source answers stay out of student lesson payloads");

  enqueue("conflicting source score", conflictingSourceFeedback());
  const sourceJobsBeforeAnswer = boundedJobCalls.length;
  const sourceAnswer = await postChat(
    baseUrl,
    sourceToken,
    sourceLesson.id,
    "B",
  );
  assert.equal(sourceAnswer.response.status, 200);
  assert.equal(sourceAnswer.json.hasActiveTask, false);
  assert.deepEqual(
    boundedJobCalls.slice(sourceJobsBeforeAnswer),
    ["phase2_feedback_result"],
    "typed source exercise must use deterministic scoring and skip EVALUATION AI",
  );
  sourceSession = await getSession(
    sourceLesson.id,
    sourceStudent.userId,
  );
  assert.equal(sourceSession.nodeTeachingStage, "VERIFIED");
  assert.equal(sourceSession.activeLessonExerciseId, null);
  assert.equal(sourceSession.activeTaskProvenance, null);

  const sourceEvidenceRows = await waitForEvidenceCount(sourceSession.id, 2);
  const selectedSourceEvidence = sourceEvidenceRows.filter(
    (row) => row.lessonExerciseId === sourceExercise2.id,
  );
  assert.equal(selectedSourceEvidence.length, 1);
  assert.equal(selectedSourceEvidence[0]?.wasCorrect, true);
  assert.equal(
    sourceEvidenceRows.some(
      (row) => row.lessonExerciseId === sourceExercise1.id,
    ),
    false,
  );
  console.log("  ✓ persisted source row deterministically overrides model score");
  console.log("  ✓ source evidence is written once with no identity drift");

  await db
    .update(lessonSessionsTable)
    .set({
      nodeTeachingStage: "EXERCISE",
      activeTaskProvenance: "source_exercise",
      activeLessonExerciseId: sourceExercise2.id,
      activeObjectiveTaskPayload: null,
      activeAttemptSequence: 1,
    } as any)
    .where(eq(lessonSessionsTable.id, sourceSession.id));
  const sourceFreeFormEvaluation = multipleChoiceTask("Ազատ աղբյուրային պատասխան");
  sourceFreeFormEvaluation.student_message = "գնահատման ներքին payload";
  sourceFreeFormEvaluation.answer_evaluation = {
    status: "CORRECT",
    evidence_quality: "MODERATE",
    error_family: null,
    error_stability: null,
    correct_parts: ["նշված տարբերակը հիմնավորված է"],
    incorrect_parts: [],
  };
  enqueue("free-form typed source evaluation", sourceFreeFormEvaluation);
  enqueue("free-form typed source feedback", prematureCompletionFeedback("Ազատ աղբյուրային պատասխան"));
  const sourceFreeFormJobsBefore = boundedJobCalls.length;
  const sourceFreeFormAnswer = await postChat(
    baseUrl,
    sourceToken,
    sourceLesson.id,
    "Կարծում եմ՝ Բ տարբերակն է, քանի որ այն նկարագրում է երևույթը։",
  );
  assert.equal(sourceFreeFormAnswer.response.status, 200);
  assert.deepEqual(
    boundedJobCalls.slice(sourceFreeFormJobsBefore),
    ["phase2_evaluation_result", "phase2_feedback_result"],
    "free-form typed source answer must use bounded EVALUATION before FEEDBACK",
  );
  console.log("  ✓ free-form typed source answer uses bounded EVALUATION before FEEDBACK");

  await db
    .update(lessonExercisesTable)
    .set({
      interactionType: "constructed_response",
      correctAnswer: null,
    })
    .where(eq(lessonExercisesTable.id, sourceExercise1.id));
  await db
    .update(lessonSessionsTable)
    .set({
      nodeTeachingStage: "EXERCISE",
      activeTaskProvenance: "source_exercise",
      activeLessonExerciseId: sourceExercise1.id,
      activeObjectiveTaskPayload: null,
      activeAttemptSequence: 1,
    } as any)
    .where(eq(lessonSessionsTable.id, sourceSession.id));
  const sourceConstructedEvaluation = multipleChoiceTask("Աղբյուրային կառուցված");
  sourceConstructedEvaluation.student_message = "գնահատման ներքին payload";
  sourceConstructedEvaluation.answer_evaluation = {
    status: "CORRECT",
    evidence_quality: "MODERATE",
    error_family: null,
    error_stability: null,
    correct_parts: ["բացատրությունը համապատասխանում է կանոնին"],
    incorrect_parts: [],
  };
  const sourceConstructedFeedback = multipleChoiceTask("Աղբյուրային կառուցված feedback");
  sourceConstructedFeedback.student_message = "Բացատրությունդ ճիշտ ուղղությամբ է։";
  enqueue("non-deterministic source evaluation", sourceConstructedEvaluation);
  enqueue("non-deterministic source feedback", sourceConstructedFeedback);
  const sourceConstructedJobsBefore = boundedJobCalls.length;
  const sourceConstructedAnswer = await postChat(
    baseUrl,
    sourceToken,
    sourceLesson.id,
    "Մասնիկները շարժվում են ջերմային էներգիայի պատճառով։",
  );
  assert.equal(sourceConstructedAnswer.response.status, 200);
  assert.deepEqual(
    boundedJobCalls.slice(sourceConstructedJobsBefore),
    ["phase2_evaluation_result", "phase2_feedback_result"],
    "non-deterministic source answer must evaluate before FEEDBACK",
  );
  console.log("  ✓ non-deterministic source exercise uses bounded EVALUATION before FEEDBACK");

  const constructedEvaluation = multipleChoiceTask("Կառուցված պատասխան");
  constructedEvaluation.student_message = "գնահատման ներքին payload";
  constructedEvaluation.answer_evaluation = {
    status: "CORRECT",
    evidence_quality: "MODERATE",
    error_family: null,
    error_stability: null,
    correct_parts: ["պատասխանը բացատրում է շարժումը"],
    incorrect_parts: [],
  };
  constructedEvaluation.node_decision = {
    action: "COMPLETE_NODE",
    reason: "must be ignored by bounded evaluation",
  };
  const constructedFeedback = multipleChoiceTask("Կառուցված feedback");
  constructedFeedback.student_message = "Ճիշտ ես բացատրել մասնիկների շարժումը։";
  constructedFeedback.answer_evaluation.status = "INCORRECT";
  enqueue("constructed bounded evaluation", constructedEvaluation);
  enqueue("constructed bounded feedback", constructedFeedback);
  const constructedJobsBeforeAnswer = boundedJobCalls.length;
  const constructedAnswer = await postChat(
    baseUrl,
    constructedToken,
    lesson.id,
    "Քանի որ մասնիկները ջերմային շարժման մեջ են։",
  );
  assert.equal(constructedAnswer.response.status, 200);
  assert.equal(constructedAnswer.json.teachingMode, "FEEDBACK");
  assert.equal(constructedAnswer.json.sessionDecision, "ADVANCE_COGNITIVE_LEVEL");
  assert.deepEqual(
    boundedJobCalls.slice(constructedJobsBeforeAnswer),
    ["phase2_evaluation_result", "phase2_feedback_result"],
    "constructed answer must evaluate before Decision Engine feedback",
  );
  const constructedSession = await getSession(lesson.id, constructedStudent.userId);
  assert.equal(constructedSession.nodeTeachingStage, "THEORY");
  assert.equal(constructedSession.activeTaskProvenance, null);
  const constructedEvidence = await waitForEvidenceCount(constructedSession.id, 1);
  assert.equal(constructedEvidence[0]?.wasCorrect, true);
  console.log("  ✓ constructed response uses bounded EVALUATION before FEEDBACK");
  console.log("  ✓ evaluation and feedback cannot override server progression or correctness");

  await db
    .update(lessonSessionsTable)
    .set({
      nodeTeachingStage: "MICRO_CHECK",
      activeTaskProvenance: "constructed_response",
      activeLessonExerciseId: null,
      activeObjectiveTaskPayload: null,
      activeAttemptSequence: 1,
      lastQuestionAsked: "Կրկին բացատրի՛ր շարժման պատճառը։",
    } as any)
    .where(eq(lessonSessionsTable.id, constructedSession.id));
  const invalidEvaluation = {
    ...constructedEvaluation,
    answer_evaluation: {
      ...constructedEvaluation.answer_evaluation,
      status: "NOT_A_CANONICAL_STATUS",
    },
  } as unknown as StructuredResponse;
  enqueue("invalid constructed evaluation initial", invalidEvaluation);
  enqueue("invalid constructed evaluation retry", invalidEvaluation);
  const constructedJobsBeforeInvalid = boundedJobCalls.length;
  const invalidConstructed = await postChat(
    baseUrl,
    constructedToken,
    lesson.id,
    "Անվավեր գնահատման փորձ։",
  );
  assert.equal(invalidConstructed.response.status, 503);
  assert.deepEqual(
    boundedJobCalls.slice(constructedJobsBeforeInvalid),
    ["phase2_evaluation_result", "phase2_evaluation_result"],
    "invalid evaluation must retry once and never invoke FEEDBACK",
  );
  const constructedAfterInvalid = await getSession(lesson.id, constructedStudent.userId);
  assert.equal(constructedAfterInvalid.nodeTeachingStage, "MICRO_CHECK");
  assert.equal(constructedAfterInvalid.activeTaskProvenance, "constructed_response");
  assert.equal(
    (await waitForEvidenceCount(constructedAfterInvalid.id, 1)).length,
    1,
    "invalid evaluation must not write a new evidence event",
  );
  console.log("  ✓ invalid EVALUATION fails closed without evidence, progression, or FEEDBACK");

  const adversarialFeedback = multipleChoiceTask("Անվավեր feedback");
  adversarialFeedback.student_message = "Հաշվիր 2 + 2-ը և գրիր պատասխանը։";
  enqueue("feedback evaluation before adversarial output", constructedEvaluation);
  enqueue("adversarial feedback initial", adversarialFeedback);
  enqueue("adversarial feedback retry", adversarialFeedback);
  const constructedJobsBeforeAdversarialFeedback = boundedJobCalls.length;
  const adversarialFeedbackResponse = await postChat(
    baseUrl,
    constructedToken,
    lesson.id,
    "Նոր պատասխան։",
  );
  assert.equal(adversarialFeedbackResponse.response.status, 503);
  assert.deepEqual(
    boundedJobCalls.slice(constructedJobsBeforeAdversarialFeedback),
    [
      "phase2_evaluation_result",
      "phase2_feedback_result",
      "phase2_feedback_result",
    ],
    "task-shaped feedback must fail closed and never reach the learner",
  );
  console.log("  ✓ task-shaped FEEDBACK is rejected before delivery");

  const failingIntro = await postChat(
    baseUrl,
    failingToken,
    lesson.id,
    "Բարև",
  );
  assert.equal(failingIntro.response.status, 200);
  const providerCallsBeforeFailure = providerCallCount;
  const failingSessionBefore = await getSession(
    lesson.id,
    failingStudent.userId,
  );
  const assistantMessagesBefore = await db
    .select()
    .from(chatMessagesTable)
    .where(and(
      eq(chatMessagesTable.lessonId, lesson.id),
      eq(chatMessagesTable.userId, failingStudent.userId),
      eq(chatMessagesTable.role, "assistant"),
    ));

  enqueue("invalid initial", {
    ...invalidTheory("Անվավեր առաջին փորձ։"),
    student_message: "",
  });
  enqueue("invalid retry", {
    ...invalidTheory("Անվավեր կրկնափորձ։"),
    student_message: "",
  });
  const failed = await postChat(
    baseUrl,
    failingToken,
    lesson.id,
    "պատրաստ",
  );
  assert.equal(failed.response.status, 503);
  assert.deepEqual(failed.json, {
    error: "STRUCTURED_AI_REQUIRED",
    message: "Չհաջողվեց շարունակել դասը։ Խնդրում եմ կրկին փորձել։",
  });
  assert.equal(providerCallCount - providerCallsBeforeFailure, 2);

  const failingSessionAfter = await getSession(
    lesson.id,
    failingStudent.userId,
  );
  assert.equal(failingSessionAfter.currentPhase, 2);
  assert.equal(
    failingSessionAfter.currentNodeId,
    failingSessionBefore.currentNodeId,
  );
  assert.equal(failingSessionAfter.nodeTeachingStage, "THEORY");
  assert.equal(failingSessionAfter.activeLessonExerciseId, null);
  assert.equal(failingSessionAfter.activeTaskProvenance, null);
  assert.equal(failingSessionAfter.activeObjectiveTaskPayload, null);
  assert.equal(
    (await waitForEvidenceCount(failingSessionAfter.id, 0)).length,
    0,
  );
  const assistantMessagesAfter = await db
    .select()
    .from(chatMessagesTable)
    .where(and(
      eq(chatMessagesTable.lessonId, lesson.id),
      eq(chatMessagesTable.userId, failingStudent.userId),
      eq(chatMessagesTable.role, "assistant"),
    ));
  assert.equal(assistantMessagesAfter.length, assistantMessagesBefore.length);
  console.log("  ✓ invalid generation retry fails closed with no success pair");

  await db
    .update(lessonSessionsTable)
    .set({
      nodeTeachingStage: "TASK_REQUIRED",
      activeTaskProvenance: null,
      activeLessonExerciseId: null,
      activeObjectiveTaskPayload: null,
      activeAttemptSequence: 0,
    } as any)
    .where(eq(lessonSessionsTable.id, failingSessionAfter.id));
  const invalidTaskCandidate = multipleChoiceTask("Անվավեր առաջադրանքի թեկնածու");
  invalidTaskCandidate.student_message = "Մոլեկուլները մշտապես շարժվում են։";
  enqueue("invalid task candidate initial", invalidTaskCandidate);
  enqueue("invalid task candidate retry", invalidTaskCandidate);
  const invalidTaskJobsBefore = boundedJobCalls.length;
  const invalidTaskResponse = await postChat(
    baseUrl,
    failingToken,
    lesson.id,
    "շարունակել",
  );
  assert.equal(invalidTaskResponse.response.status, 503);
  assert.deepEqual(
    boundedJobCalls.slice(invalidTaskJobsBefore),
    ["phase2_task_candidate", "phase2_task_candidate"],
  );
  const failingAfterInvalidTask = await getSession(
    lesson.id,
    failingStudent.userId,
  );
  assert.equal(failingAfterInvalidTask.nodeTeachingStage, "TASK_REQUIRED");
  assert.equal(failingAfterInvalidTask.activeTaskProvenance, null);
  assert.equal(failingAfterInvalidTask.activeObjectiveTaskPayload, null);
  console.log("  ✓ invalid bounded TASK fails before activation or legacy compatibility");

  await db
    .update(lessonSessionsTable)
    .set({
      nodeTeachingStage: "EXERCISE",
      activeTaskProvenance: "source_exercise",
      activeLessonExerciseId: null,
      activeObjectiveTaskPayload: null,
    } as any)
    .where(eq(lessonSessionsTable.id, failingSessionAfter.id));
  const providerCallsBeforeMalformedState = providerCallCount;
  const malformedStateResponse = await postChat(
    baseUrl,
    failingToken,
    lesson.id,
    "B",
  );
  assert.equal(malformedStateResponse.response.status, 409);
  assert.deepEqual(malformedStateResponse.json, {
    error: "INVALID_PHASE2_STATE",
    message: "Դասի ընթացիկ վիճակը հնարավոր չէ անվտանգ շարունակել։ Խնդրում եմ կրկին սկսել դասը։",
  });
  assert.equal(providerCallCount, providerCallsBeforeMalformedState);
  const malformedSessionAfter = await getSession(
    lesson.id,
    failingStudent.userId,
  );
  assert.equal(malformedSessionAfter.nodeTeachingStage, "EXERCISE");
  assert.equal(malformedSessionAfter.activeTaskProvenance, "source_exercise");
  assert.equal(malformedSessionAfter.activeLessonExerciseId, null);
  assert.equal(
    (await waitForEvidenceCount(malformedSessionAfter.id, 0)).length,
    0,
  );
  const assistantMessagesAfterMalformedState = await db
    .select()
    .from(chatMessagesTable)
    .where(and(
      eq(chatMessagesTable.lessonId, lesson.id),
      eq(chatMessagesTable.userId, failingStudent.userId),
      eq(chatMessagesTable.role, "assistant"),
    ));
  assert.equal(
    assistantMessagesAfterMalformedState.length,
    assistantMessagesAfter.length,
  );
  console.log("  ✓ malformed non-legacy task state fails before provider or state effects");

  assert.equal(providerQueue.length, 0);
  assert.ok(providerCallCount >= 6);
  assert.ok(classifierCallCount >= 1);
  console.log("\nPhase 2 Stage 0 HTTP baseline: 14 passed, 0 failed\n");
} finally {
  globalThis.fetch = originalFetch;
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  }
  await factory.cleanup();
  await closeTestDb();
}