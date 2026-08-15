/**
 * V2-R3 Pedagogical Decision Engine — Test Suite
 *
 * Tests: T01–T45
 * All tests are pure (no DB, no HTTP) — the engine is a pure function.
 *
 * Run: pnpm --filter @workspace/api-server test:v2r3
 */

import assert from "node:assert/strict";
import {
  decideNextPedagogicalAction,
  MAX_REMEDIATION_STEPS,
  type PedagogicalDecisionInput,
  type CognitiveLevelRow,
  type LevelEvidenceSummary,
} from "../../services/pedagogicalDecisionEngine.js";

// ── Minimal test runner ───────────────────────────────────────────────────────

type TestFn = () => void | Promise<void>;
const _tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) { _tests.push({ name, fn }); }

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLevel(overrides: Partial<CognitiveLevelRow> = {}): CognitiveLevelRow {
  return {
    id: 1,
    cognitiveLevel: "remember",
    sequence: 1,
    isTargetCeiling: false,
    isApplicable: true,
    minimumIndependentEvidence: 1,   // 1 for fast tests
    preferredInteractionTypes: ["micro_check"],
    performanceObjective: null,
    successCriterion: null,
    ...overrides,
  };
}

function makeCeilingLevel(overrides: Partial<CognitiveLevelRow> = {}): CognitiveLevelRow {
  return makeLevel({
    id: 2,
    cognitiveLevel: "understand",
    sequence: 2,
    isTargetCeiling: true,
    ...overrides,
  });
}

/** Default two-level path: remember (id=1) → understand (id=2, ceiling) */
const DEFAULT_PATH: CognitiveLevelRow[] = [
  makeLevel({ id: 1, cognitiveLevel: "remember", sequence: 1, isTargetCeiling: false }),
  makeCeilingLevel({ id: 2, cognitiveLevel: "understand", sequence: 2, isTargetCeiling: true }),
];

const EMPTY_EVIDENCE: LevelEvidenceSummary = {
  independentCorrectCount: 0,
  totalCorrectCount: 0,
  bestQuality: null,
};

function makeInput(overrides: Partial<PedagogicalDecisionInput> = {}): PedagogicalDecisionInput {
  return {
    lessonNodeId: 100,
    lessonId: 10,
    sessionId: 50,
    userId: 7,
    nodeTeachingStage: "MICRO_CHECK",
    remediationStep: 0,
    activeCognitiveLevelId: 1,
    activeCognitiveLevelRow: DEFAULT_PATH[0],
    cognitivePath: DEFAULT_PATH,
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    errorFamily: null,
    errorStability: null,
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    activeAttemptSequence: 1,
    activeTaskProvenance: "micro_check",
    levelEvidenceSummary: EMPTY_EVIDENCE,
    nextNodeId: null,
    nextNodeHasCriticalDependencyOnCurrentNode: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T01–T05: Guard conditions
// ─────────────────────────────────────────────────────────────────────────────

test("T01 — answerStatus=null → NON_ANSWER", () => {
  const d = decideNextPedagogicalAction(makeInput({ answerStatus: null }));
  assert.equal(d.metaAction, "NON_ANSWER");
  assert.equal(d.mayCompleteMicroNode, false);
});

test("T02 — answerStatus=NOT_APPLICABLE → NON_ANSWER", () => {
  const d = decideNextPedagogicalAction(makeInput({ answerStatus: "NOT_APPLICABLE" }));
  assert.equal(d.metaAction, "NON_ANSWER");
  assert.equal(d.newRemediationStep, 0); // unchanged
});

test("T03 — answerStatus=OFF_TOPIC → NON_ANSWER", () => {
  const d = decideNextPedagogicalAction(makeInput({ answerStatus: "OFF_TOPIC" }));
  assert.equal(d.metaAction, "NON_ANSWER");
});

test("T04 — empty cognitivePath → NO_COGNITIVE_PATH", () => {
  const d = decideNextPedagogicalAction(makeInput({
    cognitivePath: [],
    activeCognitiveLevelRow: null,
    activeCognitiveLevelId: null,
  }));
  assert.equal(d.metaAction, "NO_COGNITIVE_PATH");
  assert.equal(d.mayCompleteMicroNode, false);
});

test("T05 — activeCognitiveLevelRow=null → NO_COGNITIVE_PATH", () => {
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelRow: null,
    activeCognitiveLevelId: null,
  }));
  assert.equal(d.metaAction, "NO_COGNITIVE_PATH");
});

// ─────────────────────────────────────────────────────────────────────────────
// T06–T10: Evidence gate — independent correct
// ─────────────────────────────────────────────────────────────────────────────

test("T06 — first independent correct, minRequired=1 → ADVANCE_COGNITIVE_LEVEL", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    levelEvidenceSummary: { independentCorrectCount: 0, totalCorrectCount: 0, bestQuality: null },
  }));
  assert.equal(d.metaAction, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(d.levelConfirmed, true);
  assert.equal(d.confirmedLevel, "remember");
  assert.equal(d.targetReached, false);
  assert.equal(d.newActiveCognitiveLevelId, 2);
  assert.equal(d.newRemediationStep, 0);
});

test("T07 — at ceiling with minRequired=1, independent correct → COMPLETE_NODE", () => {
  const ceilPath = [
    makeCeilingLevel({ id: 1, cognitiveLevel: "understand", sequence: 1, isTargetCeiling: true }),
  ];
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelId: 1,
    activeCognitiveLevelRow: ceilPath[0],
    cognitivePath: ceilPath,
    answerStatus: "CORRECT",
    evidenceQuality: "STRONG",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  assert.equal(d.metaAction, "COMPLETE_NODE");
  assert.equal(d.mayCompleteMicroNode, true);
  assert.equal(d.targetReached, true);
  assert.equal(d.levelConfirmed, true);
  assert.equal(d.confirmedLevel, "understand");
  assert.equal(d.revisitRequired, false);
  assert.equal(d.mayWriteMastery, true);
});

test("T08 — evidence quality WEAK → quality gate fails → remediation", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "CORRECT",
    evidenceQuality: "WEAK",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  assert.equal(d.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.equal(d.levelConfirmed, false);
  assert.equal(d.newRemediationStep, 1);
});

test("T09 — minRequired=3, have 2 existing + current → 3 → ADVANCE_COGNITIVE_LEVEL", () => {
  const path = [
    makeLevel({ id: 1, minimumIndependentEvidence: 3, isTargetCeiling: false }),
    makeCeilingLevel({ id: 2 }),
  ];
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelRow: path[0],
    cognitivePath: path,
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    levelEvidenceSummary: { independentCorrectCount: 2, totalCorrectCount: 3, bestQuality: "MODERATE" },
  }));
  assert.equal(d.metaAction, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(d.levelConfirmed, true);
});

test("T10 — minRequired=3, have 1 existing → 1+1=2 < 3 → need more evidence", () => {
  const path = [
    makeLevel({ id: 1, minimumIndependentEvidence: 3, isTargetCeiling: false }),
    makeCeilingLevel({ id: 2 }),
  ];
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelRow: path[0],
    cognitivePath: path,
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    levelEvidenceSummary: { independentCorrectCount: 1, totalCorrectCount: 2, bestQuality: "MODERATE" },
  }));
  assert.equal(d.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.equal(d.remediationAction, "CONTINUE_SAME_NODE");
  assert.equal(d.newRemediationStep, 0); // correct → reset
  assert.equal(d.levelConfirmed, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// T11–T15: Helped / assisted success
// ─────────────────────────────────────────────────────────────────────────────

test("T11 — CORRECT + moderate assistance → REQUEST_INDEPENDENT_CHECK", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 3,
    activeAssistanceLevel: "moderate",
  }));
  assert.equal(d.metaAction, "REQUEST_INDEPENDENT_CHECK");
  assert.equal(d.levelConfirmed, false);
  assert.equal(d.newRemediationStep, 0);
  assert.equal(d.preserveActiveTask, false);
});

test("T12 — CORRECT + guided assistance → REQUEST_INDEPENDENT_CHECK", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "CORRECT",
    evidenceQuality: "STRONG",
    activeHelpCount: 5,
    activeAssistanceLevel: "guided",
  }));
  assert.equal(d.metaAction, "REQUEST_INDEPENDENT_CHECK");
  assert.equal(d.revisitRequired, false);
});

test("T13 — CORRECT + 1 help + light assistance → still independent → ADVANCE", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 1,
    activeAssistanceLevel: "light",
  }));
  // helpCount=1 AND assistanceLevel=light → qualifies as independent
  assert.equal(d.metaAction, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(d.levelConfirmed, true);
});

test("T14 — PARTIALLY_CORRECT + moderate assistance → REQUEST_INDEPENDENT_CHECK", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "PARTIALLY_CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 2,
    activeAssistanceLevel: "moderate",
  }));
  assert.equal(d.metaAction, "REQUEST_INDEPENDENT_CHECK");
});

test("T15 — CORRECT + revealed assistance → REQUEST_INDEPENDENT_CHECK", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "CORRECT",
    evidenceQuality: "CONCLUSIVE",
    activeHelpCount: 10,
    activeAssistanceLevel: "revealed",
  }));
  assert.equal(d.metaAction, "REQUEST_INDEPENDENT_CHECK");
  assert.equal(d.levelConfirmed, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// T16–T25: Remediation — error family action mapping
// ─────────────────────────────────────────────────────────────────────────────

function incorrectInput(errorFamily: string | null, step = 0): PedagogicalDecisionInput {
  return makeInput({
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
    errorFamily,
    remediationStep: step,
  });
}

test("T16 — CONCEPTUAL step 0 → EXTRA_EXAMPLE", () => {
  const d = decideNextPedagogicalAction(incorrectInput("CONCEPTUAL", 0));
  assert.equal(d.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.equal(d.remediationAction, "EXTRA_EXAMPLE");
  assert.equal(d.newRemediationStep, 1);
});

test("T17 — CONCEPTUAL step 2 → CONTRAST_EXAMPLE", () => {
  const d = decideNextPedagogicalAction(incorrectInput("CONCEPTUAL", 2));
  assert.equal(d.remediationAction, "CONTRAST_EXAMPLE");
  assert.equal(d.newRemediationStep, 3);
});

test("T18 — PREREQUISITE any step → RETURN_TO_PREREQUISITE", () => {
  const d = decideNextPedagogicalAction(incorrectInput("PREREQUISITE", 1));
  assert.equal(d.remediationAction, "RETURN_TO_PREREQUISITE");
});

test("T19 — PROCEDURAL → STEP_BY_STEP", () => {
  const d = decideNextPedagogicalAction(incorrectInput("PROCEDURAL", 0));
  assert.equal(d.remediationAction, "STEP_BY_STEP");
});

test("T20 — CALCULATION_EXECUTION → VERIFY_SELECTION", () => {
  const d = decideNextPedagogicalAction(incorrectInput("CALCULATION_EXECUTION", 0));
  assert.equal(d.remediationAction, "VERIFY_SELECTION");
});

test("T21 — READING_LANGUAGE → SIMPLIFY_LANGUAGE", () => {
  const d = decideNextPedagogicalAction(incorrectInput("READING_LANGUAGE", 0));
  assert.equal(d.remediationAction, "SIMPLIFY_LANGUAGE");
});

test("T22 — GUESSING_CONFIDENCE → REQUIRE_REASONING", () => {
  const d = decideNextPedagogicalAction(incorrectInput("GUESSING_CONFIDENCE", 0));
  assert.equal(d.remediationAction, "REQUIRE_REASONING");
});

test("T23 — null errorFamily step 0 → EXTRA_EXAMPLE (generic fallback)", () => {
  const d = decideNextPedagogicalAction(incorrectInput(null, 0));
  assert.equal(d.remediationAction, "EXTRA_EXAMPLE");
});

test("T24 — step ≥ 3 → escalation cap → GUIDED_QUESTION", () => {
  const d = decideNextPedagogicalAction(incorrectInput("CONCEPTUAL", 3));
  assert.equal(d.remediationAction, "GUIDED_QUESTION");
});

test("T25 — INCOMPLETE_COMMUNICATION → GUIDED_QUESTION", () => {
  const d = decideNextPedagogicalAction(incorrectInput("INCOMPLETE_COMMUNICATION", 0));
  assert.equal(d.remediationAction, "GUIDED_QUESTION");
});

// ─────────────────────────────────────────────────────────────────────────────
// T26–T30: Remediation step counter
// ─────────────────────────────────────────────────────────────────────────────

test("T26 — incorrect from step 0 → newRemediationStep=1", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
    remediationStep: 0,
  }));
  assert.equal(d.newRemediationStep, 1);
  assert.equal(d.metaAction, "CONTINUE_COGNITIVE_LEVEL");
});

test("T27 — incorrect from step 4 → newRemediationStep=5 (last before budget)", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
    remediationStep: 4,
  }));
  assert.equal(d.newRemediationStep, 5);
  assert.equal(d.metaAction, "CONTINUE_COGNITIVE_LEVEL");
});

test("T28 — budget exhausted, no critical dep → MARK_TARGET_NOT_REACHED", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
    remediationStep: MAX_REMEDIATION_STEPS,
    nextNodeHasCriticalDependencyOnCurrentNode: false,
  }));
  assert.equal(d.metaAction, "MARK_TARGET_NOT_REACHED");
  assert.equal(d.revisitRequired, true);
  assert.equal(d.newRemediationStep, 0);
  assert.equal(d.mayCompleteMicroNode, true);
});

test("T29 — budget exhausted + critical dep → REVISIT_LATER", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
    remediationStep: MAX_REMEDIATION_STEPS,
    nextNodeHasCriticalDependencyOnCurrentNode: true,
  }));
  assert.equal(d.metaAction, "REVISIT_LATER");
  assert.equal(d.revisitRequired, true);
  assert.equal(d.mayCompleteMicroNode, false);
  assert.equal(d.preserveActiveTask, true);
});

test("T30 — correct answer resets remediationStep to 0", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
    remediationStep: 3,
  }));
  assert.equal(d.newRemediationStep, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// T31–T35: State update invariants
// ─────────────────────────────────────────────────────────────────────────────

test("T31 — NON_ANSWER never changes remediationStep", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "NOT_APPLICABLE",
    remediationStep: 3,
  }));
  assert.equal(d.newRemediationStep, 3);
});

test("T32 — NON_ANSWER: levelConfirmed=false, revisitRequired=false, mayWriteMastery=false", () => {
  const d = decideNextPedagogicalAction(makeInput({ answerStatus: null }));
  assert.equal(d.levelConfirmed, false);
  assert.equal(d.revisitRequired, false);
  assert.equal(d.mayWriteMastery, false);
});

test("T33 — CONTINUE: preserveActiveTask=true (stay on same task type)", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
    remediationStep: 0,
  }));
  assert.equal(d.preserveActiveTask, true);
});

test("T34 — ADVANCE_COGNITIVE_LEVEL: newActiveCognitiveLevelId = next level id", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  // remember (id=1) → understand (id=2)
  assert.equal(d.metaAction, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(d.newActiveCognitiveLevelId, 2);
});

test("T35 — COMPLETE_NODE: mayWriteMastery=true, revisitRequired=false", () => {
  const ceilPath = [makeCeilingLevel({ id: 1, cognitiveLevel: "understand", sequence: 1 })];
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelRow: ceilPath[0],
    cognitivePath: ceilPath,
    activeCognitiveLevelId: 1,
    answerStatus: "CORRECT",
    evidenceQuality: "STRONG",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  assert.equal(d.mayWriteMastery, true);
  assert.equal(d.revisitRequired, false);
  assert.equal(d.mayCompleteMicroNode, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// T36–T40: Multi-level path traversal
// ─────────────────────────────────────────────────────────────────────────────

const THREE_LEVEL_PATH: CognitiveLevelRow[] = [
  makeLevel({ id: 10, cognitiveLevel: "remember", sequence: 1, isTargetCeiling: false }),
  makeLevel({ id: 11, cognitiveLevel: "understand", sequence: 2, isTargetCeiling: false }),
  makeLevel({ id: 12, cognitiveLevel: "apply", sequence: 3, isTargetCeiling: true }),
];

test("T36 — remember confirmed → advance to understand (id=11)", () => {
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelId: 10,
    activeCognitiveLevelRow: THREE_LEVEL_PATH[0],
    cognitivePath: THREE_LEVEL_PATH,
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  assert.equal(d.metaAction, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(d.newActiveCognitiveLevelId, 11);
  assert.equal(d.confirmedLevel, "remember");
  assert.equal(d.targetReached, false);
});

test("T37 — understand confirmed → advance to apply (id=12)", () => {
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelId: 11,
    activeCognitiveLevelRow: THREE_LEVEL_PATH[1],
    cognitivePath: THREE_LEVEL_PATH,
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  assert.equal(d.metaAction, "ADVANCE_COGNITIVE_LEVEL");
  assert.equal(d.newActiveCognitiveLevelId, 12);
  assert.equal(d.confirmedLevel, "understand");
  assert.equal(d.targetReached, false);
});

test("T38 — apply (ceiling) confirmed → COMPLETE_NODE", () => {
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelId: 12,
    activeCognitiveLevelRow: THREE_LEVEL_PATH[2],
    cognitivePath: THREE_LEVEL_PATH,
    answerStatus: "CORRECT",
    evidenceQuality: "STRONG",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  assert.equal(d.metaAction, "COMPLETE_NODE");
  assert.equal(d.targetReached, true);
  assert.equal(d.confirmedLevel, "apply");
});

test("T39 — single-level path (only ceiling) → CORRECT → COMPLETE_NODE directly", () => {
  const singlePath = [
    makeLevel({ id: 20, cognitiveLevel: "remember", sequence: 1, isTargetCeiling: true }),
  ];
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelId: 20,
    activeCognitiveLevelRow: singlePath[0],
    cognitivePath: singlePath,
    answerStatus: "CORRECT",
    evidenceQuality: "MODERATE",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  assert.equal(d.metaAction, "COMPLETE_NODE");
  assert.equal(d.targetReached, true);
});

test("T40 — INCORRECT at remember in 3-level path → CONTINUE, path unchanged", () => {
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelId: 10,
    activeCognitiveLevelRow: THREE_LEVEL_PATH[0],
    cognitivePath: THREE_LEVEL_PATH,
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
    errorFamily: "CONCEPTUAL",
  }));
  assert.equal(d.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.equal(d.newActiveCognitiveLevelId, null);
  assert.equal(d.currentCognitiveLevel, "remember");
  assert.equal(d.targetCognitiveLevel, "apply");
});

// ─────────────────────────────────────────────────────────────────────────────
// T41–T45: Output completeness and edge cases
// ─────────────────────────────────────────────────────────────────────────────

test("T41 — MAX_REMEDIATION_STEPS is 5", () => {
  assert.equal(MAX_REMEDIATION_STEPS, 5);
});

test("T42 — all decisions include non-empty reasonCode", () => {
  const inputs: Partial<PedagogicalDecisionInput>[] = [
    { answerStatus: null },
    { cognitivePath: [], activeCognitiveLevelRow: null, activeCognitiveLevelId: null },
    { answerStatus: "CORRECT", evidenceQuality: "MODERATE", activeHelpCount: 0, activeAssistanceLevel: "none" },
    { answerStatus: "INCORRECT", evidenceQuality: "NONE" },
  ];
  for (const override of inputs) {
    const d = decideNextPedagogicalAction(makeInput(override));
    assert.equal(typeof d.reasonCode, "string");
    assert.ok(d.reasonCode.length > 0, `reasonCode empty for override ${JSON.stringify(override)}`);
  }
});

test("T43 — CONTINUE_COGNITIVE_LEVEL: remediationAction is always non-null", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
    errorFamily: "CONCEPTUAL",
  }));
  assert.equal(d.metaAction, "CONTINUE_COGNITIVE_LEVEL");
  assert.notEqual(d.remediationAction, null);
});

test("T44 — COMPLETE_NODE: remediationAction is null (engine doesn't invent actions)", () => {
  const ceilPath = [makeCeilingLevel({ id: 1 })];
  const d = decideNextPedagogicalAction(makeInput({
    activeCognitiveLevelRow: ceilPath[0],
    cognitivePath: ceilPath,
    activeCognitiveLevelId: 1,
    answerStatus: "CORRECT",
    evidenceQuality: "STRONG",
    activeHelpCount: 0,
    activeAssistanceLevel: "none",
  }));
  assert.equal(d.metaAction, "COMPLETE_NODE");
  assert.equal(d.remediationAction, null);
});

test("T45 — currentCognitiveLevel and targetCognitiveLevel populated when path exists", () => {
  const d = decideNextPedagogicalAction(makeInput({
    answerStatus: "INCORRECT",
    evidenceQuality: "NONE",
  }));
  assert.equal(d.currentCognitiveLevel, "remember");
  assert.equal(d.targetCognitiveLevel, "understand");
});

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const { name, fn } of _tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.message ?? err}`);
    failed++;
    failures.push(name);
  }
}

console.log(`\nV2-R3 Decision Engine: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("FAILURES:", failures);
  process.exit(1);
}
