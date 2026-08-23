import type { C7ExecutionTarget } from "./c7-execution-target.js";
import type { ActiveObjectiveTaskPayload } from "./orchestration.js";

export type CanonicalTaskSource =
  | "source_exercise"
  | "micro_check"
  | "generated_task"
  | "legacy_compatibility";

export type CanonicalTaskSnapshot = Readonly<{
  version: 1;
  taskReference: string;
  taskSource: CanonicalTaskSource;
  taskKind: "source" | "generated" | "micro_check" | "legacy";
  renderedPrompt: string;
  lessonNodeId: number | null;
  cognitiveLevelId: number | null;
  interactionType: string | null;
  lessonExerciseId: number | null;
  sourceExerciseId: string | null;
  sourcePage: string | null;
  learnerTextSource: "verbatim" | "edited" | "generated" | "legacy";
  successCriterion: string | null;
  sourceSuccessCriteria: string | null;
  targetCompatibleAtActivation: boolean;
  attemptSequence: number;
  assistanceBaseline: { helpCount: 0; assistanceLevel: "none" };
  objectivePayload: ActiveObjectiveTaskPayload | null;
  sourceAnswer: {
    interactionType: string | null;
    correctAnswer: string | null;
  } | null;
  generated: {
    questionTemplate: string | null;
    parentTaskReference: string | null;
  } | null;
}>;

export type CanonicalTaskEvidenceSnapshot = Omit<
  CanonicalTaskSnapshot,
  "objectivePayload" | "sourceAnswer" | "sourceSuccessCriteria"
>;

function freezeSnapshot(snapshot: CanonicalTaskSnapshot): CanonicalTaskSnapshot {
  // The persisted JSON value is never updated for an active reference. The
  // freeze here catches accidental in-process mutation without changing the
  // mutable DB-facing TypeScript payload types.
  if (snapshot.objectivePayload?.options) {
    Object.freeze(snapshot.objectivePayload.options);
  }
  if (snapshot.objectivePayload) Object.freeze(snapshot.objectivePayload);
  if (snapshot.sourceAnswer) Object.freeze(snapshot.sourceAnswer);
  if (snapshot.generated) Object.freeze(snapshot.generated);
  Object.freeze(snapshot.assistanceBaseline);
  return Object.freeze({ ...snapshot });
}

export function buildCanonicalTaskSnapshot(input: {
  taskReference: string;
  taskSource: CanonicalTaskSource;
  taskKind: CanonicalTaskSnapshot["taskKind"];
  renderedPrompt: string;
  executionTarget?: C7ExecutionTarget;
  interactionType?: string | null;
  lessonExerciseId?: number | null;
  sourceExerciseId?: string | null;
  sourcePage?: string | null;
  learnerTextSource: CanonicalTaskSnapshot["learnerTextSource"];
  objectivePayload?: ActiveObjectiveTaskPayload | null;
  sourceAnswer?: CanonicalTaskSnapshot["sourceAnswer"];
  sourceSuccessCriteria?: string | null;
  questionTemplate?: string | null;
  parentTaskReference?: string | null;
  targetCompatibleAtActivation: boolean;
}): CanonicalTaskSnapshot {
  if (!input.taskReference || !input.renderedPrompt.trim()) {
    throw new Error("canonical task snapshot requires an identity and rendered prompt");
  }
  if (input.targetCompatibleAtActivation && !input.executionTarget) {
    throw new Error("eligible canonical task snapshot requires a locked C7 target");
  }
  return freezeSnapshot({
    version: 1,
    taskReference: input.taskReference,
    taskSource: input.taskSource,
    taskKind: input.taskKind,
    renderedPrompt: input.renderedPrompt,
    lessonNodeId: input.executionTarget?.microNodeId ?? null,
    cognitiveLevelId: input.executionTarget?.activeCognitiveLevelId ?? null,
    interactionType: input.interactionType ?? null,
    lessonExerciseId: input.lessonExerciseId ?? null,
    sourceExerciseId: input.sourceExerciseId ?? null,
    sourcePage: input.sourcePage ?? null,
    learnerTextSource: input.learnerTextSource,
    successCriterion: input.executionTarget?.successCriterion ?? null,
    sourceSuccessCriteria: input.sourceSuccessCriteria?.trim() || null,
    targetCompatibleAtActivation: input.targetCompatibleAtActivation,
    attemptSequence: 1,
    assistanceBaseline: { helpCount: 0, assistanceLevel: "none" },
    objectivePayload: input.objectivePayload ?? null,
    sourceAnswer: input.sourceAnswer ?? null,
    generated: input.taskKind === "source"
      ? null
      : {
          questionTemplate: input.questionTemplate ?? null,
          parentTaskReference: input.parentTaskReference ?? null,
        },
  });
}

export function createCanonicalTaskRetrySnapshot(
  snapshot: CanonicalTaskSnapshot,
  input: { taskReference: string; attemptSequence: number },
): CanonicalTaskSnapshot {
  if (!input.taskReference || input.attemptSequence <= snapshot.attemptSequence) {
    throw new Error("canonical task retry requires a new identity and higher attempt sequence");
  }
  return freezeSnapshot({
    ...snapshot,
    taskReference: input.taskReference,
    attemptSequence: input.attemptSequence,
    generated: snapshot.generated
      ? {
          ...snapshot.generated,
          parentTaskReference: snapshot.taskReference,
        }
      : null,
  });
}

export function isCanonicalTaskSnapshot(value: unknown): value is CanonicalTaskSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<CanonicalTaskSnapshot>;
  const nullableString = (candidate: unknown): candidate is string | null =>
    candidate === null || typeof candidate === "string";
  const validSources: CanonicalTaskSource[] = [
    "source_exercise",
    "micro_check",
    "generated_task",
    "legacy_compatibility",
  ];
  const validKinds: CanonicalTaskSnapshot["taskKind"][] = [
    "source",
    "generated",
    "micro_check",
    "legacy",
  ];
  const validLearnerTextSources = ["verbatim", "edited", "generated", "legacy"];
  const sourceAnswer = snapshot.sourceAnswer;
  const generated = snapshot.generated;
  const assistanceBaseline = snapshot.assistanceBaseline;
  return (
    snapshot.version === 1 &&
    typeof snapshot.taskReference === "string" &&
    snapshot.taskReference.length > 0 &&
    typeof snapshot.renderedPrompt === "string" &&
    snapshot.renderedPrompt.length > 0 &&
    validSources.includes(snapshot.taskSource as CanonicalTaskSource) &&
    validKinds.includes(snapshot.taskKind as CanonicalTaskSnapshot["taskKind"]) &&
    nullableString(snapshot.interactionType) &&
    (snapshot.lessonNodeId === null || Number.isInteger(snapshot.lessonNodeId)) &&
    (snapshot.cognitiveLevelId === null || Number.isInteger(snapshot.cognitiveLevelId)) &&
    (snapshot.lessonExerciseId === null || Number.isInteger(snapshot.lessonExerciseId)) &&
    nullableString(snapshot.sourceExerciseId) &&
    nullableString(snapshot.sourcePage) &&
    validLearnerTextSources.includes(snapshot.learnerTextSource as string) &&
    nullableString(snapshot.successCriterion) &&
    nullableString(snapshot.sourceSuccessCriteria) &&
    typeof snapshot.targetCompatibleAtActivation === "boolean" &&
    typeof snapshot.attemptSequence === "number" &&
    Number.isInteger(snapshot.attemptSequence) &&
    snapshot.attemptSequence > 0 &&
    !!assistanceBaseline &&
    assistanceBaseline.helpCount === 0 &&
    assistanceBaseline.assistanceLevel === "none" &&
    (sourceAnswer === null ||
      (!!sourceAnswer &&
        typeof sourceAnswer === "object" &&
        nullableString(sourceAnswer.interactionType) &&
        nullableString(sourceAnswer.correctAnswer))) &&
    (generated === null ||
      (!!generated &&
        typeof generated === "object" &&
        nullableString(generated.questionTemplate) &&
        nullableString(generated.parentTaskReference))) &&
    (snapshot.taskSource !== "source_exercise" || snapshot.taskKind === "source") &&
    (snapshot.taskSource !== "micro_check" || snapshot.taskKind === "micro_check") &&
    (snapshot.taskSource !== "generated_task" || snapshot.taskKind === "generated") &&
    (snapshot.taskSource !== "legacy_compatibility" || snapshot.taskKind === "legacy") &&
    (snapshot.targetCompatibleAtActivation
      ? snapshot.lessonNodeId !== null && snapshot.cognitiveLevelId !== null
      : true)
  );
}

export function taskSnapshotForEvidence(
  snapshot: CanonicalTaskSnapshot,
): CanonicalTaskEvidenceSnapshot {
  const {
    objectivePayload: _objectivePayload,
    sourceAnswer: _sourceAnswer,
    sourceSuccessCriteria: _sourceSuccessCriteria,
    ...safe
  } = snapshot;
  return safe;
}

export function snapshotMatchesExecutionTarget(
  snapshot: CanonicalTaskSnapshot,
  target: C7ExecutionTarget,
): boolean {
  return (
    snapshot.targetCompatibleAtActivation &&
    snapshot.lessonNodeId === target.microNodeId &&
    snapshot.cognitiveLevelId === target.activeCognitiveLevelId
  );
}

export function snapshotCanQualifyC3(snapshot: CanonicalTaskSnapshot): boolean {
  return (
    snapshotMatchesOwnIdentity(snapshot) &&
    snapshot.targetCompatibleAtActivation &&
    (snapshot.taskSource === "source_exercise" || snapshot.taskSource === "micro_check")
  );
}

function snapshotMatchesOwnIdentity(snapshot: CanonicalTaskSnapshot): boolean {
  return (
    snapshot.taskReference.length > 0 &&
    snapshot.attemptSequence === 1 &&
    snapshot.lessonNodeId !== null &&
    snapshot.cognitiveLevelId !== null
  );
}

export function sourceTaskText(exercise: {
  exerciseTextVerbatim: string | null;
  exerciseTextEdited: string | null;
  sourcePage: string | null;
  exerciseId: string;
}): { prompt: string; learnerTextSource: "verbatim" | "edited" } {
  const storedVerbatim = exercise.exerciseTextVerbatim ?? "";
  const verbatim = storedVerbatim.trim();
  const edited = exercise.exerciseTextEdited?.trim() ?? "";
  const learnerText = verbatim ? storedVerbatim : edited;
  if (!learnerText) throw new Error("source task has no learner-visible text");
  const learnerTextSource = verbatim ? "verbatim" : "edited";
  return {
    prompt: `${learnerText}\n(Էջ ${exercise.sourcePage ?? "?"}, Վ. ${exercise.exerciseId})`,
    learnerTextSource,
  };
}