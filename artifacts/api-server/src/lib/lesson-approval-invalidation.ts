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
 * This is a silent no-op when the lesson is neither approved nor active, or when
 * everApproved=true.
 * Never throws — failures are logged but do not roll back the authoring change.
 */
import { db, lessonsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "./logger.js";

export async function invalidateLessonApproval(lessonId: number): Promise<void> {
  try {
    // An explicit missing-content override is deliberately non-sticky
    // (everApproved=false). It may already have been activated for students, so
    // editing it must also remove the active/deliverable state. Once a lesson is
    // normally approved (everApproved=true), teacher edits remain authoritative.
    await db
      .update(lessonsTable)
      .set({ status: "needs_review" })
      .where(
        and(
          eq(lessonsTable.id, lessonId),
          inArray(lessonsTable.status, ["approved", "active"]),
          eq(lessonsTable.everApproved, false),
        )
      );
  } catch (err) {
    // Log but never propagate — the authoring change already committed.
    logger.error({ err, lessonId }, "P1.7: failed to invalidate lesson approval");
  }
}
