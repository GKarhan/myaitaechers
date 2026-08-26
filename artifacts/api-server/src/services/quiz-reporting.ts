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