import { normalizeQuestionText } from "./quiz-question-quality.js";
import { allocateNodeQuestions, type AssessmentConfig } from "./node-assessment-policy.js";
import {
  db,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
  quizAnswersTable,
  quizAttemptsTable,
  quizAssignmentsTable,
  quizLessonLinksTable,
  quizQuestionsTable,
  quizzesTable,
} from "@workspace/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import {
  generateQuizQuestions,
  type GenerateQuizInput,
  type GeneratedQuestion,
} from "./quiz-generation.js";
import type { RetestStrategy } from "./quiz-retest-authority.js";
import {
  resolveCanonicalQuizTarget,
  type CanonicalQuizTarget,
  type CanonicalQuizTargetFailureReason,
} from "../lib/cognitive-path-grounding.js";

export const QUIZ_DIFFICULTY_MODES = ["SIMPLE", "MEDIUM", "HARD", "MIXED"] as const;
export type QuizDifficultyMode = (typeof QUIZ_DIFFICULTY_MODES)[number];

export class QuizCreationError extends Error {
  readonly code:
    | "EMPTY_GENERATION"
    | "QUESTION_SCOPE_INVALID"
    | "CANONICAL_TARGET_INVALID";

  constructor(code: QuizCreationError["code"]) {
    super(code);
    this.name = "QuizCreationError";
    this.code = code;
  }
}

export class QuizCanonicalTargetError extends QuizCreationError {
  readonly nodeId: number;
  readonly resolverReason: CanonicalQuizTargetFailureReason;

  constructor(nodeId: number, resolverReason: CanonicalQuizTargetFailureReason) {
    super("CANONICAL_TARGET_INVALID");
    this.name = "QuizCanonicalTargetError";
    this.nodeId = nodeId;
    this.resolverReason = resolverReason;
  }
}

export class QuizCanonicalTargetChangedError extends Error {
  readonly code = "CANONICAL_TARGET_CHANGED" as const;
  readonly nodeId: number;
  readonly generatedCognitiveLevelId: number;
  readonly currentCognitiveLevelId: number;

  constructor(
    nodeId: number,
    generatedCognitiveLevelId: number,
    currentCognitiveLevelId: number,
  ) {
    super("CANONICAL_TARGET_CHANGED");
    this.name = "QuizCanonicalTargetChangedError";
    this.nodeId = nodeId;
    this.generatedCognitiveLevelId = generatedCognitiveLevelId;
    this.currentCognitiveLevelId = currentCognitiveLevelId;
  }
}

export type CreateQuizFromNodeScopeInput = {
  assessmentConfig?: AssessmentConfig;
  teacherId: number;
  subjectId: number;
  classId?: number | null;
  sourceBookId?: number | null;
  lessonIds?: number[];
  nodeIds: number[];
  title: string;
  questionCount: number;
  difficultyMode: QuizDifficultyMode;
  quizType?: string | null;
  studentId?: number;
  retestSourceAttemptId?: number;
  retestStrategy?: RetestStrategy;
  allowEmptyQuestions?: boolean;
  requireGeneratedNodeScope?: boolean;
  generationPurpose?: "normal" | "retest" | "standard";
  generateQuestions?: (input: GenerateQuizInput) => Promise<GeneratedQuestion[]>;
  questionProvider?: GenerateQuizInput["questionProvider"];
  qualityReview?: GenerateQuizInput["qualityReview"];
};

export type CreatedQuizResult = {
  quiz: typeof quizzesTable.$inferSelect;
  questions: typeof quizQuestionsTable.$inferSelect[];
  generated: GeneratedQuestion[];
  assignmentId: number | null;
};

type QuizPersistenceExecutor = typeof db | PgTransaction<any, any, any>;

async function resolveNormalQuizCanonicalTargetsWith(
  executor: QuizPersistenceExecutor,
  nodeIds: number[],
): Promise<CanonicalQuizTarget[]> {
  const nodes = await executor
    .select({
      id: lessonNodesTable.id,
      cogPathStatus: lessonNodesTable.cogPathStatus,
      theoryContent: lessonNodesTable.theoryContent,
      learningObjective: lessonNodesTable.learningObjective,
      targetBloomLevel: lessonNodesTable.targetBloomLevel,
    })
    .from(lessonNodesTable)
    .where(inArray(lessonNodesTable.id, nodeIds));
  if (nodes.length !== nodeIds.length) {
    throw new QuizCreationError("QUESTION_SCOPE_INVALID");
  }

  const levels = await executor
    .select()
    .from(lessonNodeCognitiveLevelsTable)
    .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeIds))
    .orderBy(
      asc(lessonNodeCognitiveLevelsTable.lessonNodeId),
      asc(lessonNodeCognitiveLevelsTable.sequence),
      asc(lessonNodeCognitiveLevelsTable.id),
    );
  const levelsByNode = new Map<number, typeof levels>();
  for (const level of levels) {
    const current = levelsByNode.get(level.lessonNodeId) ?? [];
    current.push(level);
    levelsByNode.set(level.lessonNodeId, current);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return nodeIds.map((nodeId) => {
    const resolution = resolveCanonicalQuizTarget(
      nodeById.get(nodeId)!,
      levelsByNode.get(nodeId) ?? [],
    );
    if (!resolution.valid) {
      throw new QuizCanonicalTargetError(nodeId, resolution.reason);
    }
    return resolution.target;
  });
}

export async function resolveNormalQuizCanonicalTargets(
  nodeIds: number[],
): Promise<CanonicalQuizTarget[]> {
  return resolveNormalQuizCanonicalTargetsWith(db, nodeIds);
}

function allocateQuestionsByNode(
  nodeIds: number[],
  questionCount: number,
): Map<number, number> {
  const base = Math.floor(questionCount / nodeIds.length);
  const remainder = questionCount % nodeIds.length;
  return new Map(nodeIds.map((nodeId, index) => [
    nodeId,
    base + (index < remainder ? 1 : 0),
  ]));
}

function canonicalTargetSnapshotMatches(
  generated: CanonicalQuizTarget,
  current: CanonicalQuizTarget,
): boolean {
  return generated.nodeId === current.nodeId
    && generated.cognitiveLevelId === current.cognitiveLevelId
    && generated.cognitiveLevel === current.cognitiveLevel
    && generated.sequence === current.sequence
    && generated.performanceObjective === current.performanceObjective
    && generated.successCriterion === current.successCriterion
    && generated.minimumIndependentEvidence === current.minimumIndependentEvidence
    && JSON.stringify(generated.preferredInteractionTypes)
      === JSON.stringify(current.preferredInteractionTypes);
}

export async function generateQuizFromNodeScope(
  input: CreateQuizFromNodeScopeInput,
): Promise<{
  nodeIds: number[];
  generated: GeneratedQuestion[];
  canonicalTargets?: CanonicalQuizTarget[];
}> {
  const nodeIds = [...new Set(input.nodeIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (nodeIds.length === 0) {
    throw new QuizCreationError("QUESTION_SCOPE_INVALID");
  }

  if (input.assessmentConfig?.fullConfirmation) allocateNodeQuestions(nodeIds, input.questionCount, input.assessmentConfig);
  const priorQuestions = input.assessmentConfig && input.studentId != null
    ? await db.select({text:quizQuestionsTable.questionText}).from(quizAnswersTable)
      .innerJoin(quizQuestionsTable,eq(quizQuestionsTable.id,quizAnswersTable.questionId))
      .innerJoin(quizAttemptsTable,eq(quizAttemptsTable.id,quizAnswersTable.attemptId))
      .innerJoin(quizAssignmentsTable,eq(quizAssignmentsTable.id,quizAttemptsTable.quizAssignmentId))
      .where(and(eq(quizAssignmentsTable.studentId,input.studentId),inArray(quizQuestionsTable.nodeId,nodeIds))) : [];
  const avoidQuestionTexts = [...new Set(priorQuestions.map(q=>q.text))];
  const exposedFamilies = new Set(avoidQuestionTexts.map(normalizeQuestionText));
  const canonicalTargets = !input.assessmentConfig?.fullConfirmation && (input.generationPurpose === "retest" || input.generationPurpose === "standard")
    ? []
    : await resolveNormalQuizCanonicalTargets(nodeIds);
  let generated: GeneratedQuestion[];
  if (canonicalTargets.length > 0) {
    const allocation = input.assessmentConfig ? allocateNodeQuestions(nodeIds, input.questionCount, input.assessmentConfig) : allocateQuestionsByNode(nodeIds, input.questionCount);
    const batches: GeneratedQuestion[] = [];
    for (const target of canonicalTargets) {
      const nodeQuestionCount = allocation.get(target.nodeId) ?? 0;
      if (nodeQuestionCount === 0) continue;
      const injectedProvider = input.questionProvider
        ?? (input.generateQuestions
          ? async (request: Parameters<NonNullable<GenerateQuizInput["questionProvider"]>>[0]) =>
            input.generateQuestions!({
              nodeIds: request.nodeIds,
              questionCount: request.questionCount,
              difficultyMode: request.difficultyMode,
              canonicalTargets: request.canonicalTargets,
              qualityRetryReasonCodes: [...request.qualityRetryReasonCodes],
            })
          : undefined);
      const nodeBatch = await generateQuizQuestions({
        nodeIds: [target.nodeId],
        questionCount: nodeQuestionCount,
        difficultyMode: input.difficultyMode,
        canonicalTargets: [target],
        avoidQuestionTexts,
        questionProvider: injectedProvider,
        qualityReview: input.qualityReview,
      });
      if (
        nodeBatch.length !== nodeQuestionCount
        || nodeBatch.some((question) =>
          question.nodeId !== target.nodeId
          || question.cognitiveLevelId !== target.cognitiveLevelId
        )
      ) {
        throw new QuizCreationError("QUESTION_SCOPE_INVALID");
      }
      batches.push(...nodeBatch);
    }
    generated = batches;
  } else if (input.assessmentConfig) {
    const allocation = allocateNodeQuestions(nodeIds, input.questionCount, input.assessmentConfig);
    const batches: GeneratedQuestion[] = [];
    for (const [nodeId, count] of allocation) {
      const generate = input.generateQuestions ?? generateQuizQuestions;
      let accepted: GeneratedQuestion[] | null = null;
      const avoid = [...avoidQuestionTexts];
      for (let attempt=0;attempt<2;attempt++) {
        const batch = await generate({ nodeIds: [nodeId], questionCount: count, difficultyMode: input.difficultyMode,
          avoidQuestionTexts:avoid, questionProvider: input.questionProvider, qualityReview: input.qualityReview });
        const families=batch.map(q=>normalizeQuestionText(q.questionText));
        if(batch.length===count && batch.every(q=>q.nodeId===nodeId) && new Set(families).size===count && !families.some(f=>exposedFamilies.has(f))) {
          accepted=batch;break;
        }
        avoid.push(...batch.map(q=>q.questionText));
      }
      if(!accepted)throw new QuizCreationError("QUESTION_SCOPE_INVALID");
      batches.push(...accepted);
    }
    generated = batches;
  } else {
    const generate = input.generateQuestions ?? generateQuizQuestions;
    generated = await generate({
      nodeIds,
      questionCount: input.questionCount,
      difficultyMode: input.difficultyMode,
    });
  }

  if (input.assessmentConfig) {
    const allocation = allocateNodeQuestions(nodeIds, input.questionCount, input.assessmentConfig);
    for (const [nodeId, count] of allocation) {
      const questions = generated.filter(q => q.nodeId === nodeId);
      const unique = new Set(questions.map(q => normalizeQuestionText(q.questionText)));
      if (questions.length !== count || unique.size !== count || questions.some(q=>exposedFamilies.has(normalizeQuestionText(q.questionText)))) throw new QuizCreationError("QUESTION_SCOPE_INVALID");
    }
  }

  if (generated.length === 0 && !input.allowEmptyQuestions) {
    throw new QuizCreationError("EMPTY_GENERATION");
  }

  const requiresNodeScope = input.requireGeneratedNodeScope || canonicalTargets.length > 0;
  if (
    requiresNodeScope &&
    generated.some((question) =>
      question.nodeId === null || !nodeIds.includes(question.nodeId)
    )
  ) {
    throw new QuizCreationError("QUESTION_SCOPE_INVALID");
  }

  return { nodeIds, generated, canonicalTargets };
}

/**
 * Persist already-generated questions using the supplied database executor.
 * Passing a transaction here lets the async job finalizer commit the quiz and
 * the completed job together.
 */
export async function persistGeneratedQuizInTransaction(
  tx: QuizPersistenceExecutor,
  input: CreateQuizFromNodeScopeInput,
  nodeIds: number[],
  generated: GeneratedQuestion[],
  canonicalTargets?: CanonicalQuizTarget[],
): Promise<CreatedQuizResult> {
  if (input.generationPurpose !== "retest" && input.generationPurpose !== "standard" && canonicalTargets?.length) {
    if (generated.length !== input.questionCount) {
      throw new QuizCreationError("QUESTION_SCOPE_INVALID");
    }
    const targetByNode = new Map(
      canonicalTargets.map((target) => [target.nodeId, target]),
    );
    if (generated.some((question) => {
      if (question.nodeId === null) return true;
      const target = targetByNode.get(question.nodeId);
      return !target || question.cognitiveLevelId !== target.cognitiveLevelId;
    })) {
      throw new QuizCreationError("QUESTION_SCOPE_INVALID");
    }
    await tx.execute(sql`
      SELECT id
      FROM lesson_nodes
      WHERE id IN (${sql.join(nodeIds.map((nodeId) => sql`${nodeId}`), sql`, `)})
      ORDER BY id
      FOR UPDATE
    `);
    const currentTargets = await resolveNormalQuizCanonicalTargetsWith(tx, nodeIds);
    const generatedTargetByNode = new Map(
      canonicalTargets.map((target) => [target.nodeId, target]),
    );
    for (const currentTarget of currentTargets) {
      const generatedTarget = generatedTargetByNode.get(currentTarget.nodeId);
      if (
        !generatedTarget
        || !canonicalTargetSnapshotMatches(generatedTarget, currentTarget)
      ) {
        throw new QuizCanonicalTargetChangedError(
          currentTarget.nodeId,
          generatedTarget?.cognitiveLevelId ?? 0,
          currentTarget.cognitiveLevelId,
        );
      }
    }
  }

  const [quiz] = await tx
    .insert(quizzesTable)
    .values({
      assessmentConfig: input.assessmentConfig ?? null,
      teacherId: input.teacherId,
      subjectId: input.subjectId,
      classId: input.classId ?? null,
      sourceBookId: input.sourceBookId ?? null,
      nodeIds,
      title: input.title,
      questionCount: input.questionCount,
      difficultyMode: input.difficultyMode,
      status: "DRAFT",
      quizType: input.quizType ?? null,
      retestSourceAttemptId: input.retestSourceAttemptId ?? null,
      retestStrategy: input.retestStrategy ?? null,
    })
    .returning();

  if (input.lessonIds && input.lessonIds.length > 0) {
    await tx
      .insert(quizLessonLinksTable)
      .values([...new Set(input.lessonIds)].map((lessonId) => ({
        quizId: quiz.id,
        lessonId,
      })))
      .onConflictDoNothing();
  }

  if (generated.length > 0) {
    await tx.insert(quizQuestionsTable).values(
      generated.map((question, index) => ({
        quizId: quiz.id,
        nodeId: question.nodeId,
        cognitiveLevelId: question.cognitiveLevelId,
        questionText: question.questionText,
        options: question.options,
        correctOptionIndex: question.correctOptionIndex,
        difficultyLevel: question.difficultyLevel,
        sequence: index + 1,
        optionExplanations: question.optionExplanations?.map((slot) => slot ?? "") ?? null,
        interactionType: "multiple_choice",
      })),
    );
  }

  const finalStatus = input.studentId == null ? "GENERATED" : "ASSIGNED";
  await tx
    .update(quizzesTable)
    .set({ status: finalStatus, updatedAt: new Date() })
    .where(eq(quizzesTable.id, quiz.id));

  let assignmentId: number | null = null;
  if (input.studentId != null) {
    const [assignment] = await tx
      .insert(quizAssignmentsTable)
      .values({
        quizId: quiz.id,
        studentId: input.studentId,
        status: "ASSIGNED",
      })
      .returning({ id: quizAssignmentsTable.id });
    assignmentId = assignment.id;
  }

  const questions = await tx
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, quiz.id))
    .orderBy(asc(quizQuestionsTable.sequence));

  return {
    quiz: { ...quiz, status: finalStatus },
    questions,
    generated,
    assignmentId,
  };
}

/**
 * Shared persistence boundary for generated quizzes.
 *
 * Generation runs before the transaction because it is an external provider
 * call. Quiz metadata, lesson links, questions, final status, and an optional
 * learner assignment are committed together, so a failed DB write cannot
 * expose a partially usable retest.
 */
export async function createQuizFromNodeScope(
  input: CreateQuizFromNodeScopeInput,
): Promise<CreatedQuizResult> {
  const { nodeIds, generated, canonicalTargets } = await generateQuizFromNodeScope(input);

  return db.transaction(async (tx) => {
    return persistGeneratedQuizInTransaction(
      tx,
      input,
      nodeIds,
      generated,
      canonicalTargets,
    );
  });
}

export function normalizeQuizConfig(input: {
  questionCount: number | null | undefined;
  difficultyMode: string | null | undefined;
}): Pick<CreateQuizFromNodeScopeInput, "questionCount" | "difficultyMode"> {
  const questionCount =
    Number.isInteger(input.questionCount) && input.questionCount! >= 1 && input.questionCount! <= 50
      ? input.questionCount!
      : 10;
  const difficultyMode = (QUIZ_DIFFICULTY_MODES as readonly string[]).includes(input.difficultyMode ?? "")
    ? input.difficultyMode as QuizDifficultyMode
    : "MIXED";
  return { questionCount, difficultyMode };
}