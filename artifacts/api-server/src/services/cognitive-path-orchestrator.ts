import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
  mappingJobsTable,
  type MappingJob,
} from "@workspace/db";
import {
  generateCognitivePath,
  type CogPathGenerationResult,
  type CogPathInput,
} from "./lesson-mapping.js";
import { invalidateLessonApproval } from "../lib/lesson-approval-invalidation.js";

export const COGNITIVE_PATH_JOB_TYPE = "generate_cognitive_paths";

export const COGNITIVE_PATH_STATES = [
  "NOT_ATTEMPTED",
  "IN_PROGRESS",
  "SKIPPED_CONFIRMED",
  "SKIPPED_TEACHER_AUTHORED",
  "SKIPPED_EXISTING",
  "BLOCKED_C1_REVIEW",
  "GENERATED_NEEDS_REVIEW",
  "CONFIRMED",
  "PROVIDER_FAILURE",
  "PARSE_FAILURE",
  "VALIDATION_FAILURE",
  "PERSISTENCE_FAILURE",
] as const;

export type CognitivePathState = (typeof COGNITIVE_PATH_STATES)[number];

export type CognitivePathNodeLedgerEntry = {
  nodeId: number;
  title: string;
  state: CognitivePathState;
  reasonCode?: string;
  attemptCount: number;
  levelCount: number;
  targetLevel: string | null;
  lastAttemptAt?: string;
  completedAt?: string;
};

export type CognitivePathAttempt = {
  nodeId: number;
  attempt: number;
  state: CognitivePathState;
  reasonCode: string;
  startedAt: string;
  completedAt: string;
  retryCount: number;
  levelCount: number;
  targetLevel: string | null;
  errorMessage?: string;
};

export type CognitivePathSummary = {
  total: number;
  notAttempted: number;
  inProgress: number;
  generatedNeedsReview: number;
  confirmed: number;
  skipped: number;
  blocked: number;
  failed: number;
};

export type CognitivePathJobResult = {
  schemaVersion: 1;
  lessonId: number;
  trigger: "bulk" | "single";
  force: boolean;
  totalNodes: number;
  stateLedger: CognitivePathNodeLedgerEntry[];
  attempts: CognitivePathAttempt[];
  summary: CognitivePathSummary;
};

export type CognitivePathNodeSnapshot = {
  id: number;
  title: string;
  status: string | null;
  cogPathStatus: string | null;
  existingLevelCount: number;
  hasTeacherAuthoredLevels: boolean;
};

export type CognitivePathProtectionSnapshot = {
  cogPathStatus: string | null;
  pathFingerprint: string;
};

type JobClaim = {
  job: MappingJob | null;
  conflictingNodeIds: number[];
};

const FAILURE_MESSAGE_LIMIT = 500;

export function fingerprintCognitivePath(
  levels: ReadonlyArray<{
    id?: number;
    cognitiveLevel: string;
    sequence: number;
    isApplicable?: boolean;
    isTargetCeiling: boolean;
    performanceObjective: string | null;
    successCriterion: string | null;
    minimumIndependentEvidence?: number | null;
    preferredInteractionTypes?: unknown;
    provenance?: string | null;
  }>,
): string {
  return JSON.stringify([...levels]
    .map((level) => ({
      id: level.id ?? null,
      cognitiveLevel: level.cognitiveLevel,
      sequence: level.sequence,
      isApplicable: level.isApplicable ?? true,
      isTargetCeiling: level.isTargetCeiling,
      performanceObjective: level.performanceObjective,
      successCriterion: level.successCriterion,
      minimumIndependentEvidence: level.minimumIndependentEvidence ?? null,
      preferredInteractionTypes: level.preferredInteractionTypes ?? [],
      provenance: level.provenance ?? null,
    }))
    .sort((left, right) => (left.id ?? 0) - (right.id ?? 0) || left.sequence - right.sequence));
}

class CognitivePathProtectionChangedError extends Error {
  constructor(
    readonly state: Extract<CognitivePathState, "SKIPPED_CONFIRMED" | "SKIPPED_TEACHER_AUTHORED" | "SKIPPED_EXISTING">,
    readonly code: string,
  ) {
    super(code);
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, FAILURE_MESSAGE_LIMIT);
}

function targetLevel(levels: Array<{ cognitiveLevel: string; isTargetCeiling: boolean }>): string | null {
  return levels.find((level) => level.isTargetCeiling)?.cognitiveLevel ?? null;
}

function isActiveJob(job: MappingJob): boolean {
  return job.jobType === COGNITIVE_PATH_JOB_TYPE
    && (job.status === "pending" || job.status === "running");
}

function isCognitivePathLedgerEntry(entry: unknown): entry is CognitivePathNodeLedgerEntry {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as Partial<CognitivePathNodeLedgerEntry>;
  return typeof value.nodeId === "number" && typeof value.state === "string";
}

function parseJobLedger(job: MappingJob): CognitivePathNodeLedgerEntry[] | null {
  const result = job.result;
  if (!result || typeof result !== "object") return null;
  const ledger = (result as { stateLedger?: unknown }).stateLedger;
  if (!Array.isArray(ledger)) return null;
  return ledger.filter(isCognitivePathLedgerEntry);
}

export function findCognitivePathJobConflicts(
  requestedNodeIds: readonly number[],
  activeJobResults: readonly unknown[],
): number[] {
  const requested = new Set(requestedNodeIds);
  const conflicts = new Set<number>();
  for (const result of activeJobResults) {
    if (!result || typeof result !== "object") {
      for (const nodeId of requested) conflicts.add(nodeId);
      continue;
    }
    const ledger = (result as { stateLedger?: unknown }).stateLedger;
    if (!Array.isArray(ledger)) {
      for (const nodeId of requested) conflicts.add(nodeId);
      continue;
    }
    for (const entry of ledger) {
      if (
        isCognitivePathLedgerEntry(entry)
        && entry.reasonCode !== "SAME_NODE_GENERATION_IN_PROGRESS"
        && requested.has(entry.nodeId)
      ) {
        conflicts.add(entry.nodeId);
      }
    }
  }
  return [...conflicts].sort((left, right) => left - right);
}

export function canCommitCognitivePathReplacement(
  result: CogPathGenerationResult,
): boolean {
  return !result.skipped
    && result.levels.length > 0
    && result.levels.filter((level) => level.isTargetCeiling).length === 1;
}

export function buildInitialCognitivePathLedger(
  nodes: readonly CognitivePathNodeSnapshot[],
): CognitivePathNodeLedgerEntry[] {
  return nodes.map((node) => {
    let state: CognitivePathState = "NOT_ATTEMPTED";
    if (node.cogPathStatus === "confirmed") {
      state = "SKIPPED_CONFIRMED";
    } else if (node.hasTeacherAuthoredLevels) {
      state = "SKIPPED_TEACHER_AUTHORED";
    } else if (node.existingLevelCount > 0 || node.cogPathStatus === "needs_review") {
      state = "SKIPPED_EXISTING";
    }
    return {
      nodeId: node.id,
      title: node.title,
      state,
      attemptCount: 0,
      levelCount: node.existingLevelCount,
      targetLevel: null,
    };
  });
}

export function summarizeCognitivePathLedger(
  ledger: readonly CognitivePathNodeLedgerEntry[],
): CognitivePathSummary {
  const skippedStates = new Set<CognitivePathState>([
    "SKIPPED_CONFIRMED",
    "SKIPPED_TEACHER_AUTHORED",
    "SKIPPED_EXISTING",
  ]);
  const blockedStates = new Set<CognitivePathState>(["BLOCKED_C1_REVIEW"]);
  const failedStates = new Set<CognitivePathState>([
    "PROVIDER_FAILURE",
    "PARSE_FAILURE",
    "VALIDATION_FAILURE",
    "PERSISTENCE_FAILURE",
  ]);
  return {
    total: ledger.length,
    notAttempted: ledger.filter((entry) => entry.state === "NOT_ATTEMPTED").length,
    inProgress: ledger.filter((entry) => entry.state === "IN_PROGRESS").length,
    generatedNeedsReview: ledger.filter((entry) => entry.state === "GENERATED_NEEDS_REVIEW").length,
    confirmed: ledger.filter((entry) => entry.state === "CONFIRMED").length,
    skipped: ledger.filter((entry) => skippedStates.has(entry.state)).length,
    blocked: ledger.filter((entry) => blockedStates.has(entry.state)).length,
    failed: ledger.filter((entry) => failedStates.has(entry.state)).length,
  };
}

export function classifyCognitivePathResult(
  result: CogPathGenerationResult,
): { state: CognitivePathState; reasonCode: string } {
  if (!result.skipped) {
    return { state: "GENERATED_NEEDS_REVIEW", reasonCode: "GENERATED_AND_VALIDATED" };
  }
  if (result.skipCode?.startsWith("C1_")) {
    return { state: "BLOCKED_C1_REVIEW", reasonCode: result.skipCode };
  }
  if (result.skipCode) {
    return { state: "VALIDATION_FAILURE", reasonCode: result.skipCode };
  }
  if ((result.skipReason ?? "").toLowerCase().includes("unparseable")) {
    return { state: "PARSE_FAILURE", reasonCode: "C2_RESPONSE_PARSE_FAILED" };
  }
  return { state: "VALIDATION_FAILURE", reasonCode: "C2_RESPONSE_VALIDATION_FAILED" };
}

async function claimCognitivePathJob(
  lessonId: number,
  ledger: CognitivePathNodeLedgerEntry[],
  trigger: "bulk" | "single",
  force: boolean,
): Promise<JobClaim> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM lessons WHERE id = ${lessonId} FOR UPDATE`);
    const activeJobs = await tx
      .select()
      .from(mappingJobsTable)
      .where(and(
        eq(mappingJobsTable.lessonId, lessonId),
        eq(mappingJobsTable.jobType, COGNITIVE_PATH_JOB_TYPE),
        inArray(mappingJobsTable.status, ["pending", "running"]),
      ));

    const requestedIds = ledger.map((entry) => entry.nodeId);
    const conflictingNodeIds = findCognitivePathJobConflicts(
      requestedIds,
      activeJobs.map((job) => {
        const activeLedger = parseJobLedger(job);
        return activeLedger ? { stateLedger: activeLedger } : null;
      }),
    );
    const claimedLedger = ledger.map((entry) => conflictingNodeIds.includes(entry.nodeId)
      ? {
          ...entry,
          state: "IN_PROGRESS" as const,
          reasonCode: "SAME_NODE_GENERATION_IN_PROGRESS",
        }
      : entry);
    const hasClaimedNodes = claimedLedger.some(
      (entry) => entry.state !== "IN_PROGRESS" || entry.reasonCode !== "SAME_NODE_GENERATION_IN_PROGRESS",
    );
    if (!hasClaimedNodes) return { job: null, conflictingNodeIds };

    const initialResult: CognitivePathJobResult = {
      schemaVersion: 1,
      lessonId,
      trigger,
      force,
      totalNodes: ledger.length,
      stateLedger: claimedLedger,
      attempts: [],
      summary: summarizeCognitivePathLedger(claimedLedger),
    };
    const [job] = await tx
      .insert(mappingJobsTable)
      .values({
        lessonId,
        jobType: COGNITIVE_PATH_JOB_TYPE,
        status: "running",
        progress: `Preparing Cognitive Path generation for ${ledger.length} MicroNodes...`,
        result: initialResult,
      })
      .returning();
    return { job, conflictingNodeIds };
  });
}

async function updateCognitivePathJob(
  jobId: number,
  result: CognitivePathJobResult,
  progress: string,
  status?: "running" | "completed" | "failed",
  error?: string | null,
): Promise<void> {
  await db.update(mappingJobsTable)
    .set({
      result,
      progress,
      ...(status ? { status } : {}),
      ...(error !== undefined ? { error } : {}),
      updatedAt: new Date(),
    })
    .where(eq(mappingJobsTable.id, jobId));
}

async function persistCognitivePathAtomically(
  lessonId: number,
  nodeId: number,
  levels: CogPathGenerationResult["levels"],
  protection: CognitivePathProtectionSnapshot,
  force: boolean,
): Promise<{ savedLevels: typeof levels; targetLevel: string | null }> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id FROM lesson_nodes
      WHERE id = ${nodeId} AND lesson_id = ${lessonId}
      FOR UPDATE
    `);
    const [node] = await tx
      .select({
        id: lessonNodesTable.id,
        cogPathStatus: lessonNodesTable.cogPathStatus,
        childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
      })
      .from(lessonNodesTable)
      .where(and(eq(lessonNodesTable.id, nodeId), eq(lessonNodesTable.lessonId, lessonId)))
      .limit(1);
    if (!node) throw new Error("MicroNode no longer belongs to this lesson");

    const currentLevels = await tx.select()
      .from(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId))
      .orderBy(lessonNodeCognitiveLevelsTable.id);
    const currentFingerprint = fingerprintCognitivePath(currentLevels);
    const currentHasTeacherLevels = currentLevels.some((level) => level.provenance === "teacher_authored");
    const protectionState = node.cogPathStatus === "confirmed"
      ? "SKIPPED_CONFIRMED"
      : currentHasTeacherLevels
        ? "SKIPPED_TEACHER_AUTHORED"
        : "SKIPPED_EXISTING";
    if (!force && (node.cogPathStatus !== null || currentLevels.length > 0)) {
      throw new CognitivePathProtectionChangedError(
        protectionState,
        "C2_PATH_BECAME_PROTECTED_DURING_GENERATION",
      );
    }
    if (
      force
      && (node.cogPathStatus !== protection.cogPathStatus
        || currentFingerprint !== protection.pathFingerprint)
    ) {
      throw new CognitivePathProtectionChangedError(
        protectionState,
        "C2_PATH_CHANGED_DURING_FORCED_GENERATION",
      );
    }

    const newTargetLevel = targetLevel(levels);
    await tx.delete(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId));
    for (const level of levels) {
      await tx.insert(lessonNodeCognitiveLevelsTable).values({
        lessonNodeId: nodeId,
        cognitiveLevel: level.cognitiveLevel,
        sequence: level.sequence,
        isApplicable: true,
        isTargetCeiling: level.isTargetCeiling,
        performanceObjective: level.performanceObjective || null,
        successCriterion: level.successCriterion || null,
        provenance: "ai_generated",
        minimumIndependentEvidence: level.minimumIndependentEvidence,
        preferredInteractionTypes: level.preferredInteractionTypes,
      });
    }

    const updates: Record<string, unknown> = { cogPathStatus: "needs_review" };
    if (node.cogPathStatus === "confirmed" && node.childFriendlyExplanation) {
      updates.teachingContentStale = true;
    }
    await tx.update(lessonNodesTable)
      .set(updates as never)
      .where(and(eq(lessonNodesTable.id, nodeId), eq(lessonNodesTable.lessonId, lessonId)));
    return { savedLevels: levels, targetLevel: newTargetLevel };
  });
  await invalidateLessonApproval(lessonId);
  return result;
}

function setLedgerEntry(
  ledger: CognitivePathNodeLedgerEntry[],
  nodeId: number,
  patch: Partial<CognitivePathNodeLedgerEntry>,
): CognitivePathNodeLedgerEntry[] {
  return ledger.map((entry) => entry.nodeId === nodeId ? { ...entry, ...patch } : entry);
}

export async function runCognitivePathOrchestrator(input: {
  lessonId: number;
  nodes: readonly {
    snapshot: CognitivePathNodeSnapshot;
    cogInput: CogPathInput;
    protection: CognitivePathProtectionSnapshot;
    eligible: boolean;
    preflightReason?: string;
  }[];
  trigger: "bulk" | "single";
  force: boolean;
}): Promise<{
  jobId: number | null;
  result: CognitivePathJobResult;
  conflictNodeIds: number[];
  generatedNodeIds: number[];
}> {
  const initialLedger = buildInitialCognitivePathLedger(input.nodes.map((entry) => entry.snapshot));
  for (const entry of input.nodes) {
    if (!entry.eligible) {
      const ledgerEntry = initialLedger.find((candidate) => candidate.nodeId === entry.snapshot.id);
      if (ledgerEntry) {
        ledgerEntry.state = "BLOCKED_C1_REVIEW";
        ledgerEntry.reasonCode = entry.preflightReason ?? "C1_REVIEW_REQUIRED";
      }
    }
  }

  const claim = await claimCognitivePathJob(input.lessonId, initialLedger, input.trigger, input.force);
  if (!claim.job) {
    const stateLedger = initialLedger.map((entry) => claim.conflictingNodeIds.includes(entry.nodeId)
      ? { ...entry, state: "IN_PROGRESS" as const, reasonCode: "SAME_NODE_GENERATION_IN_PROGRESS" }
      : entry);
    const result: CognitivePathJobResult = {
      schemaVersion: 1,
      lessonId: input.lessonId,
      trigger: input.trigger,
      force: input.force,
      totalNodes: initialLedger.length,
      stateLedger,
      attempts: [],
      summary: summarizeCognitivePathLedger(stateLedger),
    };
    return { jobId: null, result, conflictNodeIds: claim.conflictingNodeIds, generatedNodeIds: [] };
  }

  let result = claim.job.result as CognitivePathJobResult;
  const generatedNodeIds: number[] = [];
  const nodeById = new Map(input.nodes.map((entry) => [entry.snapshot.id, entry]));
  const pendingEntries = result.stateLedger.filter((entry) =>
    entry.state === "NOT_ATTEMPTED"
    || (input.force && [
      "SKIPPED_CONFIRMED",
      "SKIPPED_TEACHER_AUTHORED",
      "SKIPPED_EXISTING",
    ].includes(entry.state)),
  );

  try {
    for (const pending of pendingEntries) {
      const node = nodeById.get(pending.nodeId);
      if (!node || !node.eligible) continue;
      const startedAt = new Date().toISOString();
      const attemptNumber = pending.attemptCount + 1;
      result = {
        ...result,
        stateLedger: setLedgerEntry(result.stateLedger, pending.nodeId, {
          state: "IN_PROGRESS",
          reasonCode: "PROVIDER_CALL_IN_PROGRESS",
          attemptCount: attemptNumber,
          lastAttemptAt: startedAt,
        }),
      };
      await updateCognitivePathJob(
        claim.job.id,
        result,
        `Generating Cognitive Path... (${result.stateLedger.filter((entry) => entry.state !== "NOT_ATTEMPTED").length}/${result.totalNodes} MicroNodes)`,
      );

      let generated: CogPathGenerationResult;
      let retryCount = 0;
      try {
        generated = await generateCognitivePath(node.cogInput);
        if (
          generated.skipped
          && ["C2_PATH_STRUCTURE_REJECTED", "C2_CEILING_VIOLATION", "C2_OBJECTIVE_COGNITIVE_FLOOR_VIOLATION", "C2_GROUNDING_REJECTED"]
            .includes(generated.skipCode ?? "")
        ) {
          retryCount = 1;
          generated = await generateCognitivePath(node.cogInput);
        }
      } catch (error) {
        const completedAt = new Date().toISOString();
        const attempt: CognitivePathAttempt = {
          nodeId: pending.nodeId,
          attempt: attemptNumber,
          state: "PROVIDER_FAILURE",
          reasonCode: "C2_PROVIDER_FAILURE",
          startedAt,
          completedAt,
          retryCount,
          levelCount: 0,
          targetLevel: null,
          errorMessage: safeErrorMessage(error),
        };
        result = {
          ...result,
          stateLedger: setLedgerEntry(result.stateLedger, pending.nodeId, {
            state: "PROVIDER_FAILURE",
            reasonCode: attempt.reasonCode,
            completedAt,
            levelCount: 0,
            targetLevel: null,
          }),
          attempts: [...result.attempts, attempt],
        };
        await updateCognitivePathJob(claim.job.id, result, `Cognitive Path generation has failures; continuing...`);
        continue;
      }

      if (!canCommitCognitivePathReplacement(generated)) {
        const completedAt = new Date().toISOString();
        const classified = classifyCognitivePathResult(generated);
        const attempt: CognitivePathAttempt = {
          nodeId: pending.nodeId,
          attempt: attemptNumber,
          state: classified.state,
          reasonCode: classified.reasonCode,
          startedAt,
          completedAt,
          retryCount,
          levelCount: 0,
          targetLevel: null,
        };
        result = {
          ...result,
          stateLedger: setLedgerEntry(result.stateLedger, pending.nodeId, {
            state: classified.state,
            reasonCode: classified.reasonCode,
            completedAt,
            levelCount: 0,
            targetLevel: null,
          }),
          attempts: [...result.attempts, attempt],
        };
        await updateCognitivePathJob(claim.job.id, result, `Cognitive Path generation has reviews; continuing...`);
        continue;
      }

      try {
        const persisted = await persistCognitivePathAtomically(
          input.lessonId,
          pending.nodeId,
          generated.levels,
          node.protection,
          input.force,
        );
        const completedAt = new Date().toISOString();
        const attempt: CognitivePathAttempt = {
          nodeId: pending.nodeId,
          attempt: attemptNumber,
          state: "GENERATED_NEEDS_REVIEW",
          reasonCode: "GENERATED_AND_PERSISTED",
          startedAt,
          completedAt,
          retryCount,
          levelCount: persisted.savedLevels.length,
          targetLevel: persisted.targetLevel,
        };
        result = {
          ...result,
          stateLedger: setLedgerEntry(result.stateLedger, pending.nodeId, {
            state: "GENERATED_NEEDS_REVIEW",
            reasonCode: attempt.reasonCode,
            completedAt,
            levelCount: persisted.savedLevels.length,
            targetLevel: persisted.targetLevel,
          }),
          attempts: [...result.attempts, attempt],
        };
        generatedNodeIds.push(pending.nodeId);
      } catch (error) {
        const completedAt = new Date().toISOString();
        if (error instanceof CognitivePathProtectionChangedError) {
          const attempt: CognitivePathAttempt = {
            nodeId: pending.nodeId,
            attempt: attemptNumber,
            state: error.state,
            reasonCode: error.code,
            startedAt,
            completedAt,
            retryCount,
            levelCount: pending.levelCount,
            targetLevel: pending.targetLevel,
          };
          result = {
            ...result,
            stateLedger: setLedgerEntry(result.stateLedger, pending.nodeId, {
              state: error.state,
              reasonCode: error.code,
              completedAt,
              levelCount: pending.levelCount,
              targetLevel: pending.targetLevel,
            }),
            attempts: [...result.attempts, attempt],
          };
          await updateCognitivePathJob(claim.job.id, result, "A newer teacher path was preserved; continuing...");
          continue;
        }
        const attempt: CognitivePathAttempt = {
          nodeId: pending.nodeId,
          attempt: attemptNumber,
          state: "PERSISTENCE_FAILURE",
          reasonCode: "C2_PERSISTENCE_FAILURE",
          startedAt,
          completedAt,
          retryCount,
          levelCount: 0,
          targetLevel: null,
          errorMessage: safeErrorMessage(error),
        };
        result = {
          ...result,
          stateLedger: setLedgerEntry(result.stateLedger, pending.nodeId, {
            state: "PERSISTENCE_FAILURE",
            reasonCode: attempt.reasonCode,
            completedAt,
            levelCount: pending.levelCount,
            targetLevel: pending.targetLevel,
          }),
          attempts: [...result.attempts, attempt],
        };
      }
      await updateCognitivePathJob(claim.job.id, result, `Cognitive Path generation continues...`);
    }

    result = {
      ...result,
      summary: summarizeCognitivePathLedger(result.stateLedger),
    };
    await updateCognitivePathJob(
      claim.job.id,
      result,
      `Cognitive Path generation completed for ${result.totalNodes} MicroNodes.`,
      "completed",
    );
  } catch (error) {
    result = {
      ...result,
      summary: summarizeCognitivePathLedger(result.stateLedger),
    };
    await updateCognitivePathJob(
      claim.job.id,
      result,
      "Cognitive Path generation stopped unexpectedly.",
      "failed",
      safeErrorMessage(error),
    ).catch(() => {});
  }

  return {
    jobId: claim.job.id,
    result,
    conflictNodeIds: claim.conflictingNodeIds,
    generatedNodeIds,
  };
}
