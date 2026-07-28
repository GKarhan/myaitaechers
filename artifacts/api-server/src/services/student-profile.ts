import { db, knowledgeNodesTable, lessonSessionsTable, studentProfileTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Recomputes and upserts the aggregated student_profile row for one user.
 * Intended to be called once per lesson completion (not per answer) — see
 * the call site in routes/lessons.ts (advance-phase, when isComplete).
 *
 * reviewQueueSummary is intentionally left untouched here (stays whatever
 * it already was, or [] by default) — populating it with the fuller
 * review_reason/priority structure from the Student Model spec (P2) is
 * future work, not part of this MVP aggregation.
 */
export async function updateStudentProfile(userId: number): Promise<void> {
  try {
    const nodes = await db
      .select({
        masteryScore: knowledgeNodesTable.masteryScore,
        status: knowledgeNodesTable.status,
      })
      .from(knowledgeNodesTable)
      .where(eq(knowledgeNodesTable.userId, userId));

    const graded = nodes.filter((n) => n.masteryScore !== null) as { masteryScore: number; status: string }[];
    const avgMastery =
      graded.length > 0
        ? Math.round(graded.reduce((sum, n) => sum + n.masteryScore, 0) / graded.length)
        : null;

    const masteredTopicsCount = nodes.filter((n) => n.status === "mastered").length;
    const weakTopicsCount = nodes.filter((n) => n.status === "weak").length;
    const notStartedTopicsCount = nodes.filter((n) => n.status === "not_started").length;

    const [{ count: totalLessonsCompleted }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(lessonSessionsTable)
      .where(and(eq(lessonSessionsTable.userId, userId), eq(lessonSessionsTable.status, "completed")));

    const [existing] = await db
      .select({ id: studentProfileTable.id })
      .from(studentProfileTable)
      .where(eq(studentProfileTable.userId, userId))
      .limit(1);

    if (existing) {
      await db
        .update(studentProfileTable)
        .set({
          avgMastery,
          masteredTopicsCount,
          weakTopicsCount,
          notStartedTopicsCount,
          totalLessonsCompleted: Number(totalLessonsCompleted),
          lastUpdatedAt: new Date(),
        })
        .where(eq(studentProfileTable.id, existing.id));
    } else {
      await db.insert(studentProfileTable).values({
        userId,
        avgMastery,
        masteredTopicsCount,
        weakTopicsCount,
        notStartedTopicsCount,
        totalLessonsCompleted: Number(totalLessonsCompleted),
      });
    }

    logger.info(
      { userId, avgMastery, masteredTopicsCount, weakTopicsCount, notStartedTopicsCount, totalLessonsCompleted },
      "student profile updated"
    );
  } catch (err) {
    logger.error({ err, userId }, "student profile update failed");
  }
}