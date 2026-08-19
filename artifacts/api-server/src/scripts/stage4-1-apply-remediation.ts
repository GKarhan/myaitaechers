import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db, lessonExercisesTable } from "@workspace/db";
import { resolveLearnerExerciseContent } from "../lib/exercise-content-boundary.js";
import { deriveStage41Remediation } from "../lib/stage4-1-remediation.js";

const AUTHORIZED_IDS = [941, 942] as const;

const changes = await db.transaction(async (tx) => {
  const applied: Array<{
    id: number;
    exerciseId: string;
    before: string | null;
    after: string;
    authority: string;
  }> = [];

  for (const id of AUTHORIZED_IDS) {
    const [before] = await tx
      .select()
      .from(lessonExercisesTable)
      .where(eq(lessonExercisesTable.id, id))
      .limit(1);
    if (!before) throw new Error(`Stage 4.1 transaction aborted: exercise ${id} is missing.`);

    const remediation = deriveStage41Remediation(before);
    if (!remediation) {
      throw new Error(`Stage 4.1 transaction aborted: exercise ${before.exerciseId} no longer matches its audited evidence.`);
    }

    const preWriteBoundary = resolveLearnerExerciseContent({
      ...before,
      exerciseTextEdited: remediation.learnerTextAfter,
    });
    if (!preWriteBoundary.ok) {
      throw new Error(`Stage 4.1 transaction aborted: proposed learner text for ${before.exerciseId} failed validation.`);
    }

    const [after] = await tx
      .update(lessonExercisesTable)
      .set({ exerciseTextEdited: remediation.learnerTextAfter })
      .where(eq(lessonExercisesTable.id, before.id))
      .returning();
    if (!after) throw new Error(`Stage 4.1 transaction aborted: update did not return ${before.exerciseId}.`);

    const postWriteBoundary = resolveLearnerExerciseContent(after);
    const identityPreserved =
      after.id === before.id &&
      after.exerciseId === before.exerciseId &&
      after.lessonId === before.lessonId &&
      after.relatedNodeId === before.relatedNodeId;
    const hiddenMetadataPreserved =
      after.successCriteria === before.successCriteria &&
      after.correctAnswer === before.correctAnswer &&
      after.interactionType === before.interactionType;
    const sourceFidelityPreserved =
      after.exerciseTextVerbatim === before.exerciseTextVerbatim &&
      after.sourcePage === before.sourcePage &&
      after.sourceText === before.sourceText &&
      after.sourceBlockIndex === before.sourceBlockIndex &&
      after.sourceType === before.sourceType;
    if (
      !postWriteBoundary.ok ||
      after.exerciseTextEdited !== remediation.learnerTextAfter ||
      !identityPreserved ||
      !hiddenMetadataPreserved ||
      !sourceFidelityPreserved
    ) {
      throw new Error(`Stage 4.1 transaction aborted: post-write verification failed for ${before.exerciseId}.`);
    }

    applied.push({
      id: before.id,
      exerciseId: before.exerciseId,
      before: before.exerciseTextEdited,
      after: after.exerciseTextEdited!,
      authority: remediation.authority,
    });
  }

  return applied;
});

const report = [
  "# Stage 4.1 — Database Change Report",
  "",
  "## Result",
  "",
  `- Rows examined for authorized remediation: ${AUTHORIZED_IDS.length}`,
  `- Rows changed: ${changes.length}`,
  `- Rows unchanged by this write operation: 32`,
  `- Rows still requiring one or more human reviews: 34 (see stage4-1-review-required.md)`,
  "- Transaction result: COMMITTED",
  "- Schema migration: NONE",
  "",
  "## Exact mutations",
  "",
  ...changes.flatMap((change) => [
    `### ${change.exerciseId} (DB ${change.id})`,
    "",
    "- Changed field: `exerciseTextEdited` only",
    "- BEFORE:",
    "```text",
    change.before ?? "",
    "```",
    "- AFTER:",
    "```text",
    change.after,
    "```",
    `- Authority: ${change.authority}`,
    "- Validation: PASS — learner text resolves safely; hidden successCriteria/correctAnswer, source-fidelity text, provenance, identity, lesson, and MicroNode relationship were re-read and preserved in the transaction.",
    "",
  ]),
];

const reportsDir = resolve(process.cwd(), "../../reports");
await mkdir(reportsDir, { recursive: true });
await writeFile(resolve(reportsDir, "stage4-1-database-change-report.md"), report.join("\n"), "utf8");
console.log(JSON.stringify({ changed: changes }, null, 2));