/**
 * P1.7 — Approval Invalidation Helper
 *
 * When a lesson is "approved" and a teacher makes a meaningful authoring change,
 * the lesson must revert to "needs_review" — the teacher must run Final Approval again.
 *
 * Usage: call `await invalidateLessonApproval(lessonId)` immediately after any
 * persisted authoring change in lessons.ts and teacher.ts routes.
 *
 * This is a silent no-op when the lesson is not approved.
 * Never throws — failures are logged but do not roll back the authoring change.
 */
import { db, lessonsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger.js";

export async function invalidateLessonApproval(lessonId: number): Promise<void> {
  try {
    await db
      .update(lessonsTable)
      .set({ status: "needs_review" })
      .where(
        and(
          eq(lessonsTable.id, lessonId),
          eq(lessonsTable.status, "approved"),
        )
      );
  } catch (err) {
    // Log but never propagate — the authoring change already committed.
    logger.error({ err, lessonId }, "P1.7: failed to invalidate lesson approval");
  }
}
