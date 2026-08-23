/**
 * Provider-free C6 canonical personalization matrix.
 * Run: pnpm --filter @workspace/api-server test:c6-personalization
 */
import assert from "node:assert/strict";
import {
  resolveC6DecisionFromSnapshot,
  resolveNextCognitiveLevel,
  type C6NodeSnapshot,
} from "../c6-personalization.js";

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

const UNDERSTAND = 702;
const APPLY = 703;
const ANALYZE = 704;
const REMEMBER = 701;

function node(
  id: number,
  sequence: number,
  knowledgeState: C6NodeSnapshot["knowledgeState"],
  demonstratedCognitiveLevelId: number | null = null,
  overrides: Partial<C6NodeSnapshot> = {},
): C6NodeSnapshot {
  return {
    id,
    sequence,
    knowledgeState,
    curriculumTargetCognitiveLevelId: ANALYZE,
    demonstratedCognitiveLevelId,
    pathAccepted: true,
    cognitivePath: [
      {
        id: UNDERSTAND, cognitiveLevel: "UNDERSTAND", sequence: 10,
        isApplicable: true, isTargetCeiling: false, minimumIndependentEvidence: 1,
        performanceObjective: null, successCriterion: null, preferredInteractionTypes: [],
      },
      {
        id: APPLY, cognitiveLevel: "APPLY", sequence: 20,
        isApplicable: true, isTargetCeiling: false, minimumIndependentEvidence: 1,
        performanceObjective: null, successCriterion: null, preferredInteractionTypes: [],
      },
      {
        id: ANALYZE, cognitiveLevel: "ANALYZE", sequence: 30,
        isApplicable: true, isTargetCeiling: true, minimumIndependentEvidence: 1,
        performanceObjective: null, successCriterion: null, preferredInteractionTypes: [],
      },
    ],
    ...overrides,
  };
}

function decide(
  nodes: C6NodeSnapshot[],
  input: Omit<Parameters<typeof resolveC6DecisionFromSnapshot>[0], "nodes"> = {},
) {
  return resolveC6DecisionFromSnapshot({
    learnerId: 50,
    lessonId: 60,
    nodes,
    ...input,
  });
}

test("1 NOT_STUDIED starts at the first accepted path level", () => {
  const result = decide([node(1, 1, "NOT_STUDIED")], { requestedMicroNodeId: 1 });
  assert.equal(result.decisionType, "START");
  assert.equal(result.nextTargetCognitiveLevelId, UNDERSTAND);
});

test("2 NOT_KNOWN remediates at the first undemonstrated level", () => {
  const result = decide([node(1, 1, "NOT_KNOWN")], { requestedMicroNodeId: 1 });
  assert.equal(result.decisionType, "REMEDIATE");
  assert.equal(result.nextTargetCognitiveLevelId, UNDERSTAND);
});

test("3 PARTIAL after UNDERSTAND continues at APPLY", () => {
  const result = decide([node(1, 1, "PARTIAL", UNDERSTAND)], { requestedMicroNodeId: 1 });
  assert.equal(result.decisionType, "CONTINUE");
  assert.equal(result.nextTargetCognitiveLevelId, APPLY);
});

test("4 PARTIAL after APPLY continues at ANALYZE", () => {
  const result = decide([node(1, 1, "PARTIAL", APPLY)], { requestedMicroNodeId: 1 });
  assert.equal(result.nextTargetCognitiveLevelId, ANALYZE);
});

test("5 MASTERED explicit review keeps the requested node", () => {
  const result = decide(
    [node(1, 1, "MASTERED", ANALYZE)],
    { requestedMicroNodeId: 1, entryIntent: "EXPLICIT_REVIEW" },
  );
  assert.equal(result.decisionType, "REVIEW");
  assert.equal(result.microNodeId, 1);
  assert.equal(result.nextTargetCognitiveLevelId, ANALYZE);
});

test("6 MASTERED normal learning advances to the first non-mastered node", () => {
  const result = decide(
    [node(1, 1, "MASTERED", ANALYZE), node(2, 2, "NOT_STUDIED")],
    { requestedMicroNodeId: 1 },
  );
  assert.equal(result.decisionType, "ADVANCE");
  assert.equal(result.microNodeId, 2);
});

test("7 accepted path does not invent REMEMBER", () => {
  const noRemember = node(1, 1, "NOT_STUDIED", null, {
    curriculumTargetCognitiveLevelId: APPLY,
    cognitivePath: [
      {
        id: UNDERSTAND, cognitiveLevel: "UNDERSTAND", sequence: 10,
        isApplicable: true, isTargetCeiling: false, minimumIndependentEvidence: 1,
        performanceObjective: null, successCriterion: null, preferredInteractionTypes: [],
      },
      {
        id: APPLY, cognitiveLevel: "APPLY", sequence: 20,
        isApplicable: true, isTargetCeiling: true, minimumIndependentEvidence: 1,
        performanceObjective: null, successCriterion: null, preferredInteractionTypes: [],
      },
    ],
  });
  assert.notEqual(resolveNextCognitiveLevel(noRemember).levelId, REMEMBER);
  assert.equal(resolveNextCognitiveLevel(noRemember).levelId, UNDERSTAND);
});

test("8 unsatisfied REQUIRED prerequisite redirects deterministically", () => {
  const result = decide(
    [node(1, 1, "NOT_STUDIED"), node(2, 2, "NOT_STUDIED")],
    {
      requestedMicroNodeId: 2,
      dependencies: [{ fromNodeId: 1, toNodeId: 2, dependencyType: "REQUIRED" }],
    },
  );
  assert.equal(result.microNodeId, 1);
  assert.equal(result.prerequisiteStatus, "REDIRECTED");
  assert.equal(result.reasonCode, "REQUIRED_PREREQUISITE_UNSATISFIED");
});

test("9 no REQUIRED dependency creates no prerequisite redirect", () => {
  const result = decide(
    [node(1, 1, "NOT_STUDIED"), node(2, 2, "NOT_STUDIED")],
    {
      requestedMicroNodeId: 2,
      dependencies: [{ fromNodeId: 1, toNodeId: 2, dependencyType: "SEQUENTIAL" }],
    },
  );
  assert.equal(result.microNodeId, 2);
  assert.equal(result.prerequisiteStatus, "NOT_APPLICABLE");
});

test("10 forward advance skips a mastered first candidate", () => {
  const result = decide(
    [
      node(1, 1, "MASTERED", ANALYZE),
      node(2, 2, "MASTERED", ANALYZE),
      node(3, 3, "PARTIAL", UNDERSTAND),
    ],
    { afterMicroNodeId: 1 },
  );
  assert.equal(result.decisionType, "ADVANCE");
  assert.equal(result.microNodeId, 3);
  assert.equal(result.nextTargetCognitiveLevelId, APPLY);
});

test("11 a demonstrated level is never unnecessarily restarted", () => {
  const result = decide([node(1, 1, "PARTIAL", APPLY)], { requestedMicroNodeId: 1 });
  assert.notEqual(result.nextTargetCognitiveLevelId, APPLY);
});

test("12 equivalent entry inputs resolve the same canonical target", () => {
  const nodes = [node(1, 1, "PARTIAL", UNDERSTAND)];
  const fromTree = decide(nodes, { requestedMicroNodeId: 1 });
  const fromLesson = decide(nodes, { requestedMicroNodeId: 1 });
  assert.deepEqual(
    [fromTree.microNodeId, fromTree.nextTargetCognitiveLevelId],
    [fromLesson.microNodeId, fromLesson.nextTargetCognitiveLevelId],
  );
});

test("13 updated C4 ceiling fixture changes the next C6 target", () => {
  const before = decide([node(1, 1, "PARTIAL", UNDERSTAND)], { requestedMicroNodeId: 1 });
  const after = decide([node(1, 1, "PARTIAL", APPLY)], { requestedMicroNodeId: 1 });
  assert.equal(before.nextTargetCognitiveLevelId, APPLY);
  assert.equal(after.nextTargetCognitiveLevelId, ANALYZE);
});

test("14 invalid C2 path fails closed without a fallback target", () => {
  const result = decide(
    [node(1, 1, "NOT_STUDIED", null, { pathAccepted: false })],
    { requestedMicroNodeId: 1 },
  );
  assert.equal(result.microNodeId, null);
  assert.equal(result.nextTargetCognitiveLevelId, null);
  assert.equal(result.reasonCode, "C2_PATH_UNAVAILABLE");
});

test("15 dependency cycle terminates safely", () => {
  const result = decide(
    [node(1, 1, "NOT_STUDIED"), node(2, 2, "NOT_STUDIED")],
    {
      requestedMicroNodeId: 1,
      dependencies: [
        { fromNodeId: 2, toNodeId: 1, dependencyType: "REQUIRED" },
        { fromNodeId: 1, toNodeId: 2, dependencyType: "REQUIRED" },
      ],
    },
  );
  assert.equal(result.microNodeId, null);
  assert.equal(result.reasonCode, "DEPENDENCY_CYCLE");
});

test("16 explicit review of an invalid C2 path remains fail-closed", () => {
  const result = decide(
    [node(1, 1, "MASTERED", ANALYZE, { pathAccepted: false })],
    { requestedMicroNodeId: 1, entryIntent: "EXPLICIT_REVIEW" },
  );
  assert.equal(result.nextTargetCognitiveLevelId, null);
  assert.equal(result.reasonCode, "C2_PATH_UNAVAILABLE");
});

test("17 dependency cycles are rejected even when a prerequisite is mastered", () => {
  const result = decide(
    [node(1, 1, "NOT_STUDIED"), node(2, 2, "MASTERED", ANALYZE)],
    {
      requestedMicroNodeId: 1,
      dependencies: [
        { fromNodeId: 2, toNodeId: 1, dependencyType: "REQUIRED" },
        { fromNodeId: 1, toNodeId: 2, dependencyType: "REQUIRED" },
      ],
    },
  );
  assert.equal(result.microNodeId, null);
  assert.equal(result.reasonCode, "DEPENDENCY_CYCLE");
});

test("18 automatic advance into an invalid next path is unavailable, not complete", () => {
  const result = decide(
    [
      node(1, 1, "MASTERED", ANALYZE),
      node(2, 2, "NOT_STUDIED", null, { pathAccepted: false }),
    ],
    { afterMicroNodeId: 1 },
  );
  assert.equal(result.microNodeId, null);
  assert.equal(result.decisionType, null);
  assert.equal(result.reasonCode, "C2_PATH_UNAVAILABLE");
});

for (const { name, fn } of tests) {
  fn();
  console.log(`PASS ${name}`);
}
console.log(`C6 canonical personalization regression suite passed (${tests.length}/${tests.length})`);