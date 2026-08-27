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
} from "../quiz-creation.js";
import {
  createOrReuseQuizGenerationJob,
  normalizeQuizGenerationRequest,
  runQuizGenerationJob,
} from "../quiz-generation-jobs.js";
import type { GeneratedQuestion } from "../quiz-generation.js";
import {
  QuizQuestionQualityError,
  type CognitiveLevel,
  type SemanticQuestionReviewInput,
  type SemanticQuestionReviewResult,
} from "../quiz-question-quality.js";

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

function passReview(level: CognitiveLevel): SemanticQuestionReviewResult {
  return {
    verdict: "PASS",
    reasonCodes: [],
    measuredCognitiveLevel: level,
    nodeAligned: true,
    objectiveAligned: true,
    criterionAligned: true,
    interactionCompatible: true,
    sourceGrounded: true,
  };
}

function failReview(
  measuredCognitiveLevel: CognitiveLevel,
): SemanticQuestionReviewResult {
  return {
    verdict: "FAIL",
    reasonCodes: ["COGNITIVE_DEMAND_TOO_LOW"],
    measuredCognitiveLevel,
    nodeAligned: true,
    objectiveAligned: true,
    criterionAligned: true,
    interactionCompatible: true,
    sourceGrounded: true,
  };
}

function reviewError(): SemanticQuestionReviewResult {
  return {
    verdict: "REVIEW_ERROR",
    reasonCodes: ["SEMANTIC_REVIEW_ERROR"],
    nodeAligned: false,
    objectiveAligned: false,
    criterionAligned: false,
    interactionCompatible: false,
    sourceGrounded: false,
  };
}

const teacher = await factory.teacher();
const [subject] = await db.insert(subjectsTable).values({
  name: runTag(runId, "quality_gate_subject"),
}).returning({ id: subjectsTable.id });
const lesson = await factory.lesson(teacher.userId, null, subject.id, {
  title: runTag(runId, "quality_gate_lesson"),
});
const node = await factory.node(lesson.id, {
  title: runTag(runId, "quality_gate_node"),
  theoryContent: "Ջուրը անհրաժեշտ է բույսի աճի համար, իսկ առանց ջրի բույսը թառամում է։",
  learningObjective: "Սովորողը վերլուծում է ջրի ազդեցությունը բույսի աճի վրա։",
});
const [targetLevel] = await db.insert(lessonNodeCognitiveLevelsTable).values({
  lessonNodeId: node.id,
  cognitiveLevel: "analyze",
  sequence: 1,
  isApplicable: true,
  isTargetCeiling: true,
  provenance: "teacher_authored",
  performanceObjective: "Վերլուծել ջրի ազդեցությունը բույսի աճի վրա։",
  successCriterion: "Պատճառահետևանքային կապով տարբերակել ջրով և առանց ջրի պայմանները։",
  minimumIndependentEvidence: 3,
  preferredInteractionTypes: ["multiple_choice"],
}).returning();
await db.update(lessonNodesTable).set({
  cogPathStatus: "confirmed",
  targetBloomLevel: 4,
}).where(eq(lessonNodesTable.id, node.id));

function question(
  label: string,
  overrides: Partial<GeneratedQuestion> = {},
): GeneratedQuestion {
  return {
    nodeId: node.id,
    cognitiveLevelId: targetLevel.id,
    questionText: `${label}․ Ջուր ստացող և ջուր չստացող բույսերի ո՞ր տարբերությունն է ցույց տալիս պատճառահետևանքային կապը։`,
    options: [
      "Ջուր ստացող բույսը շարունակում է աճել",
      "Երկու բույսերն էլ նույն ձևով են աճում",
      "Ջուրը փոխում է միայն բույսի գույնը",
      "Առանց ջրի բույսն ավելի արագ է աճում",
    ],
    correctOptionIndex: 0,
    difficultyLevel: "MEDIUM",
    optionExplanations: null,
    ...overrides,
  };
}

type ProviderCall = {
  questionCount: number;
  reasons: readonly string[];
};

function baseInput(title: string) {
  return {
    teacherId: teacher.userId,
    subjectId: subject.id,
    lessonIds: [lesson.id],
    nodeIds: [node.id],
    title: runTag(runId, title),
    questionCount: 2,
    difficultyMode: "MIXED" as const,
  };
}

async function quizCount(title: string): Promise<number> {
  const [row] = await db.select({ value: count() }).from(quizzesTable).where(and(
    eq(quizzesTable.teacherId, teacher.userId),
    eq(quizzesTable.title, title),
  ));
  return Number(row?.value ?? 0);
}

try {
  console.log("\nLive Quiz Question Quality Gate\n");

  await test("A: best case uses one generation batch and one review per slot", async () => {
    const providerCalls: ProviderCall[] = [];
    let reviewerCalls = 0;
    const result = await generateQuizFromNodeScope({
      ...baseInput("best_case"),
      questionProvider: async (request) => {
        providerCalls.push({
          questionCount: request.questionCount,
          reasons: request.qualityRetryReasonCodes,
        });
        return [question("Ա"), question("Բ")];
      },
      qualityReview: async (input) => {
        reviewerCalls++;
        assert.equal(input.context.cognitiveLevel, "analyze");
        return passReview("analyze");
      },
    });
    assert.deepEqual(providerCalls.map((call) => call.questionCount), [2]);
    assert.equal(reviewerCalls, 2);
    assert.equal(result.generated.length, 2);
  });

  await test("B: deterministic rejection skips review and regenerates only that slot", async () => {
    const providerCalls: ProviderCall[] = [];
    const reviewed: string[] = [];
    const passing = question("Պահպանվող");
    const invalid = question("Անվավեր", {
      options: ["Կրկնվող", "Կրկնվող", "Երրորդ", "Չորրորդ"],
    });
    const replacement = question("Փոխարինող");
    const batches = [[passing, invalid], [replacement]];
    const result = await generateQuizFromNodeScope({
      ...baseInput("deterministic_retry"),
      questionProvider: async (request) => {
        providerCalls.push({
          questionCount: request.questionCount,
          reasons: request.qualityRetryReasonCodes,
        });
        return batches.shift() ?? [];
      },
      qualityReview: async (input) => {
        reviewed.push(input.candidate.questionText);
        return passReview("analyze");
      },
    });
    assert.deepEqual(providerCalls.map((call) => call.questionCount), [2, 1]);
    assert.ok(providerCalls[1]!.reasons.includes("DUPLICATE_OPTIONS"));
    assert.deepEqual(reviewed, [passing.questionText, replacement.questionText]);
    assert.equal(result.generated[0]!.questionText, passing.questionText);
    assert.equal(result.generated[1]!.questionText, replacement.questionText);
  });

  await test("C: semantic lower-level failure retries one slot without changing target", async () => {
    const providerCalls: ProviderCall[] = [];
    const passing = question("Բարձր մակարդակ");
    const tooLow = question("Ցածր մակարդակ");
    const replacement = question("Վերլուծական փոխարինող");
    const batches = [[passing, tooLow], [replacement]];
    const seenTargets: string[] = [];
    const result = await generateQuizFromNodeScope({
      ...baseInput("semantic_retry"),
      questionProvider: async (request) => {
        providerCalls.push({
          questionCount: request.questionCount,
          reasons: request.qualityRetryReasonCodes,
        });
        return batches.shift() ?? [];
      },
      qualityReview: async (input) => {
        seenTargets.push(input.context.cognitiveLevel);
        return input.candidate.questionText === tooLow.questionText
          ? failReview("understand")
          : passReview("analyze");
      },
    });
    assert.deepEqual(providerCalls.map((call) => call.questionCount), [2, 1]);
    assert.ok(providerCalls[1]!.reasons.includes("COGNITIVE_DEMAND_TOO_LOW"));
    assert.deepEqual(seenTargets, ["analyze", "analyze", "analyze"]);
    assert.equal(result.generated[0]!.questionText, passing.questionText);
    assert.ok(result.generated.every((item) => item.cognitiveLevelId === targetLevel.id));
  });

  await test("D: wrong Cognitive Level ID fails deterministically before review", async () => {
    let reviewerCalls = 0;
    let providerCalls = 0;
    const result = await generateQuizFromNodeScope({
      ...baseInput("identity_retry"),
      questionCount: 1,
      questionProvider: async () => {
        providerCalls++;
        return providerCalls === 1
          ? [question("Սխալ ինքնություն", { cognitiveLevelId: targetLevel.id + 1000 })]
          : [question("Ճիշտ ինքնություն")];
      },
      qualityReview: async () => {
        reviewerCalls++;
        return passReview("analyze");
      },
    });
    assert.equal(providerCalls, 2);
    assert.equal(reviewerCalls, 1);
    assert.equal(result.generated[0]!.cognitiveLevelId, targetLevel.id);
  });

  await test("E: review outage exhausts two replacement attempts and fails closed", async () => {
    let providerCalls = 0;
    let reviewerCalls = 0;
    await assert.rejects(
      generateQuizFromNodeScope({
        ...baseInput("review_outage"),
        questionCount: 1,
        questionProvider: async () => [question(`Փորձ ${++providerCalls}`)],
        qualityReview: async () => {
          reviewerCalls++;
          return reviewError();
        },
      }),
      (error: unknown) =>
        error instanceof QuizQuestionQualityError
        && error.nodeId === node.id
        && error.reasonCodes.includes("SEMANTIC_REVIEW_ERROR"),
    );
    assert.equal(providerCalls, 3);
    assert.equal(reviewerCalls, 6);
  });

  await test("F: deterministic exhaustion never calls semantic reviewer", async () => {
    let providerCalls = 0;
    let reviewerCalls = 0;
    await assert.rejects(
      generateQuizFromNodeScope({
        ...baseInput("deterministic_exhaustion"),
        questionCount: 1,
        questionProvider: async () => {
          providerCalls++;
          return [question(`Կրկնվող ${providerCalls}`, {
            options: ["Նույն", "Նույն", "Երրորդ", "Չորրորդ"],
          })];
        },
        qualityReview: async () => {
          reviewerCalls++;
          return passReview("analyze");
        },
      }),
      QuizQuestionQualityError,
    );
    assert.equal(providerCalls, 3);
    assert.equal(reviewerCalls, 0);
  });

  await test("G: missing candidates are retried as missing slots, not as a full batch", async () => {
    const providerCalls: ProviderCall[] = [];
    const first = question("Միակ սկզբնական");
    const result = await generateQuizFromNodeScope({
      ...baseInput("missing_slot"),
      questionProvider: async (request) => {
        providerCalls.push({
          questionCount: request.questionCount,
          reasons: request.qualityRetryReasonCodes,
        });
        return providerCalls.length === 1 ? [first] : [question("Լրացված երկրորդ")];
      },
      qualityReview: async () => passReview("analyze"),
    });
    assert.deepEqual(providerCalls.map((call) => call.questionCount), [2, 1]);
    assert.equal(result.generated[0]!.questionText, first.questionText);
    assert.equal(result.generated.length, 2);
  });

  await test("H: exact-count exhaustion persists no quiz", async () => {
    const title = baseInput("exact_count_failure").title;
    await assert.rejects(
      createQuizFromNodeScope({
        ...baseInput("unused"),
        title,
        questionProvider: async () => [],
        qualityReview: async () => passReview("analyze"),
      }),
      QuizQuestionQualityError,
    );
    assert.equal(await quizCount(title), 0);
  });

  await test("I: successful sync flow persists exact canonical provenance", async () => {
    const input = baseInput("sync_success");
    const created = await createQuizFromNodeScope({
      ...input,
      questionProvider: async () => [question("Համաժամ Ա"), question("Համաժամ Բ")],
      qualityReview: async () => passReview("analyze"),
    });
    assert.equal(created.questions.length, 2);
    assert.ok(created.questions.every((item) =>
      item.nodeId === node.id && item.cognitiveLevelId === targetLevel.id,
    ));
  });

  await test("J: async quality failure stores only bounded code and reason details", async () => {
    const title = runTag(runId, "async_quality_failure");
    const snapshot = normalizeQuizGenerationRequest({
      subjectId: subject.id,
      lessonIds: [lesson.id],
      nodeIds: [node.id],
      title,
      questionCount: 1,
      difficultyMode: "HARD",
      quizType: "lesson",
    });
    const pending = await createOrReuseQuizGenerationJob({
      teacherId: teacher.userId,
      idempotencyKey: runTag(runId, "async_quality_failure_key"),
      snapshot,
    });
    const failed = await runQuizGenerationJob(pending.job.id, {
      generate: (creationInput) => generateQuizFromNodeScope({
        ...creationInput,
        questionProvider: async () => [
          question("Ասինխրոն սխալ", { difficultyLevel: "HIGH" }),
        ],
        qualityReview: async () => reviewError(),
      }),
    });
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "QUIZ_QUESTION_QUALITY_FAILED");
    assert.deepEqual(failed?.errorDetails, {
      nodeId: node.id,
      reasonCodes: ["SEMANTIC_REVIEW_ERROR"],
    });
    assert.equal(await quizCount(title), 0);
  });

  await test("K: reviewer receives source, objective, criterion, and fixed target", async () => {
    let captured: SemanticQuestionReviewInput | null = null;
    await generateQuizFromNodeScope({
      ...baseInput("review_context"),
      questionCount: 1,
      difficultyMode: "HARD",
      questionProvider: async () => [question("Համատեքստ", { difficultyLevel: "HIGH" })],
      qualityReview: async (input) => {
        captured = input;
        return passReview("analyze");
      },
    });
    assert.ok(captured);
    const reviewed = captured as SemanticQuestionReviewInput;
    assert.equal(reviewed.context.canonicalNodeId, node.id);
    assert.equal(reviewed.context.canonicalCognitiveLevelId, targetLevel.id);
    assert.equal(reviewed.context.cognitiveLevel, "analyze");
    assert.match(reviewed.context.instructionalContent, /Ջուրը/);
    assert.match(reviewed.context.performanceObjective ?? "", /Վերլուծել/);
    assert.match(reviewed.context.successCriterion ?? "", /Պատճառահետևանքային/);
    assert.equal(reviewed.candidate.difficultyLevel, "HIGH");
  });

  await test("L: duplicate replacement cannot displace a preserved passing question", async () => {
    const kept = question("Պահվող կրկնօրինակում");
    let providerCalls = 0;
    const result = await generateQuizFromNodeScope({
      ...baseInput("duplicate_retry"),
      questionProvider: async () => {
        providerCalls++;
        if (providerCalls === 1) {
          return [
            kept,
            question("Սեմանտիկ սխալ"),
          ];
        }
        return providerCalls === 2
          ? [{ ...kept }]
          : [question("Վերջնական եզակի")];
      },
      qualityReview: async (input) =>
        input.candidate.questionText.includes("Սեմանտիկ սխալ")
          ? failReview("understand")
          : passReview("analyze"),
    });
    assert.equal(providerCalls, 3);
    assert.equal(result.generated[0]!.questionText, kept.questionText);
    assert.equal(result.generated[1]!.questionText, question("Վերջնական եզակի").questionText);
  });

  await test("M: wrong difficulty distribution fails before review and is replaced", async () => {
    let providerCalls = 0;
    let reviewerCalls = 0;
    const result = await generateQuizFromNodeScope({
      ...baseInput("difficulty_distribution"),
      questionCount: 1,
      difficultyMode: "HARD",
      questionProvider: async () => {
        providerCalls++;
        return providerCalls === 1
          ? [question("Սխալ բարդություն", { difficultyLevel: "MEDIUM" })]
          : [question("Ճիշտ բարդություն", { difficultyLevel: "HIGH" })];
      },
      qualityReview: async () => {
        reviewerCalls++;
        return passReview("analyze");
      },
    });
    assert.equal(providerCalls, 2);
    assert.equal(reviewerCalls, 1);
    assert.equal(result.generated[0]!.difficultyLevel, "HIGH");
  });

  await test("N: transient reviewer error retries the same candidate before regeneration", async () => {
    let providerCalls = 0;
    let reviewerCalls = 0;
    const original = question("Նույն թեկնածուի վերանայում");
    const result = await generateQuizFromNodeScope({
      ...baseInput("review_retry_same_candidate"),
      questionCount: 1,
      questionProvider: async () => {
        providerCalls++;
        return [original];
      },
      qualityReview: async () => {
        reviewerCalls++;
        return reviewerCalls === 1 ? reviewError() : passReview("analyze");
      },
    });
    assert.equal(providerCalls, 1);
    assert.equal(reviewerCalls, 2);
    assert.equal(result.generated[0]!.questionText, original.questionText);
  });
} finally {
  await factory.cleanup();
  await db.delete(subjectsTable).where(eq(subjectsTable.id, subject.id));
  await closeTestDb();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
if (failed.length > 0) process.exit(1);