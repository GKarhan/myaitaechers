import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { planUnifiedLessonMapping, type UnifiedMappingSnapshot } from "./unified-lesson-mapping-plan.js";

const ready: UnifiedMappingSnapshot = {
  hasSource: true,
  hasValidPageRange: true,
  c1: "completed",
  c2: "completed",
  teachingPackage: "completed",
  validationPassed: true,
};

describe("unified lesson mapping plan", () => {
  it("requires a source before doing work", () => {
    assert.deepEqual(planUnifiedLessonMapping({ ...ready, hasSource: false }).reasons, ["SOURCE_REQUIRED"]);
  });
  it("starts with C1 and moves through the three stages", () => {
    assert.equal(planUnifiedLessonMapping({ ...ready, c1: "pending", c2: "pending", teachingPackage: "pending" }).nextStage, "source_and_c1");
    assert.equal(planUnifiedLessonMapping({ ...ready, c2: "pending", teachingPackage: "pending" }).nextStage, "c2_paths");
    assert.equal(planUnifiedLessonMapping({ ...ready, teachingPackage: "pending" }).nextStage, "teaching_package");
  });
  it("halts on failures without advancing to the next stage", () => {
    const plan = planUnifiedLessonMapping({ ...ready, c2: "blocked" });
    assert.equal(plan.outcome, "blocked");
    assert.equal(plan.nextStage, null);
  });
  it("never publishes or approves on its own", () => {
    const plan = planUnifiedLessonMapping(ready);
    assert.equal(plan.outcome, "needs_review");
    assert.equal(plan.nextStage, "teacher_review");
    assert.equal(plan.requiresTeacherApproval, true);
  });
  it("holds the result when final validation fails", () => {
    assert.equal(planUnifiedLessonMapping({ ...ready, validationPassed: false }).outcome, "blocked");
  });
});
