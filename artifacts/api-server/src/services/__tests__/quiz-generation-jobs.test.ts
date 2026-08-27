import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import {
  db,
  lessonNodesTable,
  lessonsTable,
  quizGenerationJobsTable,
  quizQuestionsTable,
  quizzesTable,
  subjectsTable,
  usersTable,
} from "@workspace/db";
import { and, count, eq } from "drizzle-orm";
import app from "../../app.js";
import { assertTestDb } from "../../lib/__tests__/helpers/test-db.js";
import type { GeneratedQuestion } from "../quiz-generation.js";
import {
  claimQuizGenerationJob,
  createOrReuseQuizGenerationJob,
  failQuizGenerationJob,
  finalizeQuizGenerationJob,
  IdempotencyKeyReusedError,
  normalizeQuizGenerationRequest,
  runQuizGenerationSupervisorCycle,
  runQuizGenerationJob,
  type QuizGenerationRequestSnapshot,
} from "../quiz-generation-jobs.js";

assertTestDb();

const runId = `quiz_jobs_${Date.now()}_${process.pid}`;
const generatedQuestion = (nodeId: number): GeneratedQuestion => ({
  nodeId,
  cognitiveLevelId: null,
  questionText: "Փորձնական հարց",
  options: ["Ա", "Բ", "Գ", "Դ"],
  correctOptionIndex: 0,
  difficultyLevel: "LOW",
  optionExplanations: null,
});

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.stack ?? error.message : error}`);
    failed++;
  }
}

const server = app.listen(0);
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

let subjectId = 0;
let teacherId = 0;
let otherTeacherId = 0;
let lessonId = 0;
let nodeId = 0;

function snapshot(
  title: string,
  overrides: Partial<QuizGenerationRequestSnapshot> = {},
): QuizGenerationRequestSnapshot {
  return normalizeQuizGenerationRequest({
    subjectId,
    classId: null,
    sourceBookId: null,
    quizType: "lesson",
    lessonIds: [lessonId],
    nodeIds: [nodeId],
    questionCount: 1,
    difficultyMode: "SIMPLE",
    title,
    ...overrides,
  });
}

function teacherToken(id: number): string {
  return jwt.sign(
    { userId: id, role: "teacher" },
    process.env.SESSION_SECRET ?? "myaiteacher-secret",
    { expiresIn: "5m" },
  );
}

async function jobCount(key: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(quizGenerationJobsTable)
    .where(and(
      eq(quizGenerationJobsTable.teacherId, teacherId),
      eq(quizGenerationJobsTable.idempotencyKey, key),
    ));
  return Number(row?.value ?? 0);
}

async function quizCount(title: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(quizzesTable)
    .where(and(
      eq(quizzesTable.teacherId, teacherId),
      eq(quizzesTable.title, title),
    ));
  return Number(row?.value ?? 0);
}

try {
  const [subject] = await db.insert(subjectsTable).values({
    name: `${runId}_subject`,
    grade: "test",
  }).returning({ id: subjectsTable.id });
  subjectId = subject.id;

  const teachers = await db.insert(usersTable).values([
    {
      username: `${runId}_teacher`,
      passwordHash: "test",
      fullName: "Quiz job teacher",
      role: "teacher",
    },
    {
      username: `${runId}_other_teacher`,
      passwordHash: "test",
      fullName: "Other quiz job teacher",
      role: "teacher",
    },
  ]).returning({ id: usersTable.id });
  teacherId = teachers[0]!.id;
  otherTeacherId = teachers[1]!.id;

  const [lesson] = await db.insert(lessonsTable).values({
    subjectId,
    teacherId,
    title: `${runId}_lesson`,
  }).returning({ id: lessonsTable.id });
  lessonId = lesson.id;

  const [node] = await db.insert(lessonNodesTable).values({
    lessonId,
    sequence: 1,
    title: `${runId}_node`,
    createdBy: "teacher",
  }).returning({ id: lessonNodesTable.id });
  nodeId = node.id;

  console.log("\nAsync Quiz Generation Backend\n");

  await test("CASE A — valid request creates a pending durable job and POST returns 202 without provider work", async () => {
    const key = `${runId}_A`;
    const request = snapshot(`${runId}_A_quiz`);
    const startedAt = Date.now();
    const created = await createOrReuseQuizGenerationJob({
      teacherId,
      idempotencyKey: key,
      snapshot: request,
    });
    assert.equal(created.job.status, "pending");
    assert.equal(await quizCount(request.title), 0);

    // Mark completed so the route's fire-and-forget scheduler cannot invoke the
    // real provider during this provider-free HTTP assertion.
    await db.update(quizGenerationJobsTable)
      .set({ status: "completed", progress: "test terminal state" })
      .where(eq(quizGenerationJobsTable.id, created.job.id));

    const response = await fetch(`${baseUrl}/quizzes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${teacherToken(teacherId)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        subjectId,
        lessonIds: [lessonId],
        nodeIds: [nodeId],
        quizType: "lesson",
        questionCount: 1,
        difficultyMode: "SIMPLE",
        title: request.title,
      }),
    });
    const body = await response.json() as { jobId: number };
    assert.equal(response.status, 202);
    assert.equal(body.jobId, created.job.id);
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(await quizCount(request.title), 0);
  });

  await test("CASE B — same teacher, key, and request returns the same job", async () => {
    const key = `${runId}_B`;
    const request = snapshot(`${runId}_B_quiz`);
    const first = await createOrReuseQuizGenerationJob({ teacherId, idempotencyKey: key, snapshot: request });
    const second = await createOrReuseQuizGenerationJob({ teacherId, idempotencyKey: key, snapshot: request });
    assert.equal(second.reused, true);
    assert.equal(second.job.id, first.job.id);
    assert.equal(await jobCount(key), 1);
  });

  await test("CASE C — reused key with a different request is rejected", async () => {
    const key = `${runId}_C`;
    await createOrReuseQuizGenerationJob({
      teacherId,
      idempotencyKey: key,
      snapshot: snapshot(`${runId}_C_quiz`),
    });
    await assert.rejects(
      createOrReuseQuizGenerationJob({
        teacherId,
        idempotencyKey: key,
        snapshot: snapshot(`${runId}_C_quiz`, { questionCount: 2 }),
      }),
      (error: unknown) => error instanceof IdempotencyKeyReusedError,
    );
    assert.equal(await jobCount(key), 1);

    const response = await fetch(`${baseUrl}/quizzes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${teacherToken(teacherId)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        subjectId,
        lessonIds: [lessonId],
        nodeIds: [nodeId],
        quizType: "lesson",
        questionCount: 2,
        difficultyMode: "SIMPLE",
        title: `${runId}_C_quiz`,
      }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "IDEMPOTENCY_KEY_REUSED" });
  });

  await test("CASE D — an atomic claim moves pending to running only once", async () => {
    const created = await createOrReuseQuizGenerationJob({
      teacherId,
      idempotencyKey: `${runId}_D`,
      snapshot: snapshot(`${runId}_D_quiz`),
    });
    const claimed = await claimQuizGenerationJob(created.job.id);
    assert.equal(claimed?.status, "running");
    assert.ok(claimed?.claimToken);
    assert.equal(claimed?.attemptCount, 1);
    assert.equal(await claimQuizGenerationJob(created.job.id), null);
  });

  await test("CASE E — success atomically commits quiz, questions, and completed job", async () => {
    const title = `${runId}_E_quiz`;
    const created = await createOrReuseQuizGenerationJob({
      teacherId,
      idempotencyKey: `${runId}_E`,
      snapshot: snapshot(title),
    });
    const finished = await runQuizGenerationJob(created.job.id, {
      generate: async () => ({ nodeIds: [nodeId], generated: [generatedQuestion(nodeId)] }),
    });
    assert.equal(finished?.status, "completed");
    assert.ok(finished?.quizId);
    const [questionRow] = await db
      .select({ value: count() })
      .from(quizQuestionsTable)
      .where(eq(quizQuestionsTable.quizId, finished!.quizId!));
    assert.equal(Number(questionRow?.value ?? 0), 1);
    assert.equal(await quizCount(title), 1);
  });

  await test("CASE F — generation failure marks failed and leaves no partial quiz", async () => {
    const title = `${runId}_F_quiz`;
    const created = await createOrReuseQuizGenerationJob({
      teacherId,
      idempotencyKey: `${runId}_F`,
      snapshot: snapshot(title),
    });
    const finished = await runQuizGenerationJob(created.job.id, {
      generate: async () => {
        throw new Error("provider test failure");
      },
    });
    assert.equal(finished?.status, "failed");
    assert.equal(finished?.errorCode, "GENERATION_FAILED");
    assert.equal(await quizCount(title), 0);
  });

  await test("CASE G — a returned pending job remains executable independently", async () => {
    const created = await createOrReuseQuizGenerationJob({
      teacherId,
      idempotencyKey: `${runId}_G`,
      snapshot: snapshot(`${runId}_G_quiz`),
    });
    await Promise.resolve();
    const [stillPending] = await db
      .select({ status: quizGenerationJobsTable.status })
      .from(quizGenerationJobsTable)
      .where(eq(quizGenerationJobsTable.id, created.job.id));
    assert.equal(stillPending?.status, "pending");
    const finished = await runQuizGenerationJob(created.job.id, {
      generate: async () => ({ nodeIds: [nodeId], generated: [generatedQuestion(nodeId)] }),
    });
    assert.equal(finished?.status, "completed");
  });

  await test("CASE H — a teacher cannot poll another teacher's job", async () => {
    const created = await createOrReuseQuizGenerationJob({
      teacherId,
      idempotencyKey: `${runId}_H`,
      snapshot: snapshot(`${runId}_H_quiz`),
    });
    const response = await fetch(`${baseUrl}/quizzes/generation-jobs/${created.job.id}`, {
      headers: { Authorization: `Bearer ${teacherToken(otherTeacherId)}` },
    });
    assert.equal(response.status, 404);

    const createResponse = await fetch(`${baseUrl}/quizzes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${teacherToken(otherTeacherId)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `${runId}_H_foreign_scope`,
      },
      body: JSON.stringify({
        subjectId,
        lessonIds: [lessonId],
        nodeIds: [nodeId],
        quizType: "lesson",
        questionCount: 1,
        difficultyMode: "SIMPLE",
        title: `${runId}_H_foreign_quiz`,
      }),
    });
    assert.equal(createResponse.status, 403);
  });

  await test("CASE I — stale recovery invalidates the old claim lease", async () => {
    const created = await createOrReuseQuizGenerationJob({
      teacherId,
      idempotencyKey: `${runId}_I`,
      snapshot: snapshot(`${runId}_I_quiz`),
    });
    const oldClaim = await claimQuizGenerationJob(created.job.id);
    assert.ok(oldClaim?.claimToken);
    const scheduled: number[] = [];
    const beforeStale = await runQuizGenerationSupervisorCycle({
      staleAfterMs: 60_000,
      schedule: (jobId) => scheduled.push(jobId),
    });
    assert.equal(beforeStale.recovered, 0);
    assert.equal(scheduled.includes(created.job.id), false);
    scheduled.length = 0;

    await db.update(quizGenerationJobsTable)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(quizGenerationJobsTable.id, created.job.id));
    let releaseGeneration!: () => void;
    let signalGenerationStarted!: () => void;
    const generationGate = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    const generationStarted = new Promise<void>((resolve) => { signalGenerationStarted = resolve; });
    const executions: Array<ReturnType<typeof runQuizGenerationJob>> = [];
    const afterStale = await runQuizGenerationSupervisorCycle({
      staleAfterMs: 1_000,
      schedule: (jobId) => {
        scheduled.push(jobId);
        if (jobId === created.job.id) {
          executions.push(runQuizGenerationJob(jobId, {
            generate: async () => {
              signalGenerationStarted();
              await generationGate;
              return { nodeIds: [nodeId], generated: [generatedQuestion(nodeId)] };
            },
          }));
        }
      },
    });
    assert.ok(afterStale.recovered >= 1);
    assert.ok(scheduled.includes(created.job.id));
    await generationStarted;

    const [replacement] = await db
      .select({
        status: quizGenerationJobsTable.status,
        claimToken: quizGenerationJobsTable.claimToken,
      })
      .from(quizGenerationJobsTable)
      .where(eq(quizGenerationJobsTable.id, created.job.id));
    assert.equal(replacement?.status, "running");
    assert.ok(replacement?.claimToken);
    assert.notEqual(replacement!.claimToken, oldClaim!.claimToken);

    await failQuizGenerationJob(created.job.id, oldClaim!.claimToken!, "GENERATION_FAILED");
    const [afterOldFailure] = await db
      .select({
        status: quizGenerationJobsTable.status,
        claimToken: quizGenerationJobsTable.claimToken,
      })
      .from(quizGenerationJobsTable)
      .where(eq(quizGenerationJobsTable.id, created.job.id));
    assert.equal(afterOldFailure?.status, "running");
    assert.equal(afterOldFailure?.claimToken, replacement!.claimToken);

    releaseGeneration();
    const [finished] = await Promise.all(executions);
    assert.equal(finished?.status, "completed");
    assert.ok(finished?.quizId);
  });

  await test("CASE J — competing finalizers reuse one committed quiz", async () => {
    const title = `${runId}_J_quiz`;
    const request = snapshot(title);
    const created = await createOrReuseQuizGenerationJob({
      teacherId,
      idempotencyKey: `${runId}_J`,
      snapshot: request,
    });
    const claim = await claimQuizGenerationJob(created.job.id);
    assert.ok(claim?.claimToken);
    const input = {
      jobId: created.job.id,
      teacherId,
      claimToken: claim!.claimToken!,
      snapshot: request,
      nodeIds: [nodeId],
      generated: [generatedQuestion(nodeId)],
    };
    const [first, second] = await Promise.all([
      finalizeQuizGenerationJob(input),
      finalizeQuizGenerationJob(input),
    ]);
    assert.ok(first?.quizId);
    assert.equal(second?.quizId, first?.quizId);
    assert.equal(await quizCount(title), 1);
  });
} finally {
  server.close();
  await once(server, "close");
  if (teacherId) await db.delete(usersTable).where(eq(usersTable.id, teacherId));
  if (otherTeacherId) await db.delete(usersTable).where(eq(usersTable.id, otherTeacherId));
  if (subjectId) await db.delete(subjectsTable).where(eq(subjectsTable.id, subjectId));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);