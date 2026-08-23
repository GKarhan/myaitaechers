/**
 * C7.1 provider-free authorization regressions.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx src/services/__tests__/canonical-completion-authority.test.ts
 */
import assert from "node:assert/strict";
import {
  authorizeCanonicalCompletion,
  buildAuthorizedLevelTransitionUpdate,
  buildAuthorizedTargetTransitionUpdate,
} from "../phase2/canonical-completion-authority.js";

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

const confirmedLevelProjection = {
  pathAccepted: true,
  ceilingLevelId: 102,
  reachedTarget: false,
};

test("C3-rejected evidence never authorizes a model cognitive-level candidate", () => {
  const result = authorizeCanonicalCompletion({
    candidate: "ADVANCE_COGNITIVE_LEVEL",
    qualificationStatus: "unqualified",
    projection: confirmedLevelProjection,
    currentLevelConfirmed: true,
  });
  assert.deepEqual(result, { authorized: false, reasonCode: "C3_EVIDENCE_UNQUALIFIED" });
});

test("an unlinked/fallback task cannot complete a MicroNode", () => {
  const result = authorizeCanonicalCompletion({
    candidate: "COMPLETE_MICRONODE",
    qualificationStatus: "unqualified",
    projection: { ...confirmedLevelProjection, reachedTarget: true },
    currentLevelConfirmed: true,
  });
  assert.equal(result.authorized, false);
  assert.equal(result.reasonCode, "C3_EVIDENCE_UNQUALIFIED");
});

test("C4 must confirm the active level before a level transition", () => {
  const result = authorizeCanonicalCompletion({
    candidate: "ADVANCE_COGNITIVE_LEVEL",
    qualificationStatus: "qualified",
    projection: confirmedLevelProjection,
    currentLevelConfirmed: false,
  });
  assert.deepEqual(result, { authorized: false, reasonCode: "C4_CURRENT_LEVEL_NOT_CONFIRMED" });
});

test("a moderate qualified result below C4 target does not complete the node", () => {
  const result = authorizeCanonicalCompletion({
    candidate: "COMPLETE_MICRONODE",
    qualificationStatus: "qualified",
    projection: confirmedLevelProjection,
    currentLevelConfirmed: true,
  });
  assert.deepEqual(result, { authorized: false, reasonCode: "C4_TARGET_NOT_REACHED" });
});

test("invalid C2/C4 paths fail closed before C6 can be consulted", () => {
  const result = authorizeCanonicalCompletion({
    candidate: "COMPLETE_MICRONODE",
    qualificationStatus: "qualified",
    projection: { pathAccepted: false, ceilingLevelId: null, reachedTarget: false },
    currentLevelConfirmed: false,
  });
  assert.deepEqual(result, { authorized: false, reasonCode: "C4_PATH_UNAVAILABLE" });
});

test("qualified evidence and C4 confirmation authorize only the corresponding transition", () => {
  assert.equal(authorizeCanonicalCompletion({
    candidate: "ADVANCE_COGNITIVE_LEVEL",
    qualificationStatus: "qualified",
    projection: confirmedLevelProjection,
    currentLevelConfirmed: true,
  }).authorized, true);
  assert.equal(authorizeCanonicalCompletion({
    candidate: "COMPLETE_MICRONODE",
    qualificationStatus: "qualified",
    projection: { ...confirmedLevelProjection, reachedTarget: true },
    currentLevelConfirmed: true,
  }).authorized, true);
});

test("authorized node transition clears transient target state but preserves no C3/C4 fields", () => {
  const update = buildAuthorizedTargetTransitionUpdate({
    sessionId: 1,
    currentNodeId: 22,
    nextPhase: 2,
    nextActiveCognitiveLevelId: 202,
  });
  assert.equal(update.currentNodeId, 22);
  assert.equal(update.activeCognitiveLevelId, 202);
  assert.equal(update.nodeTeachingStage, "THEORY");
  assert.equal(update.activeTaskReference, null);
  assert.equal(update.activeHelpCount, 0);
  assert.equal(update.remediationStep, 0);
  assert.equal("demonstratedCognitiveLevel" in update, false);
});

test("same-node level transition does not clear node-wide progress counters", () => {
  const update = buildAuthorizedLevelTransitionUpdate(303);
  assert.equal(update.activeCognitiveLevelId, 303);
  assert.equal(update.nodeTeachingStage, "THEORY");
  assert.equal("nodeMasteryEvidenceCount" in update, false);
  assert.equal("nodeConsecutiveCorrect" in update, false);
});

let passed = 0;
for (const { name, fn } of tests) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}
console.log(`\n${passed}/${tests.length} C7.1 canonical completion authority tests passed`);