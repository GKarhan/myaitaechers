import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { auditC1SourceDispositions, type C1SourceDisposition } from "./c1-source-coverage-gate.js";

describe("C1 source coverage gate", () => {
  it("accepts source knowledge plus an assigned and a supplementary task", () => {
    const items: C1SourceDisposition[] = [
      { sourceBlockId: "B1", kind: "KNOWLEDGE", disposition: "MICRONODE" },
      { sourceBlockId: "B2", kind: "EXERCISE", disposition: "ATTACHED_TASK" },
      { sourceBlockId: "B3", kind: "ACTIVITY", disposition: "SUPPLEMENTARY_TASK" },
    ];
    const report = auditC1SourceDispositions(["B1", "B2", "B3"], items);
    assert.equal(report.ok, true);
    assert.equal(report.preservedTaskCount, 2);
  });
  it("rejects a silently discarded exercise", () => {
    const report = auditC1SourceDispositions(["B1"], [{ sourceBlockId: "B1", kind: "EXERCISE", disposition: "EXCLUDED" }]);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some(x => x.code === "TASK_NOT_PRESERVED"));
  });
  it("detects a missing source block", () => {
    const report = auditC1SourceDispositions(["B1", "B2"], [{ sourceBlockId: "B1", kind: "KNOWLEDGE", disposition: "MICRONODE" }]);
    assert.ok(report.issues.some(x => x.code === "MISSING_SOURCE_ID" && x.sourceBlockId === "B2"));
  });
  it("rejects duplicate source identities", () => {
    const row: C1SourceDisposition = { sourceBlockId: "B1", kind: "CONTEXT", disposition: "REVIEW_REQUIRED" };
    assert.ok(auditC1SourceDispositions(["B1"], [row, row]).issues.some(x => x.code === "DUPLICATE_SOURCE_ID"));
  });
  it("requires a reason for excluded non-task material", () => {
    const report = auditC1SourceDispositions(["B1"], [{ sourceBlockId: "B1", kind: "CONTEXT", disposition: "EXCLUDED" }]);
    assert.ok(report.issues.some(x => x.code === "EXCLUSION_WITHOUT_REASON"));
  });
});
