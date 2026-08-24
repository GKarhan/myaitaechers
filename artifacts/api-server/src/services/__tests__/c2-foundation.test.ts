import assert from "node:assert/strict";
import {
  buildInitialCognitivePathLedger,
  canCommitCognitivePathReplacement,
  classifyCognitivePathResult,
  findCognitivePathJobConflicts,
  summarizeCognitivePathLedger,
  type CognitivePathNodeSnapshot,
} from "../cognitive-path-orchestrator.js";
import { assessAcceptedCognitivePath } from "../../lib/cognitive-path-grounding.js";
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

const validGenerated = {
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
};

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
});

it("7. partial candidates cannot be committed as a replacement", () => {
  assert.equal(canCommitCognitivePathReplacement({
    ...validGenerated,
    levels: [{ ...validGenerated.levels[0], isTargetCeiling: false }],
  }), false);
});

it("8. parse failures receive a durable parse reason code", () => {
  assert.deepEqual(classifyCognitivePathResult({
    nodeId: 1, skipped: true, skipReason: "AI returned unparseable JSON after retry", levels: [],
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