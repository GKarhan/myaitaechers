import assert from "node:assert/strict";
import { preservesC1TargetCeiling } from "../lesson-mapping.js";

const rememberOnly = [{
  cognitiveLevel: "remember" as const,
  isTargetCeiling: true,
}];

assert.equal(
  preservesC1TargetCeiling(1, rememberOnly),
  true,
  "an explicit C1 level-1 ceiling accepts one REMEMBER level",
);
assert.equal(
  preservesC1TargetCeiling(1, [
    { cognitiveLevel: "remember", isTargetCeiling: false },
    { cognitiveLevel: "understand", isTargetCeiling: true },
  ]),
  false,
  "C2 generation cannot raise an explicit C1 level-1 ceiling",
);
assert.equal(
  preservesC1TargetCeiling(null, [
    { cognitiveLevel: "remember", isTargetCeiling: false },
    { cognitiveLevel: "apply", isTargetCeiling: true },
  ]),
  true,
  "an absent C1 ceiling does not manufacture a constraint",
);

console.log("C2 C1-ceiling constraint: 3/3 passed");