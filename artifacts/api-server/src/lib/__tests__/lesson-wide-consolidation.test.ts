import assert from "node:assert/strict";
import {
  consolidateLessonWideKnowledge,
  type DuplicateResolutionAudit,
  type Pass2MicroNode,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";

function node(
  candidateId: string,
  sourceBlockIndices: number[],
  options: Partial<Pass2MicroNode> = {},
): Pass2MicroNode {
  return {
    candidateId,
    title: options.title ?? candidateId,
    learningObjective: options.learningObjective ?? "Սովորողը կարող է բացատրել տվյալ կանոնը։",
    microNodeType: options.microNodeType ?? "knowledge",
    sourceBlockIndices,
    supportingMaterialIndices: options.supportingMaterialIndices ?? [],
    exercises: options.exercises ?? [],
  };
}

function topic(sequence: number, title: string, microNodes: Pass2MicroNode[]): Pass2TopicResult {
  return {
    sequence,
    title,
    topicType: "mathematics",
    inputBlockIndices: microNodes.flatMap((candidate) => candidate.sourceBlockIndices),
    microNodes,
    unmappedBlockIndices: [],
    additionalExercises: [],
  };
}

function audit(overrides: Partial<DuplicateResolutionAudit> = {}): DuplicateResolutionAudit {
  return {
    candidatePairCount: 0,
    resolvedDistinctCount: 0,
    mergedCount: 0,
    crossTopicMergePairs: [],
    distinctPairIds: [],
    unresolvedPairIds: [],
    rejectedPairIds: [],
    rejectedDecisionCount: 0,
    actions: [],
    ...overrides,
  };
}

function cloneTopics(topics: Pass2TopicResult[]): Pass2TopicResult[] {
  return structuredClone(topics);
}

function canonicalSourceIndices(topics: Pass2TopicResult[]): number[] {
  return topics.flatMap((entry) => entry.microNodes.flatMap((candidate) => [
    ...candidate.sourceBlockIndices,
    ...candidate.supportingMaterialIndices,
  ])).sort((left, right) => left - right);
}

{
  const topics = [
    topic(1, "Ներածություն", [
      node("t1:n0", [0], {
        title: "Արտադրյալի նշանը",
        supportingMaterialIndices: [1],
        exercises: [{ blockIndex: 8, sourceParagraph: null }],
      }),
      node("t1:n1", [2], { title: "Դրական թիվ" }),
    ]),
    topic(2, "Կիրառություն", [
      node("t2:n0", [3], {
        title: "Արտադրյալի դրական կամ բացասական լինելը",
        supportingMaterialIndices: [4],
        exercises: [{ blockIndex: 9, sourceParagraph: null }, { blockIndex: 8, sourceParagraph: null }],
      }),
      node("t2:n1", [5], { title: "Բացասական թիվ" }),
      node("t2:n2", [6], { title: "Գործոնների քանակ" }),
    ]),
  ];
  const beforeSource = canonicalSourceIndices(topics);
  const result = consolidateLessonWideKnowledge({
    topics,
    promotionEligibleCandidateIds: new Set(["t1:n0", "t1:n1", "t2:n0", "t2:n1", "t2:n2"]),
    duplicateResolution: audit({
      candidatePairCount: 2,
      crossTopicMergePairs: [{ candidateAId: "t1:n0", candidateBId: "t2:n0" }],
      distinctPairIds: [{ candidateAId: "t1:n1", candidateBId: "t2:n1" }],
      resolvedDistinctCount: 1,
    }),
  });
  assert.equal(topics.length, 2);
  assert.equal(topics[0].microNodes.length, 2);
  assert.equal(topics[1].microNodes.length, 2);
  const canonical = topics[0].microNodes.find((candidate) => candidate.candidateId === "t1:n0");
  assert.ok(canonical);
  assert.deepEqual(canonical.sourceBlockIndices, [0, 3]);
  assert.deepEqual(canonical.supportingMaterialIndices, [1, 4]);
  assert.deepEqual(canonical.exercises.map((exercise) => exercise.blockIndex), [8, 9]);
  assert.equal(result.sameKnowledgeConsolidationCount, 1);
  assert.equal(result.crossTopicConsolidationCount, 1);
  assert.equal(result.groups[0].finalTopicAssignmentReason, "FIRST_SUBSTANTIVE_INTRODUCTION");
  assert.deepEqual(canonicalSourceIndices(topics), beforeSource);
  console.log("  ✓ Cases 2/3/4/5/6/7/8/11/12/14: canonical cross-topic identity preserves distinct concepts, sources, support, and exercises");
}

{
  const topics = [
    topic(1, "Առաջին", [node("t1:n0", [0])]),
    topic(2, "Երկրորդ", [node("t2:n0", [1])]),
  ];
  const result = consolidateLessonWideKnowledge({
    topics,
    promotionEligibleCandidateIds: new Set(["t1:n0", "t2:n0"]),
    duplicateResolution: audit({
      crossTopicMergePairs: [{ candidateAId: "t1:n0", candidateBId: "t2:n0" }],
    }),
  });
  assert.equal(topics.length, 1);
  assert.equal(topics[0].sequence, 1);
  assert.equal(topics[0].microNodes.length, 1);
  assert.equal(result.emptiedProvisionalTopicCount, 1);
  console.log("  ✓ Cases 1/13/15: canonical node selects a deterministic primary Topic and removes an accidental empty Topic");
}

{
  const topics = [
    topic(1, "Ա", [node("t1:n0", [0])]),
    topic(2, "Բ", [node("t2:n0", [1])]),
    topic(3, "Գ", [node("t3:n0", [2])]),
  ];
  const result = consolidateLessonWideKnowledge({
    topics,
    promotionEligibleCandidateIds: new Set(["t1:n0", "t2:n0", "t3:n0"]),
    duplicateResolution: audit({
      crossTopicMergePairs: [
        { candidateAId: "t1:n0", candidateBId: "t2:n0" },
        { candidateAId: "t2:n0", candidateBId: "t3:n0" },
      ],
      distinctPairIds: [{ candidateAId: "t1:n0", candidateBId: "t3:n0" }],
      resolvedDistinctCount: 1,
    }),
  });
  assert.equal(topics.flatMap((entry) => entry.microNodes).length, 3);
  assert.equal(result.sameKnowledgeConsolidationCount, 0);
  assert.deepEqual(result.forcedReviewCandidateIds, ["t1:n0", "t2:n0", "t3:n0"]);
  assert.equal(result.groups[0].state, "REVIEW_REQUIRED");
  console.log("  ✓ Cases 9/10/16/22: contradictory transitive decisions become review-required, never an unsafe merge");
}

{
  const fixture = [
    topic(1, "Կանոն", [
      node("t1:n0", [0], { supportingMaterialIndices: [1], exercises: [{ blockIndex: 10, sourceParagraph: null }] }),
      node("t1:n1", [2]),
    ]),
    topic(2, "Բացատրություն", [
      node("t2:n0", [3], { exercises: [{ blockIndex: 11, sourceParagraph: null }] }),
      node("t2:n1", [4]),
      node("t2:n2", [5]),
    ]),
  ];
  const inputAudit = audit({
    candidatePairCount: 3,
    crossTopicMergePairs: [{ candidateAId: "t1:n0", candidateBId: "t2:n0" }],
    unresolvedPairIds: [{ candidateAId: "t1:n1", candidateBId: "t2:n1" }],
  });
  const eligible = new Set(["t1:n0", "t1:n1", "t2:n0", "t2:n1", "t2:n2"]);
  const oldExerciseCount = fixture.flatMap((entry) => entry.microNodes)
    .flatMap((candidate) => candidate.exercises).length;
  const oldSourceCount = canonicalSourceIndices(fixture).length;
  const left = cloneTopics(fixture);
  const right = cloneTopics(fixture);
  const first = consolidateLessonWideKnowledge({
    topics: left,
    promotionEligibleCandidateIds: eligible,
    duplicateResolution: structuredClone(inputAudit),
  });
  const second = consolidateLessonWideKnowledge({
    topics: right,
    promotionEligibleCandidateIds: eligible,
    duplicateResolution: structuredClone(inputAudit),
  });
  assert.deepEqual(left, right);
  assert.deepEqual(first, second);
  const finalExercises = left.flatMap((entry) => entry.microNodes)
    .flatMap((candidate) => candidate.exercises);
  assert.equal(new Set(finalExercises.map((exercise) => exercise.blockIndex)).size, oldExerciseCount);
  assert.equal(canonicalSourceIndices(left).length, oldSourceCount);
  console.log(
    `  ✓ Shadow: topics 2→${left.length}; candidates 5→${first.canonicalKnowledgeUnitCount}; `
    + `consolidations=${first.sameKnowledgeConsolidationCount}; cross-topic=${first.crossTopicConsolidationCount}; `
    + `reviews=${first.reviewRequiredSemanticGroupCount}; source loss=0; exercise loss=0`,
  );
}

console.log("\nLesson-wide semantic consolidation: 4/4 passed");