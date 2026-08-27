import { and, eq } from "drizzle-orm";
import {
  db,
  quizAssignmentsTable,
  quizAttemptsTable,
  quizLessonLinksTable,
  quizzesTable,
} from "@workspace/db";
import {
  resolveRetestEligibleNodes,
  type RetestAuthorityResult,
  type RetestStrategy,
} from "./quiz-retest-authority.js";
import {
  createQuizFromNodeScope,
  normalizeQuizConfig,
  QuizCreationError,
} from "./quiz-creation.js";
import type { GenerateQuizInput, GeneratedQuestion } from "./quiz-generation.js";

export type TargetedRetestResult =
  | {
      created: false;
      reason: "NO_ELIGIBLE_NODES";
      sourceAttemptId: number;
      strategy: RetestStrategy;
    }
  | {
      created: true;
      reused: boolean;
      sourceAttemptId: number;
      strategy: RetestStrategy;
      quizId: number;
      assignmentId: number;
    };

export class TargetedRetestError extends Error {
  readonly code: "SOURCE_NOT_FOUND" | "GENERATION_FAILED";

  constructor(code: TargetedRetestError["code"]) {
    super(code);
    this.name = "TargetedRetestError";
    this.code = code;
  }
}

type TargetedRetestDependencies = {
  resolveEligibility?: (input: {
    learnerId: number;
    completedAttemptId: number;
    strategy: RetestStrategy;
  }) => Promise<RetestAuthorityResult>;
  generateQuestions?: (input: GenerateQuizInput) => Promise<GeneratedQuestion[]>;
};

type SourceRetestRecord = {
  quizId: number;
  teacherId: number;
  subjectId: number;
  classId: number | null;
  sourceBookId: number | null;
  title: string;
  questionCount: number;
  difficultyMode: string;
  quizType: string | null;
};

async function findExistingRetest(input: {
  learnerId: number;
  sourceAttemptId: number;
  strategy: RetestStrategy;
}) {
  const [existing] = await db
    .select({
      quizId: quizzesTable.id,
      assignmentId: quizAssignmentsTable.id,
    })
    .from(quizzesTable)
    .innerJoin(
      quizAssignmentsTable,
      and(
        eq(quizAssignmentsTable.quizId, quizzesTable.id),
        eq(quizAssignmentsTable.studentId, input.learnerId),
      ),
    )
    .where(and(
      eq(quizzesTable.retestSourceAttemptId, input.sourceAttemptId),
      eq(quizzesTable.retestStrategy, input.strategy),
    ))
    .limit(1);
  return existing ?? null;
}

async function loadSourceQuiz(input: {
  learnerId: number;
  sourceAttemptId: number;
}): Promise<SourceRetestRecord> {
  const [source] = await db
    .select({
      quizId: quizzesTable.id,
      teacherId: quizzesTable.teacherId,
      subjectId: quizzesTable.subjectId,
      classId: quizzesTable.classId,
      sourceBookId: quizzesTable.sourceBookId,
      title: quizzesTable.title,
      questionCount: quizzesTable.questionCount,
      difficultyMode: quizzesTable.difficultyMode,
      quizType: quizzesTable.quizType,
    })
    .from(quizAttemptsTable)
    .innerJoin(
      quizAssignmentsTable,
      eq(quizAssignmentsTable.id, quizAttemptsTable.quizAssignmentId),
    )
    .innerJoin(quizzesTable, eq(quizzesTable.id, quizAssignmentsTable.quizId))
    .where(and(
      eq(quizAttemptsTable.id, input.sourceAttemptId),
      eq(quizAssignmentsTable.studentId, input.learnerId),
    ))
    .limit(1);

  if (!source) {
    throw new TargetedRetestError("SOURCE_NOT_FOUND");
  }
  return source;
}

/**
 * Creates one learner-owned targeted retest from T1's canonical result.
 *
 * T1 is called before any quiz creation. Only its returned eligible node IDs
 * enter the shared quiz creation boundary; the client never supplies them.
 */
export async function createTargetedRetest(
  input: {
    learnerId: number;
    sourceAttemptId: number;
    strategy: RetestStrategy;
  } & TargetedRetestDependencies,
): Promise<TargetedRetestResult> {
  const resolveEligibility = input.resolveEligibility ?? resolveRetestEligibleNodes;
  const authority = await resolveEligibility({
    learnerId: input.learnerId,
    completedAttemptId: input.sourceAttemptId,
    strategy: input.strategy,
  });
  if (
    authority.attemptId !== input.sourceAttemptId ||
    authority.strategy !== input.strategy
  ) {
    throw new TargetedRetestError("GENERATION_FAILED");
  }

  if (authority.eligibleNodes.length === 0) {
    return {
      created: false,
      reason: "NO_ELIGIBLE_NODES",
      sourceAttemptId: input.sourceAttemptId,
      strategy: input.strategy,
    };
  }

  const source = await loadSourceQuiz({
    learnerId: input.learnerId,
    sourceAttemptId: input.sourceAttemptId,
  });

  const existing = await findExistingRetest({
    learnerId: input.learnerId,
    sourceAttemptId: input.sourceAttemptId,
    strategy: input.strategy,
  });
  if (existing) {
    return {
      created: true,
      reused: true,
      sourceAttemptId: input.sourceAttemptId,
      strategy: input.strategy,
      quizId: existing.quizId,
      assignmentId: existing.assignmentId,
    };
  }

  const config = normalizeQuizConfig({
    questionCount: source.questionCount,
    difficultyMode: source.difficultyMode,
  });
  const nodeIds = authority.eligibleNodes.map((node) => node.nodeId);
  const lessonLinks = await db
    .select({ lessonId: quizLessonLinksTable.lessonId })
    .from(quizLessonLinksTable)
    .where(eq(quizLessonLinksTable.quizId, source.quizId));

  try {
    const created = await createQuizFromNodeScope({
      teacherId: source.teacherId,
      subjectId: source.subjectId,
      classId: source.classId,
      sourceBookId: source.sourceBookId,
      lessonIds: lessonLinks.map((link) => link.lessonId),
      nodeIds,
      title: `Նորից ստուգել — ${source.title}`,
      questionCount: config.questionCount,
      difficultyMode: config.difficultyMode,
      quizType: source.quizType,
      studentId: input.learnerId,
      retestSourceAttemptId: input.sourceAttemptId,
      retestStrategy: input.strategy,
      generationPurpose: "retest",
      requireGeneratedNodeScope: true,
      generateQuestions: input.generateQuestions,
    });

    if (created.assignmentId === null) {
      throw new TargetedRetestError("GENERATION_FAILED");
    }

    return {
      created: true,
      reused: false,
      sourceAttemptId: input.sourceAttemptId,
      strategy: input.strategy,
      quizId: created.quiz.id,
      assignmentId: created.assignmentId,
    };
  } catch (error) {
    if (error instanceof TargetedRetestError) throw error;
    if (error instanceof QuizCreationError) {
      throw new TargetedRetestError("GENERATION_FAILED");
    }

    // A concurrent duplicate request can lose the unique lineage race. The
    // committed winner is safe to reuse; all other failures remain retryable.
    const concurrentWinner = await findExistingRetest({
      learnerId: input.learnerId,
      sourceAttemptId: input.sourceAttemptId,
      strategy: input.strategy,
    });
    if (concurrentWinner) {
      return {
        created: true,
        reused: true,
        sourceAttemptId: input.sourceAttemptId,
        strategy: input.strategy,
        quizId: concurrentWinner.quizId,
        assignmentId: concurrentWinner.assignmentId,
      };
    }
    throw new TargetedRetestError("GENERATION_FAILED");
  }
}