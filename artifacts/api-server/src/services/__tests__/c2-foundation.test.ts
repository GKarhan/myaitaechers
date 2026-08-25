import assert from "node:assert/strict";
import {
  buildInitialCognitivePathLedger,
  buildCognitivePathAttemptTrace,
  canCommitCognitivePathReplacement,
  classifyCognitivePathResult,
  findCognitivePathJobConflicts,
  summarizeCognitivePathLedger,
  type CognitivePathNodeSnapshot,
} from "../cognitive-path-orchestrator.js";
import { assessAcceptedCognitivePath } from "../../lib/cognitive-path-grounding.js";
import {
  assessCognitivePathProgression,
  buildCognitiveLevelDiagnostics,
} from "../../lib/c2-progression.js";
import type { TargetCognitiveDemand } from "../../lib/c2-target-demand.js";
import { hasCompleteTeachingContent } from "../../lib/teaching-content-readiness.js";

type Test = [string, () => void];
const tests: Test[] = [];
function it(name: string, fn: () => void): void { tests.push([name, fn]); }

const nodes: CognitivePathNodeSnapshot[] = [
  { id: 1, title: "Missing", status: "approved", cogPathStatus: null, existingLevelCount: 0, hasTeacherAuthoredLevels: false },
  { id: 2, title: "Confirmed", status: "approved", cogPathStatus: "confirmed", existingLevelCount: 1, hasTeacherAuthoredLevels: false },
  { id: 3, title: "Teacher authored", status: "approved", cogPathStatus: "needs_review", existingLevelCount: 1, hasTeacherAuthoredLevels: true },
  { id: 4, title: "Existing review", status: "approved", cogPathStatus: "needs_review", existingLevelCount: 1, hasTeacherAuthoredLevels: false },
];

const validGenerated: Parameters<typeof canCommitCognitivePathReplacement>[0] = {
  nodeId: 1,
  skipped: false,
  levels: [{
    cognitiveLevel: "remember" as const,
    sequence: 1,
    isTargetCeiling: true,
    performanceObjective: "Սովորողը ճանաչում է հասկացությունը։",
    successCriterion: "Ճիշտ է ճանաչում հասկացությունը։",
    minimumIndependentEvidence: 3,
    preferredInteractionTypes: ["multiple_choice"],
  }],
  progression: {
    targetLevel: "remember",
    selectedLevels: ["remember"],
    omittedLowerLevels: [],
    generatedLevelSequence: [1],
    levelCount: 1,
    progressionDecision: "MINIMAL",
    progressionConfidence: "HIGH",
    progressionReasonCodes: ["TARGET_ONLY_SUFFICIENT", "TARGET_LEVEL_IS_FINAL"],
    reviewReasonCodes: [],
    levelDiagnostics: [],
    contractVersion: "c2-4.0",
  },
  planner: {
    targetLevel: "remember",
    orderedLevels: ["remember"],
    omittedLowerLevels: [],
    plannerDecision: "PLANNED",
    plannerConfidence: "HIGH",
    plannerReasonCodes: ["TARGET_ONLY_SUFFICIENT", "TARGET_LEVEL_IS_FINAL"],
    plannerReviewReasonCodes: [],
    contractVersion: "c2-4.0",
  },
  planConformance: { conforms: true, firstMismatch: null },
};

const traceDemand: TargetCognitiveDemand = {
  targetLevel: "remember",
  confidence: "HIGH",
  evidence: ["OBJECTIVE_PERFORMANCE"],
  c1Relation: "MATCHES_C1",
  reviewReasons: [],
  resolverVersion: "test",
};

function traceForProgression(
  progression: NonNullable<typeof validGenerated.progression>,
  levels: typeof validGenerated.levels,
) {
  return buildCognitivePathAttemptTrace({
    generated: {
      ...validGenerated,
      skipped: true,
      skipCode: "C2_PROGRESSION_REVIEW_REQUIRED",
      levels: [],
      candidateDiagnostics: buildCognitiveLevelDiagnostics(levels),
      targetDemand: traceDemand,
      progression,
    },
    attemptNumber: 1,
    retryTriggered: false,
    retryTriggerCode: null,
    finalState: "BLOCKED_PROGRESSION_REVIEW",
    finalReasonCode: "C2_PROGRESSION_REVIEW_REQUIRED",
  });
}

it("1. lesson ledger enumerates every MicroNode exactly once", () => {
  const ledger = buildInitialCognitivePathLedger(nodes);
  assert.equal(ledger.length, nodes.length);
  assert.equal(new Set(ledger.map((entry) => entry.nodeId)).size, nodes.length);
});

it("2. a node with no C2 path is eligible as NOT_ATTEMPTED", () => {
  assert.equal(buildInitialCognitivePathLedger(nodes)[0]?.state, "NOT_ATTEMPTED");
});

it("3. confirmed paths are protected in normal fill-missing runs", () => {
  assert.equal(buildInitialCognitivePathLedger(nodes)[1]?.state, "SKIPPED_CONFIRMED");
});

it("4. teacher-authored paths are protected in normal fill-missing runs", () => {
  assert.equal(buildInitialCognitivePathLedger(nodes)[2]?.state, "SKIPPED_TEACHER_AUTHORED");
});

it("5. existing needs-review AI paths are not silently overwritten", () => {
  assert.equal(buildInitialCognitivePathLedger(nodes)[3]?.state, "SKIPPED_EXISTING");
});

it("6. a complete generated candidate is the only kind eligible for replacement", () => {
  assert.equal(canCommitCognitivePathReplacement(validGenerated), true);
  assert.equal(canCommitCognitivePathReplacement({ ...validGenerated, skipped: true }), false);
  assert.equal(canCommitCognitivePathReplacement({ ...validGenerated, levels: [] }), false);
  assert.equal(canCommitCognitivePathReplacement({
    ...validGenerated,
    planConformance: { conforms: false, firstMismatch: "REORDERED_ROUTE" },
  }), false);
  assert.equal(canCommitCognitivePathReplacement({ ...validGenerated, progression: undefined }), false);
});

it("7. partial candidates cannot be committed as a replacement", () => {
  assert.equal(canCommitCognitivePathReplacement({
    ...validGenerated,
    levels: [{ ...validGenerated.levels[0], isTargetCeiling: false }],
  }), false);
});

it("8. parse failures receive a durable parse reason code", () => {
  assert.deepEqual(classifyCognitivePathResult({
    nodeId: 1, skipped: true, skipCode: "C2_RESPONSE_PARSE_FAILED", levels: [],
  }), { state: "PARSE_FAILURE", reasonCode: "C2_RESPONSE_PARSE_FAILED" });
});

it("9. structural and grounding rejections remain validation failures", () => {
  assert.deepEqual(classifyCognitivePathResult({
    nodeId: 1, skipped: true, skipCode: "C2_GROUNDING_REJECTED", levels: [],
  }), { state: "VALIDATION_FAILURE", reasonCode: "C2_GROUNDING_REJECTED" });
});

it("10. a pending job claims the same MicroNode before its provider call begins", () => {
  assert.deepEqual(findCognitivePathJobConflicts([1, 4], [{
    stateLedger: [{ nodeId: 1, state: "NOT_ATTEMPTED" }],
  }]), [1]);
  assert.deepEqual(findCognitivePathJobConflicts([1, 4], [{
    stateLedger: [
      { nodeId: 1, state: "IN_PROGRESS", reasonCode: "SAME_NODE_GENERATION_IN_PROGRESS" },
      { nodeId: 4, state: "NOT_ATTEMPTED" },
    ],
  }]), [4]);
});

it("11. malformed active job metadata fails closed for concurrent generation", () => {
  assert.deepEqual(findCognitivePathJobConflicts([1, 4], [null]), [1, 4]);
});

it("12. lesson summaries are deterministic and reconcile every ledger state", () => {
  const ledger = buildInitialCognitivePathLedger(nodes).map((entry) =>
    entry.nodeId === 1 ? { ...entry, state: "GENERATED_NEEDS_REVIEW" as const } : entry,
  );
  assert.deepEqual(summarizeCognitivePathLedger(ledger), {
    total: 4,
    notAttempted: 0,
    inProgress: 0,
    generatedNeedsReview: 1,
    confirmed: 0,
    skipped: 3,
    blocked: 0,
    failed: 0,
  });
});

it("13. AI Teacher remains fail-closed for an unconfirmed generated path", () => {
  const acceptance = assessAcceptedCognitivePath({
    cogPathStatus: "needs_review",
    theoryContent: "Հասկացությունը նկարագրված է աղբյուրում։",
    learningObjective: "Սովորողը ճանաչում է հասկացությունը։",
    levels: [{ ...validGenerated.levels[0], isApplicable: true }],
  });
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.reason, "PATH_NOT_CONFIRMED");
});

it("14. Teaching Content completeness remains independent of C2 status", () => {
  assert.equal(hasCompleteTeachingContent({
    childFriendlyExplanation: "Պարզ բացատրություն",
    commonMisconception: "Սխալ պատկերացում",
    basicExamples: ["Օրինակ"],
    nonExamples: ["Հակաօրինակ"],
  }), true);
});

it("15. retry history retains both bounded candidate summaries", () => {
  const candidateDiagnostics = buildCognitiveLevelDiagnostics(validGenerated.levels);
  const first = buildCognitivePathAttemptTrace({
    generated: {
      ...validGenerated,
      skipped: true,
      skipCode: "C2_PATH_STRUCTURE_REJECTED",
      levels: [],
      candidateDiagnostics,
    },
    attemptNumber: 1,
    retryTriggered: true,
    retryTriggerCode: "C2_PATH_STRUCTURE_REJECTED",
    finalState: "VALIDATION_FAILURE",
    finalReasonCode: "C2_PATH_STRUCTURE_REJECTED",
  });
  const second = buildCognitivePathAttemptTrace({
    generated: { ...validGenerated, candidateDiagnostics },
    attemptNumber: 2,
    retryTriggered: false,
    retryTriggerCode: null,
    finalState: "GENERATED_NEEDS_REVIEW",
    finalReasonCode: "GENERATED_AND_PERSISTED",
  });

  assert.deepEqual([first.attemptNumber, second.attemptNumber], [1, 2]);
  assert.equal(first.retryTriggered, true);
  assert.equal(first.firstBlockingGate, "STRUCTURAL_VALIDATION");
  assert.equal(second.retryTriggered, false);
  assert.equal(second.persistenceAllowed, true);
  assert.equal(second.candidateTargetCeilingCount, 1);
});

it("16. progression-held candidates retain the validator decision and gate", () => {
  const candidateDiagnostics = buildCognitiveLevelDiagnostics(validGenerated.levels);
  const progression = {
    ...validGenerated.progression!,
    progressionDecision: "REVIEW_REQUIRED" as const,
    progressionConfidence: "LOW" as const,
    reviewReasonCodes: ["REDUNDANT_LEVEL" as const],
    levelDiagnostics: candidateDiagnostics,
  };
  const trace = buildCognitivePathAttemptTrace({
    generated: {
      ...validGenerated,
      skipped: true,
      skipCode: "C2_PROGRESSION_REVIEW_REQUIRED",
      levels: [],
      candidateDiagnostics,
      progression,
    },
    attemptNumber: 1,
    retryTriggered: false,
    retryTriggerCode: null,
    finalState: "BLOCKED_PROGRESSION_REVIEW",
    finalReasonCode: "C2_PROGRESSION_REVIEW_REQUIRED",
  });

  assert.equal(trace.firstBlockingGate, "PROGRESSION_VALIDATION");
  assert.equal(trace.progressionDecision, "REVIEW_REQUIRED");
  assert.equal(trace.persistenceAllowed, false);
  assert.ok(trace.levelDiagnostics[0]?.isTargetCeiling);
});

it("17. diagnostic trace excludes adversarial provider-like content", () => {
  const sensitive = "Authorization: Bearer super-secret-token prompt source exercise answer key";
  const candidateDiagnostics = buildCognitiveLevelDiagnostics([{
    cognitiveLevel: "remember",
    sequence: 1,
    isTargetCeiling: true,
    performanceObjective: sensitive,
    successCriterion: sensitive,
  }]);
  const trace = buildCognitivePathAttemptTrace({
    generated: {
      ...validGenerated,
      candidateDiagnostics,
    },
    attemptNumber: 1,
    retryTriggered: false,
    retryTriggerCode: null,
    finalState: "GENERATED_NEEDS_REVIEW",
    finalReasonCode: "GENERATED_AND_PERSISTED",
  });
  const serialized = JSON.stringify(trace).toLowerCase();

  assert.equal(serialized.includes("super-secret-token"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("answer key"), false);
});

it("18. interaction-format holds identify the responsible level in the persisted trace", () => {
  const levels = [{ ...validGenerated.levels[0], preferredInteractionTypes: [] }];
  const progression = assessCognitivePathProgression({
    targetDemand: traceDemand,
    title: "Trace fixture",
    learningObjective: "Recall source facts",
    theoryContent: "Source facts are available.",
    exercises: [],
  }, levels);
  const trace = traceForProgression(progression, levels);

  assert.ok(trace.levelDiagnostics[0]?.levelReviewReasonCodes.includes("INTERACTION_TYPE_MISMATCH"));
  assert.equal(trace.levelDiagnostics[0]?.levelDecision, "REVIEW_REQUIRED");
});

it("19. independent-evidence holds identify the responsible level in the persisted trace", () => {
  const levels = [{ ...validGenerated.levels[0], minimumIndependentEvidence: 6 }];
  const progression = assessCognitivePathProgression({
    targetDemand: traceDemand,
    title: "Trace fixture",
    learningObjective: "Recall source facts",
    theoryContent: "Source facts are available.",
    exercises: [],
  }, levels);
  const trace = traceForProgression(progression, levels);

  assert.ok(trace.levelDiagnostics[0]?.levelReviewReasonCodes.includes("SUCCESS_CRITERION_WEAK"));
  assert.equal(trace.levelDiagnostics[0]?.levelDecision, "REVIEW_REQUIRED");
});

it("20. unnecessary lower levels identify the redundant level in the persisted trace", () => {
  const demand: TargetCognitiveDemand = { ...traceDemand, targetLevel: "apply" };
  const levels = [
    {
      ...validGenerated.levels[0],
      cognitiveLevel: "remember" as const,
      isTargetCeiling: false,
      performanceObjective: "Recall source facts",
      successCriterion: "State source facts accurately",
    },
    {
      ...validGenerated.levels[0],
      cognitiveLevel: "apply" as const,
      sequence: 2,
      isTargetCeiling: true,
      performanceObjective: "Apply the rule",
      successCriterion: "Use the rule accurately",
    },
  ];
  const progression = assessCognitivePathProgression({
    targetDemand: demand,
    title: "Trace fixture",
    learningObjective: "Apply the rule",
    theoryContent: "Apply the rule in a routine calculation.",
    exercises: [],
  }, levels);
  const trace = traceForProgression(progression, levels);

  assert.ok(trace.levelDiagnostics[0]?.levelReviewReasonCodes.includes("REDUNDANT_LEVEL"));
  assert.deepEqual(trace.levelDiagnostics[0]?.redundancyReasonCodes, ["REDUNDANT_LEVEL"]);
  assert.equal(trace.levelDiagnostics[0]?.redundancyDecision, "REDUNDANT");
});

it("21. retry history records the identical frozen plan without provider content", () => {
  const first = buildCognitivePathAttemptTrace({
    generated: {
      ...validGenerated,
      skipped: true,
      skipCode: "C2_PLAN_CONFORMANCE_REJECTED",
      levels: [],
      planConformance: { conforms: false, firstMismatch: "REORDERED_ROUTE" },
    },
    attemptNumber: 1,
    retryTriggered: true,
    retryTriggerCode: "C2_PLAN_CONFORMANCE_REJECTED",
    finalState: "VALIDATION_FAILURE",
    finalReasonCode: "C2_PLAN_CONFORMANCE_REJECTED",
  });
  const second = buildCognitivePathAttemptTrace({
    generated: validGenerated,
    attemptNumber: 2,
    retryTriggered: false,
    retryTriggerCode: null,
    finalState: "GENERATED_NEEDS_REVIEW",
    finalReasonCode: "GENERATED_AND_PERSISTED",
  });

  assert.deepEqual(first.plannedLevelSequence, second.plannedLevelSequence);
  assert.deepEqual(first.omittedPlannedLevels, second.omittedPlannedLevels);
  assert.equal(first.firstPlanMismatch, "REORDERED_ROUTE");
  assert.equal(second.planConformance, "CONFORMS");
});

let passed = 0;
for (const [name, test] of tests) {
  try {
    test();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}
console.log(`C2 foundation: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exitCode = 1;