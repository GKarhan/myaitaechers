import { createHash, randomUUID } from "node:crypto";
import {
  db,
  quizGenerationJobsTable,
  type QuizGenerationJob,
} from "@workspace/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  generateQuizFromNodeScope,
  persistGeneratedQuizInTransaction,
  QuizCanonicalTargetChangedError,
  QuizCanonicalTargetError,
  type CreateQuizFromNodeScopeInput,
} from "./quiz-creation.js";
import type { GeneratedQuestion } from "./quiz-generation.js";
import { logger } from "../lib/logger.js";

export const QUIZ_GENERATION_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;
export type QuizGenerationJobStatus = (typeof QUIZ_GENERATION_JOB_STATUSES)[number];

export const QUIZ_GENERATION_ERROR_CODES = [
  "INVALID_REQUEST",
  "QUESTION_SCOPE_INVALID",
  "CANONICAL_TARGET_INVALID",
  "CANONICAL_TARGET_CHANGED",
  "EMPTY_GENERATION",
  "GENERATION_FAILED",
  "PERSISTENCE_FAILED",
] as const;
export type QuizGenerationErrorCode = (typeof QUIZ_GENERATION_ERROR_CODES)[number];
export type QuizGenerationErrorDetails = {
  nodeId: number;
  resolverReason?: string;
  generatedCognitiveLevelId?: number;
  currentCognitiveLevelId?: number;
};

export type QuizGenerationRequestSnapshot = {
  schemaVersion: 1;
  subjectId: number;
  classId: number | null;
  sourceBookId: number | null;
  quizType: string | null;
  lessonIds: number[];
  nodeIds: number[];
  questionCount: number;
  difficultyMode: CreateQuizFromNodeScopeInput["difficultyMode"];
  title: string;
};

export type QuizGenerationJobResult = {
  job: QuizGenerationJob;
  reused: boolean;
};

export class IdempotencyKeyReusedError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED" as const;

  constructor() {
    super("IDEMPOTENCY_KEY_REUSED");
    this.name = "IdempotencyKeyReusedError";
  }
}

export class QuizGenerationJobFinalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuizGenerationJobFinalizationError";
  }
}

function uniqueSortedPositiveIntegers(values: number[] | undefined): number[] {
  return [...new Set((values ?? []).filter((value) => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b);
}

export function normalizeQuizGenerationRequest(input: {
  subjectId: number;
  classId?: number | null;
  sourceBookId?: number | null;
  quizType?: string | null;
  lessonIds?: number[];
  nodeIds: number[];
  questionCount: number;
  difficultyMode: CreateQuizFromNodeScopeInput["difficultyMode"];
  title: string;
}): QuizGenerationRequestSnapshot {
  return {
    schemaVersion: 1,
    subjectId: input.subjectId,
    classId: input.classId ?? null,
    sourceBookId: input.sourceBookId ?? null,
    quizType: input.quizType ?? null,
    lessonIds: uniqueSortedPositiveIntegers(input.lessonIds),
    nodeIds: uniqueSortedPositiveIntegers(input.nodeIds),
    questionCount: input.questionCount,
    difficultyMode: input.difficultyMode,
    title: input.title.trim(),
  };
}

function stableJson(value: QuizGenerationRequestSnapshot): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    subjectId: value.subjectId,
    classId: value.classId,
    sourceBookId: value.sourceBookId,
    quizType: value.quizType,
    lessonIds: value.lessonIds,
    nodeIds: value.nodeIds,
    questionCount: value.questionCount,
    difficultyMode: value.difficultyMode,
    title: value.title,
  });
}

export function fingerprintQuizGenerationRequest(
  snapshot: QuizGenerationRequestSnapshot,
): string {
  return createHash("sha256").update(stableJson(snapshot), "utf8").digest("hex");
}

export async function createOrReuseQuizGenerationJob(input: {
  teacherId: number;
  idempotencyKey: string;
  snapshot: QuizGenerationRequestSnapshot;
}): Promise<QuizGenerationJobResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  }

  const requestFingerprint = fingerprintQuizGenerationRequest(input.snapshot);
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(quizGenerationJobsTable)
      .values({
        teacherId: input.teacherId,
        idempotencyKey,
        requestSnapshot: input.snapshot,
        requestFingerprint,
        status: "pending",
        progress: "Queued for quiz generation",
      })
      .onConflictDoNothing({
        target: [quizGenerationJobsTable.teacherId, quizGenerationJobsTable.idempotencyKey],
      })
      .returning();

    if (inserted) {
      return { job: inserted, reused: false };
    }

    const [existing] = await tx
      .select()
      .from(quizGenerationJobsTable)
      .where(and(
        eq(quizGenerationJobsTable.teacherId, input.teacherId),
        eq(quizGenerationJobsTable.idempotencyKey, idempotencyKey),
      ))
      .limit(1);

    if (!existing) {
      throw new Error("QUIZ_GENERATION_JOB_NOT_FOUND_AFTER_CONFLICT");
    }
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyKeyReusedError();
    }
    return { job: existing, reused: true };
  });
}

export async function claimQuizGenerationJob(
  jobId: number,
  claimToken = randomUUID(),
): Promise<QuizGenerationJob | null> {
  const [claimed] = await db
    .update(quizGenerationJobsTable)
    .set({
      status: "running",
      progress: "Generating quiz questions",
      claimToken,
      attemptCount: sql`${quizGenerationJobsTable.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(quizGenerationJobsTable.id, jobId),
      eq(quizGenerationJobsTable.status, "pending"),
    ))
    .returning();
  return claimed ?? null;
}

export async function claimNextQuizGenerationJob(): Promise<QuizGenerationJob | null> {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT id
      FROM quiz_generation_jobs
      WHERE status = 'pending'
      ORDER BY id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const candidate = result.rows[0] as { id?: unknown } | undefined;
    if (!candidate || !Number.isInteger(candidate.id)) return null;

    const claimToken = randomUUID();
    const [claimed] = await tx
      .update(quizGenerationJobsTable)
      .set({
        status: "running",
        progress: "Generating quiz questions",
        claimToken,
        attemptCount: sql`${quizGenerationJobsTable.attemptCount} + 1`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(quizGenerationJobsTable.id, candidate.id as number),
        eq(quizGenerationJobsTable.status, "pending"),
      ))
      .returning();
    return claimed ?? null;
  });
}

export async function recoverStaleQuizGenerationJobs(
  staleAfterMs = 10 * 60 * 1000,
): Promise<number> {
  const staleBefore = new Date(Date.now() - staleAfterMs);
  const recovered = await db
    .update(quizGenerationJobsTable)
    .set({
      status: "pending",
      progress: "Re-queued after an interrupted generation attempt",
      claimToken: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(quizGenerationJobsTable.status, "running"),
      lt(quizGenerationJobsTable.updatedAt, staleBefore),
    ))
    .returning({ id: quizGenerationJobsTable.id });
  return recovered.length;
}

export async function updateQuizGenerationJobProgress(
  jobId: number,
  claimToken: string,
  progress: string,
): Promise<void> {
  await db
    .update(quizGenerationJobsTable)
    .set({ progress, updatedAt: new Date() })
    .where(and(
      eq(quizGenerationJobsTable.id, jobId),
      eq(quizGenerationJobsTable.status, "running"),
      eq(quizGenerationJobsTable.claimToken, claimToken),
    ));
}

export async function heartbeatQuizGenerationJob(
  jobId: number,
  claimToken: string,
): Promise<void> {
  await db
    .update(quizGenerationJobsTable)
    .set({ updatedAt: new Date() })
    .where(and(
      eq(quizGenerationJobsTable.id, jobId),
      eq(quizGenerationJobsTable.status, "running"),
      eq(quizGenerationJobsTable.claimToken, claimToken),
    ));
}

export async function failQuizGenerationJob(
  jobId: number,
  claimToken: string,
  errorCode: QuizGenerationErrorCode,
  errorDetails: QuizGenerationErrorDetails | null = null,
): Promise<void> {
  await db
    .update(quizGenerationJobsTable)
    .set({
      status: "failed",
      progress: "Quiz generation failed",
      errorCode,
      errorDetails,
      claimToken: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(quizGenerationJobsTable.id, jobId),
      inArray(quizGenerationJobsTable.status, ["pending", "running"]),
      eq(quizGenerationJobsTable.claimToken, claimToken),
    ));
}

function snapshotToCreationInput(
  teacherId: number,
  snapshot: QuizGenerationRequestSnapshot,
): CreateQuizFromNodeScopeInput {
  return {
    teacherId,
    subjectId: snapshot.subjectId,
    classId: snapshot.classId,
    sourceBookId: snapshot.sourceBookId,
    lessonIds: snapshot.lessonIds,
    nodeIds: snapshot.nodeIds,
    title: snapshot.title,
    questionCount: snapshot.questionCount,
    difficultyMode: snapshot.difficultyMode,
    quizType: snapshot.quizType,
    allowEmptyQuestions: true,
  };
}

function parseSnapshot(value: unknown): QuizGenerationRequestSnapshot {
  if (!value || typeof value !== "object") {
    throw new QuizGenerationJobFinalizationError("Invalid request snapshot");
  }
  const candidate = value as Partial<QuizGenerationRequestSnapshot>;
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isInteger(candidate.subjectId) ||
    !Number.isInteger(candidate.questionCount) ||
    !Array.isArray(candidate.lessonIds) ||
    !Array.isArray(candidate.nodeIds) ||
    typeof candidate.title !== "string" ||
    !["SIMPLE", "MEDIUM", "HARD", "MIXED"].includes(candidate.difficultyMode ?? "")
  ) {
    throw new QuizGenerationJobFinalizationError("Invalid request snapshot");
  }
  return candidate as QuizGenerationRequestSnapshot;
}

export async function finalizeQuizGenerationJob(input: {
  jobId: number;
  teacherId: number;
  claimToken: string;
  snapshot: QuizGenerationRequestSnapshot;
  nodeIds: number[];
  generated: GeneratedQuestion[];
  canonicalTargets?: Awaited<ReturnType<typeof generateQuizFromNodeScope>>["canonicalTargets"];
}): Promise<{ quizId: number; reused: boolean } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id
      FROM quiz_generation_jobs
      WHERE id = ${input.jobId}
      FOR UPDATE
    `);

    const [job] = await tx
      .select()
      .from(quizGenerationJobsTable)
      .where(eq(quizGenerationJobsTable.id, input.jobId))
      .limit(1);

    if (!job || job.teacherId !== input.teacherId) {
      throw new QuizGenerationJobFinalizationError("Quiz generation job not found");
    }
    if (job.status === "completed" && job.quizId != null) {
      return { quizId: job.quizId, reused: true };
    }
    if (job.status !== "running" || job.claimToken !== input.claimToken) {
      return null;
    }

    const created = await persistGeneratedQuizInTransaction(
      tx,
      snapshotToCreationInput(input.teacherId, input.snapshot),
      input.nodeIds,
      input.generated,
      input.canonicalTargets,
    );

    const [completed] = await tx
      .update(quizGenerationJobsTable)
      .set({
        status: "completed",
        progress: "Quiz generation completed",
        quizId: created.quiz.id,
        errorCode: null,
        errorDetails: null,
        claimToken: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(quizGenerationJobsTable.id, input.jobId),
        eq(quizGenerationJobsTable.status, "running"),
        eq(quizGenerationJobsTable.claimToken, input.claimToken),
      ))
      .returning({ id: quizGenerationJobsTable.id });

    if (!completed) {
      throw new QuizGenerationJobFinalizationError("Quiz generation finalization lost its claim");
    }
    return { quizId: created.quiz.id, reused: false };
  });
}

function errorCodeForGenerationFailure(error: unknown): QuizGenerationErrorCode {
  if (error instanceof QuizCanonicalTargetError) {
    return "CANONICAL_TARGET_INVALID";
  }
  if (error instanceof QuizCanonicalTargetChangedError) {
    return "CANONICAL_TARGET_CHANGED";
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "QUESTION_SCOPE_INVALID"
  ) {
    return "QUESTION_SCOPE_INVALID";
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EMPTY_GENERATION"
  ) {
    return "EMPTY_GENERATION";
  }
  return "GENERATION_FAILED";
}

function errorDetailsForGenerationFailure(
  error: unknown,
): QuizGenerationErrorDetails | null {
  if (error instanceof QuizCanonicalTargetError) {
    return {
      nodeId: error.nodeId,
      resolverReason: error.resolverReason,
    };
  }
  if (error instanceof QuizCanonicalTargetChangedError) {
    return {
      nodeId: error.nodeId,
      generatedCognitiveLevelId: error.generatedCognitiveLevelId,
      currentCognitiveLevelId: error.currentCognitiveLevelId,
    };
  }
  return null;
}

const scheduledJobIds = new Set<number>();

export function scheduleQuizGenerationJob(jobId: number): void {
  if (scheduledJobIds.has(jobId)) return;
  scheduledJobIds.add(jobId);
  setImmediate(() => {
    void runQuizGenerationJob(jobId)
      .catch((error) => {
        logger.error({ err: error, jobId }, "quiz generation job runner crashed");
      })
      .finally(() => {
        scheduledJobIds.delete(jobId);
      });
  });
}

export async function runQuizGenerationJob(
  jobId: number,
  dependencies: {
    generate?: typeof generateQuizFromNodeScope;
  } = {},
): Promise<QuizGenerationJob | null> {
  const claimed = await claimQuizGenerationJob(jobId);
  if (!claimed) return null;
  if (!claimed.claimToken) {
    throw new QuizGenerationJobFinalizationError("Claimed quiz generation job has no lease token");
  }
  const claimToken = claimed.claimToken;
  const heartbeatTimer = setInterval(() => {
    void heartbeatQuizGenerationJob(jobId, claimToken).catch((error) => {
      logger.warn({ err: error, jobId }, "quiz generation job heartbeat failed");
    });
  }, 30_000);
  heartbeatTimer.unref();

  try {
  let snapshot: QuizGenerationRequestSnapshot;
  try {
    snapshot = parseSnapshot(claimed.requestSnapshot);
  } catch (error) {
    logger.error({ err: error, jobId }, "quiz generation job request snapshot is invalid");
    await failQuizGenerationJob(jobId, claimToken, "INVALID_REQUEST");
    const [failed] = await db
      .select()
      .from(quizGenerationJobsTable)
      .where(eq(quizGenerationJobsTable.id, jobId))
      .limit(1);
    return failed ?? null;
  }

  let generatedResult: Awaited<ReturnType<typeof generateQuizFromNodeScope>>;
  try {
    await updateQuizGenerationJobProgress(jobId, claimToken, "Generating quiz questions");
    generatedResult = await (dependencies.generate ?? generateQuizFromNodeScope)(
      snapshotToCreationInput(claimed.teacherId, snapshot),
    );
  } catch (error) {
    const errorCode = errorCodeForGenerationFailure(error);
    logger.error({ err: error, jobId, errorCode }, "quiz generation job failed");
    await failQuizGenerationJob(
      jobId,
      claimToken,
      errorCode,
      errorDetailsForGenerationFailure(error),
    );
    const [failed] = await db
      .select()
      .from(quizGenerationJobsTable)
      .where(eq(quizGenerationJobsTable.id, jobId))
      .limit(1);
    return failed ?? null;
  }

  try {
    await updateQuizGenerationJobProgress(jobId, claimToken, "Saving generated quiz");
    await finalizeQuizGenerationJob({
      jobId,
      teacherId: claimed.teacherId,
      claimToken,
      snapshot,
      nodeIds: generatedResult.nodeIds,
      generated: generatedResult.generated,
      canonicalTargets: generatedResult.canonicalTargets,
    });
  } catch (error) {
    logger.error({ err: error, jobId }, "quiz generation job finalization failed");
    const canonicalErrorCode = errorCodeForGenerationFailure(error);
    await failQuizGenerationJob(
      jobId,
      claimToken,
      canonicalErrorCode === "GENERATION_FAILED"
        ? "PERSISTENCE_FAILED"
        : canonicalErrorCode,
      errorDetailsForGenerationFailure(error),
    );
  }

  const [finished] = await db
    .select()
    .from(quizGenerationJobsTable)
    .where(eq(quizGenerationJobsTable.id, jobId))
    .limit(1);
  return finished ?? null;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function schedulePendingQuizGenerationJobs(
  schedule: (jobId: number) => void = scheduleQuizGenerationJob,
): Promise<number> {
  const pending = await db
    .select({ id: quizGenerationJobsTable.id })
    .from(quizGenerationJobsTable)
    .where(eq(quizGenerationJobsTable.status, "pending"))
    .orderBy(desc(quizGenerationJobsTable.id));
  for (const job of pending) schedule(job.id);
  return pending.length;
}

export const QUIZ_GENERATION_STALE_AFTER_MS = 10 * 60 * 1000;
export const QUIZ_GENERATION_SUPERVISOR_INTERVAL_MS = 30 * 1000;

export async function runQuizGenerationSupervisorCycle(options: {
  staleAfterMs?: number;
  schedule?: (jobId: number) => void;
} = {}): Promise<{ recovered: number; scheduled: number }> {
  const recovered = await recoverStaleQuizGenerationJobs(
    options.staleAfterMs ?? QUIZ_GENERATION_STALE_AFTER_MS,
  );
  const scheduled = await schedulePendingQuizGenerationJobs(options.schedule);
  return { recovered, scheduled };
}

let supervisorTimer: NodeJS.Timeout | null = null;
let supervisorCycleRunning = false;

async function runGuardedSupervisorCycle(): Promise<void> {
  if (supervisorCycleRunning) return;
  supervisorCycleRunning = true;
  try {
    const { recovered, scheduled } = await runQuizGenerationSupervisorCycle();
    if (recovered > 0 || scheduled > 0) {
      logger.info({ recovered, scheduled }, "quiz generation job supervisor cycle completed");
    }
  } catch (error) {
    logger.error({ err: error }, "quiz generation job supervisor cycle failed");
  } finally {
    supervisorCycleRunning = false;
  }
}

export async function startQuizGenerationJobs(): Promise<void> {
  stopQuizGenerationJobs();
  await runGuardedSupervisorCycle();
  supervisorTimer = setInterval(() => {
    void runGuardedSupervisorCycle();
  }, QUIZ_GENERATION_SUPERVISOR_INTERVAL_MS);
  supervisorTimer.unref();
}

export function stopQuizGenerationJobs(): void {
  if (supervisorTimer) {
    clearInterval(supervisorTimer);
    supervisorTimer = null;
  }
}