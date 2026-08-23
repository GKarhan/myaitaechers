import {
  assessAcceptedCognitivePath,
  type CognitivePathAcceptance,
  type CognitivePathAcceptanceLevel,
} from "./cognitive-path-grounding.js";

/**
 * Server-side readiness gate for a MicroNode that is about to become approved.
 * It delegates all path semantics to the canonical C2 acceptance contract.
 */
export type ApprovedMicroNodeC2Readiness = {
  ready: boolean;
  acceptance: CognitivePathAcceptance;
};

export function assessApprovedMicroNodeC2Readiness(input: {
  cogPathStatus: string | null | undefined;
  theoryContent: string | null | undefined;
  learningObjective: string | null | undefined;
  levels: readonly CognitivePathAcceptanceLevel[];
}): ApprovedMicroNodeC2Readiness {
  const acceptance = assessAcceptedCognitivePath(input);
  return {
    ready: acceptance.accepted,
    acceptance,
  };
}