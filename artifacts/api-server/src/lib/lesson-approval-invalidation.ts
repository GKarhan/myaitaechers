/**
 * P1.7 — Approval Invalidation Helper
 *
 * When a lesson is "approved" and a teacher makes a meaningful authoring change,
 * the lesson must revert to "needs_review" — the teacher must run Final Approval again.
 *
 * POST-P1.12 AUTHORING SIMPLIFICATION:
 * Once a lesson has ever passed Final Approval (everApproved=true), ordinary teacher
 * edits must NOT revert the lesson to needs_review.  Teacher is the final authority
 * after the initial quality gate.
 *
 * Usage: call `await invalidateLessonApproval(lessonId)` immediately after any
 * persisted authoring change in lessons.ts and teacher.ts routes.
 *
 * This is a silent no-op when the lesson is not approved OR when everApproved=true.
 * Never throws — failures are logged but do not roll back the authoring change.
 */
import { db, lessonsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger.js";

export async function invalidateLessonApproval(lessonId: number): Promise<void> {
  try {
    // Only invalidate lessons that are currently "approved" AND have never been
    // approved before (everApproved=false).  Once a lesson is everApproved, teacher
    // edits are authoritative and must not trigger re-approval workflow.
    await db
      .update(lessonsTable)
      .set({ status: "needs_review" })
      .where(
        and(
          eq(lessonsTable.id, lessonId),
          eq(lessonsTable.status, "approved"),
          eq(lessonsTable.everApproved, false),
        )
      );
  } catch (err) {
    // Log but never propagate — the authoring change already committed.
    logger.error({ err, lessonId }, "P1.7: failed to invalidate lesson approval");
  }
}
