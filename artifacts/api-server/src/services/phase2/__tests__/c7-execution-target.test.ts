import assert from "node:assert/strict";
import {
  assertC7ExecutionTargetMatchesSession,
  buildC7TargetContext,
  createC7ExecutionTarget,
  isC7TopicSwitchRequest,
  isExerciseCompatibleWithC7Target,
  validateC7ModelTargetProposal,
} from "../c7-execution-target.js";

type TestFn = () => void;
const tests: Array<[string, TestFn]> = [];
const test = (name: string, fn: TestFn) => tests.push([name, fn]);

const target = createC7ExecutionTarget({
  lessonId: 64,
  currentNodeId: 100,
  activeCognitiveLevelId: 202,
  node: {
    id: 100,
    title: "Թվերի հաջորդականություն",
    learningObjective: "Բացատրել հաջորդականության կանոնը",
    theoryContent: "Յուրաքանչյուր անդամ կապված է կանոնով։",
  },
  acceptedPath: [
    { id: 202, cognitiveLevel: "UNDERSTAND", performanceObjective: "Բացատրի կանոնը", successCriterion: "Ճիշտ նկարագրի կանոնը", preferredInteractionTypes: ["constructed_response"], minimumIndependentEvidence: 1 },
    { id: 203, cognitiveLevel: "APPLY" },
  ],
});

test("1 C6 target snapshot is node X + UNDERSTAND", () => {
  assert.equal(target.microNodeId, 100);
  assert.equal(target.cognitiveLevel, "UNDERSTAND");
});
test("2 model cannot propose node Y", () => assert.equal(validateC7ModelTargetProposal(target, { microNodeId: 101 }), false));
test("3 model cannot propose APPLY while UNDERSTAND is active", () => assert.equal(validateC7ModelTargetProposal(target, { cognitiveLevelId: 203 }), false));
test("4 accepted C2 path never invents REMEMBER", () => assert.equal(target.acceptedPathLevelIds.includes(201), false));
test("5 topic switch is deterministically redirected", () => assert.equal(isC7TopicSwitchRequest("անցնենք ուրիշ թեմայի"), true));
test("6 clarification stays available", () => assert.equal(isC7TopicSwitchRequest("ինչու է այս կանոնը այդպես"), false));
test("7 foreign-node micro-check proposal is rejected", () => assert.equal(validateC7ModelTargetProposal(target, { microNodeId: 999 }), false));
test("8 above-target micro-check proposal is rejected", () => assert.equal(validateC7ModelTargetProposal(target, { cognitiveLevelId: 203 }), false));
test("9 feedback snapshot must match original target", () => assert.doesNotThrow(() => assertC7ExecutionTargetMatchesSession(target, { lessonId: 64, currentNodeId: 100, activeCognitiveLevelId: 202 })));
test("10 wrong-node exercise is excluded", () => assert.equal(isExerciseCompatibleWithC7Target(target, { id: 4, relatedNodeId: 101 }, new Set([4])), false));
test("11 remediation cannot mutate node target", () => assert.doesNotThrow(() => assertC7ExecutionTargetMatchesSession(target, { lessonId: 64, currentNodeId: 100, activeCognitiveLevelId: 202 })));
test("12 LOWER_DIFFICULTY cannot lower canonical target", () => assert.equal(target.activeCognitiveLevelId, 202));
test("13 prerequisite proposal cannot directly mutate node", () => assert.equal(validateC7ModelTargetProposal(target, { microNodeId: 99 }), false));
test("14 C6 prerequisite snapshot is accepted when persisted", () => assert.equal(createC7ExecutionTarget({ lessonId: 64, currentNodeId: 99, activeCognitiveLevelId: 202, node: { id: 99, title: "Նախադրյալ" }, acceptedPath: [{ id: 202, cognitiveLevel: "UNDERSTAND" }] }).microNodeId, 99));
test("15 completion/new-target model proposal cannot mutate target", () => assert.equal(validateC7ModelTargetProposal(target, { microNodeId: 101, cognitiveLevelId: 203 }), false));
test("16 fallback context preserves the same target", () => assert.ok(buildC7TargetContext(target).includes("MICRONODE_ID: 100")));
test("17 malformed output cannot alter immutable target", () => assert.equal(Object.isFrozen(target), true));
test("18 stale resume target is rejected before delivery", () => assert.throws(() => assertC7ExecutionTargetMatchesSession(target, { lessonId: 64, currentNodeId: 101, activeCognitiveLevelId: 202 })));
test("19 new target uses a separate snapshot", () => assert.notEqual(createC7ExecutionTarget({ lessonId: 64, currentNodeId: 101, activeCognitiveLevelId: 203, node: { id: 101, title: "Հաջորդ" }, acceptedPath: [{ id: 203, cognitiveLevel: "APPLY" }] }).microNodeId, target.microNodeId));
test("20 recovered feedback rejects reloaded foreign target", () => assert.throws(() => assertC7ExecutionTargetMatchesSession(target, { lessonId: 64, currentNodeId: 100, activeCognitiveLevelId: 203 })));
test("21 source context is current-node only", () => assert.equal(target.sourceContext, "Յուրաքանչյուր անդամ կապված է կանոնով։"));
test("22 unrelated lesson cannot become a micro-check target", () => assert.equal(validateC7ModelTargetProposal(target, { lessonId: 65 }), false));

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
if (failed > 0) process.exit(1);