import {
  COGNITIVE_LEVEL_TO_BLOOM_INT,
  db,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  assessAcceptedCognitivePath,
  assessCognitivePathForConfirmation,
  resolveCanonicalQuizTarget,
  type CognitivePathAcceptance,
  type CognitivePathConfirmationAssessment,
} from "./cognitive-path-grounding.js";

/**
 * Preserve targetBloomLevel as a compatibility snapshot while a path is under
 * review. Canonical consumers remain blocked by cogPathStatus until a successful
 * confirmation refreshes the copy from the selected target.
 */
export function buildCognitivePathMutationInvalidationQuery(nodeId: number) {
  return sql`
    UPDATE ${lessonNodesTable}
    SET
      cog_path_status = CASE
        WHEN EXISTS (
          SELECT 1
          FROM ${lessonNodeCognitiveLevelsTable}
          WHERE ${lessonNodeCognitiveLevelsTable.lessonNodeId} = ${nodeId}
        ) THEN 'needs_review'
        ELSE NULL
      END,
      teaching_content_stale = CASE
        WHEN cog_path_status = 'confirmed'
          AND child_friendly_explanation IS NOT NULL
          THEN TRUE
        ELSE teaching_content_stale
      END
    WHERE
      id = ${nodeId}
  `;
}

export type CognitivePathReadState = "missing" | "review_required" | "confirmed";

export function deriveCognitivePathReadState(
  cogPathStatus: string | null | undefined,
  cognitiveLevelCount: number,
): CognitivePathReadState {
  if (cognitiveLevelCount === 0) return "missing";
  return cogPathStatus === "confirmed" ? "confirmed" : "review_required";
}

export async function updateAuthoredNodeAtCognitivePathBoundary(input: {
  lessonId: number;
  nodeId: number;
  patch: Partial<typeof lessonNodesTable.$inferInsert>;
  invalidatesCognitivePath: boolean;
  invalidatesTeachingContent: boolean;
  requiresAcceptedCognitivePath: boolean;
}): Promise<
  | { found: false }
  | {
      found: true;
      updated: false;
      acceptance: CognitivePathAcceptance;
    }
  | {
      found: true;
      updated: true;
      node: typeof lessonNodesTable.$inferSelect;
    }
> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT ${lessonNodesTable.id}
      FROM ${lessonNodesTable}
      WHERE ${lessonNodesTable.id} = ${input.nodeId}
        AND ${lessonNodesTable.lessonId} = ${input.lessonId}
      FOR UPDATE
    `);
    const [lockedNode] = await tx
      .select({
        id: lessonNodesTable.id,
        status: lessonNodesTable.status,
        cogPathStatus: lessonNodesTable.cogPathStatus,
        childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation,
        theoryContent: lessonNodesTable.theoryContent,
        learningObjective: lessonNodesTable.learningObjective,
      })
      .from(lessonNodesTable)
      .where(and(
        eq(lessonNodesTable.id, input.nodeId),
        eq(lessonNodesTable.lessonId, input.lessonId),
      ))
      .limit(1);
    if (!lockedNode) return { found: false };

    const patch: Partial<typeof lessonNodesTable.$inferInsert> = { ...input.patch };
    if (input.invalidatesCognitivePath && lockedNode.cogPathStatus === "confirmed") {
      patch.cogPathStatus = "needs_review";
      if (lockedNode.status === "approved") {
        patch.status = "needs_review";
      }
      if (input.invalidatesTeachingContent
        && lockedNode.childFriendlyExplanation !== null) {
        patch.teachingContentStale = true;
      }
    }

    if (input.requiresAcceptedCognitivePath) {
      const levels = await tx
        .select()
        .from(lessonNodeCognitiveLevelsTable)
        .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, input.nodeId));
      const acceptance = assessAcceptedCognitivePath({
        cogPathStatus: patch.cogPathStatus ?? lockedNode.cogPathStatus,
        theoryContent: patch.theoryContent !== undefined
          ? patch.theoryContent
          : lockedNode.theoryContent,
        learningObjective: patch.learningObjective !== undefined
          ? patch.learningObjective
          : lockedNode.learningObjective,
        levels,
      });
      if (!acceptance.accepted) {
        return { found: true, updated: false, acceptance };
      }
    }

    const [updated] = await tx
      .update(lessonNodesTable)
      .set(patch)
      .where(eq(lessonNodesTable.id, input.nodeId))
      .returning();
    if (!updated) return { found: false };
    if (input.invalidatesCognitivePath) {
      await tx.execute(buildCognitivePathMutationInvalidationQuery(input.nodeId));
      updated.cogPathStatus = deriveCognitivePathReadState(
        updated.cogPathStatus,
        (await tx.select({ id: lessonNodeCognitiveLevelsTable.id })
          .from(lessonNodeCognitiveLevelsTable)
          .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, input.nodeId))).length,
      ) === "missing" ? null : "needs_review";
    }
    return { found: true, updated: true, node: updated };
  });
}

export type ConfirmAuthoredCognitivePathResult =
  | { found: false }
  | {
      found: true;
      confirmed: false;
      assessment: Extract<CognitivePathConfirmationAssessment, { valid: false }>;
    }
  | {
      found: true;
      confirmed: true;
      nodeId: number;
      cogPathStatus: "confirmed";
      targetBloomLevel: number;
      assessment: Extract<CognitivePathConfirmationAssessment, { valid: true }>;
    };

export async function confirmAuthoredCognitivePath(
  lessonId: number,
  nodeId: number,
): Promise<ConfirmAuthoredCognitivePathResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT ${lessonNodesTable.id}
      FROM ${lessonNodesTable}
      WHERE ${lessonNodesTable.id} = ${nodeId}
        AND ${lessonNodesTable.lessonId} = ${lessonId}
      FOR UPDATE
    `);
    const [node] = await tx
      .select({
        id: lessonNodesTable.id,
        theoryContent: lessonNodesTable.theoryContent,
        learningObjective: lessonNodesTable.learningObjective,
      })
      .from(lessonNodesTable)
      .where(and(
        eq(lessonNodesTable.id, nodeId),
        eq(lessonNodesTable.lessonId, lessonId),
      ))
      .limit(1);
    if (!node) return { found: false };

    const levels = await tx
      .select()
      .from(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId))
      .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));
    const assessment = assessCognitivePathForConfirmation(node, levels);
    if (!assessment.valid) {
      return { found: true, confirmed: false, assessment };
    }

    const targetBloomLevel = COGNITIVE_LEVEL_TO_BLOOM_INT[
      assessment.target.cognitiveLevel as keyof typeof COGNITIVE_LEVEL_TO_BLOOM_INT
    ];
    if (!targetBloomLevel) {
      throw new Error("Canonical Cognitive Path target has no Bloom compatibility mapping");
    }

    await tx
      .update(lessonNodesTable)
      .set({
        cogPathStatus: "confirmed",
        targetBloomLevel,
      })
      .where(eq(lessonNodesTable.id, nodeId));

    const runtimeResolution = resolveCanonicalQuizTarget(
      {
        ...node,
        cogPathStatus: "confirmed",
        targetBloomLevel,
      },
      levels,
    );
    if (!runtimeResolution.valid) {
      throw new Error(`Confirmed Cognitive Path failed canonical target resolution: ${runtimeResolution.reason}`);
    }

    return {
      found: true,
      confirmed: true,
      nodeId,
      cogPathStatus: "confirmed",
      targetBloomLevel,
      assessment,
    };
  });
}

export type ReorderAuthoredCognitiveLevelsResult =
  | { found: false }
  | { found: true; valid: false; reason: "COGNITIVE_LEVEL_SET_MISMATCH" }
  | { found: true; valid: true; reordered: number };

export async function reorderAuthoredCognitiveLevels(
  lessonId: number,
  nodeId: number,
  orderedLevelIds: readonly number[],
): Promise<ReorderAuthoredCognitiveLevelsResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT ${lessonNodesTable.id}
      FROM ${lessonNodesTable}
      WHERE ${lessonNodesTable.id} = ${nodeId}
        AND ${lessonNodesTable.lessonId} = ${lessonId}
      FOR UPDATE
    `);
    const [node] = await tx
      .select({ id: lessonNodesTable.id })
      .from(lessonNodesTable)
      .where(and(
        eq(lessonNodesTable.id, nodeId),
        eq(lessonNodesTable.lessonId, lessonId),
      ))
      .limit(1);
    if (!node) return { found: false };

    const currentLevels = await tx
      .select({ id: lessonNodeCognitiveLevelsTable.id })
      .from(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId));
    const currentIds = new Set(currentLevels.map((level) => level.id));
    const requestedIds = new Set(orderedLevelIds);
    if (orderedLevelIds.length !== currentLevels.length
      || requestedIds.size !== orderedLevelIds.length
      || orderedLevelIds.some((levelId) => !currentIds.has(levelId))) {
      return {
        found: true,
        valid: false,
        reason: "COGNITIVE_LEVEL_SET_MISMATCH",
      };
    }

    for (let index = 0; index < orderedLevelIds.length; index += 1) {
      await tx
        .update(lessonNodeCognitiveLevelsTable)
        .set({ sequence: -(index + 1) })
        .where(and(
          eq(lessonNodeCognitiveLevelsTable.id, orderedLevelIds[index]),
          eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId),
        ));
    }
    for (let index = 0; index < orderedLevelIds.length; index += 1) {
      await tx
        .update(lessonNodeCognitiveLevelsTable)
        .set({ sequence: index + 1 })
        .where(and(
          eq(lessonNodeCognitiveLevelsTable.id, orderedLevelIds[index]),
          eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId),
        ));
    }
    await tx.execute(buildCognitivePathMutationInvalidationQuery(nodeId));
    return { found: true, valid: true, reordered: orderedLevelIds.length };
  });
}

export type DeleteAuthoredCognitiveLevelResult =
  | { found: false }
  | { found: true; deleted: false }
  | { found: true; deleted: true };

export async function deleteAuthoredCognitiveLevel(
  lessonId: number,
  nodeId: number,
  levelId: number,
): Promise<DeleteAuthoredCognitiveLevelResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT ${lessonNodesTable.id}
      FROM ${lessonNodesTable}
      WHERE ${lessonNodesTable.id} = ${nodeId}
        AND ${lessonNodesTable.lessonId} = ${lessonId}
      FOR UPDATE
    `);
    const [node] = await tx
      .select({ id: lessonNodesTable.id })
      .from(lessonNodesTable)
      .where(and(
        eq(lessonNodesTable.id, nodeId),
        eq(lessonNodesTable.lessonId, lessonId),
      ))
      .limit(1);
    if (!node) return { found: false };

    const [deleted] = await tx
      .delete(lessonNodeCognitiveLevelsTable)
      .where(and(
        eq(lessonNodeCognitiveLevelsTable.id, levelId),
        eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId),
      ))
      .returning({ id: lessonNodeCognitiveLevelsTable.id });
    if (!deleted) return { found: true, deleted: false };

    const remainingLevels = await tx
      .select({ id: lessonNodeCognitiveLevelsTable.id })
      .from(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId))
      .orderBy(
        asc(lessonNodeCognitiveLevelsTable.sequence),
        asc(lessonNodeCognitiveLevelsTable.id),
      );
    for (let index = 0; index < remainingLevels.length; index += 1) {
      await tx
        .update(lessonNodeCognitiveLevelsTable)
        .set({ sequence: -(index + 1) })
        .where(eq(lessonNodeCognitiveLevelsTable.id, remainingLevels[index].id));
    }
    for (let index = 0; index < remainingLevels.length; index += 1) {
      await tx
        .update(lessonNodeCognitiveLevelsTable)
        .set({ sequence: index + 1 })
        .where(eq(lessonNodeCognitiveLevelsTable.id, remainingLevels[index].id));
    }
    await tx.execute(buildCognitivePathMutationInvalidationQuery(nodeId));
    return { found: true, deleted: true };
  });
}