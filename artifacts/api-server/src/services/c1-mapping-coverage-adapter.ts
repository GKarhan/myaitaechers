/**
 * Bridges the existing Pass-1/Pass-2 source material contract to the new
 * independent source-and-task completeness audit.
 *
 * Non-lesson adjacent blocks are excluded deliberately by the existing
 * semantic scope classifier, and unreadable blocks remain REVIEW_REQUIRED.
 */
import { auditC1SourceDispositions, type C1CoverageReport, type C1SourceDisposition } from "./c1-source-coverage-gate.js";

export interface C1PersistedSourceBlock {
  sourceBlockIndex: number;
  blockType: string;
  primaryDisposition: string;
  dispositionReasonCodes: readonly string[];
}
export interface C1MappedTopic {
  microNodes: readonly {
    sourceBlockIndices: readonly number[];
    supportingMaterialIndices: readonly number[];
    exercises: readonly { blockIndex: number }[];
  }[];
  additionalExercises?: readonly { blockIndex: number }[];
}

/** Invoke after existing durable source validation, before mapping persistence. */
export function auditPersistableC1TaskCoverage(
  sources: readonly C1PersistedSourceBlock[],
  topics: readonly C1MappedTopic[],
): C1CoverageReport {
  const attachedTasks = new Set<number>();
  const coveredKnowledge = new Set<number>();
  for (const topic of topics) {
    for (const node of topic.microNodes) {
      node.exercises.forEach(exercise => attachedTasks.add(exercise.blockIndex));
      node.sourceBlockIndices.forEach(index => coveredKnowledge.add(index));
      node.supportingMaterialIndices.forEach(index => coveredKnowledge.add(index));
    }
    topic.additionalExercises?.forEach(exercise => attachedTasks.add(exercise.blockIndex));
  }
  const rows: C1SourceDisposition[] = sources.map(source => {
    const index = source.sourceBlockIndex;
    const task = ["EXERCISE", "ACTIVITY", "HOMEWORK"].includes(source.blockType);
    const outsideLesson = source.primaryDisposition === "EXCLUDED_WITH_REASON"
      && source.dispositionReasonCodes.includes("ADJACENT_NEXT_SECTION");
    const unresolved = source.primaryDisposition.startsWith("UNRESOLVED");
    const kind: C1SourceDisposition["kind"] = task ? source.blockType as "EXERCISE" | "ACTIVITY" | "HOMEWORK" : "KNOWLEDGE";
    let disposition: C1SourceDisposition["disposition"];
    if (outsideLesson) disposition = "EXCLUDED";
    else if (attachedTasks.has(index)) disposition = "ATTACHED_TASK";
    else if (unresolved || source.primaryDisposition === "UNRESOLVED_VISUAL_OR_FORMULA") disposition = "REVIEW_REQUIRED";
    else if (task) disposition = "EXCLUDED";
    else if (coveredKnowledge.has(index)) disposition = "MICRONODE";
    else disposition = "REVIEW_REQUIRED";

    // Adjacent next-section task records are explicitly outside the mapped lesson.
    // They are retained as CONTEXT to avoid conflating intentional scope-exclusion
    // with a lost in-scope exercise.
    return {
      sourceBlockId: String(index),
      kind: outsideLesson ? "CONTEXT" : kind,
      disposition,
      reason: outsideLesson ? "ADJACENT_NEXT_SECTION" : undefined,
    };
  });
  return auditC1SourceDispositions(rows.map(row => row.sourceBlockId), rows);
}
