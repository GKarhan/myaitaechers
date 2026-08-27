import { db, lessonTopicsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";

/**
 * Normalize a lesson's topic sequences to 1..N.
 *
 * Without an explicit order, current sequence is the primary order and topic
 * ID is the stable tie-breaker. Reorder callers may provide a validated
 * explicit order.
 */
export async function normalizeTopicSequences(
  lessonId: number,
  dbInstance: typeof db = db,
  orderedTopicIds?: number[],
): Promise<number[]> {
  const topics = await dbInstance
    .select({ id: lessonTopicsTable.id, sequence: lessonTopicsTable.sequence })
    .from(lessonTopicsTable)
    .where(eq(lessonTopicsTable.lessonId, lessonId))
    .orderBy(asc(lessonTopicsTable.sequence), asc(lessonTopicsTable.id));

  const topicIds = orderedTopicIds ?? topics.map((topic) => topic.id);
  for (let i = 0; i < topicIds.length; i++) {
    await dbInstance
      .update(lessonTopicsTable)
      .set({ sequence: i + 1 })
      .where(eq(lessonTopicsTable.id, topicIds[i]));
  }

  return topicIds;
}