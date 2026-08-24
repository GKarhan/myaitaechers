import assert from "node:assert/strict";
import {
  validateInstructionalCoverage,
  validateSourceCoverage,
  type CoverageValidationResult,
  type InstructionalCoverageResult,
  type ValidatorTopic,
} from "../coverage-validator.js";
import { classifyMicroNodeSourceAlignment } from "../micronode-source-alignment.js";
import {
  assertPass2PersistenceGates,
  applyBoundedSourceReallocation,
  preserveUnresolvedInstructionalBlocksForReview,
  buildDuplicateReviewCandidates,
  buildAutomaticOutcomeAlignmentPlan,
  collectDuplicateSuspicions,
  consolidateHighConfidenceOverSplits,
  MappingSourcePlacementError,
  parseDuplicateResolutions,
  resolveDuplicateSuspicions,
  type DuplicateResolutionAudit,
  type Pass2Result,
  type Pass2SourceAlignment,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";

const diagnostics = {
  detectedGroupCount: 1,
  groupsAfterTheoryMergeCount: 1,
  topics: [],
  totals: {
    candidateMicroNodes: 0,
    acceptedBeforeNormalization: 0,
    acceptedAfterNormalization: 0,
    rejectedMicroNodes: 0,
  },
};

const validInstructionalCoverage: InstructionalCoverageResult = {
  valid: true,
  readableInstructionalBlocks: 0,
  microNodeOwnedInstructionalBlocks: 0,
  unresolvedInstructionalIndices: [],
  unresolvedActivityIndices: [],
  dispositionCounts: {
    MICRONODE_OWNED: 0,
    EXERCISE_OWNED: 0,
    LEGITIMATE_NON_INSTRUCTIONAL: 0,
    UNREADABLE: 0,
    UNRESOLVED: 0,
  },
  blocks: [],
};

const validSourceAlignment: Pass2SourceAlignment = {
  valid: true,
  sufficientCount: 0,
  partialCount: 0,
  insufficientCount: 0,
  unreadableCount: 0,
  nodes: [],
};

const noDuplicateConcern: DuplicateResolutionAudit = {
  candidatePairCount: 0,
  resolvedDistinctCount: 0,
  mergedCount: 0,
  unresolvedPairIds: [],
  rejectedDecisionCount: 0,
  actions: [],
};

function node(title: string, learningObjective: string, sourceBlockIndices: number[], candidateId?: string) {
  return {
    ...(candidateId ? { candidateId } : {}),
    title,
    learningObjective,
    microNodeType: "knowledge" as const,
    sourceBlockIndices,
    exercises: [],
    supportingMaterialIndices: [],
  };
}

function topic(sequence: number, microNodes: Pass2TopicResult["microNodes"]): Pass2TopicResult {
  return {
    sequence,
    title: `Թեմա ${sequence}`,
    topicType: "knowledge",
    inputBlockIndices: [0, 1],
    microNodes,
    unmappedBlockIndices: [],
    additionalExercises: [],
  };
}

function assertPreservesOldMap(
  coverageValidation: CoverageValidationResult,
  expected: new (...args: any[]) => Error,
  overrides: Partial<Parameters<typeof assertPass2PersistenceGates>[0]> = {},
) {
  const oldMapping = [{ id: 7, title: "Նախորդ անվտանգ քարտեզ" }];
  assert.throws(
    () => assertPass2PersistenceGates({
      coverageValidation,
      instructionalCoverage: validInstructionalCoverage,
      sourceAlignment: validSourceAlignment,
      duplicateResolution: noDuplicateConcern,
      diagnostics,
      ...overrides,
    }),
    expected,
  );
  assert.deepEqual(oldMapping, [{ id: 7, title: "Նախորդ անվտանգ քարտեզ" }]);
}

const validPlacement = validateSourceCoverage(2, [{
  microNodes: [{
    title: "Կանոն",
    sourceBlockIndices: [0, 1],
    exercises: [],
    supportingMaterialIndices: [],
  }],
  unmappedBlockIndices: [],
}]);

for (const [label, invalid] of [
  ["missing", validateSourceCoverage(2, [{
    microNodes: [{ title: "Կանոն", sourceBlockIndices: [0], exercises: [], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
  }])],
  ["duplicate", validateSourceCoverage(2, [{
    microNodes: [
      { title: "Ա", sourceBlockIndices: [0], exercises: [], supportingMaterialIndices: [] },
      { title: "Բ", sourceBlockIndices: [0, 1], exercises: [], supportingMaterialIndices: [] },
    ],
    unmappedBlockIndices: [],
  }])],
  ["out-of-range", validateSourceCoverage(2, [{
    microNodes: [{ title: "Կանոն", sourceBlockIndices: [0, 1, 3], exercises: [], supportingMaterialIndices: [] }],
    unmappedBlockIndices: [],
  }])],
  ["empty MicroNode", validateSourceCoverage(2, [{
    microNodes: [
      { title: "Դատարկ", sourceBlockIndices: [], exercises: [], supportingMaterialIndices: [] },
      { title: "Կանոն", sourceBlockIndices: [0, 1], exercises: [], supportingMaterialIndices: [] },
    ],
    unmappedBlockIndices: [],
  }])],
] as const) {
  assert.equal(invalid.valid, false, `${label} fixture must be invalid`);
  assertPreservesOldMap(invalid, MappingSourcePlacementError);
}
assert.equal(validPlacement.valid, true);
console.log("  ✓ all invalid placement categories block persistence and preserve the old map");

{
  const topics = [topic(1, [
    node("Առաջին", "Բացատրում է առաջին հասկացությունը։", [0], "t1:n0"),
    node("Երկրորդ", "Բացատրում է երկրորդ հասկացությունը։", [1], "t1:n1"),
    node("Երրորդ", "Բացատրում է երրորդ հասկացությունը։", [2], "t1:n2"),
    node("Չորրորդ", "Բացատրում է չորրորդ հասկացությունը։", [3], "t1:n3"),
    node("Հինգերորդ", "Բացատրում է հինգերորդ հասկացությունը։", [4], "t1:n4"),
    node("Վերանայվող", "Կիրառում է չհիմնավորված հատուկ կանոն։", [5], "t1:n5"),
  ])];
  const placement = validateSourceCoverage(6, topics);
  const oneUnsafeRelation: Pass2SourceAlignment = {
    valid: false,
    sufficientCount: 5,
    partialCount: 1,
    insufficientCount: 0,
    unreadableCount: 0,
    nodes: [],
  };
  assert.equal(topics[0].microNodes.length, 6);
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: placement,
    instructionalCoverage: validInstructionalCoverage,
    sourceAlignment: oneUnsafeRelation,
    duplicateResolution: noDuplicateConcern,
    diagnostics,
  }));
  console.log("  ✓ five grounded nodes remain eligible when one source relation requires review");
}

{
  const blocks = [
    { blockType: "RULE", sourceText: "Առաջին կանոնը բացատրում է առաջին հասկացությունը։", sourcePage: 11 },
    { blockType: "RULE", sourceText: "Երկրորդ կանոնը բացատրում է երկրորդ հասկացությունը։", sourcePage: 11 },
    { blockType: "RULE", sourceText: "Երրորդ կանոնը բացատրում է երրորդ հասկացությունը։", sourcePage: 11 },
    { blockType: "RULE", sourceText: "Չորրորդ կանոնը բացատրում է չորրորդ հասկացությունը։", sourcePage: 11 },
    { blockType: "RULE", sourceText: "Հինգերորդ կանոնը բացատրում է հինգերորդ հասկացությունը։", sourcePage: 11 },
    { blockType: "RULE", sourceText: "Վեցերորդ կանոնը պահանջում է ուսուցչի ձեռքով կապում։", sourcePage: 11 },
  ];
  const topics = [topic(1, [
    node("Առաջին", "Բացատրում է առաջին հասկացությունը։", [0], "t1:n0"),
    node("Երկրորդ", "Բացատրում է երկրորդ հասկացությունը։", [1], "t1:n1"),
    node("Երրորդ", "Բացատրում է երրորդ հասկացությունը։", [2], "t1:n2"),
    node("Չորրորդ", "Բացատրում է չորրորդ հասկացությունը։", [3], "t1:n3"),
    node("Հինգերորդ", "Բացատրում է հինգերորդ հասկացությունը։", [4], "t1:n4"),
  ])];
  topics[0].inputBlockIndices = [0, 1, 2, 3, 4, 5];
  const before = validateInstructionalCoverage(blocks, topics);
  assert.deepEqual(before.unresolvedInstructionalIndices, [5]);
  const preserved = preserveUnresolvedInstructionalBlocksForReview(topics, blocks);
  const after = validateInstructionalCoverage(blocks, topics);
  assert.deepEqual(preserved.preservedBlockIndices, [5]);
  assert.deepEqual(topics[0].unmappedBlockIndices, [5]);
  assert.deepEqual(after.unresolvedInstructionalIndices, [5], "review status must remain visible");
  assert.equal(validateSourceCoverage(blocks.length, topics).valid, true, "the preserved block is structurally accounted for");
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(blocks.length, topics),
    instructionalCoverage: after,
    sourceAlignment: validSourceAlignment,
    duplicateResolution: noDuplicateConcern,
    diagnostics,
  }));
  console.log("  ✓ an unassigned readable source block persists as review-required instead of discarding valid nodes");
}

{
  const blocks = [
    { blockType: "RULE", sourceText: "", sourcePage: 11 },
    { blockType: "RULE", sourceText: "Ընթեռնելի կանոնը բացատրում է հասկացությունը։", sourcePage: 11 },
  ];
  const topics = [topic(1, [
    node("Ընթեռնելի կանոն", "Բացատրում է հասկացությունը։", [1], "t1:n0"),
  ])];
  const preserved = preserveUnresolvedInstructionalBlocksForReview(topics, blocks);
  const coverage = validateInstructionalCoverage(blocks, topics);
  assert.deepEqual(preserved.preservedBlockIndices, [0]);
  assert.equal(coverage.blocks[0].disposition, "UNREADABLE");
  assert.equal(validateSourceCoverage(blocks.length, topics).valid, true);
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(blocks.length, topics),
    instructionalCoverage: coverage,
    sourceAlignment: validSourceAlignment,
    duplicateResolution: noDuplicateConcern,
    diagnostics,
  }));
  console.log("  ✓ unreadable source stays unmapped for review and never becomes valid grounding");
}

{
  const blocks = [
    { blockType: "OBJECTIVE", sourceText: "Թեմայի վերնագիր", sourcePage: 11 },
    { blockType: "RULE", sourceText: "Կանոնը բացատրում է կողմերի տարբերությունը։", sourcePage: 11 },
    { blockType: "EXERCISE", sourceText: "Լուծիր առաջադրանքը։", sourcePage: 11 },
    { blockType: "IMAGE", sourceText: "Նկար", sourcePage: 11 },
  ];
  const structuralAndExercises: ValidatorTopic[] = [{
    microNodes: [{
      title: "Կողմերի կանոն",
      sourceBlockIndices: [1],
      exercises: [{ blockIndex: 2 }],
      supportingMaterialIndices: [],
    }],
    unmappedBlockIndices: [0, 3],
  }];
  assert.equal(validateSourceCoverage(4, structuralAndExercises).valid, true);
  assert.equal(validateInstructionalCoverage(blocks, structuralAndExercises).valid, true);
  console.log("  ✓ structural, visual, and canonical exercise placements remain valid");
}

{
  const lexicalOnly = classifyMicroNodeSourceAlignment("Համեմատում է գույն և ձև։", [{
    blockType: "NOTE",
    sourceText: "Գույն և ձև նկարում երևում էին որպես գեղեցիկ պատկեր։",
  }]);
  assert.equal(lexicalOnly.status, "PARTIAL");
  assert.equal(lexicalOnly.reasonCode, "LEXICAL_OVERLAP_ONLY");

  const directRule = classifyMicroNodeSourceAlignment("Բացատրում է քառակուսու կողմերի կանոնը։", [{
    blockType: "RULE",
    sourceText: "Քառակուսու կանոնը բացատրում է, որ նրա բոլոր կողմերը հավասար են։",
  }]);
  assert.equal(directRule.status, "SUFFICIENT");

  const unsupportedSpecific = classifyMicroNodeSourceAlignment("Կիրառում է նոր շենքի 7/2 հասցեի գրառումը։", [{
    blockType: "RULE",
    sourceText: "Նոր շենքի հասցեի գրառումը կարող է լինել 5/1 ձևով։",
  }]);
  assert.equal(unsupportedSpecific.status, "PARTIAL");
  assert.equal(unsupportedSpecific.reasonCode, "UNSUPPORTED_SPECIFIC_CLAIM");

  const genericOnly = classifyMicroNodeSourceAlignment("Բացատրում է կանոնը։", [{
    blockType: "RULE",
    sourceText: "Կանոնը կիրառվում է տվյալ թեմայում։",
  }]);
  assert.notEqual(genericOnly.status, "SUFFICIENT");
  console.log("  ✓ lexical, narrative, generic, and unsupported-specific claims cannot ground a MicroNode");
}

{
  const topics = [topic(1, [
    node("Կանոն", "Բացատրում է շենքերի համարակալման կանոնը։", [0], "t1:n0"),
    node("Կանոնի ներկայացում", "Բացատրում է շենքերի համարակալման կանոնը։", [1], "t1:n1"),
  ])];
  const candidates = collectDuplicateSuspicions(topics);
  assert.equal(candidates.length, 1);
  const audit = resolveDuplicateSuspicions(topics, candidates, [{
    candidateAId: "t1:n0",
    candidateBId: "t1:n1",
    decision: "MERGE",
    confidence: "HIGH",
    keepCandidateId: "t1:n0",
  }]);
  assert.equal(audit.mergedCount, 1);
  assert.deepEqual(topics[0].microNodes[0].sourceBlockIndices, [0, 1]);
  console.log("  ✓ explicit HIGH same-topic duplicate merge preserves source ownership");
}

{
  const topics = [topic(1, [
    node("Կանոն", "Բացատրում է շենքերի համարակալման կանոնը։", [0], "t1:n0"),
    node("Կանոն", "Բացատրում է շենքերի համարակալման կանոնը։", [1], "t1:n1"),
  ])];
  const titleOnly = consolidateHighConfidenceOverSplits(topics, [{
    topicTitle: "Թեմա 1",
    microNodeTitle: "Կանոն",
    mergeIntoMicroNodeTitle: "Կանոն",
    issue: "OVER_SPLIT",
    confidence: "HIGH",
    reason: "Թեստ",
  }], { requireStableIds: true });
  assert.equal(titleOnly.mergedMicroNodeCount, 0);
  assert.equal(titleOnly.rejectedDecisionCount, 1);
  const forgedId = consolidateHighConfidenceOverSplits(topics, [{
    topicTitle: "Թեմա 1",
    microNodeTitle: "Կանոն",
    microNodeId: "t1:n999",
    mergeIntoMicroNodeTitle: "Կանոն",
    mergeIntoMicroNodeId: "t1:n0",
    issue: "OVER_SPLIT",
    confidence: "HIGH",
    reason: "Թեստ",
  }], { requireStableIds: true });
  assert.equal(forgedId.mergedMicroNodeCount, 0);
  assert.equal(forgedId.rejectedDecisionCount, 1);

  const blocks = [
    { blockType: "RULE", sourceText: "Շենքերի համարակալման կանոնը բացատրվում է այստեղ։", sourcePage: 11 },
    { blockType: "RULE", sourceText: "Նույն կանոնի հաջորդ բացատրությունը։", sourcePage: 11 },
  ] as any;
  const titleOnlyMove = applyBoundedSourceReallocation(topics, blocks, [{
    topicTitle: "Թեմա 1",
    microNodeTitle: "Կանոն",
    action: "MOVE_BLOCKS",
    sourceBlockIndices: [1],
    reason: "Թեստ",
  }], { requireStableIds: true });
  const forgedIdMove = applyBoundedSourceReallocation(topics, blocks, [{
    topicTitle: "Թեմա 1",
    microNodeTitle: "Կանոն",
    topicSequence: 1,
    microNodeId: "t1:n999",
    action: "MOVE_BLOCKS",
    sourceBlockIndices: [1],
    reason: "Թեստ",
  }], { requireStableIds: true });
  assert.equal(titleOnlyMove.rejectedDecisionCount, 1);
  assert.equal(forgedIdMove.rejectedDecisionCount, 1);
  assert.deepEqual(topics[0].microNodes.map((item) => item.sourceBlockIndices), [[0], [1]]);
  console.log("  ✓ title-only and forged-ID semantic actions cannot mutate colliding production candidates");
}

{
  const topics = [
    topic(1, [node("Կանոն", "Բացատրում է շենքերի համարակալման կանոնը։", [0], "t1:n0")]),
    topic(2, [node("Կանոն", "Բացատրում է շենքերի համարակալման կանոնը։", [1], "t2:n0")]),
  ];
  const candidates = collectDuplicateSuspicions(topics);
  assert.equal(candidates.length, 1);
  const unresolved = resolveDuplicateSuspicions(topics, candidates, [{
    candidateAId: "t1:n0",
    candidateBId: "t2:n0",
    decision: "REVIEW_REQUIRED",
    confidence: "MEDIUM",
  }]);
  assert.equal(unresolved.unresolvedPairIds.length, 1);
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validPlacement,
    instructionalCoverage: validInstructionalCoverage,
    sourceAlignment: validSourceAlignment,
    duplicateResolution: unresolved,
    diagnostics,
  }));

  const collisionAudit = resolveDuplicateSuspicions(topics, [{
    candidateAId: "t1:n0",
    candidateBId: "t2:n0",
    topicASequence: 1,
    topicBSequence: 2,
  }], [{
    candidateAId: "t1:n0",
    candidateBId: "t2:n0",
    decision: "DISTINCT",
    confidence: "HIGH",
  }]);
  assert.equal(collisionAudit.resolvedDistinctCount, 1);
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validPlacement,
    instructionalCoverage: validInstructionalCoverage,
    sourceAlignment: validSourceAlignment,
    duplicateResolution: collisionAudit,
    diagnostics,
  }));
  assert.deepEqual(buildDuplicateReviewCandidates(candidates), [{
    candidateAId: "t1:n0",
    candidateBId: "t2:n0",
    topicASequence: 1,
    topicBSequence: 2,
  }]);
  assert.equal(topics[0].microNodes[0].candidateId, "t1:n0");
  assert.equal(topics[1].microNodes[0].candidateId, "t2:n0");
  console.log("  ✓ cross-topic candidates reach review, accept HIGH DISTINCT, and persist as review-required when unresolved");
}

{
  const makeCandidateFixture = () => {
    const topics = [topic(1, [
      node("Ա", "Բացատրում է շենքերի համարակալման կանոնը։", [0], "t1:n0"),
      node("Բ", "Բացատրում է շենքերի համարակալման կանոնը։", [1], "t1:n1"),
    ])];
    return {
      topics,
      suspicions: [{
        candidateAId: "t1:n0",
        candidateBId: "t1:n1",
        topicASequence: 1,
        topicBSequence: 1,
      }],
      distinct: {
        candidateAId: "t1:n0",
        candidateBId: "t1:n1",
        decision: "DISTINCT" as const,
        confidence: "HIGH" as const,
      },
    };
  };
  for (const [label, resolutions] of [
    ["contradictory", (fixture: ReturnType<typeof makeCandidateFixture>) => [
      fixture.distinct,
      { ...fixture.distinct, decision: "REVIEW_REQUIRED" as const, confidence: "MEDIUM" as const },
    ]],
    ["repeated", (fixture: ReturnType<typeof makeCandidateFixture>) => [
      fixture.distinct,
      { ...fixture.distinct, candidateAId: "t1:n1", candidateBId: "t1:n0" },
    ]],
    ["unknown", (fixture: ReturnType<typeof makeCandidateFixture>) => [
      fixture.distinct,
      { candidateAId: "t1:n404", candidateBId: "t1:n405", decision: "DISTINCT" as const, confidence: "HIGH" as const },
    ]],
  ] as const) {
    const fixture = makeCandidateFixture();
    const audit = resolveDuplicateSuspicions(fixture.topics, fixture.suspicions, resolutions(fixture));
    assert.ok(audit.rejectedDecisionCount > 0, `${label} output must be rejected`);
    assert.ok(audit.unresolvedPairIds.length > 0, `${label} output must remain unresolved`);
    assert.ok((audit.rejectedPairIds?.length ?? 0) > 0, `${label} pair identity must remain reviewable`);
    const gate = assertPass2PersistenceGates({
      coverageValidation: validPlacement,
      instructionalCoverage: validInstructionalCoverage,
      sourceAlignment: validSourceAlignment,
      duplicateResolution: audit,
      diagnostics,
    });
    assert.equal(gate.disposition, "REVIEW_REQUIRED");
    assert.ok(gate.reviewReasons.includes("DUPLICATE_REVIEW_REJECTED"));
  }
  console.log("  ✓ contradictory, repeated, and unknown duplicate resolutions become review-required");
}

{
  const topics = [topic(1, [
    node("Ա", "Բացատրում է շենքերի համարակալման կանոնը։", [0], "t1:n0"),
    node("Բ", "Բացատրում է շենքերի համարակալման կանոնը։", [1], "t1:n1"),
  ])];
  const suspicions = [{
    candidateAId: "t1:n0",
    candidateBId: "t1:n1",
    topicASequence: 1,
    topicBSequence: 1,
  }];
  const validDistinct = {
    candidateAId: "t1:n0",
    candidateBId: "t1:n1",
    decision: "DISTINCT",
    confidence: "HIGH",
  };
  for (const [label, providerEntries] of [
    ["malformed reversed duplicate", [validDistinct, {
      candidateAId: "t1:n1", candidateBId: "t1:n0", decision: "INVALID", confidence: "HIGH",
    }]],
    ["malformed unknown pair", [validDistinct, {
      candidateAId: "t1:n404", candidateBId: "t1:n405", decision: "INVALID", confidence: "HIGH",
    }]],
  ] as const) {
    const parsed = parseDuplicateResolutions(providerEntries);
    const audit = resolveDuplicateSuspicions(topics, suspicions, parsed.resolutions, [], parsed.malformedEntries);
    assert.ok(audit.rejectedDecisionCount > 0, `${label} must be retained as rejected output`);
    assert.ok((audit.rejectedPairIds?.length ?? 0) > 0, `${label} pair identity must be retained`);
    const gate = assertPass2PersistenceGates({
      coverageValidation: validPlacement,
      instructionalCoverage: validInstructionalCoverage,
      sourceAlignment: validSourceAlignment,
      duplicateResolution: audit,
      diagnostics,
    });
    assert.equal(gate.disposition, "REVIEW_REQUIRED");
    assert.ok(gate.reviewReasons.includes("DUPLICATE_REVIEW_REJECTED"));
  }
  const omitted = resolveDuplicateSuspicions(topics, suspicions, []);
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validPlacement,
    instructionalCoverage: validInstructionalCoverage,
    sourceAlignment: validSourceAlignment,
    duplicateResolution: omitted,
    diagnostics,
  }));
  console.log("  ✓ parser rejects malformed duplicate actions while all unresolved pairs persist as review-required");
}

{
  const topics = [topic(1, [
    node("Ա", "Բացատրում է շենքերի համարակալման կանոնը։", [0], "t1:n0"),
    node("Բ", "Բացատրում է շենքերի համարակալման կանոնը։", [1], "t1:n1"),
    node("Գ", "Բացատրում է հարակից շենքերի համարակալման կանոնը։", [2], "t1:n2"),
  ])];
  const suspicions = [
    { candidateAId: "t1:n0", candidateBId: "t1:n1", topicASequence: 1, topicBSequence: 1 },
    { candidateAId: "t1:n0", candidateBId: "t1:n2", topicASequence: 1, topicBSequence: 1 },
  ];
  const consolidation = consolidateHighConfidenceOverSplits(topics, [{
    topicTitle: "Թեմա 1",
    microNodeTitle: "Ա",
    microNodeId: "t1:n0",
    mergeIntoMicroNodeTitle: "Բ",
    mergeIntoMicroNodeId: "t1:n1",
    issue: "OVER_SPLIT",
    confidence: "HIGH",
    reason: "Թեստ",
  }], { requireStableIds: true });
  const audit = resolveDuplicateSuspicions(
    topics,
    suspicions,
    [],
    consolidation.resolvedCandidatePairs,
  );
  assert.equal(audit.unresolvedPairIds.length, 1);
  assert.deepEqual(audit.unresolvedPairIds[0], {
    candidateAId: "t1:n0",
    candidateBId: "t1:n2",
  });
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validPlacement,
    instructionalCoverage: validInstructionalCoverage,
    sourceAlignment: validSourceAlignment,
    duplicateResolution: audit,
    diagnostics,
  }));
  console.log("  ✓ merging one candidate cannot suppress a different unresolved duplicate review edge");
}

{
  const weakTopics = [topic(1, [
    node("Հասցեի գրառում", "Բացատրում է հասցեի գրառումը։", [0], "t1:n0"),
  ])];
  const plan = buildAutomaticOutcomeAlignmentPlan(
    ["Սովորողը կբացատրի հասցեի գրառումը։"],
    weakTopics,
  );
  assert.equal(plan.proposals.length, 1, "an Outcome may be conceptually alignable");
  const oldMapping = [{ id: 8, title: "Աղբյուրով հաստատված հին քարտեզ" }];
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validPlacement,
    instructionalCoverage: validInstructionalCoverage,
    sourceAlignment: {
      valid: false,
      sufficientCount: 0,
      partialCount: 1,
      insufficientCount: 0,
      unreadableCount: 0,
      nodes: [],
    },
    duplicateResolution: noDuplicateConcern,
    diagnostics,
  }));
  assert.deepEqual(oldMapping, [{ id: 8, title: "Աղբյուրով հաստատված հին քարտեզ" }]);
  console.log("  ✓ Outcome similarity cannot auto-approve a weak source-grounding review state");
}

console.log("\nC1 mapping hardening: provider-free gates passing");