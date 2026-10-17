import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { assessUnifiedMappingReadiness, type UnifiedQualityCheck, type UnifiedQualityArea } from "./unified-mapping-quality-readiness.js";

const areas: UnifiedQualityArea[] = ["C1", "C2", "TEACHING_PACKAGE", "TASKS", "OUTCOMES"];
const passing = (): UnifiedQualityCheck[] => areas.map(area => ({ area, code: area + "_VERIFIED", state: "PASS" }));

describe("Unified mapping strict quality readiness", () => {
  it("fails closed when nothing has been checked", () => {
    const result = assessUnifiedMappingReadiness([]);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.blockingCodes.length, 5);
    assert.equal(result.teacherApproved, false);
  });
  it("accepts fully checked quality only for teacher review, never auto approval", () => {
    const result = assessUnifiedMappingReadiness(passing());
    assert.equal(result.status, "QUALITY_READY");
    assert.equal(result.readyForTeacherApproval, true);
    assert.equal(result.teacherApproved, false);
  });
  it("requires explicit review for advisory semantic uncertainty", () => {
    const result = assessUnifiedMappingReadiness([...passing(), { area: "C1", code: "ATOMICITY_UNCERTAIN", state: "REVIEW_REQUIRED" }]);
    assert.equal(result.status, "TEACHER_REVIEW_REQUIRED");
    assert.deepEqual(result.reviewCodes, ["ATOMICITY_UNCERTAIN"]);
  });
  it("blocks when any mandatory stage has failed even when others pass", () => {
    const checks = passing().map(check => check.area === "TASKS" ? { ...check, state: "FAIL" as const } : check);
    assert.equal(assessUnifiedMappingReadiness(checks).status, "BLOCKED");
  });
  it("a completed C1 is not sufficient without C2, package, tasks and outcomes evidence", () => {
    const result = assessUnifiedMappingReadiness([passing()[0]]);
    assert.equal(result.blockingCodes.length, 4);
  });
});