import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db, lessonExercisesTable } from "@workspace/db";
import { asc } from "drizzle-orm";
import {
  isLearnerDeliveryEligible,
  resolveLearnerExerciseContent,
} from "../lib/exercise-content-boundary.js";

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
    ? "BLOCKED — UNSAFE"
    : !isLearnerDeliveryEligible(content)
      ? "BLOCKED — CONTENT REVIEW"
      : "SAFE — EDITED";
  const issues = content.ok
    ? [...content.reviewWarnings, ...provenanceIssues]
    : [
        ...content.issues.map((issue) => issue.code),
        ...provenanceIssues,
      ];
  const guidance = !content.ok
    ? "Rewrite exerciseTextEdited as learner-only task wording; keep rubric/answer metadata only in hidden fields."
    : !isLearnerDeliveryEligible(content)
      ? "Persist a teacher-approved exerciseTextEdited value; this legacy fallback is intentionally unavailable to learners."
      : provenanceIssues.length > 0
        ? "Learner text is safe; review the listed provenance gaps without rewriting source material."
        : "No content-boundary action required.";
  return { row, state, issues, guidance };
});

const blocked = classified.filter((item) => item.state.startsWith("BLOCKED")).length;
const unsafe = classified.filter((item) => item.state === "BLOCKED — UNSAFE").length;
const legacy = classified.filter((item) => item.state === "BLOCKED — CONTENT REVIEW").length;
const edited = classified.filter((item) => item.state === "SAFE — EDITED").length;

const lines = [
  "# Stage 4 Exercise Content Classification",
  "",
  "Read-only classification of existing development exercise rows. This report did not mutate database data.",
  "",
  `- Total rows: ${rows.length}`,
  `- Blocked from learner delivery: ${blocked} (${unsafe} unsafe, ${legacy} pending content review)`,
  `- Safe edited learner text: ${edited}`,
  `- Legacy fallback rows pending author review and blocked from delivery: ${legacy}`,
  "",
  "| DB id | Exercise id | Lesson | State | Review issues | Guidance |",
  "|---:|---|---:|---|---|---|",
  ...classified.map(({ row, state, issues, guidance }) =>
    `| ${row.id} | ${row.exerciseId} | ${row.lessonId} | ${state} | ${issues.join("; ") || "none"} | ${guidance} |`,
  ),
  "",
  "## Boundary interpretation",
  "",
  "- `BLOCKED — UNSAFE`: excluded because learner text leaks evaluator-only content.",
  "- `BLOCKED — CONTENT REVIEW`: validated legacy source fallback; unavailable to student-package responses, source selection, activation, HELP, delivery, and constructed-response evaluation until a teacher-approved `exerciseTextEdited` value exists.",
  "- `SAFE — EDITED`: learner text comes from the independently stored edited representation.",
  "- `successCriteria` and `correctAnswer` remain evaluator/backend-only and are never included in learner projections.",
  "",
];

const outputPath = resolve(process.cwd(), "../../reports/stage4-exercise-content-classification.md");
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, lines.join("\n"), "utf8");
console.log(JSON.stringify({ outputPath, total: rows.length, blocked, edited, legacy }));
process.exit(0);