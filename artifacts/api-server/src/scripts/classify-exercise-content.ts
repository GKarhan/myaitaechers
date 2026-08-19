import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db, lessonExercisesTable } from "@workspace/db";
import { asc } from "drizzle-orm";
import { resolveLearnerExerciseContent } from "../lib/exercise-content-boundary.js";

const rows = await db
  .select()
  .from(lessonExercisesTable)
  .orderBy(asc(lessonExercisesTable.id));

const classified = rows.map((row) => {
  const content = resolveLearnerExerciseContent(row);
  const provenanceIssues = [
    row.sourcePage == null ? "missing sourcePage" : null,
    row.sourceText == null ? "missing sourceText" : null,
    row.sourceBlockIndex == null ? "missing sourceBlockIndex" : null,
    row.sourceType === "manual" ? "manual provenance review" : null,
  ].filter((value): value is string => value !== null);
  const state = !content.ok
    ? "BLOCKED"
    : content.source === "validated_verbatim_fallback"
      ? "SAFE — LEGACY REVIEW"
      : "SAFE — EDITED";
  const issues = content.ok
    ? [...content.reviewWarnings, ...provenanceIssues]
    : [
        ...content.issues.map((issue) => issue.code),
        ...provenanceIssues,
      ];
  const guidance = !content.ok
    ? "Rewrite exerciseTextEdited as learner-only task wording; keep rubric/answer metadata only in hidden fields."
    : content.source === "validated_verbatim_fallback"
      ? "Persist a teacher-reviewed exerciseTextEdited value; do not copy hidden criteria into it."
      : provenanceIssues.length > 0
        ? "Learner text is safe; review the listed provenance gaps without rewriting source material."
        : "No content-boundary action required.";
  return { row, state, issues, guidance };
});

const blocked = classified.filter((item) => item.state === "BLOCKED").length;
const legacy = classified.filter((item) => item.state === "SAFE — LEGACY REVIEW").length;
const edited = classified.filter((item) => item.state === "SAFE — EDITED").length;

const lines = [
  "# Stage 4 Exercise Content Classification",
  "",
  "Read-only classification of existing development exercise rows. This report did not mutate database data.",
  "",
  `- Total rows: ${rows.length}`,
  `- Blocked from learner delivery: ${blocked}`,
  `- Safe edited learner text: ${edited}`,
  `- Safe validated legacy fallback, still requiring author review: ${legacy}`,
  "",
  "| DB id | Exercise id | Lesson | State | Review issues | Guidance |",
  "|---:|---|---:|---|---|---|",
  ...classified.map(({ row, state, issues, guidance }) =>
    `| ${row.id} | ${row.exerciseId} | ${row.lessonId} | ${state} | ${issues.join("; ") || "none"} | ${guidance} |`,
  ),
  "",
  "## Boundary interpretation",
  "",
  "- `BLOCKED`: excluded from student-package responses, source selection, activation, delivery, and constructed-response evaluation.",
  "- `SAFE — EDITED`: learner text comes from the independently stored edited representation.",
  "- `SAFE — LEGACY REVIEW`: historical verbatim text passed validation at read time, but a reviewed learner representation should still be persisted.",
  "- `successCriteria` and `correctAnswer` remain evaluator/backend-only and are never included in learner projections.",
  "",
];

const outputPath = resolve(process.cwd(), "../../reports/stage4-exercise-content-classification.md");
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, lines.join("\n"), "utf8");
console.log(JSON.stringify({ outputPath, total: rows.length, blocked, edited, legacy }));
process.exit(0);