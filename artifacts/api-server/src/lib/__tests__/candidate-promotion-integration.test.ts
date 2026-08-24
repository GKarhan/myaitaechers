import assert from "node:assert/strict";
import {
  applyKnowledgeCandidatePromotion,
  type DuplicateResolutionAudit,
  type Pass1Block,
  type Pass2TopicResult,
  validatePass2SourceAlignment,
} from "../../services/lesson-mapping.js";

function block(
  blockType: Pass1Block["blockType"],
  sourceText: string,
): Pass1Block {
  return {
    blockType,
    sourceText,
    sourcePage: 1,
    sourceParagraph: null,
    sourceBoundingBox: null,
  };
}

function duplicateAudit(
  unresolvedPairIds: DuplicateResolutionAudit["unresolvedPairIds"] = [],
): DuplicateResolutionAudit {
  return {
    candidatePairCount: unresolvedPairIds.length,
    resolvedDistinctCount: 0,
    mergedCount: 0,
    unresolvedPairIds,
    rejectedPairIds: [],
    rejectedDecisionCount: 0,
    actions: [],
  };
}

function copyTopics(topics: Pass2TopicResult[]): Pass2TopicResult[] {
  return topics.map((topic) => ({
    ...topic,
    inputBlockIndices: [...(topic.inputBlockIndices ?? [])],
    unmappedBlockIndices: [...topic.unmappedBlockIndices],
    additionalExercises: topic.additionalExercises.map((exercise) => ({ ...exercise })),
    microNodes: topic.microNodes.map((node) => ({
      ...node,
      sourceBlockIndices: [...node.sourceBlockIndices],
      supportingMaterialIndices: [...node.supportingMaterialIndices],
      exercises: node.exercises.map((exercise) => ({ ...exercise })),
    })),
  }));
}

function promote(
  blocks: Pass1Block[],
  topics: Pass2TopicResult[],
  duplicates: DuplicateResolutionAudit = duplicateAudit(),
) {
  return applyKnowledgeCandidatePromotion({
    topics,
    blocks,
    sourceAlignment: validatePass2SourceAlignment(topics, blocks),
    unresolvedAtomicityFindings: [],
    duplicateResolution: duplicates,
  });
}

const ruleBlocks = [
  block("RULE", "Կոտորակի նշանի կանոնը որոշում է կոտորակի ճիշտ նշանը։"),
  block("EXAMPLE", "Օրինակը ցույց է տալիս կոտորակի նշանի կանոնի կիրառումը։"),
  block("EXERCISE", "Որոշիր կոտորակի նշանը տրված օրինակներում։"),
];

function ruleTopic(): Pass2TopicResult {
  return {
    sequence: 1,
    title: "Կոտորակի նշանը",
    topicType: "mathematics",
    inputBlockIndices: [0, 1, 2],
    microNodes: [{
      candidateId: "t1:n0",
      title: "Կոտորակի նշանի կանոնը",
      learningObjective: "Սովորողը կարող է բացատրել կոտորակի նշանի կանոնը։",
      microNodeType: "knowledge",
      sourceBlockIndices: [0],
      supportingMaterialIndices: [1],
      exercises: [{ blockIndex: 2, sourceParagraph: null }],
    }],
    unmappedBlockIndices: [],
    additionalExercises: [],
  };
}

{
  const topics = [ruleTopic()];
  const result = promote(ruleBlocks, topics);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.promotedMicroNodeCount, 1);
  assert.equal(topics[0].microNodes.length, 1);
  assert.equal(topics[0].microNodes[0].promotionState, "PROMOTE");
  assert.equal(result.supportingMaterialBlockCount, 1);
  assert.equal(topics[0].microNodes[0].exercises[0].blockIndex, 2);
  console.log("  ✓ Cases 1–3/8/9: rule promotes; explanation supports; exercise remains an exercise");
}

{
  const blocks = [block("NOTE", "Նշում. Կոտորակի նշանի կանոնը որոշում է կոտորակի ճիշտ նշանը։")];
  const topics = [ruleTopic()];
  topics[0].inputBlockIndices = [0];
  topics[0].microNodes[0].sourceBlockIndices = [0];
  topics[0].microNodes[0].supportingMaterialIndices = [];
  topics[0].microNodes[0].exercises = [];
  const result = promote(blocks, topics);
  assert.equal(result.promotedMicroNodeCount, 1);
  console.log("  ✓ Case 10: a direct instructional NOTE is eligible for promotion");
}

{
  const blocks = [
    block("RULE", "Կոտորակի նշանի կանոնը որոշում է կոտորակի ճիշտ նշանը։"),
    block("RULE", "Կոտորակի նշանի կանոնը բացատրում է կոտորակի կիրառման հիմքը։"),
  ];
  const topics: Pass2TopicResult[] = [{
    ...ruleTopic(),
    inputBlockIndices: [0, 1],
    microNodes: [{
      ...ruleTopic().microNodes[0],
      sourceBlockIndices: [0, 1],
      supportingMaterialIndices: [],
      exercises: [],
    }],
  }];
  const result = promote(blocks, topics);
  assert.equal(result.promotedMicroNodeCount, 1);
  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [0, 1]);
  console.log("  ✓ Cases 4/11: one knowledge unit keeps combined provenance across wording/depth variations");
}

{
  const blocks = [
    block("RULE", "Կոտորակի նշանի կանոնը որոշում է կոտորակի ճիշտ նշանը։"),
    block("RULE", "Կոտորակի արժեքը ցույց է տալիս ամբողջի կոտորակային մասը։"),
  ];
  const topics: Pass2TopicResult[] = [{
    ...ruleTopic(),
    inputBlockIndices: [0, 1],
    microNodes: [
      {
        ...ruleTopic().microNodes[0],
        sourceBlockIndices: [0],
        supportingMaterialIndices: [],
        exercises: [],
      },
      {
        candidateId: "t1:n1",
        title: "Կոտորակի արժեքը",
        learningObjective: "Սովորողը կարող է բացատրել կոտորակի արժեքը։",
        microNodeType: "knowledge",
        sourceBlockIndices: [1],
        supportingMaterialIndices: [],
        exercises: [],
      },
    ],
  }];
  const result = promote(blocks, topics);
  assert.equal(result.promotedMicroNodeCount, 2);
  assert.equal(topics[0].microNodes.length, 2);
  console.log("  ✓ Case 5: overlapping vocabulary does not collapse distinct assessable concepts");
}

{
  const blocks = [
    block("RULE", "Կոտորակի նշանի կանոնը որոշում է կոտորակի ճիշտ նշանը։"),
    block("RULE", "Կոտորակի նշանի կանոնը որոշում է կոտորակի ճիշտ նշանը։"),
  ];
  const topics = [ruleTopic(), {
    ...ruleTopic(),
    sequence: 2,
    title: "Կիրառություն",
    inputBlockIndices: [1],
    microNodes: [{
      ...ruleTopic().microNodes[0],
      candidateId: "t2:n0",
      sourceBlockIndices: [1],
      supportingMaterialIndices: [],
      exercises: [],
    }],
  }];
  topics[0].inputBlockIndices = [0];
  topics[0].microNodes[0].sourceBlockIndices = [0];
  topics[0].microNodes[0].supportingMaterialIndices = [];
  topics[0].microNodes[0].exercises = [];
  const result = promote(blocks, topics, duplicateAudit([{ candidateAId: "t1:n0", candidateBId: "t2:n0" }]));
  assert.equal(result.reviewRequiredCandidateCount, 2);
  assert.equal(topics[0].microNodes.length, 0);
  assert.equal(topics[1].microNodes.length, 0);
  assert.deepEqual(topics[0].unmappedBlockIndices, [0]);
  assert.deepEqual(topics[1].unmappedBlockIndices, [1]);
  console.log("  ✓ Cases 6/12: cross-topic duplicate uncertainty becomes durable source-only review");
}

{
  const blocks = [
    block("IMAGE", "?ա?ա?ա?ա?ա?ա"),
    block("EXERCISE", "Որոշիր կոտորակի նշանը տրված օրինակներում։"),
  ];
  const topics: Pass2TopicResult[] = [{
    sequence: 1,
    title: "Վերնագիր",
    topicType: "mathematics",
    inputBlockIndices: [0, 1],
    microNodes: [{
      candidateId: "t1:n0",
      title: "Անընթեռնելի գծապատկեր",
      learningObjective: "Սովորողը կարող է բացատրել կոտորակի նշանի կանոնը։",
      microNodeType: "knowledge",
      sourceBlockIndices: [0],
      supportingMaterialIndices: [],
      exercises: [{ blockIndex: 1, sourceParagraph: null }],
    }],
    unmappedBlockIndices: [],
    additionalExercises: [],
  }];
  const result = promote(blocks, topics);
  assert.equal(result.unresolvedCandidateCount, 1);
  assert.equal(topics[0].microNodes.length, 0);
  assert.deepEqual(topics[0].unmappedBlockIndices, [0]);
  assert.equal(topics[0].additionalExercises[0].blockIndex, 1);
  console.log("  ✓ Cases 7/13/14: unsafe visual source cannot promote; source and activity stay retained");
}

{
  const original = [ruleTopic()];
  const shadowTopics = copyTopics(original);
  const oldMicroNodeCount = shadowTopics.reduce((count, topic) => count + topic.microNodes.length, 0);
  const shadow = promote(ruleBlocks, shadowTopics);
  console.log(
    `  ✓ Shadow comparison: old nodes=${oldMicroNodeCount}; `
    + `new candidates=${shadow.candidateCount}, promoted=${shadow.promotedMicroNodeCount}, `
    + `supporting=${shadow.supportingMaterialBlockCount}, exercises=${shadow.exerciseReferenceCount}, `
    + `unresolved=${shadow.unresolvedCandidateCount}, consolidated=${shadow.consolidatedCandidateCount}`,
  );
}

console.log("\nCandidate promotion integration: 5/5 passed");