import assert from "node:assert/strict";
import {
  auditKnowledgeCompleteness,
  buildAutomaticOutcomeAlignmentPlan,
  discoverIndependentLearningTargets,
  deriveIndependentPerformanceDirection,
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

// Target discovery is lesson-wide and promotion-independent. Both inverse
// transformations survive as distinct targets even though they share nouns.
{
  const targets = discoverIndependentLearningTargets({
    candidateSnapshots: directionalSnapshots,
    teacherGoal: "Կիրառում է ֆունկցիայի գրաֆիկը և նշանների միջակայքները։",
    teacherOutcomes: [
      "Գրաֆիկից որոշում է ֆունկցիայի նշանների միջակայքները։",
      "Նշանների միջակայքներից կառուցում է ֆունկցիայի գրաֆիկը։",
    ],
  });
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((target) => target.performanceDirection).sort(),
    ["GRAPH_TO_SIGN_INTERVALS", "SIGN_INTERVALS_TO_GRAPH"],
  );
  assert.deepEqual(
    targets.map((target) => target.exerciseBlockIndices).sort((left, right) => left[0] - right[0]),
    [[20], [21]],
  );
}

// Cross-subject matrix: each source-backed candidate stays independently
// auditable until explicit SAME_KNOWLEDGE certification; exercises/outcomes
// alone never manufacture targets; diagnostics stay deterministic.
{
  const grammarSnapshots = [
    {
      candidateId: "grammar-a",
      topicSequence: 1,
      title: "Գոյականի հոլովների որոշում",
      learningObjective: "Որոշում է գոյականի հոլովները նախադասության մեջ։",
      microNodeType: "skill" as const,
      coreSourceBlockIndices: [4],
      supportingSourceBlockIndices: [],
      exercises: [{ blockIndex: 30, sourceParagraph: null }],
    },
    {
      candidateId: "grammar-b",
      topicSequence: 2,
      title: "Գոյականի հոլովների որոշում",
      learningObjective: "Վերլուծում է գոյականի հոլովները նախադասության մեջ։",
      microNodeType: "skill" as const,
      coreSourceBlockIndices: [5],
      supportingSourceBlockIndices: [],
      exercises: [{ blockIndex: 31, sourceParagraph: null }],
    },
  ];
  const input = {
    candidateSnapshots: grammarSnapshots,
    teacherOutcomes: ["Վերլուծում է գոյականի հոլովները նախադասության մեջ։"],
    teacherGoal: "Կիրառում է գոյականի հոլովները։",
  };
  assert.equal(discoverIndependentLearningTargets(input).length, 2);
  assert.deepEqual(discoverIndependentLearningTargets(input), discoverIndependentLearningTargets(input));
  assert.deepEqual(
    discoverIndependentLearningTargets({
      candidateSnapshots: [],
      teacherOutcomes: ["Կիրառում է գոյականի հոլովները։"],
      teacherGoal: "Գոյականի հոլովներ",
    }),
    [],
  );

  const bridge = {
    ...grammarSnapshots[0],
    candidateId: "unclassified-bridge",
    title: "Ֆունկցիայի գրաֆիկ և նշանների միջակայքներ",
    learningObjective: "Կիրառում է ֆունկցիայի գրաֆիկը և նշանների միջակայքները։",
    coreSourceBlockIndices: [6],
  };
  const bridged = discoverIndependentLearningTargets({
    candidateSnapshots: [directionalSnapshots[0], bridge, directionalSnapshots[1]],
    teacherOutcomes: [
      "Գրաֆիկից որոշում է ֆունկցիայի նշանների միջակայքները։",
      "Նշանների միջակայքներից կառուցում է ֆունկցիայի գրաֆիկը։",
    ],
  });
  assert.equal(bridged.length, 3, "an unspecified candidate must not bridge inverse performance directions");
  assert.deepEqual(
    bridged.find((target) => target.candidateIds[0] === "unclassified-bridge")?.outcomeIndexes,
    [],
    "an unspecified candidate must not claim either explicit inverse outcome",
  );
  assert.deepEqual(
    discoverIndependentLearningTargets({
      candidateSnapshots: [{
        candidateId: "source-only-generic",
        topicSequence: 1,
        title: "Կիրառ",
        learningObjective: "Կիրառ",
        microNodeType: "skill",
        coreSourceBlockIndices: [7],
        supportingSourceBlockIndices: [],
        exercises: [],
      }],
    }).map((target) => ({ candidateIds: target.candidateIds, conceptTokens: target.conceptTokens })),
    [{ candidateIds: ["source-only-generic"], conceptTokens: [] }],
    "source-backed candidates remain auditable even without concept tokens",
  );
}

// Concept overlap alone is insufficient for curriculum alignment when the
// learner performance direction is the inverse transformation.
{
  const plan = buildAutomaticOutcomeAlignmentPlan(
    ["Նշանների միջակայքներից կառուցում է ֆունկցիայի գրաֆիկը։"],
    topic([node(
      "graph-to-intervals",
      directionalSnapshots[0].learningObjective,
      [0],
    )]),
  );
  assert.deepEqual(plan.proposals, []);
  assert.deepEqual(plan.unresolvedOutcomeIndexes, [0]);
  assert.equal(
    deriveIndependentPerformanceDirection(directionalSnapshots[1].learningObjective),
    "SIGN_INTERVALS_TO_GRAPH",
  );
}

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
  assert.deepEqual(
    result.independentTargets.map((target) => ({
      candidateIds: target.candidateIds,
      canonicalCandidateIds: target.canonicalCandidateIds,
      state: target.state,
    })).sort((left, right) => left.candidateIds[0].localeCompare(right.candidateIds[0])),
    [
      { candidateIds: ["graph-to-intervals"], canonicalCandidateIds: ["graph-to-intervals"], state: "COVERED" },
      { candidateIds: ["intervals-to-graph"], canonicalCandidateIds: ["intervals-to-graph"], state: "COVERED" },
    ],
  );
}

// A shared noun cannot claim target coverage without the target's canonical
// candidate ID or an explicit SAME_KNOWLEDGE certification.
{
  const topics = topic([node("lexical-other", "Ֆունկցիայի գրաֆիկ", [8])]);
  const result = auditKnowledgeCompleteness({
    topics,
    candidateSnapshots: [directionalSnapshots[0]],
    promotionPreview: promotion(["graph-to-intervals"]),
    lessonWideConsolidation: consolidation(),
  });
  assert.deepEqual(result.restoredCandidateIds, ["graph-to-intervals"]);
  assert.equal(topics[0].microNodes.length, 2);
}

// Same-direction, lexically similar candidates still need independent
// canonical coverage absent an explicit SAME_KNOWLEDGE certification.
{
  const grammarSnapshots = [
    {
      candidateId: "grammar-a",
      topicSequence: 1,
      title: "Գոյականի հոլովների որոշում",
      learningObjective: "Որոշում է գոյականի հոլովները նախադասության մեջ։",
      microNodeType: "skill" as const,
      coreSourceBlockIndices: [4],
      supportingSourceBlockIndices: [],
      exercises: [],
    },
    {
      candidateId: "grammar-b",
      topicSequence: 1,
      title: "Գոյականի հոլովների որոշում",
      learningObjective: "Վերլուծում է գոյականի հոլովները նախադասության մեջ։",
      microNodeType: "skill" as const,
      coreSourceBlockIndices: [5],
      supportingSourceBlockIndices: [],
      exercises: [],
    },
  ];
  const topics = topic([node("grammar-a", grammarSnapshots[0].learningObjective, [4])]);
  const result = auditKnowledgeCompleteness({
    topics,
    candidateSnapshots: grammarSnapshots,
    promotionPreview: promotion(["grammar-a", "grammar-b"]),
    lessonWideConsolidation: consolidation(),
  });
  assert.deepEqual(result.restoredCandidateIds, ["grammar-b"]);
  assert.equal(topics[0].microNodes.length, 2);
}

// A supporting-material owner is an established placement, not free source.
// Completeness must surface review rather than steal it for a restoration.
{
  const topics = topic([{
    ...node("other", "Այլ նպատակ", [2]),
    supportingMaterialIndices: [0],
  } as any]);
  const result = auditKnowledgeCompleteness({
    topics,
    candidateSnapshots: [directionalSnapshots[0]],
    promotionPreview: promotion(["graph-to-intervals"]),
    lessonWideConsolidation: consolidation(),
  });
  assert.deepEqual(result.restoredCandidateIds, []);
  assert.ok(result.reviewRequiredGaps.some((gap) => gap.reason === "RESTORE_SOURCE_CONFLICT"));
}

// Free core source is not enough: a restored candidate may not copy an
// exercise that already has a canonical owner and then claim false coverage.
{
  const topics = topic([node("exercise-owner", "Այլ նպատակ", [2], [20])]);
  const result = auditKnowledgeCompleteness({
    topics,
    candidateSnapshots: [directionalSnapshots[0]],
    promotionPreview: promotion(["graph-to-intervals"]),
    lessonWideConsolidation: consolidation(),
  });
  assert.deepEqual(result.restoredCandidateIds, []);
  assert.ok(result.reviewRequiredGaps.some((gap) => gap.reason === "RESTORE_EXERCISE_CONFLICT"));
  assert.equal(result.independentTargets[0].state, "REVIEW_REQUIRED");
  assert.deepEqual(
    topics[0].microNodes.map((entry) => entry.candidateId),
    ["exercise-owner"],
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
  assert.equal(result.candidateTargetCount, 1);
  assert.equal(result.independentTargetCount, 1);
  assert.equal(result.restoredCandidateIds.length, 0);
  assert.equal(result.reviewRequiredGaps.length, 1);
  assert.equal(result.independentTargets[0].state, "REVIEW_REQUIRED");
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

console.log("✓ mapping completeness: independent targets, direction-safe inverse performance, restoration, source/exercise preservation, outcome review, and semantic-only identity coverage");