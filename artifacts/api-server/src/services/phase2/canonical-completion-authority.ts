/**
 * C7.1 — Canonical completion authority.
 *
 * C7 may propose a cognitive-level or MicroNode transition, but only C3
 * qualification plus the persisted C4 projection can authorize it. C6 remains
 * the sole next-target resolver after this gate succeeds.
 */
import { eq } from "drizzle-orm";
import { db, lessonSessionsTable } from "@workspace/db";
import type { EvidenceQualificationStatus } from "../../lib/evidence-contract.js";

export type CanonicalCompletionCandidate =
  | "ADVANCE_COGNITIVE_LEVEL"
  | "COMPLETE_MICRONODE";

export type CanonicalCompletionProjection = {
  pathAccepted: boolean;
  ceilingLevelId: number | null;
  reachedTarget: boolean;
};

export type CanonicalCompletionAuthorization = {
  authorized: boolean;
  reasonCode:
    | "C3_EVIDENCE_UNQUALIFIED"
    | "C4_PATH_UNAVAILABLE"
    | "C4_CURRENT_LEVEL_NOT_CONFIRMED"
    | "C4_TARGET_NOT_REACHED"
    | "CANONICAL_COMPLETION_AUTHORIZED";
};

/**
 * Converts a C7 candidate into an authorization decision. It deliberately
 * consumes C3/C4 results instead of reproducing either system's rules.
 */
export function authorizeCanonicalCompletion(input: {
  candidate: CanonicalCompletionCandidate;
  qualificationStatus: EvidenceQualificationStatus | null;
  projection: CanonicalCompletionProjection | null;
  currentLevelConfirmed: boolean;
}): CanonicalCompletionAuthorization {
  if (input.qualificationStatus !== "qualified") {
    return { authorized: false, reasonCode: "C3_EVIDENCE_UNQUALIFIED" };
  }
  if (!input.projection?.pathAccepted) {
    return { authorized: false, reasonCode: "C4_PATH_UNAVAILABLE" };
  }
  if (input.candidate === "ADVANCE_COGNITIVE_LEVEL") {
    return input.currentLevelConfirmed
      ? { authorized: true, reasonCode: "CANONICAL_COMPLETION_AUTHORIZED" }
      : { authorized: false, reasonCode: "C4_CURRENT_LEVEL_NOT_CONFIRMED" };
  }
  return input.projection.reachedTarget
    ? { authorized: true, reasonCode: "CANONICAL_COMPLETION_AUTHORIZED" }
    : { authorized: false, reasonCode: "C4_TARGET_NOT_REACHED" };
}

export type AuthorizedTargetTransition = {
  sessionId: number;
  currentNodeId: number | null;
  nextPhase: number;
  nextActiveCognitiveLevelId: number | null;
  reviewNeeded?: boolean;
};

/**
 * The only mutation shape for a C6-authorized MicroNode target transition.
 * Durable C3 evidence and C4 state intentionally live outside lesson_sessions
 * and are never reset here.
 */
export function buildAuthorizedTargetTransitionUpdate(
  input: AuthorizedTargetTransition,
): Record<string, unknown> {
  const now = new Date();
  return {
    currentNodeId: input.currentNodeId,
    nodeStartedAt: input.currentNodeId ? now : null,
    currentPhase: input.nextPhase,
    activeCognitiveLevelId: input.nextActiveCognitiveLevelId,
    nodeAttemptCount: 0,
    lastQuestionAsked: null,
    askedQuestionTemplates: [],
    nodeMasteryEvidenceCount: 0,
    nodeConsecutiveCorrect: 0,
    nodeConsecutiveIncorrect: 0,
    nodeLastEvidenceQuality: input.reviewNeeded ? "WEAK" : null,
    nodeTeachingStage: "THEORY",
    activeLessonExerciseId: null,
    activeTaskProvenance: null,
    activeTaskReference: null,
    activeObjectiveTaskPayload: null,
    activeAttemptSequence: 0,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    remediationStep: 0,
  };
}

export async function applyAuthorizedTargetTransition(
  input: AuthorizedTargetTransition,
): Promise<void> {
  await db
    .update(lessonSessionsTable)
    .set(buildAuthorizedTargetTransitionUpdate(input) as any)
    .where(eq(lessonSessionsTable.id, input.sessionId));
}

/**
 * A same-MicroNode C6 level transition resets only target-specific task state.
 * Node-wide durable evidence and progress counters are intentionally retained.
 */
export function buildAuthorizedLevelTransitionUpdate(
  nextActiveCognitiveLevelId: number,
): Record<string, unknown> {
  return {
    activeCognitiveLevelId: nextActiveCognitiveLevelId,
    nodeTeachingStage: "THEORY",
    lastQuestionAsked: null,
    askedQuestionTemplates: [],
    activeLessonExerciseId: null,
    activeTaskProvenance: null,
    activeTaskReference: null,
    activeObjectiveTaskPayload: null,
    activeAttemptSequence: 0,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    remediationStep: 0,
  };
}