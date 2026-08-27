import {
  COGNITIVE_LEVELS,
  INTERACTION_TYPE_VALUES,
  db,
  lessonNodeCognitiveLevelsTable,
  type LessonNodeCognitiveLevel,
} from "@workspace/db";
import { and, eq, max, ne, sql } from "drizzle-orm";
import { buildCognitivePathMutationInvalidationQuery } from "./cognitive-path-authoring.js";

export type CognitiveLevelFields = {
  cognitiveLevel?: unknown;
  performanceObjective?: unknown;
  successCriterion?: unknown;
  minimumIndependentEvidence?: unknown;
  preferredInteractionTypes?: unknown;
  isApplicable?: unknown;
  isTargetCeiling?: unknown;
};

export function validateCognitiveLevelFields(
  input: CognitiveLevelFields,
  options: { requireCognitiveLevel: boolean },
): string | null {
  if (options.requireCognitiveLevel && input.cognitiveLevel === undefined) {
    return "cognitiveLevel required";
  }
  if (input.cognitiveLevel !== undefined
    && (typeof input.cognitiveLevel !== "string"
      || !(COGNITIVE_LEVELS as readonly string[]).includes(input.cognitiveLevel))) {
    return "Invalid cognitive level";
  }
  if (input.performanceObjective !== undefined
    && input.performanceObjective !== null
    && typeof input.performanceObjective !== "string") {
    return "performanceObjective must be a string or null";
  }
  if (input.successCriterion !== undefined
    && input.successCriterion !== null
    && typeof input.successCriterion !== "string") {
    return "successCriterion must be a string or null";
  }
  if (input.minimumIndependentEvidence !== undefined
    && (!Number.isInteger(input.minimumIndependentEvidence)
      || (input.minimumIndependentEvidence as number) < 1)) {
    return "minimumIndependentEvidence must be an integer >= 1";
  }
  if (input.preferredInteractionTypes !== undefined
    && (!Array.isArray(input.preferredInteractionTypes)
      || input.preferredInteractionTypes.some((item) => (
        typeof item !== "string"
        || !(INTERACTION_TYPE_VALUES as readonly string[]).includes(item)
      )))) {
    return "Invalid preferred interaction type";
  }
  if (input.isApplicable !== undefined && typeof input.isApplicable !== "boolean") {
    return "isApplicable must be boolean";
  }
  if (input.isTargetCeiling !== undefined && typeof input.isTargetCeiling !== "boolean") {
    return "isTargetCeiling must be boolean";
  }
  return null;
}

export async function createTeacherCognitiveLevel(
  nodeId: number,
  input: {
    cognitiveLevel: string;
    performanceObjective?: string | null;
    successCriterion?: string | null;
    minimumIndependentEvidence?: number;
    preferredInteractionTypes?: string[];
  },
): Promise<LessonNodeCognitiveLevel | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM lesson_nodes WHERE id = ${nodeId} FOR UPDATE`);
    const [duplicate] = await tx
      .select({ id: lessonNodeCognitiveLevelsTable.id })
      .from(lessonNodeCognitiveLevelsTable)
      .where(and(
        eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId),
        eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, input.cognitiveLevel),
      ))
      .limit(1);
    if (duplicate) return null;

    const [maximum] = await tx
      .select({ sequence: max(lessonNodeCognitiveLevelsTable.sequence) })
      .from(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId));
    const [inserted] = await tx.insert(lessonNodeCognitiveLevelsTable).values({
      lessonNodeId: nodeId,
      cognitiveLevel: input.cognitiveLevel,
      sequence: (maximum?.sequence ?? 0) + 1,
      isApplicable: true,
      isTargetCeiling: false,
      performanceObjective: input.performanceObjective || null,
      successCriterion: input.successCriterion || null,
      provenance: "teacher_authored",
      minimumIndependentEvidence: input.minimumIndependentEvidence ?? 3,
      preferredInteractionTypes: input.preferredInteractionTypes ?? [],
    }).returning();
    await tx.execute(buildCognitivePathMutationInvalidationQuery(nodeId));
    return inserted;
  });
}

export async function updateTeacherCognitiveLevel(
  nodeId: number,
  level: LessonNodeCognitiveLevel,
  input: {
    cognitiveLevel?: string;
    performanceObjective?: string | null;
    successCriterion?: string | null;
    minimumIndependentEvidence?: number;
    preferredInteractionTypes?: string[];
    isTargetCeiling?: boolean;
    isApplicable?: boolean;
  },
): Promise<LessonNodeCognitiveLevel | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM lesson_nodes WHERE id = ${nodeId} FOR UPDATE`);
    const [currentLevel] = await tx.select()
      .from(lessonNodeCognitiveLevelsTable)
      .where(and(
        eq(lessonNodeCognitiveLevelsTable.id, level.id),
        eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId),
      ))
      .limit(1);
    if (!currentLevel) return null;

    const nextCognitiveLevel = input.cognitiveLevel ?? currentLevel.cognitiveLevel;
    const nextIsTargetCeiling = input.isTargetCeiling ?? currentLevel.isTargetCeiling;

    if (input.cognitiveLevel !== undefined && input.cognitiveLevel !== currentLevel.cognitiveLevel) {
      const [duplicate] = await tx
        .select({ id: lessonNodeCognitiveLevelsTable.id })
        .from(lessonNodeCognitiveLevelsTable)
        .where(and(
          eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId),
          eq(lessonNodeCognitiveLevelsTable.cognitiveLevel, input.cognitiveLevel),
          ne(lessonNodeCognitiveLevelsTable.id, level.id),
        ))
        .limit(1);
      if (duplicate) return null;
    }

    const updates: Partial<typeof lessonNodeCognitiveLevelsTable.$inferInsert> = {
      provenance: "teacher_authored",
      updatedAt: new Date(),
    };
    if (input.cognitiveLevel !== undefined) updates.cognitiveLevel = input.cognitiveLevel;
    if (input.performanceObjective !== undefined) updates.performanceObjective = input.performanceObjective || null;
    if (input.successCriterion !== undefined) updates.successCriterion = input.successCriterion || null;
    if (input.minimumIndependentEvidence !== undefined) updates.minimumIndependentEvidence = input.minimumIndependentEvidence;
    if (input.preferredInteractionTypes !== undefined) updates.preferredInteractionTypes = input.preferredInteractionTypes;
    if (input.isApplicable !== undefined) updates.isApplicable = input.isApplicable;
    if (input.isTargetCeiling !== undefined) updates.isTargetCeiling = input.isTargetCeiling;

    if (nextIsTargetCeiling) {
      await tx
        .update(lessonNodeCognitiveLevelsTable)
        .set({ isTargetCeiling: false, updatedAt: new Date() })
        .where(and(
          eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId),
          eq(lessonNodeCognitiveLevelsTable.isTargetCeiling, true),
          ne(lessonNodeCognitiveLevelsTable.id, level.id),
        ));
    }

    const [updated] = await tx.update(lessonNodeCognitiveLevelsTable)
      .set(updates)
      .where(and(
        eq(lessonNodeCognitiveLevelsTable.id, level.id),
        eq(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeId),
      ))
      .returning();
    if (updated) {
      await tx.execute(buildCognitivePathMutationInvalidationQuery(nodeId));
    }
    return updated ?? null;
  });
}