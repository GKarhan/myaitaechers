import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { evaluatePersistedUnifiedMapEvidence, type PersistedUnifiedMapEvidence } from "./unified-mapping-persisted-evidence.js";
const sample = (): PersistedUnifiedMapEvidence => ({
  finalApproval: {
    readiness: "READY", errors: [], overrideable: [], warnings: [],
    summary: { totalNodes: 2, approvedNodes: 2, totalTopics: 1, sourceExercises: 3,
      approvedSourceExercises: 3, draftSourceExercises: 0, phase2CompleteNodes: 2,
      missingLONodes: 0, emptyNodes: 0, usableNodes: 2 },
  },
  nodeCount: 2, cognitiveNodeCount: 2, validCognitiveTargetNodeCount: 2,
  outcomeCount: 1, outcomesWithRequiredNodeCount: 1,
  expectedTextbookTaskCount: 3, preservedTextbookTaskCount: 3,
});
describe("persisted unified map quality bridge", () => {
  it("accepts complete authoritative evidence", () => {
    const r = evaluatePersistedUnifiedMapEvidence(sample());
    assert.equal(r.status, "QUALITY_READY"); assert.equal(r.teacherApproved, false);
  });
  it("does not claim tasks preserved without a source baseline", () => {
    const e=sample();e.expectedTextbookTaskCount=null;
    assert.ok(evaluatePersistedUnifiedMapEvidence(e).blockingCodes.includes("TASK_SOURCE_BASELINE_UNKNOWN"));
  });
  it("rejects loss of textbook exercise records", () => {
    const e=sample();e.preservedTextbookTaskCount=2;
    assert.ok(evaluatePersistedUnifiedMapEvidence(e).blockingCodes.includes("TASK_SOURCE_LOSS"));
  });
  it("rejects missing required outcome links", () => {
    const e=sample();e.outcomesWithRequiredNodeCount=0;
    assert.ok(evaluatePersistedUnifiedMapEvidence(e).blockingCodes.includes("OUTCOMES_WITHOUT_REQUIRED_MICRONODE"));
  });
  it("rejects C2 nodes lacking a unique ceiling", () => {
    const e=sample();e.validCognitiveTargetNodeCount=1;
    assert.ok(evaluatePersistedUnifiedMapEvidence(e).blockingCodes.includes("C2_COGNITIVE_PATH_INCOMPLETE"));
  });
  it("rejects missing teaching material for any node", () => {
    const e=sample();e.finalApproval.summary.phase2CompleteNodes=1;
    assert.ok(evaluatePersistedUnifiedMapEvidence(e).blockingCodes.includes("TEACHING_PACKAGE_INCOMPLETE"));
  });
  it("requires teacher review when canonical validator reports advisory issues", () => {
    const e=sample();e.finalApproval.warnings=[{code:"COMPOUND_LO",messageArm:"Review"}];
    assert.equal(evaluatePersistedUnifiedMapEvidence(e).status,"TEACHER_REVIEW_REQUIRED");
  });
});
