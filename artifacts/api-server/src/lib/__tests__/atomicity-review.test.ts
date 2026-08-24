import assert from "node:assert/strict";
import {
  applyBoundedAtomicityRepairs,
  applyBoundedSourceReallocation,
  assertPass2PersistenceGates,
  buildAutomaticOutcomeAlignmentPlan,
  consolidateHighConfidenceOverSplits,
  finalizeAtomicityVerificationDiagnostics,
  getUnresolvedAtomicityFindings,
  normalizeActivityPlacements,
  validatePass2SourceAlignment,
  runBoundedAtomicityVerification,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";
import { validateInstructionalCoverage, validateSourceCoverage } from "../coverage-validator.js";

const blocks = (rows: Array<{ blockType: string; sourceText: string }>) => rows.map((row, index) => ({
  ...row,
  sourcePage: 14 + index,
  sourceParagraph: null,
  sourceBoundingBox: null,
})) as any;

const node = (
  id: string,
  title: string,
  learningObjective: string,
  sourceBlockIndices: number[],
  exerciseBlockIndices: number[] = [],
) => ({
  candidateId: id,
  title,
  learningObjective,
  microNodeType: "knowledge" as const,
  sourceBlockIndices,
  exercises: exerciseBlockIndices.map((blockIndex) => ({ blockIndex, sourceParagraph: null })),
  supportingMaterialIndices: [] as number[],
});

const topic = (nodes: Pass2TopicResult["microNodes"], additional: number[] = []): Pass2TopicResult => ({
  sequence: 1,
  title: "Թեմա",
  topicType: "knowledge",
  inputBlockIndices: [0, 1, 2],
  microNodes: nodes,
  unmappedBlockIndices: [],
  additionalExercises: additional.map((blockIndex) => ({ blockIndex, sourceParagraph: null })),
});

const diagnostics = {
  detectedGroupCount: 1,
  groupsAfterTheoryMergeCount: 1,
  topics: [],
  totals: { candidateMicroNodes: 0, acceptedBeforeNormalization: 0, acceptedAfterNormalization: 0, rejectedMicroNodes: 0 },
};

function assertNoCoverageDuplicates(source: ReturnType<typeof blocks>, topics: Pass2TopicResult[]): void {
  assert.equal(
    validateSourceCoverage(source.length, topics).duplicateIndices.length,
    0,
    "normalized ownership must not contain duplicate source block indices",
  );
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A rule with sufficient source evidence." },
    { blockType: "EXERCISE", sourceText: "Solve the activity." },
  ]);
  const activityOwner = node("t1:n0", "Rule", "Apply the rule.", [0]);
  activityOwner.supportingMaterialIndices = [1];
  const topics = [topic([activityOwner])];

  normalizeActivityPlacements(topics, source);

  assert.deepEqual(activityOwner.supportingMaterialIndices, []);
  assert.deepEqual(topics[0].additionalExercises.map((exercise) => exercise.blockIndex), [1]);
  assertNoCoverageDuplicates(source, topics);
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A rule with sufficient source evidence." },
    { blockType: "EXERCISE", sourceText: "Solve the activity." },
  ]);
  const activityOwner = node("t1:n0", "Rule", "Apply the rule.", [0], [1]);
  const topics = [topic([activityOwner])];
  topics[0].unmappedBlockIndices = [1];

  normalizeActivityPlacements(topics, source);

  assert.deepEqual(activityOwner.exercises.map((exercise) => exercise.blockIndex), [1]);
  assert.deepEqual(topics[0].unmappedBlockIndices, []);
  assertNoCoverageDuplicates(source, topics);
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A rule with sufficient source evidence." },
    { blockType: "EXERCISE", sourceText: "Solve the activity." },
  ]);
  const activityOwner = node("t1:n0", "Rule", "Apply the rule.", [0], [1]);
  activityOwner.supportingMaterialIndices = [1];
  const topics = [topic([activityOwner])];

  normalizeActivityPlacements(topics, source);

  assert.deepEqual(activityOwner.exercises.map((exercise) => exercise.blockIndex), [1]);
  assert.deepEqual(activityOwner.supportingMaterialIndices, []);
  assertNoCoverageDuplicates(source, topics);
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A rule with sufficient source evidence." },
    { blockType: "EXERCISE", sourceText: "Solve the activity." },
  ]);
  const activityOwner = node("t1:n0", "Rule", "Apply the rule.", [0]);
  activityOwner.supportingMaterialIndices = [1];
  const topics = [topic([activityOwner], [1])];

  normalizeActivityPlacements(topics, source);

  assert.deepEqual(topics[0].additionalExercises.map((exercise) => exercise.blockIndex), [1]);
  assert.deepEqual(activityOwner.supportingMaterialIndices, []);
  assertNoCoverageDuplicates(source, topics);
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "First rule with sufficient source evidence." },
    { blockType: "RULE", sourceText: "Second rule with sufficient source evidence." },
    { blockType: "EXERCISE", sourceText: "Solve the activity." },
  ]);
  const firstOwner = node("t1:n0", "First rule", "Apply the first rule.", [0], [2]);
  const secondOwner = node("t1:n1", "Second rule", "Apply the second rule.", [1], [2]);
  const topics = [topic([firstOwner, secondOwner])];

  normalizeActivityPlacements(topics, source);

  assert.deepEqual(firstOwner.exercises.map((exercise) => exercise.blockIndex), [2]);
  assert.deepEqual(secondOwner.exercises, []);
  assertNoCoverageDuplicates(source, topics);
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A rule with sufficient source evidence." },
    { blockType: "NOTE", sourceText: "A non-activity supporting note." },
  ]);
  const activityOwner = node("t1:n0", "Rule", "Apply the rule.", [0]);
  activityOwner.supportingMaterialIndices = [1];
  const topics = [topic([activityOwner])];

  normalizeActivityPlacements(topics, source);

  assert.deepEqual(activityOwner.supportingMaterialIndices, [1]);
  assertNoCoverageDuplicates(source, topics);
  console.log("  ✓ activity ownership normalization removes non-canonical activity placements only");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." },
    { blockType: "RULE", sourceText: "A predecessor number comes immediately before a natural number." },
    { blockType: "EXERCISE", sourceText: "Find the predecessor number." },
  ]);
  const topics = [topic([node(
    "t1:n0",
    "Natural number relationships",
    "Identify successor and predecessor numbers.",
    [0, 1],
    [2],
  )])];
  const repaired = applyBoundedAtomicityRepairs(topics, source, [{
    action: "SPLIT_MICRONODE",
    topicSequence: 1,
    microNodeId: "t1:n0",
    reason: "Two independently assessable relationships.",
    splitMicroNodes: [
      {
        title: "Successor number",
        learningObjective: "Identify successor number.",
        microNodeType: "knowledge",
        sourceBlockIndices: [0],
        exerciseBlockIndices: [],
      },
      {
        title: "Predecessor number",
        learningObjective: "Identify predecessor number.",
        microNodeType: "knowledge",
        sourceBlockIndices: [1],
        exerciseBlockIndices: [2],
      },
    ],
  }]);
  assert.equal(repaired.appliedCount, 1);
  assert.equal(topics[0].microNodes.length, 2);
  assert.deepEqual(topics[0].microNodes.map((item) => item.sourceBlockIndices), [[0], [1]]);
  assert.equal(validatePass2SourceAlignment(topics, source).valid, true);
  normalizeActivityPlacements(topics, source);
  assert.equal(validateSourceCoverage(source.length, topics).valid, true);
  const retry = applyBoundedAtomicityRepairs(topics, source, [{
    action: "SPLIT_MICRONODE",
    topicSequence: 1,
    microNodeId: "t1:n0",
    reason: "The same candidate must not receive another split pass.",
    splitMicroNodes: [],
  }]);
  assert.equal(retry.appliedCount, 0);
  assert.equal(topics[0].microNodes.length, 2, "retry must not duplicate repaired nodes");
  const unresolvedAfterRepair = getUnresolvedAtomicityFindings(topics, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Combined rule",
    microNodeId: "t1:n0",
    issue: "UNDER_SPLIT",
    confidence: "HIGH",
    reason: "Two independently assessable rules were initially combined.",
  }], repaired, validatePass2SourceAlignment(topics, source));
  assert.deepEqual(unresolvedAfterRepair, []);
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(source.length, topics),
    instructionalCoverage: validateInstructionalCoverage(source, topics),
    sourceAlignment: validatePass2SourceAlignment(topics, source),
    duplicateResolution: { candidatePairCount: 0, resolvedDistinctCount: 0, mergedCount: 0, unresolvedPairIds: [], rejectedDecisionCount: 0, actions: [] },
    diagnostics,
    unresolvedAtomicityFindings: unresolvedAfterRepair,
  }));
  console.log("  ✓ UNDER_SPLIT produces source-partitioned atomic MicroNodes without retry duplicates");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "Rule one explains the first atomic concept." },
    { blockType: "RULE", sourceText: "Rule two explains the second atomic concept." },
    { blockType: "RULE", sourceText: "Rule three explains the third atomic concept." },
    { blockType: "RULE", sourceText: "Rule four explains the fourth atomic concept." },
    { blockType: "RULE", sourceText: "Rule five explains the fifth atomic concept." },
    { blockType: "RULE", sourceText: "Rule six explains the sixth atomic concept." },
  ]);
  const topics = [topic([
    node("t1:n0", "Concept one", "Explain the first atomic concept.", [0]),
    node("t1:n1", "Concept two", "Explain the second atomic concept.", [1]),
    node("t1:n2", "Concept three", "Explain the third atomic concept.", [2]),
    node("t1:n3", "Concept four", "Explain the fourth atomic concept.", [3]),
    node("t1:n4", "Concept five", "Explain the fifth atomic concept.", [4]),
    node("t1:n5", "Concept six", "Explain the sixth atomic concept.", [5]),
  ])];
  assert.equal(topics[0].microNodes.length, 6);
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(source.length, topics),
    instructionalCoverage: validateInstructionalCoverage(source, topics),
    sourceAlignment: validatePass2SourceAlignment(topics, source),
    duplicateResolution: { candidatePairCount: 0, resolvedDistinctCount: 0, mergedCount: 0, unresolvedPairIds: [], rejectedDecisionCount: 0, actions: [] },
    diagnostics,
    unresolvedAtomicityFindings: [],
  }));
  console.log("  ✓ all six atomic nodes remain eligible for persistence");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A fraction names equal parts of one whole." },
    { blockType: "EXAMPLE", sourceText: "One half and one fourth are examples of fractions." },
    { blockType: "EXERCISE", sourceText: "Recognize the fraction in each picture." },
  ]);
  const topics = [topic([node(
    "t1:n0",
    "Fractions",
    "Recognize fractions as equal parts of a whole.",
    [0, 1],
    [2],
  )])];
  const repaired = applyBoundedAtomicityRepairs(topics, source, []);
  assert.equal(repaired.appliedCount, 0);
  assert.equal(topics[0].microNodes.length, 1);
  assert.equal(validatePass2SourceAlignment(topics, source).valid, true);
  console.log("  ✓ coherent multi-paragraph concept remains one MicroNode");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." },
    { blockType: "RULE", sourceText: "A predecessor number comes immediately before a natural number." },
    { blockType: "EXERCISE", sourceText: "Find the predecessor number." },
  ]);
  const topics = [topic([node(
    "t1:n0",
    "Natural number relationships",
    "Identify successor and predecessor numbers.",
    [0, 1],
    [2],
  )])];
  const repair = applyBoundedAtomicityRepairs(topics, source, [{
    action: "SPLIT_MICRONODE",
    topicSequence: 1,
    microNodeId: "t1:n0",
    reason: "Exercise demand has its own directly taught relationship.",
    splitMicroNodes: [
      {
        title: "Successor number",
        learningObjective: "Identify successor number.",
        microNodeType: "knowledge",
        sourceBlockIndices: [0],
        exerciseBlockIndices: [],
      },
      {
        title: "Predecessor number",
        learningObjective: "Identify predecessor number.",
        microNodeType: "knowledge",
        sourceBlockIndices: [1],
        exerciseBlockIndices: [2],
      },
    ],
  }]);
  assert.equal(topics[0].microNodes[1].exercises[0].blockIndex, 2);
  assert.equal(topics[0].additionalExercises.length, 0);
  assert.deepEqual(getUnresolvedAtomicityFindings(topics, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Natural number relationships",
    microNodeId: "t1:n0",
    exerciseBlockIndex: 2,
    issue: "MISSING_ATOMIC_MICRONODE",
    confidence: "HIGH",
    reason: "Exercise has a new source-supported owner.",
  }], repair, validatePass2SourceAlignment(topics, source)), []);
  console.log("  ✓ source-supported missing skill receives a primary exercise owner");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." },
    { blockType: "RULE", sourceText: "A picture may show a tree beside a road." },
  ]);
  const topics = [topic([node(
    "t1:n0",
    "Mixed claims",
    "Identify successor number and explain unrelated road distance.",
    [0, 1],
  )])];
  const repair = applyBoundedAtomicityRepairs(topics, source, [{
    action: "SPLIT_MICRONODE",
    topicSequence: 1,
    microNodeId: "t1:n0",
    reason: "Attempted unsupported split.",
    splitMicroNodes: [
      {
        title: "Successor number",
        learningObjective: "Identify successor number.",
        microNodeType: "knowledge",
        sourceBlockIndices: [0],
        exerciseBlockIndices: [],
      },
      {
        title: "Road distance",
        learningObjective: "Explain road distance rule.",
        microNodeType: "knowledge",
        sourceBlockIndices: [1],
        exerciseBlockIndices: [],
      },
    ],
  }]);
  assert.equal(repair.appliedCount, 0);
  assert.equal(repair.rejectedDecisionCount, 1);
  assert.equal(topics[0].microNodes.length, 1);
  assert.equal(validatePass2SourceAlignment(topics, source).valid, true);
  console.log("  ✓ source-misaligned atomic split is rejected before it can create an invented MicroNode");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." },
    { blockType: "EXERCISE", sourceText: "Find a successor and explain the natural-number sequence." },
  ]);
  const topics = [topic([
    node("t1:n0", "Successor", "Identify successor number.", [0], [1]),
    node("t1:n1", "Sequence explanation", "Explain natural-number sequence.", [0]),
  ])];
  const merged = consolidateHighConfidenceOverSplits(topics, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Sequence explanation",
    microNodeId: "t1:n1",
    mergeIntoMicroNodeTitle: "Successor",
    mergeIntoMicroNodeId: "t1:n0",
    issue: "OVER_SPLIT",
    confidence: "HIGH",
    reason: "Same objective.",
  }], { requireStableIds: true });
  assert.equal(merged.mergedMicroNodeCount, 1);
  applyBoundedAtomicityRepairs(topics, source, [{
    action: "MARK_INTEGRATIVE",
    topicSequence: 1,
    exerciseBlockIndex: 1,
    reason: "Genuinely combines two retained objectives.",
  }]);
  normalizeActivityPlacements(topics, source);
  assert.equal(topics[0].additionalExercises[0].blockIndex, 1);
  console.log("  ✓ over-split nodes merge and legitimate integrative exercise remains Additional");
}

{
  const outcomes = ["Apply successor and predecessor relationships."];
  const plan = buildAutomaticOutcomeAlignmentPlan(outcomes, [
    topic([
      node("t1:n0", "Successor", "Apply successor relationship.", [0]),
      node("t1:n1", "Predecessor", "Apply predecessor relationship.", [1]),
    ]),
  ]);
  assert.ok(plan.proposals.length >= 1);
  assert.equal(plan.unresolvedOutcomeIndexes.length, 0);
  console.log("  ✓ one Outcome may be supported by multiple atomic candidates without node-count enforcement");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "Rule one explains the first atomic concept." },
    { blockType: "RULE", sourceText: "Rule two explains the second atomic concept." },
    { blockType: "RULE", sourceText: "Rule three explains the third atomic concept." },
    { blockType: "RULE", sourceText: "Rule four explains the fourth atomic concept." },
    { blockType: "RULE", sourceText: "Rule five explains the fifth atomic concept." },
    { blockType: "RULE", sourceText: "Rule six combines two independently assessable concepts." },
  ]);
  const topics = [topic([
    node("t1:n0", "Concept one", "Explain the first atomic concept.", [0]),
    node("t1:n1", "Concept two", "Explain the second atomic concept.", [1]),
    node("t1:n2", "Concept three", "Explain the third atomic concept.", [2]),
    node("t1:n3", "Concept four", "Explain the fourth atomic concept.", [3]),
    node("t1:n4", "Concept five", "Explain the fifth atomic concept.", [4]),
    node("t1:n5", "Broad concept", "Explain the sixth concept and apply a separate seventh concept.", [5]),
  ])];
  const failedRepair = applyBoundedAtomicityRepairs(topics, source, [{
    action: "SPLIT_MICRONODE",
    topicSequence: 1,
    microNodeId: "t1:n5",
    reason: "The provider did not return a safe partition.",
    splitMicroNodes: [],
  }]);
  const unresolved = getUnresolvedAtomicityFindings(topics, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Broad concept",
    microNodeId: "t1:n5",
    issue: "UNDER_SPLIT",
    confidence: "HIGH",
    reason: "Independent objectives remain combined.",
  }], failedRepair, validatePass2SourceAlignment(topics, source));
  assert.equal(failedRepair.appliedCount, 0);
  assert.equal(failedRepair.rejectedDecisionCount, 1);
  assert.equal(topics[0].microNodes.length, 6, "the failed node must not discard its five valid siblings");
  assert.deepEqual(unresolved.map((finding) => finding.microNodeId), ["t1:n5"]);
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(source.length, topics),
    instructionalCoverage: validateInstructionalCoverage(source, topics),
    sourceAlignment: validatePass2SourceAlignment(topics, source),
    duplicateResolution: { candidatePairCount: 0, resolvedDistinctCount: 0, mergedCount: 0, unresolvedPairIds: [], rejectedDecisionCount: 0, actions: [] },
    diagnostics,
    unresolvedAtomicityFindings: unresolved,
  }));
  console.log("  ✓ six-node map preserves five atomic nodes and marks one failed repair for review");
}

{
  const source = blocks([{ blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." }]);
  const topics = [topic([node("t1:n0", "Successor", "Identify successor number.", [0])])];
  const result = assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(source.length, topics),
    instructionalCoverage: validateInstructionalCoverage(source, topics),
    sourceAlignment: validatePass2SourceAlignment(topics, source),
    duplicateResolution: { candidatePairCount: 0, resolvedDistinctCount: 0, mergedCount: 0, unresolvedPairIds: [], rejectedDecisionCount: 0, actions: [] },
    diagnostics,
    atomicityReviewUnavailableReason: "INVALID_RESPONSE",
  });
  assert.equal(result.disposition, "REVIEW_REQUIRED");
  assert.deepEqual(result.reviewReasons, ["ATOMICITY_REVIEW_UNAVAILABLE:INVALID_RESPONSE"]);
  console.log("  ✓ unavailable or malformed atomicity review becomes a persisted review requirement");
}

{
  let calls = 0;
  const complete = {
    status: "COMPLETE" as const,
    findings: [],
    sourceReallocations: [],
    atomicityRepairs: [],
    duplicateResolutions: [],
    malformedDuplicateResolutionEntries: [],
  };
  const retried = await runBoundedAtomicityVerification(async () => {
    calls++;
    return calls === 1
      ? { ...complete, status: "UNAVAILABLE" as const, unavailableReason: "REQUEST_FAILED" as const }
      : complete;
  }, 3);
  assert.equal(calls, 2, "technical verification receives exactly one retry");
  assert.equal(retried.verificationDiagnostics.retryAttempted, true);
  assert.equal(retried.verificationDiagnostics.retrySucceeded, true);
  assert.equal(retried.verificationDiagnostics.parseState, "SUCCEEDED");
  assert.equal(retried.verificationDiagnostics.generatedMicroNodeCount, 3);
  console.log("  ✓ technical atomicity retry reuses the existing candidate once");
}

{
  let calls = 0;
  const retried = await runBoundedAtomicityVerification(async () => {
    calls++;
    return {
      status: "UNAVAILABLE" as const,
      unavailableReason: "INVALID_RESPONSE" as const,
      findings: [],
      sourceReallocations: [],
      atomicityRepairs: [],
      duplicateResolutions: [],
      malformedDuplicateResolutionEntries: [],
    };
  }, 2);
  assert.equal(calls, 2, "retry exhaustion never loops");
  assert.equal(retried.verificationDiagnostics.retrySucceeded, false);
  assert.equal(retried.verificationDiagnostics.parseState, "INVALID_RESPONSE");
  console.log("  ✓ exhausted technical verification remains distinct from non-atomic content");
}

{
  const technical = finalizeAtomicityVerificationDiagnostics({
    verification: {
      generatedMicroNodeCount: 4,
      requestAttempted: true,
      responseReceived: true,
      parseState: "INVALID_RESPONSE",
      validationState: "NOT_RUN",
      repairAttempted: false,
      retryAttempted: true,
      retrySucceeded: false,
      attempts: [],
    },
    lessonId: 41,
    repairAttempted: false,
    unresolvedFindingCount: 0,
    technicalUnavailableReason: "INVALID_RESPONSE",
  });
  assert.equal(technical.validationState, "NOT_RUN");
  assert.equal(technical.finalFailureCode, "TECHNICAL_RETRY_EXHAUSTED");
  assert.equal(technical.persistenceEligible, true);
  assert.equal(technical.generatedMicroNodeCount, 4);

  const nonAtomic = finalizeAtomicityVerificationDiagnostics({
    verification: { ...technical, validationState: "NOT_RUN", finalFailureCode: undefined },
    repairAttempted: true,
    unresolvedFindingCount: 1,
  });
  assert.equal(nonAtomic.validationState, "FAILED_NON_ATOMIC");
  assert.equal(nonAtomic.finalFailureCode, "UNRESOLVED_NON_ATOMIC");
  console.log("  ✓ terminal diagnostics distinguish technical exhaustion from non-atomic content");
}

{
  const source = blocks([{ blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." }]);
  const topics = [topic([node("t1:n0", "Successor", "Identify successor number.", [0])])];
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(source.length, topics),
    instructionalCoverage: validateInstructionalCoverage(source, topics),
    sourceAlignment: validatePass2SourceAlignment(topics, source),
    duplicateResolution: { candidatePairCount: 0, resolvedDistinctCount: 0, mergedCount: 0, unresolvedPairIds: [], rejectedDecisionCount: 0, actions: [] },
    diagnostics,
    rejectedSemanticReviewDecisionCount: 1,
  }));
  console.log("  ✓ rejected repair metadata alone is not mislabeled as a technical outage");
}

{
  const source = blocks([{ blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." }]);
  const topics = [topic([node("t1:n0", "Successor", "Identify successor number.", [0])])];
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(source.length, topics),
    instructionalCoverage: validateInstructionalCoverage(source, topics),
    sourceAlignment: validatePass2SourceAlignment(topics, source),
    duplicateResolution: {
      candidatePairCount: 1,
      resolvedDistinctCount: 0,
      mergedCount: 0,
      unresolvedPairIds: [{ candidateAId: "t1:n0", candidateBId: "t1:n1" }],
      rejectedDecisionCount: 0,
      actions: [],
    },
    diagnostics,
  }));
  console.log("  ✓ unresolved duplicate candidates become a teacher-review disposition");
}

{
  const source = blocks([{ blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." }]);
  const topics = [topic([node("t1:n0", "Successor", "Identify successor number.", [0])])];
  const result = assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(source.length, topics),
    instructionalCoverage: validateInstructionalCoverage(source, topics),
    sourceAlignment: validatePass2SourceAlignment(topics, source),
    duplicateResolution: {
      candidatePairCount: 1,
      resolvedDistinctCount: 0,
      mergedCount: 0,
      unresolvedPairIds: [{ candidateAId: "t1:n0", candidateBId: "t1:n1" }],
      rejectedDecisionCount: 1,
      actions: [],
    },
    diagnostics,
  });
  assert.equal(result.disposition, "REVIEW_REQUIRED");
  assert.ok(result.reviewReasons.includes("DUPLICATE_REVIEW_REJECTED"));
  console.log("  ✓ malformed duplicate-review output becomes a persisted review requirement");
}

{
  const source = blocks([{ blockType: "OBJECTIVE", sourceText: "Natural-number relationships." }]);
  const topics = [topic([node(
    "t1:n0",
    "Natural-number sequence definition",
    "Explain why the natural-number sequence starts with one and has no end.",
    [0],
  )])];
  const alignment = validatePass2SourceAlignment(topics, source);
  assert.equal(alignment.valid, false, "Heading-only objective source remains non-sufficient");
  assert.doesNotThrow(() => assertPass2PersistenceGates({
    coverageValidation: validateSourceCoverage(source.length, topics),
    instructionalCoverage: validateInstructionalCoverage(source, topics),
    sourceAlignment: alignment,
    duplicateResolution: { candidatePairCount: 0, resolvedDistinctCount: 0, mergedCount: 0, unresolvedPairIds: [], rejectedDecisionCount: 0, actions: [] },
    diagnostics,
    unresolvedAtomicityFindings: [],
  }));
  console.log("  ✓ non-sufficient source alignment is a review disposition, not a destructive persistence failure");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." },
    { blockType: "EXERCISE", sourceText: "Find the successor number." },
  ]);
  const topics = [topic([node("t1:n0", "Successor", "Identify successor number.", [0])], [1])];
  const alignment = validatePass2SourceAlignment(topics, source);
  const missingFinding = {
    topicTitle: "Թեմա",
    microNodeTitle: "Successor",
    microNodeId: "t1:n0",
    exerciseBlockIndex: 1,
    issue: "MISSING_ATOMIC_MICRONODE" as const,
    confidence: "HIGH" as const,
    reason: "A source-supported owner is missing.",
  };
  const unresolved = getUnresolvedAtomicityFindings(topics, [missingFinding], {
    attempted: true,
    appliedCount: 1,
    rejectedDecisionCount: 0,
    splitCandidateIds: [],
    splitReplacementCandidateIds: {},
    primaryExerciseIndices: [],
    primaryExerciseOwnerCandidateIds: {},
    integrativeExerciseIndices: [1],
  }, alignment);
  assert.equal(unresolved.length, 1);
  console.log("  ✓ Additional placement cannot resolve a missing atomic MicroNode finding");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." },
    { blockType: "RULE", sourceText: "A predecessor number comes immediately before a natural number." },
  ]);
  const topics = [topic([
    node("t1:n0:split0", "Still broad", "Define successor number and identify predecessor number.", [0]),
    node("t1:n0:split1", "Predecessor", "Identify predecessor number.", [1]),
  ])];
  const unresolved = getUnresolvedAtomicityFindings(topics, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Broad",
    microNodeId: "t1:n0",
    issue: "UNDER_SPLIT",
    confidence: "MEDIUM",
    reason: "Still independently assessable.",
  }], {
    attempted: true,
    appliedCount: 1,
    rejectedDecisionCount: 0,
    splitCandidateIds: ["t1:n0"],
    splitReplacementCandidateIds: { "t1:n0": ["t1:n0:split0", "t1:n0:split1"] },
    primaryExerciseIndices: [],
    primaryExerciseOwnerCandidateIds: {},
    integrativeExerciseIndices: [],
  }, validatePass2SourceAlignment(topics, source));
  assert.equal(unresolved.length, 1);
  console.log("  ✓ a malformed split and MEDIUM finding remain review-required");
}

{
  const source = blocks([
    { blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." },
    { blockType: "RULE", sourceText: "A predecessor number comes immediately before a natural number." },
    { blockType: "EXERCISE", sourceText: "Find the predecessor number." },
  ]);
  const topics = [topic([
    node("t1:old", "Unrelated", "Explain a natural-number pattern.", [0], [2]),
    node("t1:n0", "Relationships", "Define successor and identify predecessor number.", [0, 1]),
  ])];
  const repair = applyBoundedAtomicityRepairs(topics, source, [{
    action: "SPLIT_MICRONODE",
    topicSequence: 1,
    microNodeId: "t1:n0",
    reason: "The predecessor exercise needs its direct atomic owner.",
    splitMicroNodes: [
      {
        title: "Successor",
        learningObjective: "Identify successor number.",
        microNodeType: "knowledge",
        sourceBlockIndices: [0],
        exerciseBlockIndices: [],
      },
      {
        title: "Predecessor",
        learningObjective: "Identify predecessor number.",
        microNodeType: "knowledge",
        sourceBlockIndices: [1],
        exerciseBlockIndices: [2],
      },
    ],
  }]);
  normalizeActivityPlacements(topics, source);
  assert.equal(topics[0].microNodes.find((item) => item.candidateId === "t1:old")?.exercises.length, 0);
  assert.equal(topics[0].microNodes.find((item) => item.candidateId === "t1:n0:split1")?.exercises[0]?.blockIndex, 2);
  assert.deepEqual(getUnresolvedAtomicityFindings(topics, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Relationships",
    microNodeId: "t1:n0",
    exerciseBlockIndex: 2,
    issue: "MISSING_ATOMIC_MICRONODE",
    confidence: "HIGH",
    reason: "Primary owner must be the replacement node.",
  }], repair, validatePass2SourceAlignment(topics, source)), []);
  console.log("  ✓ split repairs replace a competing old exercise owner canonically");
}

{
  const source = blocks([
    { blockType: "OBJECTIVE", sourceText: "Natural-number relationships." },
    { blockType: "RULE", sourceText: "A predecessor number comes immediately before a natural number." },
    { blockType: "RULE", sourceText: "A successor number comes immediately after a natural number." },
  ]);
  const topics = [topic([node(
    "t1:n0",
    "Relationships",
    "Identify predecessor number.",
    [0, 2],
  )])];
  const reallocation = applyBoundedSourceReallocation(topics, source, [{
    topicTitle: "Թեմա",
    microNodeTitle: "Relationships",
    topicSequence: 1,
    microNodeId: "t1:n0",
    action: "ADD_SUPPORTING_BLOCKS",
    sourceBlockIndices: [1],
    reason: "Direct predecessor rule.",
  }], { requireStableIds: true });
  assert.equal(reallocation.appliedCount, 1);
  const repair = applyBoundedAtomicityRepairs(topics, source, [{
    action: "SPLIT_MICRONODE",
    topicSequence: 1,
    microNodeId: "t1:n0",
    reason: "Partition the post-reallocation source ownership.",
    splitMicroNodes: [
      {
        title: "Successor",
        learningObjective: "Identify successor number.",
        microNodeType: "knowledge",
        sourceBlockIndices: [0, 2],
        exerciseBlockIndices: [],
      },
      {
        title: "Predecessor",
        learningObjective: "Identify predecessor number.",
        microNodeType: "knowledge",
        sourceBlockIndices: [1],
        exerciseBlockIndices: [],
      },
    ],
  }]);
  assert.equal(repair.appliedCount, 1);
  assert.deepEqual(topics[0].microNodes.map((item) => item.sourceBlockIndices), [[0, 2], [1]]);
  console.log("  ✓ combined source reallocation and split partition final ownership");
}

console.log("\nAtomicity and exercise-alignment review: 19/19 passing");