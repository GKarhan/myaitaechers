import assert from "node:assert/strict";
import {
  db,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
  quizQuestionsTable,
  quizzesTable,
  subjectsTable,
} from "@workspace/db";
import { and, count, eq } from "drizzle-orm";
import { assertTestDb, closeTestDb } from "../../lib/__tests__/helpers/test-db.js";
import { createFactory } from "../../lib/__tests__/helpers/fixture-factory.js";
import { makeRunId, runTag } from "../../lib/__tests__/helpers/run-id.js";
import {
  createQuizFromNodeScope,
  generateQuizFromNodeScope,
  QuizCanonicalTargetChangedError,
  QuizCanonicalTargetError,
} from "../quiz-creation.js";
import type {
  GenerateQuizInput,
  GeneratedQuestion,
} from "../quiz-generation.js";
import {
  createOrReuseQuizGenerationJob,
  normalizeQuizGenerationRequest,
  runQuizGenerationJob,
} from "../quiz-generation-jobs.js";
import type { SemanticQuestionReviewInput } from "../quiz-question-quality.js";
import { QuizQuestionQualityError } from "../quiz-question-quality.js";

assertTestDb();

const runId = makeRunId();
const factory = createFactory(runId);
const results: Array<{ name: string; pass: boolean }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, pass: false });
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

const teacher = await factory.teacher();
const [subject] = await db
  .insert(subjectsTable)
  .values({ name: runTag(runId, "canonical_quiz_subject") })
  .returning({ id: subjectsTable.id });
const lesson = await factory.lesson(teacher.userId, null, subject.id, {
  title: runTag(runId, "canonical_quiz_lesson"),
});

async function createNode(title: string, learningObjective: string) {
  return factory.node(lesson.id, {
    title: runTag(runId, title),
    theoryContent: "Ջուրը կարևոր է կյանքի համար և անհրաժեշտ է բույսերի աճի համար։",
    learningObjective,
  });
}

type PathLevel = {
  cognitiveLevel: string;
  target?: boolean;
};

async function setPath(
  nodeId: number,
  levels: PathLevel[],
  options: {
    status?: string;
    targetBloomLevel?: number;
  } = {},
) {
  const [node] = await db
    .select({ learningObjective: lessonNodesTable.learningObjective })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, nodeId));
  const objective = node.learningObjective
    ?? "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։";
  const inserted = await db
    .insert(lessonNodeCognitiveLevelsTable)
    .values(levels.map((level, index) => ({
      lessonNodeId: nodeId,
      cognitiveLevel: level.cognitiveLevel,
      sequence: index + 1,
      isApplicable: true,
      isTargetCeiling: level.target ?? false,
      provenance: "teacher_authored",
      performanceObjective: objective,
      successCriterion: "Ճիշտ է ներկայացնում ջրի կարևորությունը կյանքի համար։",
      minimumIndependentEvidence: 3,
      preferredInteractionTypes: ["multiple_choice"],
    })))
    .returning();
  await db
    .update(lessonNodesTable)
    .set({
      cogPathStatus: options.status ?? "confirmed",
      targetBloomLevel: options.targetBloomLevel ?? 1,
    })
    .where(eq(lessonNodesTable.id, nodeId));
  return inserted;
}

const understandNode = await createNode(
  "understand",
  "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
);
const applyNode = await createNode(
  "apply",
  "Սովորողը կիրառում է ջրի կարևորության գաղափարը բույսերի աճը բացատրելու համար։",
);
const analyzeNode = await createNode(
  "analyze",
  "Սովորողը վերլուծում է ջրի կարևորությունը կյանքի և բույսերի համար։",
);
const unconfirmedNode = await createNode(
  "unconfirmed",
  "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
);
const missingTargetNode = await createNode(
  "missing_target",
  "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
);

const understandLevels = await setPath(
  understandNode.id,
  [{ cognitiveLevel: "understand", target: true }],
  { targetBloomLevel: 2 },
);
const applyLevels = await setPath(
  applyNode.id,
  [
    { cognitiveLevel: "remember" },
    { cognitiveLevel: "understand" },
    { cognitiveLevel: "apply", target: true },
  ],
  { targetBloomLevel: 3 },
);
const analyzeLevels = await setPath(
  analyzeNode.id,
  [
    { cognitiveLevel: "understand" },
    { cognitiveLevel: "apply" },
    { cognitiveLevel: "analyze", target: true },
  ],
  { targetBloomLevel: 4 },
);
await setPath(
  unconfirmedNode.id,
  [{ cognitiveLevel: "understand", target: true }],
  { status: "needs_review", targetBloomLevel: 2 },
);
await setPath(
  missingTargetNode.id,
  [{ cognitiveLevel: "understand" }],
  { targetBloomLevel: 2 },
);

function generatedQuestion(
  nodeId: number,
  cognitiveLevelId: number | null,
  difficultyLevel: GeneratedQuestion["difficultyLevel"] = "MEDIUM",
): GeneratedQuestion {
  return {
    nodeId,
    cognitiveLevelId,
    questionText: "Ինչպե՞ս է ջուրը նպաստում բույսերի աճին։",
    options: ["Աճին նպաստում է", "Աճը դադարեցնում է", "Կապ չունի", "Միայն գույնն է փոխում"],
    correctOptionIndex: 0,
    difficultyLevel,
    optionExplanations: null,
  };
}

async function passQualityReview(input: SemanticQuestionReviewInput) {
  return {
    verdict: "PASS" as const,
    reasonCodes: [],
    measuredCognitiveLevel: input.context.cognitiveLevel,
    nodeAligned: true,
    objectiveAligned: true,
    criterionAligned: true,
    interactionCompatible: true,
    sourceGrounded: true,
  };
}

async function captureGeneration(
  nodeIds: number[],
  difficultyMode: GenerateQuizInput["difficultyMode"] = "MIXED",
) {
  const captured: GenerateQuizInput[] = [];
  await generateQuizFromNodeScope({
    teacherId: teacher.userId,
    subjectId: subject.id,
    lessonIds: [lesson.id],
    nodeIds,
    title: runTag(runId, "capture"),
    questionCount: nodeIds.length,
    difficultyMode,
    allowEmptyQuestions: true,
    generateQuestions: async (input) => {
      captured.push(input);
      const target = input.canonicalTargets?.[0];
      const difficulty = input.difficultyMode === "SIMPLE"
        ? "LOW"
        : input.difficultyMode === "HARD"
          ? "HIGH"
          : "MEDIUM";
      return target
        ? [generatedQuestion(target.nodeId, target.cognitiveLevelId, difficulty)]
        : [];
    },
    qualityReview: passQualityReview,
  });
  if (captured.length === 0) throw new Error("generator scope was not captured");
  return captured;
}

try {
  await test("A: single-level Understand target reaches generator scope", async () => {
    const [input] = await captureGeneration([understandNode.id]);
    assert.deepEqual(
      input.canonicalTargets?.map((target) => target.cognitiveLevel),
      ["understand"],
    );
  });

  await test("B: multi-level path sends Apply only", async () => {
    const [input] = await captureGeneration([applyNode.id]);
    assert.deepEqual(
      input.canonicalTargets?.map((target) => target.cognitiveLevel),
      ["apply"],
    );
    assert.equal(input.canonicalTargets?.[0]?.cognitiveLevelId, applyLevels[2]!.id);
  });

  await test("C: higher path sends Analyze only", async () => {
    const [input] = await captureGeneration([analyzeNode.id]);
    assert.deepEqual(
      input.canonicalTargets?.map((target) => target.cognitiveLevel),
      ["analyze"],
    );
  });

  await test("D/E: multi-node scope preserves distinct per-node targets", async () => {
    const inputs = await captureGeneration([
      understandNode.id,
      applyNode.id,
      analyzeNode.id,
    ]);
    assert.deepEqual(
      inputs.flatMap((input) => input.canonicalTargets ?? []).map((target) => [
          target.nodeId,
          target.cognitiveLevel,
        ]),
      [
        [understandNode.id, "understand"],
        [applyNode.id, "apply"],
        [analyzeNode.id, "analyze"],
      ],
    );
  });

  await test("F: unconfirmed path fails before generator call", async () => {
    let calls = 0;
    await assert.rejects(
      generateQuizFromNodeScope({
        teacherId: teacher.userId,
        subjectId: subject.id,
        nodeIds: [unconfirmedNode.id],
        title: runTag(runId, "unconfirmed"),
        questionCount: 1,
        difficultyMode: "MIXED",
        generateQuestions: async () => {
          calls++;
          return [];
        },
        qualityReview: passQualityReview,
      }),
      (error: unknown) =>
        error instanceof QuizCanonicalTargetError
        && error.nodeId === unconfirmedNode.id
        && error.resolverReason === "PATH_NOT_CONFIRMED",
    );
    assert.equal(calls, 0);
  });

  await test("G: missing target fails before generator call", async () => {
    let calls = 0;
    await assert.rejects(
      generateQuizFromNodeScope({
        teacherId: teacher.userId,
        subjectId: subject.id,
        nodeIds: [missingTargetNode.id],
        title: runTag(runId, "missing_target"),
        questionCount: 1,
        difficultyMode: "MIXED",
        generateQuestions: async () => {
          calls++;
          return [];
        },
        qualityReview: passQualityReview,
      }),
      (error: unknown) =>
        error instanceof QuizCanonicalTargetError
        && error.nodeId === missingTargetNode.id
        && error.resolverReason === "TARGET_MISSING",
    );
    assert.equal(calls, 0);
  });

  await test("H/I/J: difficulty modes cannot change canonical targets", async () => {
    const [mixed] = await captureGeneration([applyNode.id], "MIXED");
    const [simple] = await captureGeneration([applyNode.id], "SIMPLE");
    const [hard] = await captureGeneration([understandNode.id], "HARD");
    assert.equal(mixed.canonicalTargets?.[0]?.cognitiveLevel, "apply");
    assert.equal(simple.canonicalTargets?.[0]?.cognitiveLevel, "apply");
    assert.equal(hard.canonicalTargets?.[0]?.cognitiveLevel, "understand");
  });

  await test("K: provider cannot swap one selected node onto another node's batch", async () => {
    let calls = 0;
    await assert.rejects(
      generateQuizFromNodeScope({
        teacherId: teacher.userId,
        subjectId: subject.id,
        nodeIds: [understandNode.id, applyNode.id],
        title: runTag(runId, "swapped_node"),
        questionCount: 2,
        difficultyMode: "MIXED",
        generateQuestions: async (input) => {
          calls++;
          const requestedNodeId = input.nodeIds[0]!;
          const swappedNodeId = requestedNodeId === understandNode.id
            ? applyNode.id
            : understandNode.id;
          return [generatedQuestion(swappedNodeId, null)];
        },
        qualityReview: passQualityReview,
      }),
      (error: unknown) =>
        error instanceof QuizQuestionQualityError
        && error.reasonCodes.includes("NODE_ID_MISMATCH"),
    );
    assert.equal(calls, 3);
  });

  await test("L/M: persistence preserves validated canonical node and Cognitive Level provenance", async () => {
    const created = await createQuizFromNodeScope({
      teacherId: teacher.userId,
      subjectId: subject.id,
      lessonIds: [lesson.id],
      nodeIds: [applyNode.id],
      title: runTag(runId, "persisted_provenance"),
      questionCount: 1,
      difficultyMode: "SIMPLE",
      generateQuestions: async () => [
        generatedQuestion(applyNode.id, applyLevels[2]!.id, "LOW"),
      ],
      qualityReview: passQualityReview,
    });
    assert.equal(created.questions.length, 1);
    assert.equal(created.questions[0]!.nodeId, applyNode.id);
    assert.equal(created.questions[0]!.cognitiveLevelId, applyLevels[2]!.id);
  });

  await test("N/O: async execution preserves target and idempotent replay", async () => {
    const title = runTag(runId, "async_canonical");
    const snapshot = normalizeQuizGenerationRequest({
      subjectId: subject.id,
      lessonIds: [lesson.id],
      nodeIds: [analyzeNode.id],
      title,
      questionCount: 1,
      difficultyMode: "HARD",
      quizType: "lesson",
    });
    const key = runTag(runId, "async_key");
    const first = await createOrReuseQuizGenerationJob({
      teacherId: teacher.userId,
      idempotencyKey: key,
      snapshot,
    });
    let providerCalls = 0;
    let capturedTarget: string | null = null;
    const completed = await runQuizGenerationJob(first.job.id, {
      generate: (creationInput) => generateQuizFromNodeScope({
        ...creationInput,
        generateQuestions: async (input) => {
          providerCalls++;
          capturedTarget = input.canonicalTargets?.[0]?.cognitiveLevel ?? null;
          return [generatedQuestion(
            analyzeNode.id,
            input.canonicalTargets?.[0]?.cognitiveLevelId ?? null,
            "HIGH",
          )];
        },
        qualityReview: passQualityReview,
      }),
    });
    assert.equal(completed?.status, "completed");
    assert.equal(capturedTarget, "analyze");
    assert.equal(providerCalls, 1);
    assert.ok(completed?.quizId);

    const [persisted] = await db
      .select()
      .from(quizQuestionsTable)
      .where(eq(quizQuestionsTable.quizId, completed!.quizId!));
    assert.equal(persisted.nodeId, analyzeNode.id);
    assert.equal(persisted.cognitiveLevelId, analyzeLevels[2]!.id);

    const replay = await createOrReuseQuizGenerationJob({
      teacherId: teacher.userId,
      idempotencyKey: key,
      snapshot,
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.job.id, first.job.id);
    assert.equal(await runQuizGenerationJob(first.job.id), null);
    const [quizCount] = await db
      .select({ value: count() })
      .from(quizzesTable)
      .where(and(
        eq(quizzesTable.teacherId, teacher.userId),
        eq(quizzesTable.title, title),
      ));
    assert.equal(Number(quizCount.value), 1);
    assert.equal(providerCalls, 1);
  });

  await test("P: async canonical failure persists node and resolver reason without provider work", async () => {
    const title = runTag(runId, "async_invalid_target");
    const snapshot = normalizeQuizGenerationRequest({
      subjectId: subject.id,
      lessonIds: [lesson.id],
      nodeIds: [unconfirmedNode.id],
      title,
      questionCount: 1,
      difficultyMode: "MIXED",
      quizType: "lesson",
    });
    const pending = await createOrReuseQuizGenerationJob({
      teacherId: teacher.userId,
      idempotencyKey: runTag(runId, "async_invalid_key"),
      snapshot,
    });
    let providerCalls = 0;
    const failedJob = await runQuizGenerationJob(pending.job.id, {
      generate: (creationInput) => generateQuizFromNodeScope({
        ...creationInput,
        generateQuestions: async () => {
          providerCalls++;
          return [];
        },
        qualityReview: passQualityReview,
      }),
    });
    assert.equal(failedJob?.status, "failed");
    assert.equal(failedJob?.errorCode, "CANONICAL_TARGET_INVALID");
    assert.deepEqual(failedJob?.errorDetails, {
      nodeId: unconfirmedNode.id,
      resolverReason: "PATH_NOT_CONFIRMED",
    });
    assert.equal(providerCalls, 0);
    const [quizCount] = await db
      .select({ value: count() })
      .from(quizzesTable)
      .where(and(
        eq(quizzesTable.teacherId, teacher.userId),
        eq(quizzesTable.title, title),
      ));
    assert.equal(Number(quizCount.value), 0);
  });

  await test("Q: persistence rejects a canonical target changed after generation", async () => {
    const mutableNode = await createNode(
      "mutable_target",
      "Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։",
    );
    const initialLevels = await setPath(
      mutableNode.id,
      [{ cognitiveLevel: "understand", target: true }],
      { targetBloomLevel: 2 },
    );
    const title = runTag(runId, "changed_target");
    await assert.rejects(
      createQuizFromNodeScope({
        teacherId: teacher.userId,
        subjectId: subject.id,
        nodeIds: [mutableNode.id],
        title,
        questionCount: 1,
        difficultyMode: "MEDIUM",
        generateQuestions: async () => {
          await db
            .delete(lessonNodeCognitiveLevelsTable)
            .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, mutableNode.id));
          await setPath(
            mutableNode.id,
            [{ cognitiveLevel: "apply", target: true }],
            { targetBloomLevel: 3 },
          );
          return [generatedQuestion(mutableNode.id, initialLevels[0]!.id)];
        },
        qualityReview: passQualityReview,
      }),
      (error: unknown) =>
        error instanceof QuizCanonicalTargetChangedError
        && error.nodeId === mutableNode.id,
    );
    const [quizCount] = await db
      .select({ value: count() })
      .from(quizzesTable)
      .where(and(
        eq(quizzesTable.teacherId, teacher.userId),
        eq(quizzesTable.title, title),
      ));
    assert.equal(Number(quizCount.value), 0);
  });
} finally {
  await factory.cleanup();
  await db.delete(subjectsTable).where(eq(subjectsTable.id, subject.id));
  await closeTestDb();
}

const failed = results.filter((result) => !result.pass);
console.log(`\nCanonical normal quiz generation: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;