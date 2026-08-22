/**
 * C4 — Trustworthy learner cognitive ceiling.
 *
 * This is the single backend-owned projection from C3 evidence to durable
 * learner × MicroNode cognitive state. It deliberately does not change the
 * separate mastery/confidence scoring projection.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  evidenceEventsTable,
  knowledgeNodesTable,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
} from "@workspace/db";
import { assessAcceptedCognitivePath } from "../lib/cognitive-path-grounding.js";

const PERMITTED_EVIDENCE_QUALITIES = new Set([
  "MODERATE",
  "STRONG",
  "CONCLUSIVE",
]);

const INDEPENDENT_ASSISTANCE_LEVELS = new Set(["none", "light"]);

export type LearnerCeilingPathLevel = {
  id: number;
  cognitiveLevel: string;
  sequence: number;
  isApplicable: boolean;
  isTargetCeiling: boolean;
  minimumIndependentEvidence: number;
  performanceObjective: string | null;
  successCriterion: string | null;
  preferredInteractionTypes: unknown;
};

export type LearnerCeilingEvidence = {
  id: number;
  lessonNodeId: number | null;
  cognitiveLevelId: number | null;
  qualificationStatus: string | null;
  wasCorrect: boolean | null;
  evidenceQuality: string | null;
  assistanceLevel: string | null;
  helpCount: number | null;
  taskSource: string | null;
  taskReference: string | null;
  lessonExerciseId: number | null;
  quizQuestionId: number | null;
  createdAt: Date | null;
};

export type LearnerCeilingComputation = {
  ceiling: LearnerCeilingPathLevel | null;
  qualifyingTaskCounts: Map<number, number>;
  latestQualifyingEvidence: LearnerCeilingEvidence | null;
};

export type LearnerCeilingProjection = {
  userId: number;
  lessonNodeId: number;
  pathAccepted: boolean;
  reason: string;
  calculatedCeilingLevelId: number | null;
  ceilingLevelId: number | null;
  ceilingLevel: string | null;
  reachedTarget: boolean;
  persisted: boolean;
  qualifyingTaskCounts: Record<number, number>;
};

export type LearnerCeilingProjectionOptions = {
  /**
   * Chat's bounded-remediation signal. The projector applies it while holding
   * the learner-node lock, and target confirmation takes precedence over it.
   */
  revisitRequest?: {
    reason: string | null;
    /** Preserve an earlier remediation reason when the marker already exists. */
    onlyIfUnset?: boolean;
  };
};

function hasValidTaskIdentity(evidence: LearnerCeilingEvidence): boolean {
  if (!evidence.taskReference?.trim()) return false;

  switch (evidence.taskSource) {
    case "micro_check":
    case "generated_task":
      return evidence.taskReference.startsWith(`${evidence.taskSource}:`);
    case "source_exercise":
      return evidence.lessonExerciseId !== null &&
        evidence.taskReference.startsWith("source_exercise:");
    case "quiz_question":
      return evidence.quizQuestionId !== null &&
        evidence.taskReference.startsWith("quiz_question:");
    default:
      return false;
  }
}

export function isQualifyingIndependentEvidence(
  evidence: LearnerCeilingEvidence,
  lessonNodeId: number,
  acceptedLevelIds: ReadonlySet<number>,
): boolean {
  return (
    evidence.qualificationStatus === "qualified" &&
    evidence.lessonNodeId === lessonNodeId &&
    evidence.cognitiveLevelId !== null &&
    acceptedLevelIds.has(evidence.cognitiveLevelId) &&
    evidence.wasCorrect === true &&
    evidence.evidenceQuality !== null &&
    PERMITTED_EVIDENCE_QUALITIES.has(evidence.evidenceQuality) &&
    (evidence.helpCount ?? 0) <= 1 &&
    evidence.assistanceLevel !== null &&
    INDEPENDENT_ASSISTANCE_LEVELS.has(evidence.assistanceLevel) &&
    hasValidTaskIdentity(evidence)
  );
}

/**
 * Calculates the highest sufficiently demonstrated contiguous prefix.
 * Repeated writes/retries for the exact same stable task reference count once.
 */
export function computeContiguousLearnerCognitiveCeiling(input: {
  lessonNodeId: number;
  acceptedPath: readonly LearnerCeilingPathLevel[];
  evidence: readonly LearnerCeilingEvidence[];
}): LearnerCeilingComputation {
  const path = [...input.acceptedPath]
    .filter((level) => level.isApplicable)
    .sort((a, b) => a.sequence - b.sequence);
  const acceptedLevelIds = new Set(path.map((level) => level.id));
  const qualifying = input.evidence.filter((evidence) =>
    isQualifyingIndependentEvidence(
      evidence,
      input.lessonNodeId,
      acceptedLevelIds,
    ),
  );
  const referencesByLevel = new Map<number, Set<string>>();

  for (const evidence of qualifying) {
    const levelId = evidence.cognitiveLevelId!;
    const references = referencesByLevel.get(levelId) ?? new Set<string>();
    references.add(evidence.taskReference!);
    referencesByLevel.set(levelId, references);
  }

  const qualifyingTaskCounts = new Map<number, number>(
    path.map((level) => [level.id, referencesByLevel.get(level.id)?.size ?? 0]),
  );

  let ceiling: LearnerCeilingPathLevel | null = null;
  for (const level of path) {
    if ((qualifyingTaskCounts.get(level.id) ?? 0) < level.minimumIndependentEvidence) {
      break;
    }
    ceiling = level;
  }

  const latestQualifyingEvidence = ceiling === null
    ? null
    : qualifying
      .filter((evidence) => evidence.cognitiveLevelId === ceiling!.id)
      .sort((a, b) => {
        const aTime = a.createdAt?.getTime() ?? 0;
        const bTime = b.createdAt?.getTime() ?? 0;
        return bTime - aTime || b.id - a.id;
      })[0] ?? null;

  return { ceiling, qualifyingTaskCounts, latestQualifyingEvidence };
}

/**
 * Reads C2's accepted path, projects C3-qualified evidence, and atomically
 * persists a monotonic canonical ceiling. It never infers a level from legacy
 * text-only state and never deletes or rewrites legacy evidence.
 */
export async function projectLearnerCognitiveCeiling(
  userId: number,
  lessonNodeId: number,
  options: LearnerCeilingProjectionOptions = {},
): Promise<LearnerCeilingProjection> {
  return db.transaction(async (tx) => {
    // Serialize competing Chat/Quiz projections for this learner × MicroNode.
    await tx.execute(sql`
      SELECT id
      FROM knowledge_nodes
      WHERE user_id = ${userId} AND lesson_node_id = ${lessonNodeId}
      FOR UPDATE
    `);

    const [learnerNode] = await tx
      .select({
        id: knowledgeNodesTable.id,
        demonstratedCognitiveLevel: knowledgeNodesTable.demonstratedCognitiveLevel,
        demonstratedCognitiveLevelId: knowledgeNodesTable.demonstratedCognitiveLevelId,
        revisitRequired: knowledgeNodesTable.revisitRequired,
        demonstratedCognitiveEvidenceReference:
          knowledgeNodesTable.demonstratedCognitiveEvidenceReference,
      })
      .from(knowledgeNodesTable)
      .where(and(
        eq(knowledgeNodesTable.userId, userId),
        eq(knowledgeNodesTable.lessonNodeId, lessonNodeId),
      ))
      .limit(1);

    const empty = (reason: string, pathAccepted = false): LearnerCeilingProjection => ({
      userId,
      lessonNodeId,
      pathAccepted,
      reason,
      calculatedCeilingLevelId: null,
      // A rejected path or legacy-only row cannot claim a C4 ceiling. Existing
      // state is preserved in the database but deliberately not emitted as a
      // trustworthy projection result.
      ceilingLevelId: null,
      ceilingLevel: null,
      reachedTarget: false,
      persisted: false,
      qualifyingTaskCounts: {},
    });

    if (!learnerNode) return empty("LEARNER_NODE_MISSING");

    const [node] = await tx
      .select({
        id: lessonNodesTable.id,
        theoryContent: lessonNodesTable.theoryContent,
        learningObjective: lessonNodesTable.learningObjective,
        cogPathStatus: lessonNodesTable.cogPathStatus,
      })
      .from(lessonNodesTable)
      .where(eq(lessonNodesTable.id, lessonNodeId))
      .limit(1);
    if (!node) return empty("MICRONODE_MISSING");

    const path = await tx
      .select({
        id: lessonNodeCognitiveLevelsTable.id,
        cognitiveLevel: lessonNodeCognitiveLevelsTable.cognitiveLevel,
        sequence: lessonNodeCognitiveLevelsTable.sequence,
        isApplicable: lessonNodeCognitiveLevelsTable.isApplicable,
        isTargetCeiling: lessonNodeCognitiveLevelsTable.isTargetCeiling,
        minimumIndependentEvidence:
          lessonNodeCognitiveLevelsTable.minimumIndependentEvidence,
        performanceObjective: lessonNodeCognitiveLevelsTable.performanceObjective,
        successCriterion: lessonNodeCognitiveLevelsTable.successCriterion,
        preferredInteractionTypes:
          lessonNodeCognitiveLevelsTable.preferredInteractionTypes,
      })
      .from(lessonNodeCognitiveLevelsTable)
      .where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId, lessonNodeId))
      .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));

    const acceptance = assessAcceptedCognitivePath({
      cogPathStatus: node.cogPathStatus,
      theoryContent: node.theoryContent,
      learningObjective: node.learningObjective,
      levels: path,
    });
    if (!acceptance.accepted) return empty(acceptance.reason);

    const evidence = await tx
      .select({
        id: evidenceEventsTable.id,
        lessonNodeId: evidenceEventsTable.lessonNodeId,
        cognitiveLevelId: evidenceEventsTable.cognitiveLevelId,
        qualificationStatus: evidenceEventsTable.qualificationStatus,
        wasCorrect: evidenceEventsTable.wasCorrect,
        evidenceQuality: evidenceEventsTable.evidenceQuality,
        assistanceLevel: evidenceEventsTable.assistanceLevel,
        helpCount: evidenceEventsTable.helpCount,
        taskSource: evidenceEventsTable.taskSource,
        taskReference: evidenceEventsTable.taskReference,
        lessonExerciseId: evidenceEventsTable.lessonExerciseId,
        quizQuestionId: evidenceEventsTable.quizQuestionId,
        createdAt: evidenceEventsTable.createdAt,
      })
      .from(evidenceEventsTable)
      .where(and(
        eq(evidenceEventsTable.userId, userId),
        eq(evidenceEventsTable.lessonNodeId, lessonNodeId),
        eq(evidenceEventsTable.eventType, "answer"),
      ));

    const computation = computeContiguousLearnerCognitiveCeiling({
      lessonNodeId,
      acceptedPath: path,
      evidence,
    });
    const pathById = new Map(path.map((level) => [level.id, level]));
    const pathIndexById = new Map(path.map((level, index) => [level.id, index]));
    const calculated = computation.ceiling;
    const calculatedIndex = calculated
      ? pathIndexById.get(calculated.id) ?? -1
      : -1;
    const existingCanonicalIndex = learnerNode.demonstratedCognitiveLevelId === null
      ? -1
      : pathIndexById.get(learnerNode.demonstratedCognitiveLevelId) ?? -1;
    // C4 never derives, protects, or returns a ceiling from the legacy text
    // snapshot. Only a canonical ID that was persisted by this projector may
    // establish a monotonic floor.
    const shouldPromote = calculated !== null && calculatedIndex >= existingCanonicalIndex;
    const effectiveLevel = shouldPromote
      ? calculated
      : learnerNode.demonstratedCognitiveLevelId === null
        ? null
        : pathById.get(learnerNode.demonstratedCognitiveLevelId) ?? null;
    const effectiveCanonicalId = effectiveLevel?.id ?? null;
    const reachedTarget = effectiveLevel?.isTargetCeiling === true;

    const updates: Record<string, unknown> = {};
    if (
      shouldPromote &&
      calculated !== null &&
      (
        learnerNode.demonstratedCognitiveLevelId !== calculated.id ||
        learnerNode.demonstratedCognitiveLevel !== calculated.cognitiveLevel
      )
    ) {
      updates.demonstratedCognitiveLevelId = calculated.id;
      updates.demonstratedCognitiveLevel = calculated.cognitiveLevel;
      updates.demonstratedCognitiveLevelUpdatedAt = new Date();
      updates.demonstratedCognitiveEvidenceReference =
        computation.latestQualifyingEvidence?.taskReference ?? null;
    }
    if (reachedTarget) {
      updates.revisitRequired = false;
      updates.revisitReason = null;
    } else if (
      options.revisitRequest &&
      (!options.revisitRequest.onlyIfUnset || !learnerNode.revisitRequired)
    ) {
      updates.revisitRequired = true;
      updates.revisitReason = options.revisitRequest.reason;
    }
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await tx
        .update(knowledgeNodesTable)
        .set(updates as typeof knowledgeNodesTable.$inferInsert)
        .where(eq(knowledgeNodesTable.id, learnerNode.id));
    }

    return {
      userId,
      lessonNodeId,
      pathAccepted: true,
      reason: "ACCEPTED",
      calculatedCeilingLevelId: calculated?.id ?? null,
      ceilingLevelId: effectiveCanonicalId,
      ceilingLevel: effectiveLevel?.cognitiveLevel ?? null,
      reachedTarget,
      persisted: Object.keys(updates).length > 0,
      qualifyingTaskCounts: Object.fromEntries(computation.qualifyingTaskCounts),
    };
  });
}