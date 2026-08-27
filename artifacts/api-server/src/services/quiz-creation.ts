import {
  db,
  quizAssignmentsTable,
  quizLessonLinksTable,
  quizQuestionsTable,
  quizzesTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import {
  generateQuizQuestions,
  type GenerateQuizInput,
  type GeneratedQuestion,
} from "./quiz-generation.js";
import type { RetestStrategy } from "./quiz-retest-authority.js";

export const QUIZ_DIFFICULTY_MODES = ["SIMPLE", "MEDIUM", "HARD", "MIXED"] as const;
export type QuizDifficultyMode = (typeof QUIZ_DIFFICULTY_MODES)[number];

export class QuizCreationError extends Error {
  readonly code: "EMPTY_GENERATION" | "QUESTION_SCOPE_INVALID";

  constructor(code: QuizCreationError["code"]) {
    super(code);
    this.name = "QuizCreationError";
    this.code = code;
  }
}

export type CreateQuizFromNodeScopeInput = {
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
  generateQuestions?: (input: GenerateQuizInput) => Promise<GeneratedQuestion[]>;
};

export type CreatedQuizResult = {
  quiz: typeof quizzesTable.$inferSelect;
  questions: typeof quizQuestionsTable.$inferSelect[];
  generated: GeneratedQuestion[];
  assignmentId: number | null;
};

type QuizPersistenceExecutor = typeof db | PgTransaction<any, any, any>;

export async function generateQuizFromNodeScope(
  input: CreateQuizFromNodeScopeInput,
): Promise<{ nodeIds: number[]; generated: GeneratedQuestion[] }> {
  const nodeIds = [...new Set(input.nodeIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (nodeIds.length === 0) {
    throw new QuizCreationError("QUESTION_SCOPE_INVALID");
  }

  const generate = input.generateQuestions ?? generateQuizQuestions;
  const generated = await generate({
    nodeIds,
    questionCount: input.questionCount,
    difficultyMode: input.difficultyMode,
  });

  if (generated.length === 0 && !input.allowEmptyQuestions) {
    throw new QuizCreationError("EMPTY_GENERATION");
  }

  if (
    input.requireGeneratedNodeScope &&
    generated.some((question) =>
      question.nodeId === null || !nodeIds.includes(question.nodeId)
    )
  ) {
    throw new QuizCreationError("QUESTION_SCOPE_INVALID");
  }

  return { nodeIds, generated };
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
): Promise<CreatedQuizResult> {
  const [quiz] = await tx
    .insert(quizzesTable)
    .values({
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
  const { nodeIds, generated } = await generateQuizFromNodeScope(input);

  return db.transaction(async (tx) => {
    return persistGeneratedQuizInTransaction(tx, input, nodeIds, generated);
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