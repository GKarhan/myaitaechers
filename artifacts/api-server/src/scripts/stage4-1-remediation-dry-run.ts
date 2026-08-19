import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { asc } from "drizzle-orm";
import { db, lessonExercisesTable } from "@workspace/db";
import { resolveLearnerExerciseContent } from "../lib/exercise-content-boundary.js";
import { deriveStage41Remediation } from "../lib/stage4-1-remediation.js";

function quote(value: unknown): string {
  return value == null || value === "" ? "—" : String(value).replaceAll("\n", " ⏎ ");
}

function codeBlock(value: unknown): string {
  return value == null || value === ""
    ? "_empty_"
    : `\`\`\`text\n${String(value)}\n\`\`\``;
}

const rows = await db
  .select()
  .from(lessonExercisesTable)
  .orderBy(asc(lessonExercisesTable.id));

const records = rows.map((row) => {
  const currentBoundary = resolveLearnerExerciseContent(row);
  const remediation = deriveStage41Remediation(row);
  const afterBoundary = remediation
    ? resolveLearnerExerciseContent({ ...row, exerciseTextEdited: remediation.learnerTextAfter })
    : null;
  if (remediation && !afterBoundary?.ok) {
    throw new Error(`Refusing dry-run proposal for ${row.exerciseId}: proposed learner text is unsafe.`);
  }

  const classifications: string[] = [];
  if (remediation) {
    classifications.push("SAFE_REMEDIATION_PROVABLE");
  } else if (!currentBoundary.ok || currentBoundary.source === "validated_verbatim_fallback") {
    classifications.push("REVIEW_REQUIRED_CONTENT");
  } else {
    classifications.push("SAFE_NO_CHANGE");
  }

  if (!row.interactionType) classifications.push("REVIEW_REQUIRED_EVALUATION");
  if (
    row.sourcePage == null ||
    row.sourceText == null ||
    row.sourceBlockIndex == null ||
    row.sourceType === "manual"
  ) {
    classifications.push("REVIEW_REQUIRED_PROVENANCE");
  }

  return { row, currentBoundary, remediation, afterBoundary, classifications };
});

const count = (classification: string) =>
  records.filter((record) => record.classifications.includes(classification)).length;
const writes = records.filter((record) => record.remediation);

const overview = [
  "# Stage 4.1 — Existing Exercise Remediation Dry Run",
  "",
  "Generated read-only from the current development database. **No database rows were modified.**",
  "",
  "## Summary",
  "",
  `- TOTAL: ${records.length}`,
  `- SAFE_NO_CHANGE: ${count("SAFE_NO_CHANGE")}`,
  `- SAFE_REMEDIATION_PROVABLE: ${count("SAFE_REMEDIATION_PROVABLE")}`,
  `- REVIEW_REQUIRED_CONTENT: ${count("REVIEW_REQUIRED_CONTENT")}`,
  `- REVIEW_REQUIRED_EVALUATION: ${count("REVIEW_REQUIRED_EVALUATION")}`,
  `- REVIEW_REQUIRED_PROVENANCE: ${count("REVIEW_REQUIRED_PROVENANCE")}`,
  "",
  "Review classifications overlap: a row can have a provable learner-text repair while still requiring evaluation or provenance review. Only the two rows in SAFE_REMEDIATION_PROVABLE are authorized for a field-level write.",
  "",
  "## Row index",
  "",
  "| DB id | Exercise ID | Lesson | MicroNode | Current learner-safety state | Classification | Write authorized |",
  "|---:|---|---:|---:|---|---|---|",
  ...records.map(({ row, currentBoundary, classifications, remediation }) =>
    `| ${row.id} | ${row.exerciseId} | ${row.lessonId} | ${row.relatedNodeId ?? "—"} | ${currentBoundary.ok ? currentBoundary.source : `blocked: ${currentBoundary.issues.map((issue) => issue.code).join(", ")}`} | ${classifications.join("<br>")} | ${remediation ? "YES — edited text only" : "NO"} |`,
  ),
  "",
  "## Per-row evidence and proposal",
];

for (const { row, currentBoundary, remediation, afterBoundary, classifications } of records) {
  overview.push(
    "",
    `### ${row.exerciseId} (DB ${row.id})`,
    "",
    `- Lesson: ${row.lessonId}; related MicroNode: ${row.relatedNodeId ?? "missing"}`,
    `- Current Stage-4 safety: ${currentBoundary.ok ? `${currentBoundary.source}${currentBoundary.reviewWarnings.length ? ` (${currentBoundary.reviewWarnings.join(", ")})` : ""}` : `BLOCKED (${currentBoundary.issues.map((issue) => issue.code).join(", ")})`}`,
    `- Classification: ${classifications.join(", ")}`,
    `- Write authorized: ${remediation ? "YES" : "NO"}`,
    "",
    "**Current source-fidelity text (`exerciseTextVerbatim`)**",
    codeBlock(row.exerciseTextVerbatim),
    "",
    "**Current learner text (`exerciseTextEdited`)**",
    codeBlock(row.exerciseTextEdited),
    "",
    "**Current hidden evaluator metadata**",
    `- successCriteria: ${codeBlock(row.successCriteria)}`,
    `- correctAnswer: ${codeBlock(row.correctAnswer)}`,
    `- interactionType: ${quote(row.interactionType)}`,
    "",
    "**Current provenance**",
    `- sourcePage: ${quote(row.sourcePage)}`,
    `- sourceText: ${codeBlock(row.sourceText)}`,
    `- sourceBlockIndex: ${quote(row.sourceBlockIndex)}`,
    `- sourceType/status: ${quote(row.sourceType)} / ${quote(row.status)}`,
  );

  if (remediation) {
    overview.push(
      "",
      "**Proposed deterministic change**",
      "- Field: `exerciseTextEdited` only",
      "- BEFORE:",
      codeBlock(row.exerciseTextEdited),
      "- AFTER:",
      codeBlock(remediation.learnerTextAfter),
      `- Authority: ${remediation.authority}`,
      `- Validator result: ${afterBoundary?.ok ? `PASS (${afterBoundary.source})` : "FAIL"}`,
      "- Unchanged: source-fidelity text, successCriteria, correctAnswer, interactionType, identity, lesson, and MicroNode relation.",
    );
  } else {
    const unresolved = [
      classifications.includes("REVIEW_REQUIRED_CONTENT")
        ? "A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text."
        : null,
      classifications.includes("REVIEW_REQUIRED_EVALUATION")
        ? "Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence."
        : null,
      classifications.includes("REVIEW_REQUIRED_PROVENANCE")
        ? "No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged."
        : null,
    ].filter((item): item is string => item !== null);
    overview.push("", "**Unresolved issues**", ...unresolved.map((item) => `- ${item}`));
  }
}

const reviewRows = records.filter((record) =>
  record.classifications.some((classification) => classification.startsWith("REVIEW_REQUIRED_")),
);
const reviewReport = [
  "# Stage 4.1 — Human Review Required",
  "",
  "Generated from the Stage 4.1 dry run. These entries are **not authorized for automatic rewrites** outside explicitly proposed field changes.",
  "",
  `- Rows requiring one or more reviews: ${reviewRows.length}`,
  "",
  ...reviewRows.flatMap(({ row, classifications }) => [
    `## ${row.exerciseId} (DB ${row.id})`,
    `- Lesson: ${row.lessonId}; MicroNode: ${row.relatedNodeId ?? "missing"}`,
    `- Review classifications: ${classifications.filter((item) => item.startsWith("REVIEW_REQUIRED_")).join(", ")}`,
    `- Current source text: ${quote(row.exerciseTextVerbatim)}`,
    `- Current learner text: ${quote(row.exerciseTextEdited)}`,
    `- Hidden metadata: successCriteria=${quote(row.successCriteria)}; correctAnswer=${quote(row.correctAnswer)}; interactionType=${quote(row.interactionType)}`,
    `- Teacher/content-editor decision: ${classifications.includes("REVIEW_REQUIRED_CONTENT") ? "Approve or author a learner-only task representation without hidden answer/rubric language." : "No learner-text decision needed."} ${classifications.includes("REVIEW_REQUIRED_EVALUATION") ? "Establish interaction/evaluation metadata from authoritative source material." : ""} ${classifications.includes("REVIEW_REQUIRED_PROVENANCE") ? "Provide or confirm exact source page, source block text, and block index; do not guess." : ""}`.trim(),
    "",
  ]),
];

const reportsDir = resolve(process.cwd(), "../../reports");
await mkdir(reportsDir, { recursive: true });
await writeFile(resolve(reportsDir, "stage4-1-remediation-dry-run.md"), overview.join("\n"), "utf8");
await writeFile(resolve(reportsDir, "stage4-1-review-required.md"), reviewReport.join("\n"), "utf8");

console.log(JSON.stringify({
  total: records.length,
  safeNoChange: count("SAFE_NO_CHANGE"),
  safeRemediationProvable: count("SAFE_REMEDIATION_PROVABLE"),
  reviewRequiredContent: count("REVIEW_REQUIRED_CONTENT"),
  reviewRequiredEvaluation: count("REVIEW_REQUIRED_EVALUATION"),
  reviewRequiredProvenance: count("REVIEW_REQUIRED_PROVENANCE"),
  authorizedWriteIds: writes.map((record) => record.row.id),
}, null, 2));