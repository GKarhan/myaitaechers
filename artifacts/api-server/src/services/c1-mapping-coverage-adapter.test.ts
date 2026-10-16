import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { auditPersistableC1TaskCoverage } from "./c1-mapping-coverage-adapter.js";

const source = (index: number, kind: string, disposition = "EXERCISE", reasons: string[] = ["STUDENT_TASK"]) =>
  ({ sourceBlockIndex: index, blockType: kind, primaryDisposition: disposition, dispositionReasonCodes: reasons });

describe("C1 durable source adapter", () => {
  it("checks in-lesson exercises against mapped task links", () => {
    const report = auditPersistableC1TaskCoverage([source(0, "EXERCISE")], [{ microNodes: [], additionalExercises: [] }]);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some(x => x.code === "TASK_NOT_PRESERVED"));
  });
  it("counts exercises linked to MicroNodes and supplementary exercises", () => {
    const report = auditPersistableC1TaskCoverage([source(0, "EXERCISE"), source(1, "ACTIVITY", "ACTIVITY_OR_HOMEWORK")], [
      { microNodes: [{ sourceBlockIndices: [], supportingMaterialIndices: [], exercises: [{ blockIndex: 0 }] }], additionalExercises: [{ blockIndex: 1 }] },
    ]);
    assert.equal(report.ok, true);
    assert.equal(report.preservedTaskCount, 2);
  });
  it("does not reject deliberately excluded material from the next section", () => {
    const report = auditPersistableC1TaskCoverage([source(2, "EXERCISE", "EXCLUDED_WITH_REASON", ["ADJACENT_NEXT_SECTION"])], [
      { microNodes: [] },
    ]);
    assert.equal(report.ok, true);
  });
  it("retains unreadable task blocks as teacher review rather than forgetting them", () => {
    const report = auditPersistableC1TaskCoverage([source(3, "ACTIVITY", "UNRESOLVED_VISUAL_OR_FORMULA", ["UNREADABLE_SOURCE"])], [
      { microNodes: [] },
    ]);
    assert.equal(report.ok, true);
    assert.equal(report.preservedTaskCount, 1);
  });
});