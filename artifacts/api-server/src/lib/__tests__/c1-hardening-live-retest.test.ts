/**
 * One clean, authenticated C1 acceptance retest for the verified Math 5 source.
 *
 * This is intentionally opt-in because it calls providers and writes a tagged
 * disposable fixture to the development database. It never modifies lesson 629.
 * Run with:
 *   RUN_LIVE_C1_RETEST=1 pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/c1-hardening-live-retest.test.ts
 */
if (!process.env.RUN_LIVE_C1_RETEST) {
  console.log("[skip] Set RUN_LIVE_C1_RETEST=1 for the clean disposable C1 mapping retest");
  process.exit(0);
}

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  db,
  lessonOutcomesTable,
  lessonsTable,
  resourcesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const BASE = "http://localhost:8080/api";
const TEACHER_ID = 161;
const SUBJECT_ID = 18;
const RESOURCE_ID = 19;
const RUN_TAG = `TR_C1HARD_${Date.now()}`;
const teacherToken = jwt.sign(
  { userId: TEACHER_ID, role: "teacher" },
  process.env.SESSION_SECRET ?? "myaiteacher-secret",
  { expiresIn: "15m" },
);
const confirmedGoal = "Հասկանալ շենքերի համարակալման սկզբունքները և դրանց կիրառությունը քաղաքային միջավայրում։";
const confirmedOutcomes = [
  "Ուսանողները կկարողանան բացատրել, թե ինչպես են համարակալվում շենքերը փողոցի երկայնքով։",
  "Ուսանողները կկարողանան տարբերակել կենտ և զույգ համարներով շենքերի դասավորությունը փողոցի ձախ և աջ կողմերում։",
  "Ուսանողները կկարողանան որոշել նոր շենքի հասցեն երկու գոյություն ունեցող շենքերի միջև։",
  "Ուսանողները կկարողանան լուծել պարզ խնդիրներ՝ կապված շենքերի համարակալման հետ։",
];

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${teacherToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})) as Record<string, any>,
  };
}

async function poll(jobId: number): Promise<Record<string, any>> {
  const deadline = Date.now() + 7 * 60_000;
  while (Date.now() < deadline) {
    const response = await request("GET", `/lessons/jobs/${jobId}`);
    assert.equal(response.status, 200, "mapping job must remain readable to the authenticated teacher");
    if (["completed", "failed", "coverage_failed"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("C1 live retest mapping job timed out before a terminal status");
}

function safeEvidence(job: Record<string, any>) {
  const result = job.result ?? {};
  const report = result.mappingReport ?? {};
  const quality = report.quality ?? {};
  return {
    terminalStatus: job.status ?? null,
    failureReason: result.reason ?? null,
    errorPresent: Boolean(job.error),
    counts: {
      pass1BlocksExtracted: result.pass1BlocksExtracted ?? report.counts?.pass1BlocksExtracted ?? null,
      topicsCreated: result.topicsCreated ?? report.counts?.topicsCreated ?? null,
      microNodesCreated: result.microNodesCreated ?? report.counts?.microNodesCreated ?? null,
      exercisesCreated: result.exercisesCreated ?? report.counts?.exercisesCreated ?? null,
      unmappedBlocks: result.unmappedBlocks ?? report.counts?.unmappedBlocks ?? null,
    },
    quality: {
      coveragePercent: quality.coveragePercent ?? null,
      instructionalCoverageValid: result.instructionalCoverageValid ?? null,
      sourceAlignmentValid: quality.sourceAlignment?.valid ?? null,
      sourceAlignment: quality.sourceAlignment
        ? {
            sufficientCount: quality.sourceAlignment.sufficientCount ?? null,
            partialCount: quality.sourceAlignment.partialCount ?? null,
            insufficientCount: quality.sourceAlignment.insufficientCount ?? null,
            unreadableCount: quality.sourceAlignment.unreadableCount ?? null,
          }
        : null,
      duplicateResolution: quality.duplicateResolution
        ? {
            candidatePairCount: quality.duplicateResolution.candidatePairCount ?? null,
            unresolvedPairCount: quality.duplicateResolution.unresolvedPairCount ?? null,
          }
        : null,
    },
  };
}

let lessonId: number | null = null;
try {
  const [resource] = await db.select({ id: resourcesTable.id })
    .from(resourcesTable)
    .where(eq(resourcesTable.id, RESOURCE_ID))
    .limit(1);
  assert.ok(resource, "verified Math 5 resource 19 must exist");

  const now = new Date();
  const [lesson] = await db.insert(lessonsTable).values({
    subjectId: SUBJECT_ID,
    teacherId: TEACHER_ID,
    // The verified source-set title check intentionally requires the real
    // lesson title to match the selected physical PDF pages. The run tag lives
    // in the disposable description; cleanup is by the returned lesson ID.
    title: "Շենքերի համարակալումը",
    description: `${RUN_TAG}_Disposable_C1_acceptance_fixture`,
    bloomLevel: 1,
    textbookResourceId: RESOURCE_ID,
    pagesFrom: 11,
    pagesTo: 12,
    textbookTitle: "Մաթեմատիկա 5",
    textbookAuthor: "Սմբատ Գոգյան",
    status: "draft",
    lessonGoal: confirmedGoal,
    goalOutcomeReviewStatus: "confirmed",
    goalOutcomeConfirmedBy: TEACHER_ID,
    goalOutcomeConfirmedAt: now,
  }).returning({ id: lessonsTable.id });
  lessonId = lesson.id;
  console.log(`C1_LIVE_RETEST_FIXTURE_ID=${lessonId}`);

  await db.insert(lessonOutcomesTable).values(confirmedOutcomes.map((outcomeText, index) => ({
    lessonId: lesson.id,
    outcomeText,
    sequence: index + 1,
    status: "approved",
    provenance: "mapping_import",
  })));

  const start = await request("POST", `/lessons/${lesson.id}/map`);
  assert.ok(
    start.status === 200 || start.status === 202,
    `normal mapping endpoint must accept the disposable lesson: ${start.body.error ?? "unknown error"}`,
  );
  assert.equal(typeof start.body.jobId, "number");
  const terminal = await poll(start.body.jobId);
  const evidence = safeEvidence(terminal);
  console.log(`C1_LIVE_RETEST_EVIDENCE=${JSON.stringify(evidence)}`);
  assert.equal(terminal.status, "completed", `mapping must complete for C1 acceptance: ${terminal.error ?? terminal.result?.reason ?? "unknown failure"}`);
} finally {
  if (lessonId !== null) {
    const cleanup = await request("POST", `/lessons/${lessonId}/delete`);
    assert.equal(cleanup.status, 200, "disposable C1 lesson must be removed through the authenticated delete endpoint");
    const verification = await request("GET", `/lessons/${lessonId}`);
    assert.equal(verification.status, 404, "disposable C1 lesson deletion must be verified");
    console.log("C1_LIVE_RETEST_CLEANUP=verified");
  }
}