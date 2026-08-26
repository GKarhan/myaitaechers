import { asc, eq } from "drizzle-orm";
import {
  db,
  quizAssignmentsTable,
  quizAnswersTable,
  quizAttemptsTable,
} from "@workspace/db";
import {
  resolveKnowledgeTreeStates,
  type KnowledgeState,
} from "./knowledge-tree-state.js";

export const RETEST_STRATEGIES = [
  "PARTIAL_AND_NOT_KNOWN",
  "NOT_KNOWN_ONLY",
] as const;

export type RetestStrategy = (typeof RETEST_STRATEGIES)[number];

export type RetestEligibleNode = {
  nodeId: number;
  canonicalState: Extract<KnowledgeState, "PARTIAL" | "NOT_KNOWN">;
};

export type RetestAuthorityResult = {
  attemptId: number;
  strategy: RetestStrategy;
  eligibleNodes: RetestEligibleNode[];
  counts: {
    partial: number;
    notKnown: number;
    eligible: number;
  };
};

export type RetestAuthorityErrorCode =
  | "RETEST_STRATEGY_INVALID"
  | "RETEST_ATTEMPT_NOT_FOUND"
  | "RETEST_ATTEMPT_NOT_OWNED"
  | "RETEST_ATTEMPT_INCOMPLETE";

export class RetestAuthorityError extends Error {
  readonly code: RetestAuthorityErrorCode;

  constructor(code: RetestAuthorityErrorCode) {
    super(code);
    this.name = "RetestAuthorityError";
    this.code = code;
  }
}

export function parseRetestStrategy(value: unknown): RetestStrategy | null {
  return typeof value === "string" &&
    (RETEST_STRATEGIES as readonly string[]).includes(value)
    ? value as RetestStrategy
    : null;
}

type RetestAttemptAccessRecord = {
  attemptId: number;
  learnerId: number;
  completedAt: Date | null;
};

/**
 * Applies the bounded retest contract to a previously resolved canonical
 * attempt identity. The caller must not substitute result-page or materialized
 * mastery labels for the canonicalState values supplied here.
 */
export function assertCompletedRetestAttempt(
  attempt: RetestAttemptAccessRecord | undefined,
  learnerId: number,
): asserts attempt is RetestAttemptAccessRecord {
  if (!attempt) {
    throw new RetestAuthorityError("RETEST_ATTEMPT_NOT_FOUND");
  }
  if (attempt.learnerId !== learnerId) {
    throw new RetestAuthorityError("RETEST_ATTEMPT_NOT_OWNED");
  }
  if (attempt.completedAt === null) {
    throw new RetestAuthorityError("RETEST_ATTEMPT_INCOMPLETE");
  }
}

export type RetestScopedNode = {
  nodeId: number | null;
  /**
   * Null means C5 could not safely resolve a current state for this node.
   * Such nodes fail closed and are never eligible.
   */
  canonicalState: KnowledgeState | null;
};

/**
 * Pure retest selection over server-derived attempt scope and current C5
 * states. The first occurrence preserves the quiz's question/node order.
 */
export function selectCanonicalRetestNodes(input: {
  attemptId: number;
  strategy: RetestStrategy;
  scopedNodes: readonly RetestScopedNode[];
}): RetestAuthorityResult {
  const seenNodeIds = new Set<number>();
  const eligibleNodes: RetestEligibleNode[] = [];
  let partial = 0;
  let notKnown = 0;

  for (const scopedNode of input.scopedNodes) {
    const nodeId = scopedNode.nodeId;
    if (nodeId === null || !Number.isInteger(nodeId) || nodeId <= 0) {
      continue;
    }
    if (seenNodeIds.has(nodeId)) {
      continue;
    }
    seenNodeIds.add(nodeId);

    const state = scopedNode.canonicalState;
    if (state === "PARTIAL") {
      partial++;
    } else if (state === "NOT_KNOWN") {
      notKnown++;
    } else {
      // MASTERED, NOT_STUDIED, and unresolved state all fail closed.
      continue;
    }

    const strategyMatches =
      input.strategy === "PARTIAL_AND_NOT_KNOWN" ||
      state === "NOT_KNOWN";
    if (strategyMatches) {
      eligibleNodes.push({ nodeId, canonicalState: state });
    }
  }

  return {
    attemptId: input.attemptId,
    strategy: input.strategy,
    eligibleNodes,
    counts: {
      partial,
      notKnown,
      eligible: eligibleNodes.length,
    },
  };
}

/**
 * Reads the immutable node snapshots from answers recorded for this attempt.
 * Current quiz-question rows are deliberately not consulted: later additions,
 * edits, moves, or reordering cannot change a historical attempt's scope.
 */
export async function resolveAttemptScopedNodeIds(input: {
  attemptId: number;
}): Promise<number[]> {
  const answeredQuestions = await db
    .select({
      nodeId: quizAnswersTable.nodeId,
    })
    .from(quizAnswersTable)
    .where(eq(quizAnswersTable.attemptId, input.attemptId))
    .orderBy(asc(quizAnswersTable.id));

  return [
    ...new Set(
      answeredQuestions
        .map((answer) => answer.nodeId)
        .filter((nodeId): nodeId is number => nodeId !== null),
    ),
  ];
}

/**
 * Resolve Test 2.0 retest eligibility from one learner-owned completed
 * attempt. Scope is derived from that attempt's persisted answer snapshots;
 * the client never supplies node IDs.
 */
export async function resolveRetestEligibleNodes(input: {
  learnerId: number;
  completedAttemptId: number;
  strategy: RetestStrategy;
}): Promise<RetestAuthorityResult> {
  if (!parseRetestStrategy(input.strategy)) {
    throw new RetestAuthorityError("RETEST_STRATEGY_INVALID");
  }

  const [attempt] = await db
    .select({
      attemptId: quizAttemptsTable.id,
      learnerId: quizAssignmentsTable.studentId,
      completedAt: quizAttemptsTable.completedAt,
    })
    .from(quizAttemptsTable)
    .innerJoin(
      quizAssignmentsTable,
      eq(quizAssignmentsTable.id, quizAttemptsTable.quizAssignmentId),
    )
    .where(eq(quizAttemptsTable.id, input.completedAttemptId))
    .limit(1);

  assertCompletedRetestAttempt(attempt, input.learnerId);

  const scopedNodeIds = await resolveAttemptScopedNodeIds({
    attemptId: attempt.attemptId,
  });
  const stateMap = await resolveKnowledgeTreeStates(
    input.learnerId,
    scopedNodeIds,
  );

  return selectCanonicalRetestNodes({
    attemptId: input.completedAttemptId,
    strategy: input.strategy,
    scopedNodes: scopedNodeIds.map((nodeId) => ({
      nodeId,
      canonicalState: stateMap.get(nodeId)?.knowledgeState ?? null,
    })),
  });
}