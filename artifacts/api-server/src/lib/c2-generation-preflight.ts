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
};

export type C2GenerationPreflightInput = {
  nodeStatus?: string | null;
  learningObjective: string | null | undefined;
  theoryContent: string | null | undefined;
  blockType?: string | null;
};

/**
 * C2 may extend only an already-safe C1 MicroNode. This is deliberately a
 * deterministic, source-only gate: it does not alter C1 status or attempt to
 * repair source/objective drift. A teacher must resolve C1 first.
 */
export function assessC2GenerationPreflight(
  input: C2GenerationPreflightInput,
): C2GenerationPreflight {
  if (input.nodeStatus === "needs_review") {
    return { eligible: false, reason: "C1_REVIEW_REQUIRED", sourceAlignment: null };
  }
  if (input.nodeStatus === "needs_source_content") {
    return { eligible: false, reason: "C1_SOURCE_INSUFFICIENT", sourceAlignment: null };
  }
  if (input.nodeStatus && input.nodeStatus !== "approved") {
    return { eligible: false, reason: "C1_REVIEW_REQUIRED", sourceAlignment: null };
  }

  const sourceText = input.theoryContent?.trim() ?? "";
  if (sourceText.length < 50 || isUnreadableSource(sourceText)) {
    return { eligible: false, reason: "C1_SOURCE_INSUFFICIENT", sourceAlignment: null };
  }

  const sourceAlignment = classifyMicroNodeSourceAlignment(input.learningObjective, [{
    sourceText,
    blockType: input.blockType?.toUpperCase() ?? null,
  }]);

  if (sourceAlignment.status === "UNREADABLE" || sourceAlignment.status === "INSUFFICIENT") {
    return { eligible: false, reason: "C1_SOURCE_INSUFFICIENT", sourceAlignment };
  }
  if (sourceAlignment.status !== "SUFFICIENT") {
    return { eligible: false, reason: "C1_OBJECTIVE_NOT_GROUNDED", sourceAlignment };
  }
  return { eligible: true, reason: null, sourceAlignment };
}