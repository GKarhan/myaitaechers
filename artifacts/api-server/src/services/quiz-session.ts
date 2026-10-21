import { filterRequiredPrerequisites, parseAssessmentConfig } from "./node-assessment-policy.js";
import { resolveKnowledgeTreeStates } from "./knowledge-tree-state.js";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  lessonNodeDependenciesTable,
  quizAnswersTable,
  quizAssignmentsTable,
  quizAttemptQuestionsTable,
  quizAttemptsTable,
  quizQuestionsTable,
  quizSessionsTable,
  quizzesTable,
} from "@workspace/db";


export async function filterAutomaticAssessmentScope(userId:number,nodeIds:readonly number[]):Promise<number[]> {
  if(!nodeIds.length)return [];
  const edges=await db.select({fromNodeId:lessonNodeDependenciesTable.fromNodeId,toNodeId:lessonNodeDependenciesTable.toNodeId})
    .from(lessonNodeDependenciesTable).where(or(eq(lessonNodeDependenciesTable.requiredLevel,"CRITICAL"),eq(lessonNodeDependenciesTable.dependencyType,"REQUIRED")));
  const relevant=new Set(nodeIds);let grew=true;
  while(grew){grew=false;for(const e of edges)if(relevant.has(e.toNodeId)&&!relevant.has(e.fromNodeId)){relevant.add(e.fromNodeId);grew=true;}}
  const states=await resolveKnowledgeTreeStates(userId,[...relevant]);
  return filterRequiredPrerequisites(nodeIds,edges,states);
}

export type QuizSessionProjection = {
  masteredNodeIds: number[];
  learningNodeIds: number[];
  practiceNodeIds?: number[];
  supportNodeIds?: number[];
  supportCount?: number;
  knowsCount: number;
  learningCount: number;
};

export function projectQuizSessionStates(
  nodeIds: readonly number[],
  states: ReadonlyMap<number, { knowledgeState: string }>,
): QuizSessionProjection {
  const masteredNodeIds: number[] = [];
  const learningNodeIds: number[] = [];
  for (const nodeId of [...new Set(nodeIds)]) {
    if (states.get(nodeId)?.knowledgeState === "MASTERED") masteredNodeIds.push(nodeId);
    else learningNodeIds.push(nodeId);
  }
  return {
    masteredNodeIds,
    learningNodeIds,
    knowsCount: masteredNodeIds.length,
    learningCount: learningNodeIds.length,
  };
}

export async function resolveQuizSessionProjection(
  rootQuizId: number,
  learnerId: number,
): Promise<QuizSessionProjection> {
  const [quiz] = await db.select({ nodeIds: quizzesTable.nodeIds, assessmentConfig: quizzesTable.assessmentConfig })
    .from(quizzesTable).where(eq(quizzesTable.id, rootQuizId)).limit(1);
  let nodeIds = Array.isArray(quiz?.nodeIds)
    ? quiz.nodeIds.filter((value): value is number => Number.isInteger(value))
    : [];
  if (nodeIds.length === 0) {
    const rows = await db.select({ nodeId: quizQuestionsTable.nodeId })
      .from(quizQuestionsTable).where(eq(quizQuestionsTable.quizId, rootQuizId));
    nodeIds = rows.map((row) => row.nodeId).filter((value): value is number => value !== null);
  }
  if (parseAssessmentConfig(quiz?.assessmentConfig)) {
    const states = await resolveKnowledgeTreeStates(learnerId,nodeIds);
    const masteredNodeIds = nodeIds.filter(id=>states.get(id)?.knowledgeState === "MASTERED");
    const supportNodeIds = nodeIds.filter(id=>states.get(id)?.assessment?.status === "NEEDS_SUPPORT");
    const learningNodeIds = nodeIds.filter(id=>states.get(id)?.knowledgeState !== "MASTERED" && !supportNodeIds.includes(id));
    const practiceNodeIds = await filterAutomaticAssessmentScope(learnerId,learningNodeIds);
    return { masteredNodeIds,learningNodeIds,practiceNodeIds,supportNodeIds,supportCount:supportNodeIds.length,knowsCount:masteredNodeIds.length,learningCount:learningNodeIds.length };
  }
  // Local quiz practice tracks questions answered correctly in any completed
  // attempt. This is distinct from the canonical C4/C5 mastery model.
  const successful = await db
    .select({ nodeId: quizAnswersTable.nodeId })
    .from(quizAnswersTable)
    .innerJoin(quizAttemptsTable, eq(quizAttemptsTable.id, quizAnswersTable.attemptId))
    .innerJoin(quizSessionsTable, eq(quizSessionsTable.id, quizAttemptsTable.quizSessionId))
    .where(and(
      eq(quizSessionsTable.rootQuizId, rootQuizId),
      eq(quizSessionsTable.studentId, learnerId),
      eq(quizAnswersTable.isCorrect, true),
    ));
  const practiced = new Set(successful.map(row => row.nodeId).filter((id): id is number => id !== null));
  return projectQuizSessionStates(nodeIds, new Map(nodeIds.map(id => [
    id, { knowledgeState: practiced.has(id) ? "MASTERED" : "LEARNING" },
  ])));
}

export async function ensureQuizSession(input: {
  rootQuizId: number;
  rootAssignmentId: number;
  learnerId: number;
}) {
  const [existing] = await db.select().from(quizSessionsTable)
    .where(eq(quizSessionsTable.rootAssignmentId, input.rootAssignmentId))
    .limit(1);
  let session = existing;
  if (!session) {
    const [created] = await db.insert(quizSessionsTable).values({
      rootQuizId: input.rootQuizId,
      rootAssignmentId: input.rootAssignmentId,
      studentId: input.learnerId,
    }).onConflictDoNothing().returning();
    if (created) session = created;
    else {
      const [raced] = await db.select().from(quizSessionsTable)
        .where(eq(quizSessionsTable.rootAssignmentId, input.rootAssignmentId))
        .limit(1);
      if (!raced) throw new Error("QUIZ_SESSION_CREATE_FAILED");
      session = raced;
    }
  }

  const legacyAttempts = await db.select().from(quizAttemptsTable).where(and(
    eq(quizAttemptsTable.quizAssignmentId, input.rootAssignmentId),
    isNull(quizAttemptsTable.quizSessionId),
  )).orderBy(asc(quizAttemptsTable.startedAt), asc(quizAttemptsTable.id));
  if (legacyAttempts.length > 0) {
    await db.transaction(async (tx) => {
      const [latestSessionAttempt] = await tx.select({
        sequence: quizAttemptsTable.attemptSequence,
      }).from(quizAttemptsTable)
        .where(eq(quizAttemptsTable.quizSessionId, session.id))
        .orderBy(desc(quizAttemptsTable.attemptSequence))
        .limit(1);
      const baseSequence = latestSessionAttempt?.sequence ?? 0;
      const allQuestions = await tx.select().from(quizQuestionsTable)
        .where(eq(quizQuestionsTable.quizId, input.rootQuizId))
        .orderBy(asc(quizQuestionsTable.sequence));
      for (let index = 0; index < legacyAttempts.length; index++) {
        const legacy = legacyAttempts[index];
        await tx.update(quizAttemptsTable).set({
          quizSessionId: session.id,
          attemptSequence: baseSequence + index + 1,
        }).where(and(
          eq(quizAttemptsTable.id, legacy.id),
          isNull(quizAttemptsTable.quizSessionId),
        ));
        const answered = await tx.select({ questionId: quizAnswersTable.questionId })
          .from(quizAnswersTable)
          .where(eq(quizAnswersTable.attemptId, legacy.id));
        const answeredIds = new Set(answered.map((row) => row.questionId));
        const snapshotQuestions = answeredIds.size > 0
          ? allQuestions.filter((question) => answeredIds.has(question.id))
          : allQuestions;
        if (snapshotQuestions.length > 0) {
          await tx.insert(quizAttemptQuestionsTable).values(
            snapshotQuestions.map((question, snapshotIndex) => {
              const options = Array.isArray(question.options) ? question.options as string[] : [];
              return {
                attemptId: legacy.id,
                questionId: question.id,
                nodeId: question.nodeId,
                questionText: question.questionText,
                options,
                correctOptionIndex: question.correctOptionIndex,
                optionExplanations: question.optionExplanations,
                solutionExplanation: question.solutionExplanation,
                interactionType: question.interactionType,
                difficultyLevel: question.difficultyLevel,
                sourceExerciseId: question.sourceExerciseId,
                cognitiveLevelId: question.cognitiveLevelId,
                sequence: snapshotIndex + 1,
                optionOrder: options.map((_, optionIndex) => optionIndex),
              };
            }),
          ).onConflictDoNothing();
        }
      }
    });
  }
  return session;
}

function shuffledOrder(length: number): number[] {
  const order = Array.from({ length }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

export async function getOrCreateActiveAttempt(input: {
  rootQuizId: number;
  assignmentId: number;
  learnerId: number;
}) {
  const session = await ensureQuizSession({
    rootQuizId: input.rootQuizId,
    rootAssignmentId: input.assignmentId,
    learnerId: input.learnerId,
  });
  if (session.status !== "ACTIVE") return { session, attempt: null, snapshots: [] };

  const [active] = await db.select().from(quizAttemptsTable).where(and(
    eq(quizAttemptsTable.quizSessionId, session.id),
    eq(quizAttemptsTable.quizAssignmentId, input.assignmentId),
    isNull(quizAttemptsTable.completedAt),
  )).orderBy(desc(quizAttemptsTable.attemptSequence)).limit(1);
  if (active) {
    const snapshots = await db.select().from(quizAttemptQuestionsTable)
      .where(eq(quizAttemptQuestionsTable.attemptId, active.id))
      .orderBy(asc(quizAttemptQuestionsTable.sequence));
    return { session, attempt: active, snapshots };
  }

  const completed = await db.select({ sequence: quizAttemptsTable.attemptSequence })
    .from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.quizSessionId, session.id))
    .orderBy(desc(quizAttemptsTable.attemptSequence)).limit(1);
  const nextSequence = (completed[0]?.sequence ?? 0) + 1;
  const projection = await resolveQuizSessionProjection(input.rootQuizId, input.learnerId);
  const scope = nextSequence === 1 ? null : (projection.practiceNodeIds ?? projection.learningNodeIds);
  if (scope?.length === 0) return { session, attempt: null, snapshots: [] };

  const questions = await db.select().from(quizQuestionsTable).where(
    scope === null
      ? eq(quizQuestionsTable.quizId, input.rootQuizId)
      : and(
          eq(quizQuestionsTable.quizId, input.rootQuizId),
          inArray(quizQuestionsTable.nodeId, scope),
        ),
  ).orderBy(asc(quizQuestionsTable.sequence));
  if (questions.length === 0) return { session, attempt: null, snapshots: [] };

  try {
    return await db.transaction(async (tx) => {
      const [attempt] = await tx.insert(quizAttemptsTable).values({
        quizAssignmentId: input.assignmentId,
        quizSessionId: session.id,
        attemptSequence: nextSequence,
        totalQuestions: questions.length,
      }).returning();
      const snapshots = await tx.insert(quizAttemptQuestionsTable).values(
        questions.map((question, index) => {
          const options = Array.isArray(question.options) ? question.options as string[] : [];
          return {
            attemptId: attempt.id,
            questionId: question.id,
            nodeId: question.nodeId,
            questionText: question.questionText,
            options,
            correctOptionIndex: question.correctOptionIndex,
            optionExplanations: question.optionExplanations,
            solutionExplanation: question.solutionExplanation,
            interactionType: question.interactionType,
            difficultyLevel: question.difficultyLevel,
            sourceExerciseId: question.sourceExerciseId,
            cognitiveLevelId: question.cognitiveLevelId,
            sequence: index + 1,
            optionOrder: shuffledOrder(options.length),
          };
        }),
      ).returning();
      await tx.update(quizAssignmentsTable).set({ status: "IN_PROGRESS" })
        .where(and(
          eq(quizAssignmentsTable.id, input.assignmentId),
          eq(quizAssignmentsTable.status, "ASSIGNED"),
        ));
      return { session, attempt, snapshots };
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const [winner] = await db.select().from(quizAttemptsTable).where(and(
      eq(quizAttemptsTable.quizSessionId, session.id),
      isNull(quizAttemptsTable.completedAt),
    )).limit(1);
    if (!winner) throw error;
    const snapshots = await db.select().from(quizAttemptQuestionsTable)
      .where(eq(quizAttemptQuestionsTable.attemptId, winner.id))
      .orderBy(asc(quizAttemptQuestionsTable.sequence));
    return { session, attempt: winner, snapshots };
  }
}

export function presentAttemptQuestion(snapshot: {
  questionId: number;
  questionText: string;
  options: unknown;
  optionOrder: unknown;
  sequence: number;
  interactionType: string | null;
}) {
  const options = Array.isArray(snapshot.options) ? snapshot.options as string[] : [];
  const optionOrder = Array.isArray(snapshot.optionOrder)
    ? snapshot.optionOrder as number[]
    : options.map((_, index) => index);
  return {
    id: snapshot.questionId,
    questionText: snapshot.questionText,
    options: optionOrder.map((index) => options[index]),
    difficultyLevel: "MEDIUM",
    interactionType: snapshot.interactionType,
    sequence: snapshot.sequence,
  };
}

export function scorePresentedAnswer(
  snapshot: {
    optionOrder: unknown;
    correctOptionIndex: number;
    optionExplanations?: (string | null)[] | null;
    solutionExplanation?: string | null;
  },
  selectedPresentationIndex: number,
) {
  const order = Array.isArray(snapshot.optionOrder) ? snapshot.optionOrder as number[] : [];
  const canonicalSelectedOptionIndex = order[selectedPresentationIndex];
  if (!Number.isInteger(canonicalSelectedOptionIndex)) return null;
  const correctPresentationIndex = order.indexOf(snapshot.correctOptionIndex);
  if (correctPresentationIndex < 0) return null;
  const isCorrect = canonicalSelectedOptionIndex === snapshot.correctOptionIndex;
  const explanations = snapshot.optionExplanations ?? [];
  return {
    canonicalSelectedOptionIndex,
    selectedPresentationIndex,
    correctPresentationIndex,
    isCorrect,
    feedback: {
      whyCorrect: explanations[snapshot.correctOptionIndex] ?? null,
      whyWrong: isCorrect ? null : explanations[canonicalSelectedOptionIndex] ?? null,
      solutionExplanation: snapshot.solutionExplanation ?? null,
    },
  };
}