/**
 * Package 1C — Goal/Outcome confirmation gate persistence regression.
 *
 * Run with:
 *   DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @workspace/api-server run test:c1-review-workflow
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import {
  lessonNodesTable,
  lessonNodeCognitiveLevelsTable,
  lessonOutcomeNodeAlignmentsTable,
  lessonOutcomesTable,
  lessonExercisesTable,
  lessonTopicsTable,
  lessonsTable,
  subjectsTable,
  usersTable,
} from "@workspace/db";
import { validateLessonForFinalApproval } from "../lesson-final-approval.js";
import { assertTestDb, closeTestDb, getTestDb } from "./helpers/test-db.js";

assertTestDb();
const db = getTestDb();
const runId = `c1-review-${Date.now()}`;
let subjectId = 0;
let lessonId = 0;
let proposalLessonId = 0;
let teacherId = 0;
let server: import("node:http").Server | undefined;

try {
  const [subject] = await db.insert(subjectsTable).values({ name: `${runId}-subject` })
    .returning({ id: subjectsTable.id });
  subjectId = subject.id;
  const [teacher] = await db.insert(usersTable).values({
    username: `${runId}-teacher`,
    passwordHash: "test-only",
    fullName: "C1 Review Teacher",
    role: "teacher",
  }).returning({ id: usersTable.id });
  teacherId = teacher.id;
  const [lesson] = await db.insert(lessonsTable).values({
    subjectId,
    title: `${runId}-lesson`,
    lessonGoal: "Սովորողը կկիրառի կանոնը։",
    teacherId,
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
  const reviewRequired = await validateLessonForFinalApproval(lessonId);
  assert.equal(
    reviewRequired.overrideable.some((issue) => issue.code === "GOAL_OUTCOME_REVIEW_REQUIRED"),
    true,
    "non-legacy, unconfirmed review state becomes an explicit assignment review finding",
  );

  await db.update(lessonsTable).set({
    goalOutcomeReviewStatus: "confirmed",
    goalOutcomeConfirmedAt: new Date(),
  }).where(eq(lessonsTable.id, lessonId));
  const confirmed = await validateLessonForFinalApproval(lessonId);
  assert.equal(
    confirmed.overrideable.some((issue) => issue.code === "GOAL_OUTCOME_REVIEW_REQUIRED"),
    false,
    "the legacy confirmation endpoint remains compatible without changing canonical data",
  );

  const [[persistedNode], [persistedOutcome]] = await Promise.all([
    db.select({ id: lessonNodesTable.id, theoryContent: lessonNodesTable.theoryContent })
      .from(lessonNodesTable).where(eq(lessonNodesTable.id, node.id)),
    db.select({ id: lessonOutcomesTable.id, outcomeText: lessonOutcomesTable.outcomeText })
      .from(lessonOutcomesTable).where(eq(lessonOutcomesTable.id, outcome.id)),
  ]);
  assert.equal(persistedNode.theoryContent, "Պահպանվող աղբյուրային բովանդակություն");
  assert.equal(persistedOutcome.outcomeText, "Սովորողը կարող է կիրառել կանոնը։");
  console.log("  ✓ Goal/Outcome review remains auditable without blocking mapping or duplicating data");

  // Provider-free acceptance coverage: proposal generation itself has a source/AI
  // dependency, so seed the exact persisted proposal returned by that route and
  // exercise every teacher-controlled route that follows it.
  const proposalGoal = "Սովորողը կբացատրի և կկիրառի աղբյուրային կանոնները։";
  const proposalOutcomes = [
    "Սովորողը կճանաչի հիմնական հասկացությունները։",
    "Սովորողը կբացատրի կանոնի քայլերը։",
    "Սովորողը կկիրառի կանոնը պարզ օրինակում։",
    "Սովորողը կտարբերի ճիշտ և սխալ կիրառումները։",
    "Սովորողը կստուգի իր լուծման հիմնավորումը։",
  ];
  const [proposalLesson] = await db.insert(lessonsTable).values({
    subjectId,
    teacherId,
    title: `${runId}-proposal-lesson`,
    goalOutcomeProposal: {
      lessonGoal: proposalGoal,
      outcomes: proposalOutcomes,
      generatedAt: new Date().toISOString(),
      source: "textbook_pages",
    },
    goalOutcomeReviewStatus: "proposed",
  }).returning({ id: lessonsTable.id });
  proposalLessonId = proposalLesson.id;

  const appModule = await import("../../app.js");
  const authModule = await import("../../middlewares/auth.js");
  server = appModule.default.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/api/lessons/${proposalLessonId}`;
  const token = authModule.signToken(teacherId, "teacher");
  const requestForLesson = async (targetLessonId: number, path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/lessons/${targetLessonId}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    return { response, body: await response.json() as Record<string, unknown> };
  };
  const request = (path: string, init: RequestInit = {}) => requestForLesson(proposalLessonId, path, init);

  const [goalOnlyLesson] = await db.insert(lessonsTable).values({
    subjectId,
    teacherId,
    title: `${runId}-goal-only-lesson`,
    lessonGoal: "Սովորողը կձևակերպի նպատակային գաղափարը։",
    goalOutcomeReviewStatus: "draft",
  }).returning({ id: lessonsTable.id });
  const goalOnlyReview = await requestForLesson(goalOnlyLesson.id, "/goal-outcome-review");
  assert.equal(goalOnlyReview.response.status, 200);
  assert.equal(goalOnlyReview.body.draftVersion, "0", "a goal-only draft starts at revision zero");
  const firstOutcomeSave = await requestForLesson(goalOnlyLesson.id, "/goal-outcome-review/draft", {
    method: "POST",
    body: JSON.stringify({
      lessonGoal: goalOnlyReview.body.lessonGoal,
      draftVersion: goalOnlyReview.body.draftVersion,
      outcomes: [{ outcomeText: "Սովորողը կբացատրի նպատակային գաղափարը։" }],
    }),
  });
  assert.equal(firstOutcomeSave.response.status, 200, "revision zero accepts the first Outcome in a goal-only draft");
  const goalOnlyReadBack = await requestForLesson(goalOnlyLesson.id, "/goal-outcome-review");
  assert.deepEqual(goalOnlyReadBack.body.outcomes, ["Սովորողը կբացատրի նպատակային գաղափարը։"]);

  const imported = await request("/goal-outcome-review/apply-proposal", { method: "POST" });
  assert.equal(imported.response.status, 200, "a complete source proposal imports into canonical drafts");
  assert.equal(imported.body.createdCount, proposalOutcomes.length);
  assert.equal(imported.body.status, "draft");
  assert.deepEqual(imported.body.outcomes, proposalOutcomes, "import responds with the verified canonical outcome set");
  const [importedLesson] = await db.select({
    lessonGoal: lessonsTable.lessonGoal,
    status: lessonsTable.goalOutcomeReviewStatus,
  }).from(lessonsTable).where(eq(lessonsTable.id, proposalLessonId));
  const importedOutcomes = await db.select({
    outcomeText: lessonOutcomesTable.outcomeText,
    status: lessonOutcomesTable.status,
  }).from(lessonOutcomesTable)
    .where(eq(lessonOutcomesTable.lessonId, proposalLessonId))
    .orderBy(lessonOutcomesTable.sequence);
  assert.equal(importedLesson.lessonGoal, proposalGoal);
  assert.equal(importedLesson.status, "draft");
  assert.deepEqual(importedOutcomes.map((outcome) => outcome.outcomeText), proposalOutcomes);
  assert.equal(importedOutcomes.every((outcome) => outcome.status === "draft"), true);

  const importedReview = await request("/goal-outcome-review");
  assert.equal(importedReview.response.status, 200);
  assert.equal(
    importedReview.body.hasUsableCurrentDraft,
    true,
    "the review endpoint marks an imported goal/outcome set as the active working draft",
  );
  assert.equal(importedReview.body.currentOutcomeCount, proposalOutcomes.length);
  assert.deepEqual(importedReview.body.outcomes, proposalOutcomes, "refresh reads back every canonical outcome in order");
  const importedOutcomeRecords = importedReview.body.outcomeRecords as Array<{ id: number; outcomeText: string }>;
  assert.equal(importedOutcomeRecords.length, proposalOutcomes.length, "the primary editor receives every canonical Outcome id and text");
  assert.equal(typeof importedReview.body.draftVersion, "string", "the primary editor receives a canonical draft revision");

  const blockedProposal = await request("/goal-outcome-review/proposal", { method: "POST" });
  assert.equal(blockedProposal.response.status, 409);
  assert.equal(
    blockedProposal.body.error,
    "CANONICAL_DRAFT_EXISTS",
    "source AI cannot replace a usable imported working draft",
  );

  const repeatedImport = await request("/goal-outcome-review/apply-proposal", { method: "POST" });
  assert.equal(repeatedImport.response.status, 200, "the unchanged import is idempotent");
  assert.equal(repeatedImport.body.createdCount, 0);

  const editedGoal = `${proposalGoal} (խմբագրված)`;
  const editedOutcomeTexts = proposalOutcomes.map((outcome, index) => (
    index < 2 ? `${outcome} (խմբագրված)` : outcome
  ));
  const addedOutcomeText = "Սովորողը կձևակերպի լրացուցիչ սեփական օրինակ։";
  const combinedEdit = await request("/goal-outcome-review/draft", {
    method: "POST",
    body: JSON.stringify({
      lessonGoal: editedGoal,
      draftVersion: importedReview.body.draftVersion,
      outcomes: [
        ...importedOutcomeRecords.map((outcome, index) => ({
          id: outcome.id,
          outcomeText: editedOutcomeTexts[index],
        })),
        { outcomeText: addedOutcomeText },
      ],
    }),
  });
  assert.equal(combinedEdit.response.status, 200, "Goal and the complete Outcome set save in one request");
  assert.deepEqual(
    combinedEdit.body.outcomes,
    [...editedOutcomeTexts, addedOutcomeText],
    "the combined save reports its verified canonical Outcome set",
  );
  const goalReadBack = await request("/goal-outcome-review");
  assert.equal(goalReadBack.body.lessonGoal, editedGoal, "manual Goal edits read back from the canonical lesson record");
  assert.deepEqual(
    goalReadBack.body.outcomes,
    [...editedOutcomeTexts, addedOutcomeText],
    "two edited Outcomes and one added Outcome read back through the primary Goal/Outcome endpoint",
  );
  assert.equal(
    (goalReadBack.body.outcomeRecords as Array<{ id: number; outcomeText: string }>).length,
    proposalOutcomes.length + 1,
    "the refreshed edit surface receives the whole canonical Outcome set",
  );
  const [persistedProposalOutcome] = await db.select({ id: lessonOutcomesTable.id })
    .from(lessonOutcomesTable)
    .where(eq(lessonOutcomesTable.lessonId, proposalLessonId))
    .orderBy(lessonOutcomesTable.sequence)
    .limit(1);
  const approvedStatusAttempt = await request(`/outcomes/${persistedProposalOutcome.id}/update`, {
    method: "POST",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(approvedStatusAttempt.response.status, 409, "an Outcome status cannot bypass confirmation");

  const editedOutcomeText = `${editedOutcomeTexts[0]} (առանձին խմբագրված)`;
  const editedOutcome = await request(`/outcomes/${persistedProposalOutcome.id}/update`, {
    method: "POST",
    body: JSON.stringify({ outcomeText: editedOutcomeText }),
  });
  assert.equal(editedOutcome.response.status, 200);
  const editedReview = await request("/goal-outcome-review");
  assert.equal((editedReview.body.outcomes as string[])[0], editedOutcomeText, "manual outcome edits read back through the primary Goal/Outcome endpoint");

  const mappingBeforeConfirmation = await request("/map", { method: "POST" });
  assert.notEqual(mappingBeforeConfirmation.body.error, "GOAL_OUTCOME_CONFIRMATION_REQUIRED");

  const preMappingReadiness = await request("/outcomes/readiness");
  assert.equal(preMappingReadiness.response.status, 200);
  assert.equal(
    (preMappingReadiness.body.errors as Array<{ code: string }>).some((issue) => issue.code === "OUTCOME_WITHOUT_REQUIRED_NODE"),
    false,
    "zero MicroNodes cannot block pre-mapping confirmation",
  );

  const confirmedReview = await request("/goal-outcome-review/confirm", { method: "POST" });
  assert.equal(confirmedReview.response.status, 200, "Goal plus canonical Outcomes can be confirmed without MicroNodes");
  const [confirmedLesson] = await db.select({
    status: lessonsTable.goalOutcomeReviewStatus,
    confirmedAt: lessonsTable.goalOutcomeConfirmedAt,
  }).from(lessonsTable).where(eq(lessonsTable.id, proposalLessonId));
  assert.equal(confirmedLesson.status, "confirmed");
  assert.ok(confirmedLesson.confirmedAt);
  const confirmedOutcomes = await db.select({ status: lessonOutcomesTable.status })
    .from(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId, proposalLessonId));
  assert.equal(confirmedOutcomes.every((outcome) => outcome.status === "approved"), true);

  const [preservedTopic] = await db.insert(lessonTopicsTable).values({
    lessonId: proposalLessonId,
    title: `${runId}-preserved-topic`,
    sequence: 1,
  }).returning({ id: lessonTopicsTable.id });
  const [postMappingNode] = await db.insert(lessonNodesTable).values({
    lessonId: proposalLessonId,
    sequence: 1,
    title: `${runId}-post-mapping-node`,
    topicId: preservedTopic.id,
    status: "draft",
    cogPathStatus: "confirmed",
    theoryContent: "Պահպանվող տեսություն",
    childFriendlyExplanation: "Պահպանվող պարզ բացատրություն",
    commonMisconception: "Պահպանվող սխալ պատկերացում",
    basicExamples: [{ example: "Պահպանվող օրինակ" }],
    nonExamples: [{ nonExample: "Պահպանվող հակաօրինակ" }],
  }).returning({ id: lessonNodesTable.id });
  await db.insert(lessonNodeCognitiveLevelsTable).values({
    lessonNodeId: postMappingNode.id,
    cognitiveLevel: "understand",
    sequence: 1,
    isTargetCeiling: true,
    provenance: "teacher_authored",
  });
  const staleReview = await request("/goal-outcome-review");
  const staleOutcomeRecords = staleReview.body.outcomeRecords as Array<{
    id: number;
    outcomeText: string;
  }>;
  const concurrentlyAddedOutcomeText = "Սովորողը կպահպանի նոր խմբագրված վերջնարդյունքը։";
  const currentEditorSave = await request("/goal-outcome-review/draft", {
    method: "POST",
    body: JSON.stringify({
      lessonGoal: editedGoal,
      draftVersion: staleReview.body.draftVersion,
      outcomes: [
        ...staleOutcomeRecords.map((outcome) => ({ id: outcome.id, outcomeText: outcome.outcomeText })),
        { outcomeText: concurrentlyAddedOutcomeText },
      ],
    }),
  });
  assert.equal(currentEditorSave.response.status, 200, "a current edit surface can add a new Outcome");
  const currentReview = await request("/goal-outcome-review");
  const currentOutcomeRecords = currentReview.body.outcomeRecords as Array<{
    id: number;
    outcomeText: string;
  }>;
  const removableOutcome = currentOutcomeRecords.find((outcome) => outcome.outcomeText === concurrentlyAddedOutcomeText)!;
  await db.insert(lessonOutcomeNodeAlignmentsTable).values({
    lessonId: proposalLessonId,
    lessonOutcomeId: removableOutcome.id,
    lessonNodeId: postMappingNode.id,
    role: "SUPPORTING",
    requiredCognitiveDepth: "understand",
  });
  const staleEditorSave = await request("/goal-outcome-review/draft", {
    method: "POST",
    body: JSON.stringify({
      lessonGoal: editedGoal,
      draftVersion: staleReview.body.draftVersion,
      outcomes: staleOutcomeRecords.map((outcome) => ({ id: outcome.id, outcomeText: outcome.outcomeText })),
    }),
  });
  assert.equal(staleEditorSave.response.status, 409, "a stale editor cannot remove a concurrently added Outcome");
  assert.equal(staleEditorSave.body.error, "GOAL_OUTCOME_DRAFT_STALE");
  const alignmentAfterStaleSave = await db.select({ id: lessonOutcomeNodeAlignmentsTable.id })
    .from(lessonOutcomeNodeAlignmentsTable)
    .where(eq(lessonOutcomeNodeAlignmentsTable.lessonOutcomeId, removableOutcome.id));
  assert.equal(alignmentAfterStaleSave.length, 1, "a stale save preserves the newer Outcome→MicroNode relation");
  const removeOutcomeInCombinedEdit = await request("/goal-outcome-review/draft", {
    method: "POST",
    body: JSON.stringify({
      lessonGoal: editedGoal,
      draftVersion: currentReview.body.draftVersion,
      outcomes: currentOutcomeRecords
        .filter((outcome) => outcome.id !== removableOutcome.id)
        .map((outcome) => ({ id: outcome.id, outcomeText: outcome.outcomeText })),
    }),
  });
  assert.equal(removeOutcomeInCombinedEdit.response.status, 200, "removing an Outcome succeeds in the combined edit flow");
  const alignmentAfterRemoval = await db.select({ id: lessonOutcomeNodeAlignmentsTable.id })
    .from(lessonOutcomeNodeAlignmentsTable)
    .where(eq(lessonOutcomeNodeAlignmentsTable.lessonOutcomeId, removableOutcome.id));
  assert.equal(alignmentAfterRemoval.length, 0, "removing an Outcome cleans up its Outcome→MicroNode relations");
  const removalReadBack = await request("/goal-outcome-review");
  assert.equal(
    (removalReadBack.body.outcomes as string[]).includes(removableOutcome.outcomeText),
    false,
    "refresh does not show the removed canonical Outcome",
  );
  const [preservedExercise] = await db.insert(lessonExercisesTable).values({
    lessonId: proposalLessonId,
    exerciseId: `${runId}-preserved-exercise`,
    relatedNodeId: postMappingNode.id,
    exerciseTextVerbatim: "Պահպանվող վարժություն",
    sequence: 1,
    sourceType: "teacher",
  }).returning({ id: lessonExercisesTable.id });
  const postMappingReadiness = await request("/outcomes/readiness");
  assert.equal(
    (postMappingReadiness.body.warnings as Array<{ code: string }>).filter((issue) => issue.code === "OUTCOME_WITHOUT_REQUIRED_NODE").length,
    proposalOutcomes.length + 1,
    "required MicroNode coverage remains a post-mapping readiness rule",
  );
  const finalApprovalReadiness = await validateLessonForFinalApproval(proposalLessonId);
  assert.equal(
    finalApprovalReadiness.overrideable.filter((issue) => issue.code === "OUTCOME_WITHOUT_REQUIRED_NODE").length,
    proposalOutcomes.length + 1,
    "missing REQUIRED Outcome coverage is accepted only through the final assignment review",
  );

  await db.insert(lessonOutcomeNodeAlignmentsTable).values({
    lessonId: proposalLessonId,
    lessonOutcomeId: persistedProposalOutcome.id,
    lessonNodeId: postMappingNode.id,
    role: "REQUIRED",
    requiredCognitiveDepth: "remember",
  });
  const deletedDraft = await request("/goal-outcome-review/delete", { method: "POST" });
  assert.equal(deletedDraft.response.status, 200);
  assert.equal(deletedDraft.body.deleted, true);
  assert.equal(deletedDraft.body.deletedOutcomeCount, proposalOutcomes.length + 1);
  const [[deletedLesson], remainingOutcomes, remainingAlignments, remainingTopics, remainingNodes, remainingLevels, remainingExercises] = await Promise.all([
    db.select({ lessonGoal: lessonsTable.lessonGoal, proposal: lessonsTable.goalOutcomeProposal })
      .from(lessonsTable).where(eq(lessonsTable.id, proposalLessonId)),
    db.select({ id: lessonOutcomesTable.id }).from(lessonOutcomesTable)
      .where(eq(lessonOutcomesTable.lessonId, proposalLessonId)),
    db.select({ id: lessonOutcomeNodeAlignmentsTable.id }).from(lessonOutcomeNodeAlignmentsTable)
      .where(eq(lessonOutcomeNodeAlignmentsTable.lessonId, proposalLessonId)),
    db.select({ id: lessonTopicsTable.id }).from(lessonTopicsTable)
      .where(eq(lessonTopicsTable.lessonId, proposalLessonId)),
    db.select({
      id: lessonNodesTable.id,
      theoryContent: lessonNodesTable.theoryContent,
      childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
    }).from(lessonNodesTable)
      .where(eq(lessonNodesTable.lessonId, proposalLessonId)),
    db.select({ id: lessonNodeCognitiveLevelsTable.id }).from(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, postMappingNode.id)),
    db.select({ id: lessonExercisesTable.id }).from(lessonExercisesTable)
      .where(eq(lessonExercisesTable.id, preservedExercise.id)),
  ]);
  assert.equal(deletedLesson.lessonGoal, null);
  assert.equal(deletedLesson.proposal, null);
  assert.equal(remainingOutcomes.length, 0);
  assert.equal(remainingAlignments.length, 0, "deleting the draft leaves no orphan Outcome→MicroNode relations");
  assert.equal(remainingTopics.length, 1, "deleting a Goal/Outcome draft preserves lesson Topics");
  assert.equal(remainingNodes.length, 1, "deleting a Goal/Outcome draft preserves lesson MicroNodes");
  assert.equal(remainingNodes[0].theoryContent, "Պահպանվող տեսություն", "Teaching Content remains untouched");
  assert.equal(remainingNodes[0].childFriendlyExplanation, "Պահպանվող պարզ բացատրություն", "Teaching Content explanation remains untouched");
  assert.equal(remainingLevels.length, 1, "deleting a Goal/Outcome draft preserves Cognitive Paths");
  assert.equal(remainingExercises.length, 1, "deleting a Goal/Outcome draft preserves exercises");
  const deletedReview = await request("/goal-outcome-review");
  assert.equal(deletedReview.body.hasUsableCurrentDraft, false);
  assert.deepEqual(deletedReview.body.outcomes, []);
  console.log("  ✓ Goal/Outcome import, read-back, edits, and safe full-draft deletion use the simplified workflow");
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  if (lessonId) await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId)).catch(() => {});
  if (proposalLessonId) await db.delete(lessonsTable).where(eq(lessonsTable.id, proposalLessonId)).catch(() => {});
  if (subjectId) await db.delete(subjectsTable).where(eq(subjectsTable.id, subjectId)).catch(() => {});
  if (teacherId) await db.delete(usersTable).where(eq(usersTable.id, teacherId)).catch(() => {});
  await closeTestDb();
}