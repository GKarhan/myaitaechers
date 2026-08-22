/**
 * C4 focused provider-free regression suite.
 *
 * Run: pnpm --filter @workspace/api-server test:c4-ceiling
 */
import assert from "node:assert/strict";
import {
  computeContiguousLearnerCognitiveCeiling,
  type LearnerCeilingEvidence,
  type LearnerCeilingPathLevel,
} from "../learner-cognitive-ceiling.js";

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

const NODE_ID = 900;
const REMEMBER = 101;
const UNDERSTAND = 102;
const APPLY = 103;
const ANALYZE = 104;

function level(
  id: number,
  cognitiveLevel: string,
  sequence: number,
  minimumIndependentEvidence = 1,
): LearnerCeilingPathLevel {
  return {
    id,
    cognitiveLevel,
    sequence,
    isApplicable: true,
    isTargetCeiling: id === ANALYZE,
    minimumIndependentEvidence,
    performanceObjective: `${cognitiveLevel} concept`,
    successCriterion: `${cognitiveLevel} concept`,
    preferredInteractionTypes: [],
  };
}

const PATH = [
  level(REMEMBER, "remember", 1),
  level(UNDERSTAND, "understand", 2),
  level(APPLY, "apply", 3),
  level(ANALYZE, "analyze", 4),
];

function evidence(
  overrides: Partial<LearnerCeilingEvidence> = {},
): LearnerCeilingEvidence {
  const id = overrides.id ?? 1;
  return {
    id,
    lessonNodeId: NODE_ID,
    cognitiveLevelId: REMEMBER,
    qualificationStatus: "qualified",
    wasCorrect: true,
    evidenceQuality: "MODERATE",
    assistanceLevel: "none",
    helpCount: 0,
    taskSource: "micro_check",
    taskReference: `micro_check:${id}`,
    lessonExerciseId: null,
    quizQuestionId: null,
    createdAt: new Date(1_700_000_000_000 + id),
    ...overrides,
  };
}

function ceilingFor(
  rows: LearnerCeilingEvidence[],
  path = PATH,
) {
  return computeContiguousLearnerCognitiveCeiling({
    lessonNodeId: NODE_ID,
    acceptedPath: path,
    evidence: rows,
  });
}

test("A — contiguous success reaches the highest satisfied level", () => {
  const result = ceilingFor([
    evidence({ id: 1, cognitiveLevelId: REMEMBER }),
    evidence({ id: 2, cognitiveLevelId: UNDERSTAND }),
    evidence({ id: 3, cognitiveLevelId: APPLY }),
  ]);
  assert.equal(result.ceiling?.id, APPLY);
});

test("B — higher evidence cannot skip an unresolved lower level", () => {
  const result = ceilingFor([
    evidence({ id: 1, cognitiveLevelId: REMEMBER }),
    evidence({ id: 2, cognitiveLevelId: APPLY }),
  ]);
  assert.equal(result.ceiling?.id, REMEMBER);
});

test("C — unqualified evidence cannot establish a ceiling", () => {
  const result = ceilingFor([
    evidence({ id: 1, qualificationStatus: "unqualified" }),
  ]);
  assert.equal(result.ceiling, null);
});

test("D — legacy/null qualification evidence is ignored", () => {
  const result = ceilingFor([
    evidence({ id: 1, qualificationStatus: null, cognitiveLevelId: null }),
  ]);
  assert.equal(result.ceiling, null);
});

test("E — disqualifying assistance cannot satisfy independence", () => {
  const result = ceilingFor([
    evidence({ id: 1, assistanceLevel: "guided", helpCount: 3 }),
  ]);
  assert.equal(result.ceiling, null);
});

test("F — required independent evidence count is enforced", () => {
  const oneLevelPath = [level(REMEMBER, "remember", 1, 3)];
  const result = ceilingFor([
    evidence({ id: 1 }),
    evidence({ id: 2 }),
  ], oneLevelPath);
  assert.equal(result.ceiling, null);
  assert.equal(result.qualifyingTaskCounts.get(REMEMBER), 2);
});

test("G — repeated task-reference retries count once", () => {
  const oneLevelPath = [level(REMEMBER, "remember", 1, 2)];
  const result = ceilingFor([
    evidence({ id: 1, taskReference: "micro_check:stable-task" }),
    evidence({ id: 2, taskReference: "micro_check:stable-task" }),
  ], oneLevelPath);
  assert.equal(result.ceiling, null);
  assert.equal(result.qualifyingTaskCounts.get(REMEMBER), 1);
});

test("H — chat and quiz source evidence count through one projector", () => {
  const oneLevelPath = [level(REMEMBER, "remember", 1, 2)];
  const result = ceilingFor([
    evidence({ id: 1, taskSource: "micro_check", taskReference: "micro_check:chat" }),
    evidence({
      id: 2,
      taskSource: "quiz_question",
      taskReference: "quiz_question:42",
      quizQuestionId: 42,
    }),
  ], oneLevelPath);
  assert.equal(result.ceiling?.id, REMEMBER);
});

test("I — higher-level failure does not alter a lower contiguous calculation", () => {
  const result = ceilingFor([
    evidence({ id: 1, cognitiveLevelId: REMEMBER }),
    evidence({ id: 2, cognitiveLevelId: UNDERSTAND }),
    evidence({ id: 3, cognitiveLevelId: APPLY }),
    evidence({ id: 4, cognitiveLevelId: ANALYZE, wasCorrect: false }),
  ]);
  assert.equal(result.ceiling?.id, APPLY);
});

test("J — later lower-level reconfirmation does not reduce the ceiling", () => {
  const result = ceilingFor([
    evidence({ id: 1, cognitiveLevelId: REMEMBER }),
    evidence({ id: 2, cognitiveLevelId: UNDERSTAND }),
    evidence({ id: 3, cognitiveLevelId: APPLY }),
    evidence({ id: 4, cognitiveLevelId: UNDERSTAND }),
  ]);
  assert.equal(result.ceiling?.id, APPLY);
});

test("K — wrong MicroNode or path level cannot contribute", () => {
  const result = ceilingFor([
    evidence({ id: 1, lessonNodeId: NODE_ID + 1 }),
    evidence({ id: 2, cognitiveLevelId: 9999 }),
  ]);
  assert.equal(result.ceiling, null);
});

test("L — MODERATE micro-checks follow normal configured count rules", () => {
  const oneLevelPath = [level(REMEMBER, "remember", 1, 2)];
  const insufficient = ceilingFor([
    evidence({ id: 1, evidenceQuality: "MODERATE" }),
  ], oneLevelPath);
  const sufficient = ceilingFor([
    evidence({ id: 1, evidenceQuality: "MODERATE" }),
    evidence({ id: 2, evidenceQuality: "MODERATE" }),
  ], oneLevelPath);
  assert.equal(insufficient.ceiling, null);
  assert.equal(sufficient.ceiling?.id, REMEMBER);
});

for (const { name, fn } of tests) {
  fn();
  console.log(`PASS ${name}`);
}
console.log(`C4 learner ceiling regression suite passed (${tests.length}/${tests.length})`);