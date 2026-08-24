import assert from "node:assert/strict";
import {
  auditKnowledgeCompleteness,
  resolveDuplicateSuspicions,
  type DuplicateResolutionAudit,
  type KnowledgeCandidatePromotionDiagnostics,
  type LessonWideConsolidationDiagnostics,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";

function node(
  candidateId: string,
  title: string,
  sources: number[],
  exercises: number[] = [],
) {
  return {
    candidateId,
    title,
    learningObjective: title,
    microNodeType: "skill" as const,
    sourceBlockIndices: sources,
    supportingMaterialIndices: [],
    exercises: exercises.map((blockIndex) => ({ blockIndex, sourceParagraph: null })),
  };
}

function topic(nodes: ReturnType<typeof node>[]): Pass2TopicResult[] {
  return [{
    sequence: 1,
    title: "Հատված",
    topicType: "math",
    inputBlockIndices: [0, 1, 20, 21],
    microNodes: nodes,
    unmappedBlockIndices: [],
    additionalExercises: [],
  }];
}

function promotion(ids: string[]): KnowledgeCandidatePromotionDiagnostics {
  return {
    candidateCount: ids.length,
    promotedMicroNodeCount: ids.length,
    reviewRequiredCandidateCount: 0,
    supportingMaterialBlockCount: 0,
    exerciseReferenceCount: 0,
    unresolvedCandidateCount: 0,
    rejectedNonKnowledgeCount: 0,
    consolidatedCandidateCount: 0,
    decisions: ids.map((candidateId) => ({
      candidateId, topicSequence: 1, state: "PROMOTE" as const, reasonCodes: [],
    })),
  };
}

function consolidation(groups: LessonWideConsolidationDiagnostics["groups"] = []): LessonWideConsolidationDiagnostics {
  return {
    provisionalCandidateCount: 2,
    promotionEligibleCount: 2,
    canonicalKnowledgeUnitCount: 2,
    sameKnowledgeConsolidationCount: 0,
    distinctDecisionCount: 0,
    reviewRequiredSemanticGroupCount: 0,
    crossTopicConsolidationCount: 0,
    emptiedProvisionalTopicCount: 0,
    finalTopicCount: 1,
    groups,
    forcedReviewCandidateIds: [],
  };
}

const directionalSnapshots = [
  {
    candidateId: "graph-to-intervals",
    topicSequence: 1,
    title: "Գրաֆիկից որոշում է նշանների միջակայքները",
    learningObjective: "Գրաֆիկից որոշում է ֆունկցիայի դրական և բացասական միջակայքները։",
    microNodeType: "skill" as const,
    coreSourceBlockIndices: [0],
    supportingSourceBlockIndices: [],
    exercises: [{ blockIndex: 20, sourceParagraph: null }],
  },
  {
    candidateId: "intervals-to-graph",
    topicSequence: 1,
    title: "Նշանների միջակայքներից կառուցում է գրաֆիկ",
    learningObjective: "Նշանների միջակայքներից կառուցում է ֆունկցիայի գրաֆիկը։",
    microNodeType: "skill" as const,
    coreSourceBlockIndices: [1],
    supportingSourceBlockIndices: [],
    exercises: [{ blockIndex: 21, sourceParagraph: null }],
  },
];

// Missing learner-state certification must fail closed before candidates can collapse.
{
  const topics = topic([node("a", "A", [0]), node("b", "B", [1])]);
  const audit = resolveDuplicateSuspicions(topics, [{
    candidateAId: "a", candidateBId: "b", topicASequence: 1, topicBSequence: 1,
  }], [{ candidateAId: "a", candidateBId: "b", decision: "MERGE", confidence: "HIGH", keepCandidateId: "a" }]);
  assert.equal(audit.crossTopicMergePairs?.length, 0);
  assert.equal(audit.unresolvedPairIds.length, 1);
  assert.equal(topics[0].microNodes.length, 2);
}

// §1.5-shaped regression: a collapsed directional target is restored only from its
// exact prior candidate and exclusively available verified source/activity evidence.
{
  const topics = topic([node("intervals-to-graph", directionalSnapshots[1].learningObjective, [1], [21])]);
  const result = auditKnowledgeCompleteness({
    topics,
    candidateSnapshots: directionalSnapshots,
    promotionPreview: promotion(["graph-to-intervals", "intervals-to-graph"]),
    lessonWideConsolidation: consolidation(),
  });
  assert.deepEqual(result.restoredCandidateIds, ["graph-to-intervals"]);
  assert.equal(result.reviewRequiredGaps.length, 0);
  assert.equal(topics[0].microNodes.length, 2);
  assert.deepEqual(
    topics[0].microNodes.flatMap((entry) => entry.sourceBlockIndices).sort((a, b) => a - b),
    [0, 1],
  );
  assert.deepEqual(
    topics[0].microNodes.flatMap((entry) => entry.exercises.map((exercise) => exercise.blockIndex)).sort((a, b) => a - b),
    [20, 21],
  );
}

// A source conflict cannot be guessed into a split; it remains review-required
// and surfaces the associated substantive exercise demand.
{
  const topics = topic([node("other", "այլ նպատակ", [0, 1])]);
  const result = auditKnowledgeCompleteness({
    topics,
    candidateSnapshots: directionalSnapshots,
    promotionPreview: promotion(["graph-to-intervals", "intervals-to-graph"]),
    lessonWideConsolidation: consolidation(),
    teacherOutcomes: ["Սովորողը կիրառում է նշանների միջակայքները։"],
  });
  assert.equal(result.restoredCandidateIds.length, 0);
  assert.ok(result.reviewRequiredGaps.some((gap) => gap.reason === "RESTORE_SOURCE_CONFLICT"));
  assert.ok(result.reviewRequiredGaps.some((gap) => gap.reason === "EXERCISE_KNOWLEDGE_GAP"));
  assert.deepEqual(result.unresolvedOutcomeIndexes, [0]);
}

// A final review-required promotion decision remains review-only; the audit
// never turns an intentionally uncertain candidate into a canonical target.
{
  const topics = topic([]);
  const reviewPromotion = promotion(["graph-to-intervals"]);
  reviewPromotion.decisions[0].state = "REVIEW_REQUIRED";
  const result = auditKnowledgeCompleteness({
    topics,
    candidateSnapshots: [directionalSnapshots[0]],
    promotionPreview: promotion(["graph-to-intervals"]),
    finalPromotion: reviewPromotion,
    lessonWideConsolidation: consolidation(),
  });
  assert.equal(result.candidateTargetCount, 0);
  assert.equal(result.restoredCandidateIds.length, 0);
  assert.equal(result.reviewRequiredGaps.length, 0);
}

// A known semantic SAME group covers its non-canonical member; words alone do not.
{
  const topics = topic([node("a", "Նշանների միջակայքներ", [0])]);
  const result = auditKnowledgeCompleteness({
    topics,
    candidateSnapshots: [{ ...directionalSnapshots[0], candidateId: "a" }, { ...directionalSnapshots[1], candidateId: "b" }],
    promotionPreview: promotion(["a", "b"]),
    lessonWideConsolidation: consolidation([{
      groupId: "lwg:a+b", state: "SAME_KNOWLEDGE", candidateIds: ["a", "b"], canonicalCandidateId: "a", reasonCodes: [],
    }]),
  });
  assert.equal(result.reviewRequiredGaps.length, 0);
}

console.log("✓ mapping completeness: independent assessability, restoration, source/exercise preservation, outcome review, and semantic-only identity coverage");