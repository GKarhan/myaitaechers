import { db, lessonsTable, lessonOutcomesTable } from "@workspace/db";

/** New teacher input is authoritative draft content, not a legacy backfill. */
export function parseAuthoredOutcomes(value: unknown):
  | { valid: true; outcomes: string[] }
  | { valid: false; error: string } {
  if (value === undefined) return { valid: true, outcomes: [] };
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    return { valid: false, error: "lessonOutcomes must be an array of strings" };
  }
  return { valid: true, outcomes: [...new Set(value.map(item => item.trim()).filter(Boolean))] };
}

export async function createTeacherAuthoredLesson(values: typeof lessonsTable.$inferInsert, database: Pick<typeof db, "transaction"> = db) {
  const parsed = parseAuthoredOutcomes(values.lessonOutcomes);
  if (!parsed.valid) throw new Error(parsed.error);
  const outcomes = parsed.outcomes;
  // Both create endpoints commit the lesson and canonical outcomes together.
  // A failed outcome insert must never leave a goal-only lesson behind.
  return database.transaction(async tx => {
    const [lesson] = await tx.insert(lessonsTable).values({
      ...values,
      ...(values.lessonOutcomes !== undefined && { lessonOutcomes: outcomes }),
      ...(values.lessonGoal?.trim() || outcomes.length ? { goalOutcomeReviewStatus: "draft" } : {}),
    }).returning();
    if (outcomes.length) {
      await tx.insert(lessonOutcomesTable).values(outcomes.map((outcomeText, index) => ({
        lessonId: lesson.id,
        outcomeText,
        sequence: index + 1,
        status: "draft",
        provenance: "teacher_authored",
      })));
    }
    return lesson;
  });
}
