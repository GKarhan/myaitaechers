import {
  classifyMicroNodeSourceAlignment,
  isUnreadableSource,
  type SourceAlignmentAudit,
} from "./micronode-source-alignment.js";

export type C2GenerationBlockCode =
  | "C1_SOURCE_INSUFFICIENT"
  | "C1_OBJECTIVE_NOT_GROUNDED"
  | "C1_REVIEW_REQUIRED";

export type C2GenerationPreflight = {
  eligible: boolean;
  reason: C2GenerationBlockCode | null;
  sourceAlignment: SourceAlignmentAudit | null;
  /** Teacher-facing pipeline state. REVIEW_REQUIRED remains safe for generation. */
  outcome: "READY" | "REVIEW_REQUIRED" | "BLOCKED";
};

export type C2GenerationPreflightInput = {
  nodeStatus?: string | null;
  learningObjective: string | null | undefined;
  theoryContent: string | null | undefined;
  blockType?: string | null;
};

/**
 * C2 may extend only a source-safe C1 MicroNode. A review flag is not itself
 * proof that the source is unsafe: source-grounded partial alignment can keep
 * flowing as REVIEW_REQUIRED while unreadable/unsupported source stays blocked.
 * This function never changes C1 data or relaxes source grounding.
 */
export function assessC2GenerationPreflight(
  input: C2GenerationPreflightInput,
): C2GenerationPreflight {
  if (input.nodeStatus === "needs_source_content") {
    return { eligible: false, reason: "C1_SOURCE_INSUFFICIENT", sourceAlignment: null, outcome: "BLOCKED" };
  }

  const sourceText = input.theoryContent?.trim() ?? "";
  if (sourceText.length < 50 || isUnreadableSource(sourceText)) {
    return { eligible: false, reason: "C1_SOURCE_INSUFFICIENT", sourceAlignment: null, outcome: "BLOCKED" };
  }

  const sourceAlignment = classifyMicroNodeSourceAlignment(input.learningObjective, [{
    sourceText,
    blockType: input.blockType?.toUpperCase() ?? null,
  }]);

  if (sourceAlignment.status === "UNREADABLE" || sourceAlignment.status === "INSUFFICIENT") {
    return { eligible: false, reason: "C1_SOURCE_INSUFFICIENT", sourceAlignment, outcome: "BLOCKED" };
  }
  if (sourceAlignment.status === "PARTIAL" || input.nodeStatus === "needs_review") {
    return {
      eligible: true,
      reason: "C1_REVIEW_REQUIRED",
      sourceAlignment,
      outcome: "REVIEW_REQUIRED",
    };
  }
  return { eligible: true, reason: null, sourceAlignment, outcome: "READY" };
}