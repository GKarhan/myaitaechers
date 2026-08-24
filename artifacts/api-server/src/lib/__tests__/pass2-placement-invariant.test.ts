import assert from "node:assert/strict";
import {
  ensurePass2TopicGroupCoverage,
  rescueMissingPass2PlacementReferences,
  type Pass2TopicGroup,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";
import { validateSourceCoverage } from "../coverage-validator.js";

function topic(overrides: Partial<Pass2TopicResult> = {}): Pass2TopicResult {
  return {
    sequence: 1,
    title: "Ֆունկցիայի գրաֆիկ",
    topicType: "math",
    inputBlockIndices: Array.from({ length: 20 }, (_, index) => index),
    microNodes: [{
      candidateId: "t1:n0",
      title: "Գրաֆիկից միջակայքների որոշում",
      learningObjective: "Որոշում է նշանների միջակայքները գրաֆիկից։",
      microNodeType: "skill",
      sourceBlockIndices: [0, 1, 2, 3],
      supportingMaterialIndices: [4, 18, 19],
      exercises: Array.from({ length: 8 }, (_, offset) => ({
        blockIndex: offset + 10,
        sourceParagraph: null,
      })),
    }],
    unmappedBlockIndices: [5, 6, 7, 8],
    additionalExercises: [],
    ...overrides,
  };
}

// 1. Step 1’s model output may omit a verified block, but its deterministic
// nearest-topic recovery returns exact once-only group membership.
{
  const groups: Pass2TopicGroup[] = [
    { title: "Մեկ", topicType: "math", indices: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
    { title: "Երկու", topicType: "math", indices: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19] },
  ];
  const result = ensurePass2TopicGroupCoverage(groups, 20);
  assert.deepEqual(result.recoveredIndices, [9]);
  assert.deepEqual([...groups.flatMap((group) => group.indices)].sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index));
  assert.equal(new Set(groups.flatMap((group) => group.indices)).size, 20);
}

// 2–4. §1.5 fixture: Step 2 references 19/20 blocks and omits EXAMPLE index 9.
// The block is retained as review-safe unmapped material, not forced into a
// MicroNode, and final source coverage remains exact with no duplicates.
{
  const topics = [topic()];
  const result = rescueMissingPass2PlacementReferences(topics, 20);
  assert.deepEqual(result.missingBeforeRecovery, [9]);
  assert.deepEqual(result.rescuedToUnmapped, [9]);
  assert.deepEqual(result.unrecoverableIndices, []);
  assert.ok(topics[0].unmappedBlockIndices.includes(9));
  const coverage = validateSourceCoverage(20, topics);
  assert.equal(coverage.valid, true);
  assert.deepEqual(coverage.missingIndices, []);
  assert.deepEqual(coverage.duplicateIndices, []);
}

// 5. Existing activity placement is a concrete reference and must not be
// reclassified or duplicated by this source-preservation invariant.
{
  const topics = [topic({
    inputBlockIndices: [0, 1],
    microNodes: [{
      candidateId: "t1:n0",
      title: "Կանոն",
      learningObjective: "Կիրառում է կանոնը։",
      microNodeType: "knowledge",
      sourceBlockIndices: [0],
      supportingMaterialIndices: [],
      exercises: [{ blockIndex: 1, sourceParagraph: null }],
    }],
    unmappedBlockIndices: [],
  })];
  const result = rescueMissingPass2PlacementReferences(topics, 2);
  assert.deepEqual(result.rescuedToUnmapped, []);
  assert.deepEqual(topics[0].microNodes[0].exercises.map((exercise) => exercise.blockIndex), [1]);
}

// 6. A support reference is already a placement and cannot receive a duplicate
// unmapped rescue. Re-running the invariant is deterministic and idempotent.
{
  const topics = [topic({
    inputBlockIndices: [0, 1],
    microNodes: [{
      candidateId: "t1:n0",
      title: "Կանոն",
      learningObjective: "Բացատրում է կանոնը։",
      microNodeType: "knowledge",
      sourceBlockIndices: [0],
      supportingMaterialIndices: [1],
      exercises: [],
    }],
    unmappedBlockIndices: [],
  })];
  assert.deepEqual(rescueMissingPass2PlacementReferences(topics, 2).rescuedToUnmapped, []);
  assert.deepEqual(rescueMissingPass2PlacementReferences(topics, 2).rescuedToUnmapped, []);
  assert.deepEqual(validateSourceCoverage(2, topics).duplicateIndices, []);
}

// 7. If no topic membership exists, recovery is deliberately impossible and the
// unchanged final validator continues to reject the missing verified block.
{
  const topics: Pass2TopicResult[] = [];
  const result = rescueMissingPass2PlacementReferences(topics, 1);
  assert.deepEqual(result.unrecoverableIndices, [0]);
  const coverage = validateSourceCoverage(1, topics);
  assert.equal(coverage.valid, false);
  assert.deepEqual(coverage.missingIndices, [0]);
}

// 8. The same incomplete group input has the same recovery every time.
{
  const run = () => {
    const groups: Pass2TopicGroup[] = [
      { title: "Ա", topicType: "math", indices: [0, 1, 3] },
      { title: "Բ", topicType: "math", indices: [4, 5] },
    ];
    const result = ensurePass2TopicGroupCoverage(groups, 6);
    return { result, groups };
  };
  assert.deepEqual(run(), run());
}

console.log("✓ Pass 2 placement invariant: verified topic membership and review-safe output rescue are exact, duplicate-free, and deterministic");