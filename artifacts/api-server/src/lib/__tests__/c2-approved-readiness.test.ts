import assert from "node:assert/strict";
import { assessApprovedMicroNodeC2Readiness } from "../c2-readiness.js";

const results: Array<{ name: string; pass: boolean; error?: unknown }> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error });
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

const validLevel = {
  cognitiveLevel: "understand",
  sequence: 1,
  isApplicable: true,
  isTargetCeiling: true,
  performanceObjective: "The student can identify water in the source.",
  successCriterion: "The student identifies water independently.",
  preferredInteractionTypes: ["multiple_choice"],
};

const validInput = {
  cogPathStatus: "confirmed",
  theoryContent: "Water is essential for life.",
  learningObjective: "The student can identify water in the source.",
  levels: [validLevel],
} as const;

test("valid confirmed C2 path is ready for approval", () => {
  const readiness = assessApprovedMicroNodeC2Readiness(validInput);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.acceptance.reason, "ACCEPTED");
});

test("missing C2 path is never ready for approval", () => {
  const readiness = assessApprovedMicroNodeC2Readiness({
    ...validInput,
    cogPathStatus: null,
    levels: [],
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.acceptance.reason, "PATH_NOT_CONFIRMED");
});

test("unconfirmed C2 path is never ready for approval", () => {
  const readiness = assessApprovedMicroNodeC2Readiness({
    ...validInput,
    cogPathStatus: "needs_review",
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.acceptance.reason, "PATH_NOT_CONFIRMED");
});

test("invalid C2 path cannot become ready merely by confirmation", () => {
  const readiness = assessApprovedMicroNodeC2Readiness({
    ...validInput,
    levels: [{ ...validLevel, isTargetCeiling: false }],
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.acceptance.reason, "TARGET_CEILING_INVALID");
});

const passed = results.filter((result) => result.pass).length;
console.log(`C2 approved readiness: ${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;