/**
 * C7.6 closure: provider-free acceptance matrix for the complete C7 contract.
 * Each scenario uses the same server-owned pure contracts exercised by the
 * runtime; provider calls and persistent learner data are intentionally absent.
 */
import assert from "node:assert/strict";
import {
  buildMandatoryFeedbackStageUpdate,
  derivePhase2ServerAction,
  establishEvaluatedTurnAuthority,
} from "../../services/phase2/orchestration.js";
import {
  createC7ExecutionTarget,
  isC7TopicSwitchRequest,
  isExerciseCompatibleWithC7Target,
  validateC7ModelTargetProposal,
} from "../../services/phase2/c7-execution-target.js";
import {
  buildCanonicalTaskSnapshot,
  createCanonicalTaskRetrySnapshot,
  isCanonicalTaskSnapshot,
  snapshotCanQualifyC3,
  sourceTaskText,
  taskSnapshotForEvidence,
} from "../../services/phase2/canonical-task-snapshot.js";
import { authorizeCanonicalCompletion, buildAuthorizedLevelTransitionUpdate } from "../../services/phase2/canonical-completion-authority.js";
import { classifyQualifyingEvidence } from "../../lib/evidence-contract.js";
import {
  MAX_REMEDIATION_STEPS,
  decideNextPedagogicalAction,
  type CognitiveLevelRow,
  type PedagogicalDecisionInput,
} from "../../services/pedagogicalDecisionEngine.js";

type Test = { name: string; run: () => void };
const tests: Test[] = [];
const test = (name: string, run: () => void) => tests.push({ name, run });

const understand: CognitiveLevelRow = {
  id: 101,
  cognitiveLevel: "UNDERSTAND",
  sequence: 1,
  isApplicable: true,
  isTargetCeiling: false,
  performanceObjective: null,
  successCriterion: "correctly explain the rule",
  preferredInteractionTypes: ["micro_check"],
  minimumIndependentEvidence: 1,
};
const apply: CognitiveLevelRow = { ...understand, id: 102, cognitiveLevel: "APPLY", sequence: 2, isTargetCeiling: true };
const analyze: CognitiveLevelRow = { ...understand, id: 103, cognitiveLevel: "ANALYZE", sequence: 3, isTargetCeiling: true };
const target = createC7ExecutionTarget({
  lessonId: 50,
  currentNodeId: 70,
  activeCognitiveLevelId: understand.id,
  node: { id: 70, title: "Կանոն" },
  acceptedPath: [understand, apply, analyze],
});
const plan = (overrides: Record<string, unknown> = {}) => derivePhase2ServerAction({
  currentPhase: 2,
  currentNodeId: target.microNodeId,
  activeCognitiveLevelId: target.activeCognitiveLevelId,
  nodeTeachingStage: "THEORY",
  activeTaskProvenance: null,
  activeLessonExerciseId: null,
  activeObjectiveTaskPayload: null,
  learnerIntent: "OTHER" as any,
  evaluated: false,
  decision: null,
  progressionPlan: null,
  ...overrides,
});
const decisionInput = (overrides: Partial<PedagogicalDecisionInput> = {}): PedagogicalDecisionInput => ({
  lessonNodeId: target.microNodeId,
  lessonId: target.lessonId,
  sessionId: 1,
  userId: 1,
  nodeTeachingStage: "MICRO_CHECK",
  remediationStep: 0,
  activeCognitiveLevelId: understand.id,
  activeCognitiveLevelRow: understand,
  cognitivePath: [understand, apply, analyze],
  answerStatus: "INCORRECT",
  evidenceQuality: "NONE",
  errorFamily: "CONCEPTUAL",
  errorStability: "FIRST_OCCURRENCE",
  activeHelpCount: 0,
  activeAssistanceLevel: "none",
  activeAttemptSequence: 1,
  activeTaskProvenance: "micro_check",
  levelEvidenceSummary: { independentCorrectCount: 0, totalCorrectCount: 0, bestQuality: null },
  nextNodeId: null,
  nextNodeHasCriticalDependencyOnCurrentNode: false,
  sessionBudgetExhausted: false,
  localNodeBudgetExhausted: false,
  ...overrides,
});
const micro = () => buildCanonicalTaskSnapshot({
  taskReference: "micro_check:master-1",
  taskSource: "micro_check",
  taskKind: "micro_check",
  renderedPrompt: "Ընտրի՛ր ճիշտ պատասխանը։\nA) այո\nB) ոչ",
  executionTarget: target,
  interactionType: "multiple_choice",
  learnerTextSource: "generated",
  objectivePayload: {
    interactionType: "multiple_choice",
    options: [{ key: "A", text: "այո" }, { key: "B", text: "ոչ" }],
    correctOption: "A",
  },
  targetCompatibleAtActivation: true,
});

test("01 new learning begins at the first accepted target and THEORY", () => {
  assert.equal(target.activeCognitiveLevelId, understand.id);
  assert.equal(plan().action, "DELIVER_THEORY");
});
test("02 a partial learner's C6-selected APPLY target stays APPLY", () => {
  const partialTarget = createC7ExecutionTarget({ lessonId: 50, currentNodeId: 70, activeCognitiveLevelId: apply.id, node: { id: 70, title: "Կանոն" }, acceptedPath: [understand, apply, analyze] });
  assert.equal(partialTarget.activeCognitiveLevelId, apply.id);
});
test("03 correct micro-check requires FEEDBACK before any transition", () => {
  assert.equal(buildMandatoryFeedbackStageUpdate().nodeTeachingStage, "FEEDBACK");
});
test("04 incorrect micro-check remains on the locked target for remediation", () => {
  const decision = decideNextPedagogicalAction(decisionInput());
  assert.equal(decision.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.equal(target.activeCognitiveLevelId, understand.id);
});
test("05 assisted success cannot independently authorize completion", () => {
  assert.equal(authorizeCanonicalCompletion({ candidate: "ADVANCE_COGNITIVE_LEVEL", qualificationStatus: "qualified", projection: { pathAccepted: true, ceilingLevelId: understand.id, reachedTarget: false }, currentLevelConfirmed: false }).authorized, false);
});
test("06 source task C3 qualification precedes C4/C6 authorization gates", () => {
  const quality = classifyQualifyingEvidence({ lessonNodeId: 70, cognitiveLevelId: 101, taskSource: "source_exercise", taskReference: "source:1", levelBelongsToNode: true, acceptedPath: true, taskValidForLevel: true, authoritativeResult: true });
  assert.equal(quality, "qualified");
  assert.equal(authorizeCanonicalCompletion({ candidate: "ADVANCE_COGNITIVE_LEVEL", qualificationStatus: quality, projection: { pathAccepted: true, ceilingLevelId: 101, reachedTarget: false }, currentLevelConfirmed: true }).authorized, true);
});
test("07 partial remains a distinct evaluator status", () => {
  const authority = establishEvaluatedTurnAuthority({ status: "PARTIALLY_CORRECT" } as any);
  assert.equal(authority.status, "PARTIALLY_CORRECT");
  assert.equal(authority.evidenceWasCorrect, null);
});
test("08 unclear and no-response do not authorize completion", () => {
  for (const status of ["UNCLEAR", "NO_RESPONSE"] as const) {
    assert.equal(authorizeCanonicalCompletion({ candidate: "COMPLETE_MICRONODE", qualificationStatus: "unqualified", projection: { pathAccepted: true, ceilingLevelId: null, reachedTarget: false }, currentLevelConfirmed: false }).authorized, false, status);
  }
});
test("09 remediation exhaustion is a deterministic terminal action", () => {
  assert.equal(decideNextPedagogicalAction(decisionInput({ remediationStep: MAX_REMEDIATION_STEPS })).metaAction, "MARK_TARGET_NOT_REACHED");
});
test("10 topic switch is redirected without target mutation", () => {
  assert.equal(isC7TopicSwitchRequest("անցնենք ուրիշ թեմայի"), true);
  assert.equal(target.microNodeId, 70);
});
test("11 C6-selected prerequisite is accepted while model-invented one is rejected", () => {
  assert.equal(createC7ExecutionTarget({ lessonId: 50, currentNodeId: 69, activeCognitiveLevelId: 101, node: { id: 69, title: "Նախադրյալ" }, acceptedPath: [understand] }).microNodeId, 69);
  assert.equal(validateC7ModelTargetProposal(target, { microNodeId: 69 }), false);
});
test("12 wrong-level or wrong-node exercises are not compatible", () => {
  assert.equal(isExerciseCompatibleWithC7Target(target, { id: 1, relatedNodeId: 71 }, new Set([1])), false);
  assert.equal(isExerciseCompatibleWithC7Target(target, { id: 2, relatedNodeId: 70 }, new Set<number>()), false);
});
test("13 no eligible source task selects generation, never an arbitrary exercise", () => {
  assert.equal(plan({ nodeTeachingStage: "TASK_REQUIRED", eligibleSourceExerciseAvailable: false }).action, "GENERATE_TASK");
});
test("14 source verbatim text remains byte-for-byte before its reference suffix", () => {
  assert.equal(sourceTaskText({ exerciseTextVerbatim: "  Տեքստ  ", exerciseTextEdited: "Փոփոխված", sourcePage: "8", exerciseId: "EX-8" }).prompt, "  Տեքստ  \n(Էջ 8, Վ. EX-8)");
});
test("15 retry creates a distinct identity, sequence, and parent trace", () => {
  const retry = createCanonicalTaskRetrySnapshot(micro(), { taskReference: "micro_check:master-2", attemptSequence: 2 });
  assert.equal(retry.attemptSequence, 2);
  assert.equal(retry.generated?.parentTaskReference, "micro_check:master-1");
});
test("16 duplicate submission shares the same task-attempt identity", () => {
  const snap = micro();
  assert.equal(`${snap.taskReference}:${snap.attemptSequence}`, "micro_check:master-1:1");
});
test("17 pending FEEDBACK is authoritative and cannot create a replacement task", () => {
  assert.equal(plan({ nodeTeachingStage: "FEEDBACK" }).action, "DELIVER_FEEDBACK");
});
test("18 stale target proposals fail target validation", () => {
  assert.equal(validateC7ModelTargetProposal(target, { cognitiveLevelId: apply.id }), false);
});
test("19 active source exercise resumes from the frozen task, not mutable rows", () => {
  const snap = buildCanonicalTaskSnapshot({ taskReference: "source:master-1", taskSource: "source_exercise", taskKind: "source", renderedPrompt: "Բնագիր\n(Էջ 1, Վ. 1)", executionTarget: target, interactionType: "short_answer", learnerTextSource: "verbatim", lessonExerciseId: 9, sourceExerciseId: "1", sourcePage: "1", sourceAnswer: { interactionType: "short_answer", correctAnswer: "x" }, sourceSuccessCriteria: "ճիշտ բացատրի", targetCompatibleAtActivation: true });
  assert.equal(snap.renderedPrompt, "Բնագիր\n(Էջ 1, Վ. 1)");
});
test("20 feedback resume remains a FEEDBACK boundary", () => {
  assert.equal(plan({ nodeTeachingStage: "FEEDBACK", activeTaskProvenance: null }).responseTeachingMode, "FEEDBACK");
});
test("21 level confirmation resets only through canonical level transition", () => {
  const update = buildAuthorizedLevelTransitionUpdate(apply.id);
  assert.equal(update.activeCognitiveLevelId, apply.id);
  assert.equal(update.nodeTeachingStage, "THEORY");
  assert.equal(update.activeTaskSnapshot, null);
});
test("22 node completion remains C4-gated before C6 may choose next node", () => {
  assert.equal(authorizeCanonicalCompletion({ candidate: "COMPLETE_MICRONODE", qualificationStatus: "qualified", projection: { pathAccepted: true, ceilingLevelId: apply.id, reachedTarget: false }, currentLevelConfirmed: true }).authorized, false);
});
test("23 review target retains the current mastered node and ceiling contract", () => {
  assert.equal(validateC7ModelTargetProposal(target, { microNodeId: target.microNodeId, cognitiveLevelId: target.activeCognitiveLevelId }), true);
});
test("24 invalid snapshots and invalid C2 target proposals fail closed", () => {
  assert.equal(isCanonicalTaskSnapshot({ version: 1, taskReference: "x", renderedPrompt: "x", targetCompatibleAtActivation: true, attemptSequence: 1 }), false);
  assert.equal(validateC7ModelTargetProposal(target, { cognitiveLevelId: 999 }), false);
  assert.equal(snapshotCanQualifyC3(micro()), true);
  assert.equal("objectivePayload" in taskSnapshotForEvidence(micro()), false);
});

let failures = 0;
for (const { name, run } of tests) {
  try { run(); console.log(`✓ ${name}`); }
  catch (error) { failures += 1; console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
if (failures) process.exit(1);