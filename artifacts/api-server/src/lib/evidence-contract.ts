/**
 * C3 minimum telemetry contract.
 *
 * These helpers intentionally do not calculate mastery or learner state. They
 * only classify whether an already-evaluated response has the complete,
 * authoritative identity needed to count as Cognitive-Level evidence.
 */
import { randomUUID } from "node:crypto";

export const EVIDENCE_QUALIFICATION = {
  QUALIFIED: "qualified",
  UNQUALIFIED: "unqualified",
  LEGACY: "legacy",
} as const;

export type EvidenceQualificationStatus =
  (typeof EVIDENCE_QUALIFICATION)[keyof typeof EVIDENCE_QUALIFICATION];

export type TaskSource =
  | "micro_check"
  | "source_exercise"
  | "quiz_question"
  | "generated_task";

export function createTaskReference(source: TaskSource): string {
  return `${source}:${randomUUID()}`;
}

export function classifyQualifyingEvidence(input: {
  lessonNodeId: number | null;
  cognitiveLevelId: number | null;
  taskSource: TaskSource | null;
  taskReference: string | null;
  levelBelongsToNode: boolean;
  acceptedPath: boolean;
  taskValidForLevel: boolean;
  authoritativeResult: boolean;
}): EvidenceQualificationStatus {
  const completeIdentity =
    input.lessonNodeId !== null &&
    input.cognitiveLevelId !== null &&
    input.taskSource !== null &&
    !!input.taskReference;

  return completeIdentity &&
    input.levelBelongsToNode &&
    input.acceptedPath &&
    input.taskValidForLevel &&
    input.authoritativeResult
    ? EVIDENCE_QUALIFICATION.QUALIFIED
    : EVIDENCE_QUALIFICATION.UNQUALIFIED;
}