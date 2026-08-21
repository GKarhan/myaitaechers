/**
 * Package 1C — Goal/Outcome confirmation gate persistence regression.
 *
 * Run with:
 *   DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @workspace/api-server run test:c1-review-workflow
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  lessonNodesTable,
  lessonOutcomesTable,
  lessonsTable,
  subjectsTable,
} from "@workspace/db";
import { validateLessonForFinalApproval } from "../lesson-final-approval.js";
import { assertTestDb, closeTestDb, getTestDb } from "./helpers/test-db.js";

assertTestDb();
const db = getTestDb();
const runId = `c1-review-${Date.now()}`;
let subjectId = 0;
let lessonId = 0;

try {
  const [subject] = await db.insert(subjectsTable).values({ name: `${runId}-subject` })
    .returning({ id: subjectsTable.id });
  subjectId = subject.id;
  const [lesson] = await db.insert(lessonsTable).values({
    subjectId,
    title: `${runId}-lesson`,
    lessonGoal: "Սովորողը կկիրառի կանոնը։",
  }).returning({ id: lessonsTable.id });
  lessonId = lesson.id;
  const [node] = await db.insert(lessonNodesTable).values({
    lessonId,
    sequence: 1,
    title: `${runId}-node`,
    status: "draft",
    theoryContent: "Պահպանվող աղբյուրային բովանդակություն",
  }).returning({ id: lessonNodesTable.id });
  const [outcome] = await db.insert(lessonOutcomesTable).values({
    lessonId,
    outcomeText: "Սովորողը կարող է կիրառել կանոնը։",
    sequence: 1,
    status: "draft",
    provenance: "teacher_authored",
  }).returning({ id: lessonOutcomesTable.id });

  const [defaultState] = await db.select({
    status: lessonsTable.goalOutcomeReviewStatus,
  }).from(lessonsTable).where(eq(lessonsTable.id, lessonId));
  assert.equal(defaultState.status, "legacy", "existing lessons default to legacy compatibility");

  await db.update(lessonsTable).set({ goalOutcomeReviewStatus: "needs_review" })
    .where(eq(lessonsTable.id, lessonId));
  const blocked = await validateLessonForFinalApproval(lessonId);
  assert.equal(
    blocked.errors.some((issue) => issue.code === "GOAL_OUTCOME_CONFIRMATION_REQUIRED"),
    true,
    "non-legacy, unconfirmed review state blocks final approval",
  );

  await db.update(lessonsTable).set({
    goalOutcomeReviewStatus: "confirmed",
    goalOutcomeConfirmedAt: new Date(),
  }).where(eq(lessonsTable.id, lessonId));
  const confirmed = await validateLessonForFinalApproval(lessonId);
  assert.equal(
    confirmed.errors.some((issue) => issue.code === "GOAL_OUTCOME_CONFIRMATION_REQUIRED"),
    false,
    "explicit confirmation clears only the Goal/Outcome confirmation gate",
  );

  const [[persistedNode], [persistedOutcome]] = await Promise.all([
    db.select({ id: lessonNodesTable.id, theoryContent: lessonNodesTable.theoryContent })
      .from(lessonNodesTable).where(eq(lessonNodesTable.id, node.id)),
    db.select({ id: lessonOutcomesTable.id, outcomeText: lessonOutcomesTable.outcomeText })
      .from(lessonOutcomesTable).where(eq(lessonOutcomesTable.id, outcome.id)),
  ]);
  assert.equal(persistedNode.theoryContent, "Պահպանվող աղբյուրային բովանդակություն");
  assert.equal(persistedOutcome.outcomeText, "Սովորողը կարող է կիրառել կանոնը։");
  console.log("  ✓ Package 1C confirmation blocks approval without remapping or duplicating data");
} finally {
  if (lessonId) await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId)).catch(() => {});
  if (subjectId) await db.delete(subjectsTable).where(eq(subjectsTable.id, subjectId)).catch(() => {});
  await closeTestDb();
}