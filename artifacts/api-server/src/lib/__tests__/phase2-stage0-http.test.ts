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

  return new Response(
    JSON.stringify(
      openAiEnvelope(JSON.stringify(next.response), next.label),
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
  const [teacherProfile] = await db
    .insert(teachersTable)
    .values({ userId: teacher.userId })
    .returning({ id: teachersTable.id });
  const cls = await factory.class_(teacherProfile.id);
  await factory.enrollStudent(cls.id, successfulStudent.userId);
  await factory.enrollStudent(cls.id, failingStudent.userId);
  await factory.enrollStudent(cls.id, sourceStudent.userId);

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
        performanceObjective: "Ճանաչում է մոլեկուլների շարժումը։",
        successCriterion: "Ընտրում է, որ մոլեկուլները շարժվում են։",
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
        performanceObjective: "Բացատրում է մոլեկուլների շարժումը։",
        successCriterion: "Ճիշտ է կապում նյութը մասնիկների շարժման հետ։",
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
      performanceObjective: "Կիրառում է մասնիկների շարժման գաղափարը։",
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

  enqueue("remember task", multipleChoiceTask("Հիշելու մակարդակ։"));
  const firstTask = await postChat(
    baseUrl,
    successfulToken,
    lesson.id,
    "պատրաստ",
  );
  assert.equal(firstTask.response.status, 200);
  assert.equal(providerCallCount, 1);
  assert.equal(firstTask.json.teachingMode, "TEACH");
  assert.equal(firstTask.json.hasActiveTask, true);
  assert.equal(typeof firstTask.json.messageId, "number");
  assertNoPrivateAnswerMetadata(firstTask.json, "POST /api/chat");

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
  assert.deepEqual(Object.keys(firstTask.json).sort(), publicResponseKeys);

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
  console.log("  ✓ real THEORY response and persisted task state correspond");
  console.log("  ✓ chat and session-state payloads hide answer metadata");
  console.log("  ✓ student lesson/session payloads hide answer metadata");

  enqueue(
    "remember premature completion",
    prematureCompletionFeedback("Առաջին պատասխանը։"),
  );
  const firstAnswer = await postChat(
    baseUrl,
    successfulToken,
    lesson.id,
    "Բ",
  );
  assert.equal(firstAnswer.response.status, 200);
  assert.equal(firstAnswer.json.sessionDecision, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(firstAnswer.json.hasActiveTask, false);

  session = await getSession(lesson.id, successfulStudent.userId);
  assert.equal(session.currentPhase, 2);
  assert.equal(session.currentNodeId, node.id);
  assert.equal(session.nodeTeachingStage, "THEORY");
  assert.equal(session.activeCognitiveLevelId, understandLevel.id);
  assert.equal(session.activeTaskProvenance, null);
  assert.equal(session.activeObjectiveTaskPayload, null);
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
  console.log("  ✓ feedback creates no task and premature COMPLETE_NODE is denied");
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
  const sourceAnswer = await postChat(
    baseUrl,
    sourceToken,
    sourceLesson.id,
    "B",
  );
  assert.equal(sourceAnswer.response.status, 200);
  assert.equal(sourceAnswer.json.hasActiveTask, false);
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

  enqueue("invalid initial", invalidTheory("Անվավեր առաջին փորձ։"));
  enqueue("invalid retry", invalidTheory("Անվավեր կրկնափորձ։"));
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