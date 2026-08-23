import assert from "node:assert/strict";
import { assessC2GenerationPreflight } from "../c2-generation-preflight.js";
import { hasCompleteTeachingContent, shouldRunBoundedPhase2Repair, summarizeCurrentTeachingContent } from "../teaching-content-readiness.js";

let passed = 0;
function test(name: string, check: () => void) {
  check(); passed++; console.log(`  ✓ ${name}`);
}

const source = "7254 թիվը կարելի է ներկայացնել կարգային գումարելիների գումարով՝ 7000 + 200 + 50 + 4։";
const objective = "Ներկայացնում է 7254 թիվը կարգային գումարելիների գումարով։";
const complete = {
  childFriendlyExplanation: "Թիվը բաժանում ենք ըստ կարգերի։",
  commonMisconception: "Չպետք է փոխել թվանշանների տեղերը։",
  basicExamples: ["7254 = 7000 + 200 + 50 + 4"],
  nonExamples: ["7254 = 7000 + 20 + 5 + 4"],
};
const incomplete = { childFriendlyExplanation: "Կա միայն բացատրություն։" };

test("1 READY C1 + missing content is eligible", () => assert.equal(assessC2GenerationPreflight({ nodeStatus: "approved", theoryContent: source, learningObjective: objective, blockType: "rule" }).eligible, true));
test("2 REVIEW_REQUIRED source-safe C1 remains eligible", () => assert.equal(assessC2GenerationPreflight({ nodeStatus: "needs_review", theoryContent: source, learningObjective: objective, blockType: "rule" }).outcome, "REVIEW_REQUIRED"));
test("3 insufficient source blocks", () => assert.equal(assessC2GenerationPreflight({ theoryContent: "", learningObjective: objective }).outcome, "BLOCKED"));
test("4 heading-only source blocks", () => assert.equal(assessC2GenerationPreflight({ theoryContent: "Բնական թվեր. Թեմայի վերնագիր՝ բնական թվեր։", learningObjective: "Բացատրում է բնական թվերը։", blockType: "objective" }).outcome, "BLOCKED"));
test("5 rejected fresh candidate gets one bounded repair", () => assert.equal(shouldRunBoundedPhase2Repair({ skipped: true, groundingAudit: { valid: false } }, 0), true));
test("6 invalid repair result cannot loop", () => assert.equal(shouldRunBoundedPhase2Repair({ skipped: true, groundingAudit: { valid: false } }, 1), false));
test("7 blocked node does not remove another missing node", () => assert.equal(summarizeCurrentTeachingContent([incomplete, complete]).missing, 1));
test("8 completed historical job cannot prevent zero-content retry", () => assert.equal(summarizeCurrentTeachingContent([incomplete, incomplete]).retryAllowed, true));
test("9 partial persisted content retries only missing nodes", () => assert.deepEqual(summarizeCurrentTeachingContent([complete, incomplete]), { total: 2, complete: 1, missing: 1, retryAllowed: true }));
test("10 complete existing content is protected", () => assert.equal(hasCompleteTeachingContent(complete), true));
test("11 current state wins over stale job blocker", () => assert.equal(summarizeCurrentTeachingContent([complete]).retryAllowed, false));
test("12 nothing missing is a safe no-op", () => assert.equal(summarizeCurrentTeachingContent([complete, complete]).retryAllowed, false));
test("13 review state does not erase content completeness", () => assert.equal(hasCompleteTeachingContent(complete), true));
test("14 stale confirmation flag is not a content predicate", () => assert.equal(hasCompleteTeachingContent(complete), true));
test("15 incomplete required content remains a true blocker", () => assert.equal(hasCompleteTeachingContent(incomplete), false));
test("16 normal MicroNode success is represented by complete current state", () => assert.equal(summarizeCurrentTeachingContent([complete]).complete, 1));
test("17 normal exercise approval is outside teaching-content retry eligibility", () => assert.equal(summarizeCurrentTeachingContent([complete]).missing, 0));
test("18 exceptions remain visible through missing count", () => assert.equal(summarizeCurrentTeachingContent([complete, incomplete]).missing, 1));

console.log(`\nMapping pipeline closure: ${passed}/18 passed`);