import assert from "node:assert/strict";
import {
  matchesTargetCognitiveDemand,
  type TargetCognitiveDemand,
} from "../../lib/c2-target-demand.js";

const resolvedApply: TargetCognitiveDemand = {
  targetLevel: "apply",
  confidence: "HIGH",
  evidence: ["OBJECTIVE_PERFORMANCE", "SOURCE_PROCEDURE"],
  c1Relation: "RAISED_ABOVE_C1",
  reviewReasons: ["C1_TARGET_DISCREPANCY"],
  resolverVersion: "test",
};

assert.equal(
  matchesTargetCognitiveDemand(resolvedApply, [{
    cognitiveLevel: "apply",
    isTargetCeiling: true,
  }]),
  true,
  "a strong resolved APPLY demand may exceed a stale C1 REMEMBER prior",
);
assert.equal(
  matchesTargetCognitiveDemand(resolvedApply, [
    { cognitiveLevel: "remember", isTargetCeiling: false },
    { cognitiveLevel: "analyze", isTargetCeiling: true },
  ]),
  false,
  "the generated ceiling must match the server-resolved demand exactly",
);
assert.equal(
  matchesTargetCognitiveDemand(resolvedApply, [{
    cognitiveLevel: "remember",
    isTargetCeiling: true,
  }]),
  false,
  "a generated path cannot be silently lowered to an old C1 prior",
);

console.log("C2 target-demand constraint: 3/3 passed");