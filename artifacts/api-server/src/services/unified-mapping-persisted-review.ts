/**
 * Read-only bridge from existing canonical lesson tables to strict quality report.
 * This does not alter legacy approval and must only be used for new unified maps.
 */
import {
  db, lessonsTable, lessonNodesTable, lessonNodeCognitiveLevelsTable,
  lessonOutcomesTable, lessonOutcomeNodeAlignmentsTable, lessonExercisesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { validateLessonForFinalApproval } from "../lib/lesson-final-approval.js";
import { evaluatePersistedUnifiedMapEvidence } from "./unified-mapping-persisted-evidence.js";

export async function reviewPersistedUnifiedMap(lessonId: number) {
  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) throw new Error(`Lesson ${lessonId} not found`);
  const [finalApproval, nodes, outcomes, alignments, exercises] = await Promise.all([
    validateLessonForFinalApproval(lessonId),
    db.select({ id: lessonNodesTable.id }).from(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId)),
    db.select({ id: lessonOutcomesTable.id }).from(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId, lessonId)),
    db.select({ outcomeId: lessonOutcomeNodeAlignmentsTable.lessonOutcomeId, nodeId: lessonOutcomeNodeAlignmentsTable.lessonNodeId, role: lessonOutcomeNodeAlignmentsTable.role })
      .from(lessonOutcomeNodeAlignmentsTable).where(eq(lessonOutcomeNodeAlignmentsTable.lessonId, lessonId)),
    db.select({ sourceType: lessonExercisesTable.sourceType }).from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId, lessonId)),
  ]);
  const ids = nodes.map(node => node.id);
  const levels = ids.length
    ? await db.select({ lessonNodeId: lessonNodeCognitiveLevelsTable.lessonNodeId, isTargetCeiling: lessonNodeCognitiveLevelsTable.isTargetCeiling })
      .from(lessonNodeCognitiveLevelsTable).where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, ids))
    : [];
  const levelsByNode = new Map<number, typeof levels>();
  for (const level of levels) levelsByNode.set(level.lessonNodeId, [...(levelsByNode.get(level.lessonNodeId) ?? []), level]);
  const metadata = (lesson.mappingMetadata ?? {}) as Record<string, unknown>;
  const sourceBaseline = typeof metadata.sourceExerciseCount === "number"
    && Number.isInteger(metadata.sourceExerciseCount) && metadata.sourceExerciseCount >= 0
    ? metadata.sourceExerciseCount : null;
  const nodeIds = new Set(ids);
  const requiredOutcomeIds = new Set(alignments.filter(a => a.role === "REQUIRED" && nodeIds.has(a.nodeId)).map(a => a.outcomeId));
  const canonicalOutcomeIds = new Set(outcomes.map(o => o.id));
  return evaluatePersistedUnifiedMapEvidence({
    finalApproval,
    nodeCount: ids.length,
    cognitiveNodeCount: ids.filter(id => (levelsByNode.get(id)?.length ?? 0) > 0).length,
    validCognitiveTargetNodeCount: ids.filter(id => (levelsByNode.get(id) ?? []).filter(level => level.isTargetCeiling).length === 1).length,
    outcomeCount: canonicalOutcomeIds.size,
    outcomesWithRequiredNodeCount: [...canonicalOutcomeIds].filter(id => requiredOutcomeIds.has(id)).length,
    expectedTextbookTaskCount: sourceBaseline,
    preservedTextbookTaskCount: exercises.filter(ex => ex.sourceType === "textbook").length,
  });
}
