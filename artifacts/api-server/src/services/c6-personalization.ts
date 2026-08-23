/**
 * C6 — Canonical personalization / next-learning decisions.
 *
 * This service decides WHAT the learner should work on next. It deliberately
 * consumes C2 acceptance, C4-backed C5 state, and persisted dependencies; it
 * never qualifies evidence, calculates a ceiling, or selects teaching tactics.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  lessonNodeCognitiveLevelsTable,
  lessonNodeDependenciesTable,
  lessonNodesTable,
} from "@workspace/db";
import { assessAcceptedCognitivePath } from "../lib/cognitive-path-grounding.js";
import {
  resolveKnowledgeTreeStates,
  type KnowledgeState,
} from "./knowledge-tree-state.js";

export const C6_ENTRY_INTENTS = ["NORMAL_LEARNING", "EXPLICIT_REVIEW"] as const;
export type C6EntryIntent = (typeof C6_ENTRY_INTENTS)[number];

export const C6_DECISION_TYPES = [
  "START",
  "CONTINUE",
  "REMEDIATE",
  "REVIEW",
  "ADVANCE",
] as const;
export type C6DecisionType = (typeof C6_DECISION_TYPES)[number];

export type C6PrerequisiteStatus =
  | "NOT_APPLICABLE"
  | "SATISFIED"
  | "REDIRECTED"
  | "INVALID_GRAPH";

export type C6ReasonCode =
  | "NO_MEANINGFUL_ATTEMPT"
  | "ATTEMPTED_WITHOUT_TRUSTWORTHY_CEILING"
  | "DEMONSTRATED_BELOW_TARGET"
  | "EXPLICIT_REVIEW"
  | "MASTERED_ADVANCE"
  | "REQUIRED_PREREQUISITE_UNSATISFIED"
  | "NO_ELIGIBLE_MICRONODE"
  | "C2_PATH_UNAVAILABLE"
  | "C4_CEILING_NOT_IN_ACCEPTED_PATH"
  | "TARGET_ALREADY_DEMONSTRATED"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_TARGET_MISSING";

export type C6PathLevel = {
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

export type C6NodeSnapshot = {
  id: number;
  sequence: number;
  knowledgeState: KnowledgeState;
  curriculumTargetCognitiveLevelId: number | null;
  demonstratedCognitiveLevelId: number | null;
  pathAccepted: boolean;
  cognitivePath: readonly C6PathLevel[];
};

export type C6DependencySnapshot = {
  fromNodeId: number;
  toNodeId: number;
  dependencyType: string;
};

export type C6Decision = {
  learnerId: number;
  lessonId: number;
  microNodeId: number | null;
  knowledgeState: KnowledgeState | null;
  curriculumTargetCognitiveLevelId: number | null;
  demonstratedCognitiveLevelId: number | null;
  nextTargetCognitiveLevelId: number | null;
  decisionType: C6DecisionType | null;
  reasonCode: C6ReasonCode;
  prerequisiteStatus: C6PrerequisiteStatus;
};

/** A null C6 target is terminal only for NO_ELIGIBLE_MICRONODE / ADVANCE. */
export function isC6DeliveryBlocked(decision: C6Decision): boolean {
  return decision.microNodeId === null && decision.decisionType === null;
}

export type ResolveC6DecisionInput = {
  learnerId: number;
  lessonId: number;
  entryIntent?: C6EntryIntent;
  /**
   * A Knowledge Tree action or current session target. The client can request a
   * node, but C6 still validates lesson membership, C5 state, and prerequisites.
   */
  requestedMicroNodeId?: number | null;
  /**
   * Completion routing starts strictly after this node. It keeps curriculum
   * advancement distinct from an ordinary lesson entry.
   */
  afterMicroNodeId?: number | null;
};

type PureC6DecisionInput = Omit<ResolveC6DecisionInput, "learnerId" | "lessonId"> & {
  learnerId?: number;
  lessonId?: number;
  nodes: readonly C6NodeSnapshot[];
  dependencies?: readonly C6DependencySnapshot[];
};

type NextLevelResult = {
  levelId: number | null;
  reasonCode:
    | "NO_MEANINGFUL_ATTEMPT"
    | "ATTEMPTED_WITHOUT_TRUSTWORTHY_CEILING"
    | "DEMONSTRATED_BELOW_TARGET"
    | "C2_PATH_UNAVAILABLE"
    | "C4_CEILING_NOT_IN_ACCEPTED_PATH"
    | "TARGET_ALREADY_DEMONSTRATED";
};

function orderedApplicablePath(node: C6NodeSnapshot): C6PathLevel[] {
  return [...node.cognitivePath]
    .filter((level) => level.isApplicable)
    .sort((a, b) => a.sequence - b.sequence || a.id - b.id);
}

/**
 * C6's only level-selection algorithm. It uses accepted C2 path identity and
 * sequence plus the C4 level already validated by C5; never Bloom magnitude.
 */
export function resolveNextCognitiveLevel(
  node: C6NodeSnapshot,
): NextLevelResult {
  const path = orderedApplicablePath(node);
  const targetIndex = path.findIndex(
    (level) => level.id === node.curriculumTargetCognitiveLevelId,
  );
  if (!node.pathAccepted || targetIndex < 0) {
    return { levelId: null, reasonCode: "C2_PATH_UNAVAILABLE" };
  }

  if (node.demonstratedCognitiveLevelId === null) {
    return {
      levelId: path[0]?.id ?? null,
      reasonCode:
        node.knowledgeState === "NOT_KNOWN"
          ? "ATTEMPTED_WITHOUT_TRUSTWORTHY_CEILING"
          : "NO_MEANINGFUL_ATTEMPT",
    };
  }

  const demonstratedIndex = path.findIndex(
    (level) => level.id === node.demonstratedCognitiveLevelId,
  );
  if (demonstratedIndex < 0) {
    return { levelId: null, reasonCode: "C4_CEILING_NOT_IN_ACCEPTED_PATH" };
  }
  if (demonstratedIndex >= targetIndex) {
    return { levelId: null, reasonCode: "TARGET_ALREADY_DEMONSTRATED" };
  }

  return {
    levelId: path[demonstratedIndex + 1]?.id ?? null,
    reasonCode: "DEMONSTRATED_BELOW_TARGET",
  };
}

function decisionTypeForState(state: KnowledgeState): C6DecisionType {
  switch (state) {
    case "NOT_STUDIED":
      return "START";
    case "NOT_KNOWN":
      return "REMEDIATE";
    case "PARTIAL":
      return "CONTINUE";
    case "MASTERED":
      return "ADVANCE";
  }
}

function unavailableDecision(
  input: PureC6DecisionInput,
  reasonCode: Extract<
    C6ReasonCode,
    | "NO_ELIGIBLE_MICRONODE"
    | "C2_PATH_UNAVAILABLE"
    | "DEPENDENCY_CYCLE"
    | "DEPENDENCY_TARGET_MISSING"
  >,
  prerequisiteStatus: C6PrerequisiteStatus,
): C6Decision {
  return {
    learnerId: input.learnerId ?? 0,
    lessonId: input.lessonId ?? 0,
    microNodeId: null,
    knowledgeState: null,
    curriculumTargetCognitiveLevelId: null,
    demonstratedCognitiveLevelId: null,
    nextTargetCognitiveLevelId: null,
    decisionType: reasonCode === "NO_ELIGIBLE_MICRONODE" ? "ADVANCE" : null,
    reasonCode,
    prerequisiteStatus,
  };
}

type PrerequisiteResolution =
  | { kind: "eligible"; node: C6NodeSnapshot; redirected: boolean }
  | { kind: "invalid"; reasonCode: "DEPENDENCY_CYCLE" | "DEPENDENCY_TARGET_MISSING" };

/**
 * Resolves only persisted REQUIRED edges. Sequential/supporting edges remain
 * instructional context, never a C6 hard block. Recursion terminates on cycles.
 */
function resolveRequiredPrerequisites(
  candidate: C6NodeSnapshot,
  byId: ReadonlyMap<number, C6NodeSnapshot>,
  dependencies: readonly C6DependencySnapshot[],
): PrerequisiteResolution {
  const validateGraph = (
    node: C6NodeSnapshot,
    ancestors: ReadonlySet<number>,
  ): Extract<PrerequisiteResolution, { kind: "invalid" }> | null => {
    if (ancestors.has(node.id)) {
      return { kind: "invalid", reasonCode: "DEPENDENCY_CYCLE" };
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node.id);
    const prerequisiteIds = dependencies
      .filter(
        (dependency) =>
          dependency.toNodeId === node.id &&
          dependency.dependencyType === "REQUIRED",
      )
      .map((dependency) => dependency.fromNodeId);
    for (const prerequisiteId of prerequisiteIds) {
      const prerequisite = byId.get(prerequisiteId);
      if (!prerequisite) {
        return { kind: "invalid", reasonCode: "DEPENDENCY_TARGET_MISSING" };
      }
      // Validate every edge, including mastered prerequisites. Otherwise a
      // data cycle can be hidden merely because one node is currently mastered.
      const invalid = validateGraph(prerequisite, nextAncestors);
      if (invalid) return invalid;
    }
    return null;
  };

  const graphInvalid = validateGraph(candidate, new Set());
  if (graphInvalid) return graphInvalid;

  const visit = (
    node: C6NodeSnapshot,
    redirected: boolean,
  ): PrerequisiteResolution => {
    const prerequisiteIds = dependencies
      .filter(
        (dependency) =>
          dependency.toNodeId === node.id &&
          dependency.dependencyType === "REQUIRED",
      )
      .map((dependency) => dependency.fromNodeId)
      .sort((a, b) => (byId.get(a)?.sequence ?? Number.MAX_SAFE_INTEGER) - (byId.get(b)?.sequence ?? Number.MAX_SAFE_INTEGER) || a - b);

    for (const prerequisiteId of prerequisiteIds) {
      const prerequisite = byId.get(prerequisiteId);
      if (!prerequisite) {
        return { kind: "invalid", reasonCode: "DEPENDENCY_TARGET_MISSING" };
      }
      if (prerequisite.knowledgeState !== "MASTERED") {
        return visit(prerequisite, true);
      }
    }

    return { kind: "eligible", node, redirected };
  };

  return visit(candidate, false);
}

/**
 * Provider-free C6 matrix. Tests use this boundary with C4/C5 outputs as
 * fixtures; production data is supplied by resolveCanonicalC6Decision().
 */
export function resolveC6DecisionFromSnapshot(
  input: PureC6DecisionInput,
): C6Decision {
  const intent = input.entryIntent ?? "NORMAL_LEARNING";
  const nodes = [...input.nodes].sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dependencies = input.dependencies ?? [];

  const requested = input.requestedMicroNodeId == null
    ? null
    : byId.get(input.requestedMicroNodeId) ?? null;
  if (input.requestedMicroNodeId != null && !requested) {
    return unavailableDecision(
      input,
      "DEPENDENCY_TARGET_MISSING",
      "INVALID_GRAPH",
    );
  }

  const afterIndex = input.afterMicroNodeId == null
    ? -1
    : nodes.findIndex((node) => node.id === input.afterMicroNodeId);
  const candidatesAfterAnchor =
    input.afterMicroNodeId == null
      ? nodes
      : afterIndex >= 0
        ? nodes.slice(afterIndex + 1)
        : [];

  let candidate: C6NodeSnapshot | null = requested;
  let advancing = input.afterMicroNodeId != null;
  if (candidate?.knowledgeState === "MASTERED" && intent === "NORMAL_LEARNING") {
    const currentIndex = nodes.findIndex((node) => node.id === candidate!.id);
    candidate = nodes.slice(currentIndex + 1).find(
      (node) => node.knowledgeState !== "MASTERED",
    ) ?? null;
    advancing = true;
  }
  if (!candidate) {
    candidate = candidatesAfterAnchor.find(
      (node) => node.knowledgeState !== "MASTERED",
    ) ?? null;
  }
  if (!candidate) {
    return unavailableDecision(input, "NO_ELIGIBLE_MICRONODE", "NOT_APPLICABLE");
  }

  const prerequisite = resolveRequiredPrerequisites(candidate, byId, dependencies);
  if (prerequisite.kind === "invalid") {
    return unavailableDecision(input, prerequisite.reasonCode, "INVALID_GRAPH");
  }
  const target = prerequisite.node;
  const prerequisiteStatus: C6PrerequisiteStatus = prerequisite.redirected
    ? "REDIRECTED"
    : dependencies.some(
          (dependency) =>
            dependency.toNodeId === target.id &&
            dependency.dependencyType === "REQUIRED",
        )
      ? "SATISFIED"
      : "NOT_APPLICABLE";

  const isExplicitReview =
    intent === "EXPLICIT_REVIEW" && target.id === requested?.id &&
    target.knowledgeState === "MASTERED";
  const next = resolveNextCognitiveLevel(target);
  if (next.reasonCode === "C2_PATH_UNAVAILABLE") {
    // A C6 target without an accepted C2 path is not a safe learner-delivery
    // target. Do not let downstream chat fall back to an implied Bloom level.
    return unavailableDecision(input, "C2_PATH_UNAVAILABLE", prerequisiteStatus);
  }
  const decisionType: C6DecisionType = isExplicitReview
    ? "REVIEW"
    : advancing || prerequisite.redirected && candidate.knowledgeState === "MASTERED"
      ? "ADVANCE"
      : decisionTypeForState(target.knowledgeState);

  const hasAcceptedCognitiveTarget =
    target.curriculumTargetCognitiveLevelId !== null;
  const nextTargetCognitiveLevelId = isExplicitReview && hasAcceptedCognitiveTarget
    ? target.curriculumTargetCognitiveLevelId
    : next.levelId;
  const reasonCode: C6ReasonCode = prerequisite.redirected
    ? "REQUIRED_PREREQUISITE_UNSATISFIED"
    : isExplicitReview
      ? "EXPLICIT_REVIEW"
      : decisionType === "ADVANCE"
        ? "MASTERED_ADVANCE"
        : next.reasonCode;

  return {
    learnerId: input.learnerId ?? 0,
    lessonId: input.lessonId ?? 0,
    microNodeId: target.id,
    knowledgeState: target.knowledgeState,
    curriculumTargetCognitiveLevelId: target.curriculumTargetCognitiveLevelId,
    demonstratedCognitiveLevelId: target.demonstratedCognitiveLevelId,
    nextTargetCognitiveLevelId,
    decisionType,
    reasonCode,
    prerequisiteStatus,
  };
}

/**
 * Production C6 owner. It queries approved curriculum nodes, delegates learner
 * state to C5, validates each C2 path with the shared validator, then applies
 * the pure C6 matrix above.
 */
export async function resolveCanonicalC6Decision(
  input: ResolveC6DecisionInput,
): Promise<C6Decision> {
  const nodes = await db
    .select({
      id: lessonNodesTable.id,
      sequence: lessonNodesTable.sequence,
      theoryContent: lessonNodesTable.theoryContent,
      learningObjective: lessonNodesTable.learningObjective,
      cogPathStatus: lessonNodesTable.cogPathStatus,
    })
    .from(lessonNodesTable)
    .where(
      and(
        eq(lessonNodesTable.lessonId, input.lessonId),
        eq(lessonNodesTable.status, "approved"),
      ),
    )
    .orderBy(asc(lessonNodesTable.sequence), asc(lessonNodesTable.id));

  if (nodes.length === 0) {
    return unavailableDecision(
      { ...input, nodes: [] },
      "NO_ELIGIBLE_MICRONODE",
      "NOT_APPLICABLE",
    );
  }

  const nodeIds = nodes.map((node) => node.id);
  const [states, cognitiveLevels, dependencies] = await Promise.all([
    resolveKnowledgeTreeStates(input.learnerId, nodeIds),
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
      .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, nodeIds))
      .orderBy(
        asc(lessonNodeCognitiveLevelsTable.sequence),
        asc(lessonNodeCognitiveLevelsTable.id),
      ),
    db
      .select({
        fromNodeId: lessonNodeDependenciesTable.fromNodeId,
        toNodeId: lessonNodeDependenciesTable.toNodeId,
        dependencyType: lessonNodeDependenciesTable.dependencyType,
      })
      .from(lessonNodeDependenciesTable)
      .where(eq(lessonNodeDependenciesTable.lessonId, input.lessonId)),
  ]);

  const pathByNodeId = new Map<number, C6PathLevel[]>();
  for (const level of cognitiveLevels) {
    const path = pathByNodeId.get(level.lessonNodeId) ?? [];
    path.push(level);
    pathByNodeId.set(level.lessonNodeId, path);
  }

  const snapshots: C6NodeSnapshot[] = nodes.map((node) => {
    const cognitivePath = pathByNodeId.get(node.id) ?? [];
    const acceptance = assessAcceptedCognitivePath({
      cogPathStatus: node.cogPathStatus,
      theoryContent: node.theoryContent,
      learningObjective: node.learningObjective,
      levels: cognitivePath,
    });
    const state = states.get(node.id);
    return {
      id: node.id,
      sequence: node.sequence,
      knowledgeState: state?.knowledgeState ?? "NOT_STUDIED",
      curriculumTargetCognitiveLevelId: state?.targetCognitiveLevel?.id ?? null,
      demonstratedCognitiveLevelId: state?.demonstratedCognitiveLevel?.id ?? null,
      pathAccepted: acceptance.accepted,
      cognitivePath,
    };
  });

  return resolveC6DecisionFromSnapshot({
    ...input,
    nodes: snapshots,
    dependencies,
  });
}