import { desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  quizAssignmentsTable,
  quizAttemptsTable,
} from "@workspace/db";

export type AttemptReportRow = {
  assignmentId: number;
  attemptSequence: number | null;
  completedAt: Date | null;
};

export function collapseToLatestCompletedAttempt<T extends AttemptReportRow>(
  rows: readonly T[],
): T[] {
  const byAssignment = new Map<number, T>();
  for (const row of rows) {
    const current = byAssignment.get(row.assignmentId);
    if (!current) {
      byAssignment.set(row.assignmentId, row);
      continue;
    }
    if (
      row.completedAt !== null &&
      (
        current.completedAt === null ||
        (row.attemptSequence ?? 0) > (current.attemptSequence ?? 0)
      )
    ) {
      byAssignment.set(row.assignmentId, row);
    }
  }
  return [...byAssignment.values()];
}

export async function getLatestCompletedQuizScoreStats(quizIds: readonly number[]) {
  if (quizIds.length === 0) return [];
  const latestCompleted = db.$with("latest_completed_quiz_attempts").as(
    db.selectDistinctOn([quizAttemptsTable.quizAssignmentId], {
      quizAssignmentId: quizAttemptsTable.quizAssignmentId,
      scorePercent: quizAttemptsTable.scorePercent,
    })
      .from(quizAttemptsTable)
      .where(isNotNull(quizAttemptsTable.completedAt))
      .orderBy(
        quizAttemptsTable.quizAssignmentId,
        desc(quizAttemptsTable.attemptSequence),
        desc(quizAttemptsTable.completedAt),
      ),
  );

  return db.with(latestCompleted)
    .select({
      quizId: quizAssignmentsTable.quizId,
      averageScorePercent: sql<number | null>`round(avg(${latestCompleted.scorePercent}))`,
    })
    .from(latestCompleted)
    .innerJoin(
      quizAssignmentsTable,
      eq(quizAssignmentsTable.id, latestCompleted.quizAssignmentId),
    )
    .where(inArray(quizAssignmentsTable.quizId, [...quizIds]))
    .groupBy(quizAssignmentsTable.quizId);
}
/** Practice progress uses each question's latest completed answer. Historical
 * round accuracy keeps its own denominator; it is never averaged with retries.
 * This report does not grant canonical cognitive mastery. */
export function summarizePracticeProgress<T extends { questionId: number; isCorrect: boolean }>(
  rounds: readonly { attemptId: number; attemptSequence: number; questions: readonly T[] }[],
) {
  const latest = new Map<number, T>();
  const sorted = [...rounds].sort((a, b) => a.attemptSequence - b.attemptSequence);
  const scope = new Set(sorted.flatMap(round => round.questions.map(q => q.questionId)));
  const attempts = sorted.map(round => {
    for (const question of round.questions) latest.set(question.questionId, question);
    const cumulativeCorrect = [...latest.values()].filter(q => q.isCorrect).length;
    const totalCorrect = round.questions.filter(q => q.isCorrect).length;
    return {
      attemptId: round.attemptId,
      attemptSequence: round.attemptSequence,
      totalCorrect,
      totalQuestions: round.questions.length,
      scorePercent: round.questions.length ? Math.round(totalCorrect / round.questions.length * 100) : 0,
      cumulativeCorrect,
      cumulativeTotal: scope.size,
      cumulativePercent: scope.size ? Math.round(cumulativeCorrect / scope.size * 100) : 0,
      remainingIncorrect: scope.size - cumulativeCorrect,
    };
  });
  const totalCorrect = [...latest.values()].filter(q => q.isCorrect).length;
  return {
    totalCorrect,
    totalQuestions: scope.size,
    scorePercent: scope.size ? Math.round(totalCorrect / scope.size * 100) : 0,
    attempts,
    latestQuestions: [...latest.values()],
  };
}
