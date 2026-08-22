/**
 * C5 — Canonical Knowledge Tree state projection.
 *
 * C5 is deliberately a read-time classifier. C4 remains the only writer and
 * owner of demonstrated cognitive ceiling state; mastery/confidence remain
 * supporting metrics owned by the scoring engine.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import {
  db,
  evidenceEventsTable,
  knowledgeNodesTable,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
} from "@workspace/db";
import { assessAcceptedCognitivePath } from "../lib/cognitive-path-grounding.js";
import {
  computeContiguousLearnerCognitiveCeiling,
  isQualifyingIndependentEvidence,
  type LearnerCeilingEvidence,
  type LearnerCeilingPathLevel,
} from "./learner-cognitive-ceiling.js";

export const KNOWLEDGE_STATES = [
  "MASTERED",
  "PARTIAL",
  "NOT_KNOWN",
  "NOT_STUDIED",
] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];

export type CoverageState = "STUDIED" | "NOT_STUDIED";

export type CognitiveLevelSummary = {
  id: number;
  cognitiveLevel: string;
  sequence: number;
};

export type KnowledgeStateResult = {
  knowledgeState: KnowledgeState;
  knowledgeStateLabel: string;
  coverageState: CoverageState;
  meaningfulAttemptCount: number;
  qualifyingEvidenceCount: number;
  targetCognitiveLevel: CognitiveLevelSummary | null;
  demonstratedCognitiveLevel: CognitiveLevelSummary | null;
  remainingCognitiveLevels: string[];
  stateReason:
    | "TARGET_REACHED"
    | "DEMONSTRATED_BELOW_TARGET"
    | "ATTEMPTED_WITHOUT_TRUSTWORTHY_CEILING"
    | "NO_MEANINGFUL_ATTEMPT"
    | "PATH_NOT_USABLE";
};

export type KnowledgeTreeState = KnowledgeStateResult & {
  lessonNodeId: number;
  masteryScore: number;
  confidenceScore: number | null;
};

type ClassifierPathLevel = Pick<
  LearnerCeilingPathLevel,
  | "id"
  | "cognitiveLevel"
  | "sequence"
  | "isApplicable"
  | "isTargetCeiling"
  | "minimumIndependentEvidence"
  | "performanceObjective"
  | "successCriterion"
  | "preferredInteractionTypes"
>;

type ClassifierEvidence = Pick<
  LearnerCeilingEvidence,
  | "id"
  | "lessonNodeId"
  | "cognitiveLevelId"
  | "qualificationStatus"
  | "wasCorrect"
  | "evidenceQuality"
  | "assistanceLevel"
  | "helpCount"
  | "taskSource"
  | "taskReference"
  | "lessonExerciseId"
  | "quizQuestionId"
  | "createdAt"
> & {
  topicId: number | null;
};

const LABELS: Record<KnowledgeState, string> = {
  MASTERED: "Գիտի",
  PARTIAL: "Մասնակի գիտի",
  NOT_KNOWN: "Չգիտի",
  NOT_STUDIED: "Դեռ չի ուսումնասիրել",
};

export type KnowledgeStateClassifierInput = {
  pathAccepted: boolean;
  path: readonly ClassifierPathLevel[];
  /**
   * C5 does not trust a database level ID by itself. The batch resolver sets
   * this only after current accepted-path C3 evidence validates the persisted
   * C4 projection.
   */
  demonstratedCeilingTrusted: boolean;
  demonstratedCognitiveLevelId: number | null;
  meaningfulAttemptCount: number;
  qualifyingEvidenceCount?: number;
};

function levelSummary(level: ClassifierPathLevel | null): CognitiveLevelSummary | null {
  return level
    ? { id: level.id, cognitiveLevel: level.cognitiveLevel, sequence: level.sequence }
    : null;
}

/**
 * Pure C5 decision table. Cognitive level identity is compared by accepted
 * C2 path order, never by the legacy Bloom integer or string ordering.
 */
export function classifyKnowledgeState(
  input: KnowledgeStateClassifierInput,
): KnowledgeStateResult {
  const path = [...input.path]
    .filter((level) => level.isApplicable)
    .sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const targetIndex = path.findIndex((level) => level.isTargetCeiling);
  const target = targetIndex >= 0 ? path[targetIndex] : null;
  const demonstratedIndex = path.findIndex(
    (level) =>
      input.demonstratedCeilingTrusted &&
      level.id === input.demonstratedCognitiveLevelId,
  );
  const demonstrated =
    demonstratedIndex >= 0 ? path[demonstratedIndex] : null;
  const studied = input.meaningfulAttemptCount > 0;
  const coverageState: CoverageState = studied ? "STUDIED" : "NOT_STUDIED";

  if (!input.pathAccepted || target === null) {
    const knowledgeState: KnowledgeState = studied ? "NOT_KNOWN" : "NOT_STUDIED";
    return {
      knowledgeState,
      knowledgeStateLabel: LABELS[knowledgeState],
      coverageState,
      meaningfulAttemptCount: input.meaningfulAttemptCount,
      qualifyingEvidenceCount: input.qualifyingEvidenceCount ?? 0,
      targetCognitiveLevel: null,
      demonstratedCognitiveLevel: null,
      remainingCognitiveLevels: [],
      stateReason: "PATH_NOT_USABLE",
    };
  }

  // A C4 ceiling is always evidence-derived. Still, a read-time C5 projection
  // must never let a stale/directly-written ID turn a never-attempted node into
  // learned state.
  if (!studied) {
    return {
      knowledgeState: "NOT_STUDIED",
      knowledgeStateLabel: LABELS.NOT_STUDIED,
      coverageState,
      meaningfulAttemptCount: input.meaningfulAttemptCount,
      qualifyingEvidenceCount: input.qualifyingEvidenceCount ?? 0,
      targetCognitiveLevel: levelSummary(target),
      demonstratedCognitiveLevel: null,
      remainingCognitiveLevels: path
        .slice(0, targetIndex + 1)
        .map((level) => level.cognitiveLevel),
      stateReason: "NO_MEANINGFUL_ATTEMPT",
    };
  }

  if (demonstratedIndex >= targetIndex) {
    return {
      knowledgeState: "MASTERED",
      knowledgeStateLabel: LABELS.MASTERED,
      coverageState,
      meaningfulAttemptCount: input.meaningfulAttemptCount,
      qualifyingEvidenceCount: input.qualifyingEvidenceCount ?? 0,
      targetCognitiveLevel: levelSummary(target),
      demonstratedCognitiveLevel: levelSummary(demonstrated),
      remainingCognitiveLevels: [],
      stateReason: "TARGET_REACHED",
    };
  }

  if (demonstrated !== null && demonstratedIndex >= 0) {
    return {
      knowledgeState: "PARTIAL",
      knowledgeStateLabel: LABELS.PARTIAL,
      coverageState,
      meaningfulAttemptCount: input.meaningfulAttemptCount,
      qualifyingEvidenceCount: input.qualifyingEvidenceCount ?? 0,
      targetCognitiveLevel: levelSummary(target),
      demonstratedCognitiveLevel: levelSummary(demonstrated),
      remainingCognitiveLevels: path
        .slice(demonstratedIndex + 1, targetIndex + 1)
        .map((level) => level.cognitiveLevel),
      stateReason: "DEMONSTRATED_BELOW_TARGET",
    };
  }

  const knowledgeState: KnowledgeState = studied ? "NOT_KNOWN" : "NOT_STUDIED";
  return {
    knowledgeState,
    knowledgeStateLabel: LABELS[knowledgeState],
    coverageState,
    meaningfulAttemptCount: input.meaningfulAttemptCount,
    qualifyingEvidenceCount: input.qualifyingEvidenceCount ?? 0,
    targetCognitiveLevel: levelSummary(target),
    demonstratedCognitiveLevel: null,
    remainingCognitiveLevels: path
      .slice(0, targetIndex + 1)
      .map((level) => level.cognitiveLevel),
    stateReason: studied
      ? "ATTEMPTED_WITHOUT_TRUSTWORTHY_CEILING"
      : "NO_MEANINGFUL_ATTEMPT",
  };
}

export type KnowledgeStateCoverage = {
  totalUnits: number;
  studiedCount: number;
  notStudiedCount: number;
  coveragePercent: number | null;
  masteredCount: number;
  partialCount: number;
  doesNotKnowCount: number;
  notStartedCount: number;
};

/**
 * The only C5 hierarchy roll-up. Every aggregate is calculated from the same
 * canonical node state that the tree and detail routes expose.
 */
export function aggregateCanonicalKnowledgeState(
  nodes: ReadonlyArray<Pick<KnowledgeStateResult, "knowledgeState">>,
): KnowledgeStateCoverage {
  const totalUnits = nodes.length;
  let masteredCount = 0;
  let partialCount = 0;
  let doesNotKnowCount = 0;
  let notStartedCount = 0;

  for (const node of nodes) {
    switch (node.knowledgeState) {
      case "MASTERED":
        masteredCount++;
        break;
      case "PARTIAL":
        partialCount++;
        break;
      case "NOT_KNOWN":
        doesNotKnowCount++;
        break;
      case "NOT_STUDIED":
        notStartedCount++;
        break;
    }
  }

  const studiedCount = masteredCount + partialCount + doesNotKnowCount;
  return {
    totalUnits,
    studiedCount,
    notStudiedCount: notStartedCount,
    coveragePercent:
      totalUnits === 0 ? null : Math.round((studiedCount / totalUnits) * 100),
    masteredCount,
    partialCount,
    doesNotKnowCount,
    notStartedCount,
  };
}

type StateNodeRow = {
  lessonNodeId: number;
  theoryContent: string | null;
  learningObjective: string | null;
  cogPathStatus: string | null;
  masteryScore: number | null;
  confidenceScore: number | null;
  demonstratedCognitiveLevelId: number | null;
};

type StateNodeInput = Pick<
  StateNodeRow,
  | "lessonNodeId"
  | "theoryContent"
  | "learningObjective"
  | "cogPathStatus"
>;

function emptyStateForNode(
  node: StateNodeInput,
  result: KnowledgeStateResult,
  learnerNode: Pick<
    StateNodeRow,
    "masteryScore" | "confidenceScore" | "demonstratedCognitiveLevelId"
  > | undefined,
): KnowledgeTreeState {
  return {
    lessonNodeId: node.lessonNodeId,
    masteryScore: learnerNode?.masteryScore ?? 0,
    confidenceScore: learnerNode?.confidenceScore ?? null,
    ...result,
  };
}

/**
 * Resolves all C5 state in bounded batch queries. Legacy evidence can establish
 * that a learner attempted a node only when its topic_id points to that
 * learner's KN row; it can never establish a cognitive level.
 */
export async function resolveKnowledgeTreeStates(
  userId: number,
  lessonNodeIds: readonly number[],
): Promise<Map<number, KnowledgeTreeState>> {
  const uniqueNodeIds = [...new Set(lessonNodeIds)];
  const result = new Map<number, KnowledgeTreeState>();
  if (uniqueNodeIds.length === 0) return result;

  const [nodes, paths, knowledgeNodes] = await Promise.all([
    db
      .select({
        lessonNodeId: lessonNodesTable.id,
        theoryContent: lessonNodesTable.theoryContent,
        learningObjective: lessonNodesTable.learningObjective,
        cogPathStatus: lessonNodesTable.cogPathStatus,
      })
      .from(lessonNodesTable)
      .where(inArray(lessonNodesTable.id, uniqueNodeIds)),
    db
      .select({
        id: lessonNodeCognitiveLevelsTable.id,
        lessonNodeId: lessonNodeCognitiveLevelsTable.lessonNodeId,
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
      .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, uniqueNodeIds))
      .orderBy(lessonNodeCognitiveLevelsTable.sequence),
    db
      .select({
        id: knowledgeNodesTable.id,
        lessonNodeId: knowledgeNodesTable.lessonNodeId,
        masteryScore: knowledgeNodesTable.masteryScore,
        confidenceScore: knowledgeNodesTable.confidenceScore,
        demonstratedCognitiveLevelId:
          knowledgeNodesTable.demonstratedCognitiveLevelId,
         demonstratedCognitiveEvidenceReference:
           knowledgeNodesTable.demonstratedCognitiveEvidenceReference,
      })
      .from(knowledgeNodesTable)
      .where(
        and(
          eq(knowledgeNodesTable.userId, userId),
          inArray(knowledgeNodesTable.lessonNodeId, uniqueNodeIds),
        ),
      ),
  ]);

  const nodeMap = new Map(nodes.map((node) => [node.lessonNodeId, node]));
  const pathMap = new Map<number, ClassifierPathLevel[]>();
  for (const path of paths) {
    const list = pathMap.get(path.lessonNodeId) ?? [];
    list.push(path);
    pathMap.set(path.lessonNodeId, list);
  }
  const knowledgeNodeMap = new Map(
    knowledgeNodes
      .filter((node) => node.lessonNodeId !== null)
      .map((node) => [node.lessonNodeId!, node]),
  );
  const knowledgeNodeIds = knowledgeNodes.map((node) => node.id);

  const evidence = knowledgeNodeIds.length > 0
    ? await db
        .select({
          id: evidenceEventsTable.id,
          lessonNodeId: evidenceEventsTable.lessonNodeId,
          topicId: evidenceEventsTable.topicId,
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
        .where(
          and(
            eq(evidenceEventsTable.userId, userId),
            eq(evidenceEventsTable.eventType, "answer"),
            or(
              inArray(evidenceEventsTable.lessonNodeId, uniqueNodeIds),
              inArray(evidenceEventsTable.topicId, knowledgeNodeIds),
            ),
          ),
        )
    : [];

  const evidenceByNode = new Map<number, ClassifierEvidence[]>();
  const knowledgeNodeIdToLessonNodeId = new Map(
    knowledgeNodes
      .filter((node) => node.lessonNodeId !== null)
      .map((node) => [node.id, node.lessonNodeId!]),
  );
  for (const event of evidence) {
    const nodeId =
      event.lessonNodeId !== null && nodeMap.has(event.lessonNodeId)
        ? event.lessonNodeId
        : event.topicId !== null
          ? knowledgeNodeIdToLessonNodeId.get(event.topicId)
          : undefined;
    if (nodeId === undefined) continue;
    const list = evidenceByNode.get(nodeId) ?? [];
    list.push(event);
    evidenceByNode.set(nodeId, list);
  }

  for (const nodeId of uniqueNodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    const path = pathMap.get(nodeId) ?? [];
    const acceptance = assessAcceptedCognitivePath({
      cogPathStatus: node.cogPathStatus,
      theoryContent: node.theoryContent,
      learningObjective: node.learningObjective,
      levels: path,
    });
    const nodeEvidence = evidenceByNode.get(nodeId) ?? [];
    const meaningfulAttemptCount = nodeEvidence.filter(
      (event) => event.wasCorrect !== null,
    ).length;
    const acceptedLevelIds = new Set(
      path.filter((level) => level.isApplicable).map((level) => level.id),
    );
    const qualifyingEvidenceCount = nodeEvidence.filter((event) =>
      isQualifyingIndependentEvidence(event, nodeId, acceptedLevelIds),
    ).length;
    const computation = computeContiguousLearnerCognitiveCeiling({
      lessonNodeId: nodeId,
      acceptedPath: path,
      evidence: nodeEvidence,
    });
    const persistedLevelId =
      knowledgeNodeMap.get(nodeId)?.demonstratedCognitiveLevelId ?? null;
    const persistedReference =
      knowledgeNodeMap.get(nodeId)?.demonstratedCognitiveEvidenceReference ?? null;
    const persistedIndex = path.findIndex(
      (level) => level.isApplicable && level.id === persistedLevelId,
    );
    const computedIndex = computation.ceiling === null
      ? -1
      : path.findIndex((level) => level.id === computation.ceiling!.id);
    const demonstratedCeilingTrusted =
      acceptance.accepted &&
      persistedLevelId !== null &&
      persistedReference !== null &&
      persistedIndex >= 0 &&
      computedIndex >= persistedIndex &&
      nodeEvidence.some(
        (event) =>
          event.taskReference === persistedReference &&
          event.cognitiveLevelId === persistedLevelId &&
          isQualifyingIndependentEvidence(event, nodeId, acceptedLevelIds),
      );
    const classification = classifyKnowledgeState({
      pathAccepted: acceptance.accepted,
      path,
      demonstratedCeilingTrusted,
      demonstratedCognitiveLevelId: persistedLevelId,
      meaningfulAttemptCount,
      qualifyingEvidenceCount,
    });
    result.set(
      nodeId,
      emptyStateForNode(node, classification, knowledgeNodeMap.get(nodeId)),
    );
  }

  return result;
}