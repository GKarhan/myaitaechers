import { db, reviewScheduleTable, knowledgeNodesTable } from "@workspace/db";
import { eq, and, lte } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Spaced-repetition scheduling (Phase B).
 *
 * Interval ladder: 1 → 3 → 7 → 14 → 30 days. Where a topic lands on the
 * ladder next time is driven by its current mastery score:
 *   - mastery < 50 (weak/not_started): reset to the first rung (review tomorrow)
 *   - mastery 50–79 (weak-ish): repeat at the same interval (not advancing yet)
 *   - mastery >= 80 (mastered): advance one rung further out
 *
 * This is a simple, explainable default — not from a specific formula in the
 * documentation — and can be replaced with a more precise cognitive-model-based
 * interval calculation later without changing the table shape.
 */

const LADDER_DAYS = [1, 3, 7, 14, 30];

function nextIntervalDays(currentIntervalDays: number, masteryScore: number): number {
  const idx = LADDER_DAYS.indexOf(currentIntervalDays);

  if (masteryScore < 50) return LADDER_DAYS[0];

  if (masteryScore >= 80) {
    const nextIdx = idx === -1 ? 1 : Math.min(idx + 1, LADDER_DAYS.length - 1);
    return LADDER_DAYS[nextIdx];
  }

  // 50–79: hold at the current rung until mastery improves
  return idx === -1 ? LADDER_DAYS[0] : LADDER_DAYS[idx];
}

/**
 * Called after a topic's mastery score is (re)computed, to schedule (or
 * reschedule) its next spaced-repetition review. Fire-and-forget safe.
 */
export async function scheduleReview(
  topicId: number,
  userId: number,
  masteryScore: number
): Promise<void> {
  try {
    const [existing] = await db
      .select()
      .from(reviewScheduleTable)
      .where(and(eq(reviewScheduleTable.topicId, topicId), eq(reviewScheduleTable.userId, userId)))
      .limit(1);

    const now = new Date();

    if (!existing) {
      const intervalDays = nextIntervalDays(1, masteryScore);
      const dueAt = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);
      await db.insert(reviewScheduleTable).values({
        userId,
        topicId,
        dueAt,
        lastReviewedAt: now,
        intervalDays,
        reviewCount: 1,
      });
      return;
    }

    const intervalDays = nextIntervalDays(existing.intervalDays, masteryScore);
    const dueAt = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);

    await db
      .update(reviewScheduleTable)
      .set({
        dueAt,
        lastReviewedAt: now,
        intervalDays,
        reviewCount: existing.reviewCount + 1,
        updatedAt: now,
      })
      .where(eq(reviewScheduleTable.id, existing.id));
  } catch (err) {
    logger.error({ err, topicId, userId }, "review schedule: update failed");
  }
}

/**
 * Topics that are due (or overdue) for review right now, for this user.
 * Used at the start of a lesson (Phase 1 — review) so the AI teacher knows
 * which specific topics to prioritize, instead of reviewing vaguely.
 */
export async function getDueReviewTopics(
  userId: number
): Promise<{ topicId: number; topicName: string; dueAt: Date }[]> {
  try {
    const rows = await db
      .select({
        topicId: reviewScheduleTable.topicId,
        topicName: knowledgeNodesTable.topicName,
        dueAt: reviewScheduleTable.dueAt,
      })
      .from(reviewScheduleTable)
      .innerJoin(knowledgeNodesTable, eq(reviewScheduleTable.topicId, knowledgeNodesTable.id))
      .where(and(eq(reviewScheduleTable.userId, userId), lte(reviewScheduleTable.dueAt, new Date())))
      .orderBy(reviewScheduleTable.dueAt);

    return rows;
  } catch (err) {
    logger.error({ err, userId }, "review schedule: due lookup failed");
    return [];
  }
}