import type { Phase2ServerAction } from "./orchestration.js";

export const MAX_PHASE2_INTERNAL_CONTINUATIONS = 3;

export type Phase2ContinuationStopReason =
  | "LEARNER_INPUT_REQUIRED"
  | "COMPLETE"
  | "FAILURE"
  | "SAFETY_CAP";

/**
 * Purely derives whether the next authoritative Phase-2 state must wait for a
 * real learner action. AI output is deliberately not an input.
 */
export function nextPhase2ActionRequiresLearnerInput(input: {
  action: Phase2ServerAction;
  hasActiveTask: boolean;
}): boolean {
  if (input.hasActiveTask) return true;

  switch (input.action) {
    case "DELIVER_THEORY":
    case "GENERATE_TASK":
    case "DELIVER_SOURCE_EXERCISE":
    case "ADVANCE_COGNITIVE_LEVEL":
    case "COMPLETE_MICRONODE":
      return false;
    case "OUTSIDE_PHASE_2":
    case "EVALUATE_ACTIVE_TASK":
    case "PRESERVE_ACTIVE_TASK":
    case "DELIVER_FEEDBACK":
    case "REMEDIATE":
    case "DEFER_TO_COMPATIBILITY":
    case "INVALID_PHASE2_STATE":
      return true;
  }
}