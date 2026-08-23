/**
 * C7.3 — immutable execution boundary for one Phase-2 turn.
 *
 * C6 remains the owner of target selection and C7.1 remains the only
 * progression writer. This module only snapshots already-persisted C6/C2
 * state and validates that teaching work stays inside it.
 */
export type C7ExecutionTarget = Readonly<{
  lessonId: number;
  microNodeId: number;
  microNodeTitle: string;
  learningObjective: string | null;
  sourceContext: string | null;
  activeCognitiveLevelId: number;
  cognitiveLevel: string;
  performanceObjective: string | null;
  successCriterion: string | null;
  preferredInteractionTypes: readonly string[];
  minimumIndependentEvidence: number | null;
  acceptedPathLevelIds: readonly number[];
}>;

export type C7TargetNode = {
  id: number;
  title: string;
  learningObjective?: string | null;
  theoryContent?: string | null;
};

export type C7TargetLevel = {
  id: number;
  cognitiveLevel: string;
  performanceObjective?: string | null;
  successCriterion?: string | null;
  preferredInteractionTypes?: unknown;
  minimumIndependentEvidence?: number | null;
};

export function createC7ExecutionTarget(input: {
  lessonId: number;
  currentNodeId: number;
  activeCognitiveLevelId: number;
  node: C7TargetNode;
  acceptedPath: readonly C7TargetLevel[];
}): C7ExecutionTarget {
  if (input.node.id !== input.currentNodeId) {
    throw new Error("C7 execution target node does not match persisted session target");
  }
  const activeLevel = input.acceptedPath.find(
    (level) => level.id === input.activeCognitiveLevelId,
  );
  if (!activeLevel) {
    throw new Error("C7 execution target level is absent from the accepted C2 path");
  }
  const preferredInteractionTypes = Array.isArray(activeLevel.preferredInteractionTypes)
    ? activeLevel.preferredInteractionTypes.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  return Object.freeze({
    lessonId: input.lessonId,
    microNodeId: input.currentNodeId,
    microNodeTitle: input.node.title,
    learningObjective: input.node.learningObjective?.trim() || null,
    sourceContext: input.node.theoryContent?.trim() || null,
    activeCognitiveLevelId: activeLevel.id,
    cognitiveLevel: activeLevel.cognitiveLevel,
    performanceObjective: activeLevel.performanceObjective?.trim() || null,
    successCriterion: activeLevel.successCriterion?.trim() || null,
    preferredInteractionTypes: Object.freeze(preferredInteractionTypes),
    minimumIndependentEvidence: activeLevel.minimumIndependentEvidence ?? null,
    acceptedPathLevelIds: Object.freeze(input.acceptedPath.map((level) => level.id)),
  });
}

export function assertC7ExecutionTargetMatchesSession(
  target: C7ExecutionTarget,
  state: {
    lessonId: number;
    currentNodeId: number | null;
    activeCognitiveLevelId: number | null;
  },
): void {
  if (
    state.lessonId !== target.lessonId ||
    state.currentNodeId !== target.microNodeId ||
    state.activeCognitiveLevelId !== target.activeCognitiveLevelId
  ) {
    throw new Error("C7 execution target no longer matches canonical session state");
  }
}

export function isExerciseCompatibleWithC7Target(
  target: C7ExecutionTarget,
  exercise: { relatedNodeId: number | null; id: number },
  linkedLessonExerciseIds: ReadonlySet<number>,
): boolean {
  return (
    exercise.relatedNodeId === target.microNodeId &&
    linkedLessonExerciseIds.has(exercise.id)
  );
}

export function validateC7ModelTargetProposal(
  target: C7ExecutionTarget,
  proposal: {
    lessonId?: number | null;
    microNodeId?: number | null;
    cognitiveLevelId?: number | null;
  },
): boolean {
  return (
    (proposal.lessonId == null || proposal.lessonId === target.lessonId) &&
    (proposal.microNodeId == null || proposal.microNodeId === target.microNodeId) &&
    (proposal.cognitiveLevelId == null ||
      proposal.cognitiveLevelId === target.activeCognitiveLevelId)
  );
}

export function isC7TopicSwitchRequest(message: string): boolean {
  const normalized = message
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
  // This is deliberately a narrow, deterministic grammar for an *explicit*
  // request to leave the current curriculum target. Questions about the
  // current topic still go through normal teaching and clarification.
  if (
    /(?:ուզում եմ |եկ )?(?:թեման |դասը )?(?:փոխենք|փոխել|փոխեմ)/u.test(normalized) ||
    /(?:անցնենք|անցնել եմ|անցիր|գնանք|կարող ենք անցնել)\s+(?:ուրիշ|այլ|հաջորդ)\s+(?:թեմա|դաս)/u.test(normalized) ||
    /(?:սովորեցրու|ցույց տուր)\s+(?:հաջորդ|ուրիշ|այլ)\s+(?:թեմա|դաս)/u.test(normalized)
  ) {
    return true;
  }
  return [
    "անցնենք ուրիշ թեմայի",
    "անցնենք այլ թեմայի",
    "անցնենք հաջորդ թեմային",
    "անցնենք հաջորդ դասին",
    "սովորեցրու հաջորդ դասը",
    "նոր դաս",
    "փոխենք թեման",
  ].some((phrase) => normalized.includes(phrase));
}

export function buildC7TargetContext(target: C7ExecutionTarget): string {
  return [
    "C7_EXECUTION_TARGET (server-owned; immutable for this turn):",
    `LESSON_ID: ${target.lessonId}`,
    `MICRONODE_ID: ${target.microNodeId}`,
    `MICRONODE_TITLE: ${target.microNodeTitle}`,
    `ACTIVE_COGNITIVE_LEVEL_ID: ${target.activeCognitiveLevelId}`,
    `ACTIVE_COGNITIVE_LEVEL: ${target.cognitiveLevel}`,
    target.learningObjective
      ? `MICRONODE_LEARNING_OBJECTIVE: ${target.learningObjective}`
      : "",
    target.performanceObjective
      ? `COGNITIVE_PERFORMANCE_OBJECTIVE: ${target.performanceObjective}`
      : "",
    target.successCriterion
      ? `COGNITIVE_SUCCESS_CRITERION: ${target.successCriterion}`
      : "",
    target.preferredInteractionTypes.length > 0
      ? `PREFERRED_INTERACTION_TYPES: ${target.preferredInteractionTypes.join(", ")}`
      : "",
    target.minimumIndependentEvidence !== null
      ? `MINIMUM_INDEPENDENT_EVIDENCE: ${target.minimumIndependentEvidence}`
      : "",
    "Never select, infer, or propose another lesson, MicroNode, prerequisite, or cognitive level. The server alone changes this target through C7.1 → C3 → C4 → C6.",
  ].filter(Boolean).join("\n");
}