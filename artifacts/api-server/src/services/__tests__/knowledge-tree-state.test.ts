/**
 * C5 provider-free canonical Knowledge Tree classifier regression suite.
 *
 * Run: pnpm --filter @workspace/api-server test:c5-knowledge-tree
 */
import assert from "node:assert/strict";
import {
  aggregateCanonicalKnowledgeState,
  classifyKnowledgeState,
  type KnowledgeStateClassifierInput,
} from "../knowledge-tree-state.js";

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

const REMEMBER = 701;
const UNDERSTAND = 702;
const APPLY = 703;

const PATH: KnowledgeStateClassifierInput["path"] = [
  {
    id: REMEMBER,
    cognitiveLevel: "remember",
    sequence: 10,
    isApplicable: true,
    isTargetCeiling: false,
    minimumIndependentEvidence: 1,
    performanceObjective: "Recall the term",
    successCriterion: "Recalls the term",
    preferredInteractionTypes: [],
  },
  {
    id: UNDERSTAND,
    cognitiveLevel: "understand",
    sequence: 20,
    isApplicable: true,
    isTargetCeiling: false,
    minimumIndependentEvidence: 1,
    performanceObjective: "Explain the term",
    successCriterion: "Explains the term",
    preferredInteractionTypes: [],
  },
  {
    id: APPLY,
    cognitiveLevel: "apply",
    sequence: 30,
    isApplicable: true,
    isTargetCeiling: true,
    minimumIndependentEvidence: 1,
    performanceObjective: "Use the term",
    successCriterion: "Uses the term",
    preferredInteractionTypes: [],
  },
];

function classify(
  overrides: Partial<KnowledgeStateClassifierInput> = {},
) {
  return classifyKnowledgeState({
    pathAccepted: true,
    path: PATH,
    demonstratedCeilingTrusted: false,
    demonstratedCognitiveLevelId: null,
    meaningfulAttemptCount: 0,
    qualifyingEvidenceCount: 0,
    ...overrides,
  });
}

test("A — no meaningful learner answer remains NOT_STUDIED", () => {
  const state = classify();
  assert.equal(state.knowledgeState, "NOT_STUDIED");
  assert.equal(state.coverageState, "NOT_STUDIED");
  assert.equal(state.targetCognitiveLevel?.id, APPLY);
});

test("B — a legacy-safe attempt establishes coverage but not a C4 ceiling", () => {
  const state = classify({ meaningfulAttemptCount: 2 });
  assert.equal(state.knowledgeState, "NOT_KNOWN");
  assert.equal(state.coverageState, "STUDIED");
  assert.equal(state.demonstratedCognitiveLevel, null);
});

test("C — only a C4 ceiling at the C2 target establishes MASTERED", () => {
  const state = classify({
    meaningfulAttemptCount: 3,
    qualifyingEvidenceCount: 3,
    demonstratedCeilingTrusted: true,
    demonstratedCognitiveLevelId: APPLY,
  });
  assert.equal(state.knowledgeState, "MASTERED");
  assert.deepEqual(state.remainingCognitiveLevels, []);
});

test("D — C4 below target is PARTIAL and preserves the deterministic path gap", () => {
  const state = classify({
    meaningfulAttemptCount: 2,
    demonstratedCeilingTrusted: true,
    demonstratedCognitiveLevelId: UNDERSTAND,
  });
  assert.equal(state.knowledgeState, "PARTIAL");
  assert.equal(state.demonstratedCognitiveLevel?.id, UNDERSTAND);
  assert.deepEqual(state.remainingCognitiveLevels, ["apply"]);
});

test("E — path order, not numeric ID or Bloom label, decides whether target is reached", () => {
  const reordered = [
    { ...PATH[0], id: 9003, sequence: 50 },
    { ...PATH[1], id: 10, sequence: 100, isTargetCeiling: true },
    { ...PATH[2], id: 2, sequence: 150, isTargetCeiling: false },
  ];
  const state = classify({
    path: reordered,
    meaningfulAttemptCount: 1,
    demonstratedCeilingTrusted: true,
    demonstratedCognitiveLevelId: 9003,
  });
  assert.equal(state.knowledgeState, "PARTIAL");
  assert.equal(state.targetCognitiveLevel?.id, 10);
  assert.deepEqual(state.remainingCognitiveLevels, ["understand"]);
});

test("F — an unaccepted or target-less path fails closed", () => {
  const attempted = classify({
    pathAccepted: false,
    meaningfulAttemptCount: 1,
    demonstratedCognitiveLevelId: APPLY,
  });
  const untouched = classify({
    pathAccepted: false,
    meaningfulAttemptCount: 0,
    demonstratedCognitiveLevelId: APPLY,
  });
  assert.equal(attempted.knowledgeState, "NOT_KNOWN");
  assert.equal(attempted.targetCognitiveLevel, null);
  assert.equal(untouched.knowledgeState, "NOT_STUDIED");
});

test("G — a stale/foreign canonical ID cannot claim PARTIAL or MASTERED", () => {
  const state = classify({
    meaningfulAttemptCount: 1,
    demonstratedCeilingTrusted: true,
    demonstratedCognitiveLevelId: 999999,
  });
  assert.equal(state.knowledgeState, "NOT_KNOWN");
  assert.equal(state.demonstratedCognitiveLevel, null);
});

test("H — a current-path ID is ignored unless current C3 evidence validates its C4 provenance", () => {
  const stale = classify({
    meaningfulAttemptCount: 1,
    demonstratedCeilingTrusted: false,
    demonstratedCognitiveLevelId: APPLY,
  });
  const zeroAttempt = classify({
    meaningfulAttemptCount: 0,
    demonstratedCeilingTrusted: true,
    demonstratedCognitiveLevelId: APPLY,
  });
  assert.equal(stale.knowledgeState, "NOT_KNOWN");
  assert.equal(stale.demonstratedCognitiveLevel, null);
  assert.equal(zeroAttempt.knowledgeState, "NOT_STUDIED");
});

test("I — canonical hierarchy counts sum exactly to visible MicroNodes", () => {
  const coverage = aggregateCanonicalKnowledgeState([
    { knowledgeState: "MASTERED" },
    { knowledgeState: "PARTIAL" },
    { knowledgeState: "NOT_KNOWN" },
    { knowledgeState: "NOT_STUDIED" },
    { knowledgeState: "NOT_STUDIED" },
  ]);
  assert.equal(coverage.totalUnits, 5);
  assert.equal(
    coverage.masteredCount +
      coverage.partialCount +
      coverage.doesNotKnowCount +
      coverage.notStartedCount,
    coverage.totalUnits,
  );
  assert.equal(coverage.studiedCount, 3);
  assert.equal(coverage.coveragePercent, 60);
});

for (const { name, fn } of tests) {
  fn();
  console.log(`PASS ${name}`);
}
console.log(`C5 canonical Knowledge Tree regression suite passed (${tests.length}/${tests.length})`);