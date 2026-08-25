import assert from "node:assert/strict";
import {
  applyKnowledgeCandidatePromotion,
  getM32ValidatedSplitRepairs,
  getM32ValidatedSplitRepairCandidateIds,
  type DuplicateResolutionAudit,
  type KnowledgeCandidate,
  type M32SemanticDecision,
  type Pass1Block,
  type Pass2TopicResult,
  validateM32SemanticDecision,
  validatePass2SourceAlignment,
} from "../../services/lesson-mapping.js";

const emptyDuplicateAudit: DuplicateResolutionAudit = {
  candidatePairCount: 0,
  resolvedDistinctCount: 0,
  mergedCount: 0,
  unresolvedPairIds: [],
  rejectedPairIds: [],
  rejectedDecisionCount: 0,
  actions: [],
};

function block(type: Pass1Block["blockType"], sourceText: string): Pass1Block {
  return {
    blockType: type,
    sourceText,
    sourcePage: 1,
    sourceParagraph: null,
    sourceBoundingBox: null,
  };
}

const blocks = [
  block("RULE", "Ժամանակի մակբայը ցույց է տալիս գործողության ժամանակը։"),
  block("RULE", "Չափի և քանակի մակբայները նկարագրում են չափն ու քանակը։"),
  block("EXERCISE", "Գտիր մակբայները և բացատրի՛ր դրանց դերը։"),
];

function node(
  candidateId: string,
  learningObjective: string,
  sourceBlockIndices: number[] = [0],
  exerciseIndices: number[] = [2],
): Pass2TopicResult["microNodes"][number] {
  return {
    candidateId,
    title: learningObjective,
    learningObjective,
    microNodeType: "knowledge",
    sourceBlockIndices,
    supportingMaterialIndices: [],
    exercises: exerciseIndices.map((blockIndex) => ({ blockIndex, sourceParagraph: null })),
  };
}

function topics(nodes: Pass2TopicResult["microNodes"]): Pass2TopicResult[] {
  return [{
    sequence: 1,
    title: "Մակբայ",
    topicType: "grammar",
    inputBlockIndices: [0, 1, 2],
    microNodes: nodes,
    unmappedBlockIndices: [],
    additionalExercises: [],
  }];
}

function decision(
  candidateId: string,
  kind: M32SemanticDecision["decision"],
  overrides: Partial<M32SemanticDecision> = {},
): M32SemanticDecision {
  return {
    candidateId,
    decision: kind,
    reason: "ստուգված իմաստային որոշում",
    evidenceSourceIndices: [candidateId === "t1:n1" ? 1 : 0],
    exerciseReferences: candidateId === "t1:n1" ? [] : [2],
    confidence: "HIGH",
    ...overrides,
  };
}

function promote(
  candidates: Pass2TopicResult["microNodes"],
  decisions: M32SemanticDecision[],
  options: {
    unresolvedAtomicityFindings?: Parameters<typeof applyKnowledgeCandidatePromotion>[0]["unresolvedAtomicityFindings"];
    unavailable?: "EMPTY_RESPONSE" | "INVALID_JSON" | "SCHEMA_INVALID" | "REQUEST_FAILED";
  } = {},
) {
  const value = topics(candidates);
  const result = applyKnowledgeCandidatePromotion({
    topics: value,
    blocks,
    sourceAlignment: validatePass2SourceAlignment(value, blocks),
    unresolvedAtomicityFindings: options.unresolvedAtomicityFindings ?? [],
    duplicateResolution: emptyDuplicateAudit,
    semanticDecisions: decisions,
    semanticDecisionsProvided: true,
    ...(options.unavailable ? { atomicityReviewUnavailableReason: options.unavailable } : {}),
  });
  return { result, topics: value };
}

function validationCandidate(): Pick<KnowledgeCandidate,
  "candidateId" | "coreSourceBlockIndices" | "supportingSourceBlockIndices" | "practiceReferences"> {
  return {
    candidateId: "t1:n0",
    coreSourceBlockIndices: [0, 1],
    supportingSourceBlockIndices: [],
    practiceReferences: [{ blockIndex: 2, sourceParagraph: null, kind: "EXERCISE" }],
  };
}

const tests: Array<[string, () => void]> = [];
function it(name: string, test: () => void): void { tests.push([name, test]); }

it("M3-2-01 one concept and action promotes with KEEP_ATOMIC", () => {
  const { result } = promote([node("t1:n0", "Բացատրել ժամանակի մակբայը")], [decision("t1:n0", "KEEP_ATOMIC")]);
  assert.equal(result.promotedMicroNodeCount, 1);
});

it("M3-2-02 two cognitive actions do not force a split", () => {
  const { result } = promote([node("t1:n0", "Ճանաչել և բացատրել ժամանակի մակբայները")], [decision("t1:n0", "KEEP_ATOMIC")]);
  assert.equal(result.decisions[0].state, "PROMOTE");
});

it("M3-2-03 connector in noun phrase is not terminal atomicity evidence", () => {
  const { result } = promote([node("t1:n0", "Բացատրել չափի և քանակի մակբայները", [1], [])], [
    decision("t1:n0", "KEEP_ATOMIC", { evidenceSourceIndices: [1], exerciseReferences: [] }),
  ]);
  assert.equal(result.decisions[0].state, "PROMOTE");
});

it("M3-2-04 Armenian noun ending -ի is not terminal verb evidence", () => {
  const { result } = promote([node("t1:n0", "Բացատրել չափի և քանակի մակբայների տեսակները", [1], [])], [
    decision("t1:n0", "KEEP_ATOMIC", { evidenceSourceIndices: [1], exerciseReferences: [] }),
  ]);
  assert.equal(result.decisions[0].reasonCodes.includes("ATOMICITY_UNCERTAIN"), false);
});

it("M3-2-05 recognition and explanation of same knowledge is a variation", () => {
  const { result, topics: resultTopics } = promote([
    node("t1:n0", "Ժամանակի մակբայ"),
    node("t1:n1", "Ճանաչել ժամանակի մակբայների օրինակները", [1], []),
  ], [
    decision("t1:n0", "KEEP_ATOMIC"),
    decision("t1:n1", "COGNITIVE_PATH_VARIATION", { targetCandidateId: "t1:n0" }),
  ]);
  assert.equal(result.promotedMicroNodeCount, 1);
  assert.equal(resultTopics[0].microNodes[0].candidateId, "t1:n0");
});

it("M3-2-06 example generation is a variation/support relation", () => {
  const { result } = promote([
    node("t1:n0", "Ժամանակի մակբայ"),
    node("t1:n1", "Բերել ժամանակի մակբայների օրինակներ", [1], []),
  ], [
    decision("t1:n0", "KEEP_ATOMIC"),
    decision("t1:n1", "MERGE_OR_SUPPORT_EXISTING", { targetCandidateId: "t1:n0" }),
  ]);
  assert.equal(result.reviewCandidates[0].promotion.state, "SUPPORT_ONLY");
});

it("M3-2-07 split with exact disjoint direct sources can validate", () => {
  const valid = validateM32SemanticDecision({
    candidate: validationCandidate(),
    knownCandidateIds: new Set(["t1:n0"]),
    splitWasApplied: true,
    decision: decision("t1:n0", "SPLIT_REQUIRED", {
      evidenceSourceIndices: [0],
      exerciseReferences: [2],
      independentSuccessCriteria: ["սահմանում է առաջինը", "բացատրում է երկրորդը"],
      proposedChildren: [
        { title: "Առաջին", learningObjective: "Բացատրել առաջին կանոնը", sourceBlockIndices: [0], independentSuccessCriterion: "սահմանում է առաջինը" },
        { title: "Երկրորդ", learningObjective: "Բացատրել երկրորդ կանոնը", sourceBlockIndices: [1], independentSuccessCriterion: "բացատրում է երկրորդը" },
      ],
    }),
  });
  assert.equal(valid.valid, true);
});

it("M3-2-08 overlapping split sources fail closed", () => {
  const splitDecision = decision("t1:n0", "SPLIT_REQUIRED", {
    evidenceSourceIndices: [0], exerciseReferences: [2], independentSuccessCriteria: ["a", "b"],
    proposedChildren: [
      { title: "A", learningObjective: "A", sourceBlockIndices: [0, 1], independentSuccessCriterion: "a" },
      { title: "B", learningObjective: "B", sourceBlockIndices: [1], independentSuccessCriterion: "b" },
    ],
  });
  const outcome = validateM32SemanticDecision({
    candidate: validationCandidate(), knownCandidateIds: new Set(["t1:n0"]), splitWasApplied: true,
    decision: splitDecision,
  });
  assert.equal(outcome.reasonCode, "SPLIT_NOT_VALIDATED");
  assert.equal(getM32ValidatedSplitRepairCandidateIds({
    topics: topics([node("t1:n0", "Ընդհանուր", [0, 1])]),
    semanticDecisions: [splitDecision],
    atomicityRepairs: [{
      action: "SPLIT_MICRONODE", topicSequence: 1, microNodeId: "t1:n0", reason: "ստուգում",
      splitMicroNodes: [
        { title: "A", learningObjective: "A", microNodeType: "knowledge", sourceBlockIndices: [0, 1], exerciseBlockIndices: [] },
        { title: "B", learningObjective: "B", microNodeType: "knowledge", sourceBlockIndices: [1], exerciseBlockIndices: [] },
      ],
    }],
  }).size, 0);
});

it("M3-2-09 source-less split child fails closed", () => {
  const outcome = validateM32SemanticDecision({
    candidate: validationCandidate(), knownCandidateIds: new Set(["t1:n0"]), splitWasApplied: true,
    decision: decision("t1:n0", "SPLIT_REQUIRED", {
      evidenceSourceIndices: [0], exerciseReferences: [2], independentSuccessCriteria: ["a", "b"],
      proposedChildren: [
        { title: "A", learningObjective: "A", sourceBlockIndices: [0, 1], independentSuccessCriterion: "a" },
        { title: "B", learningObjective: "B", sourceBlockIndices: [], independentSuccessCriterion: "b" },
      ],
    }),
  });
  assert.equal(outcome.valid, false);
});

it("M3-2-10 split without independent criteria fails closed", () => {
  const splitDecision = decision("t1:n0", "SPLIT_REQUIRED", {
    evidenceSourceIndices: [0], exerciseReferences: [2],
    proposedChildren: [
      { title: "A", learningObjective: "A", sourceBlockIndices: [0], independentSuccessCriterion: "a" },
      { title: "B", learningObjective: "B", sourceBlockIndices: [1], independentSuccessCriterion: "b" },
    ],
  });
  const outcome = validateM32SemanticDecision({
    candidate: validationCandidate(), knownCandidateIds: new Set(["t1:n0"]), splitWasApplied: true,
    decision: splitDecision,
  });
  assert.equal(outcome.valid, false);
  assert.equal(getM32ValidatedSplitRepairCandidateIds({
    topics: topics([node("t1:n0", "Ընդհանուր", [0, 1])]),
    semanticDecisions: [splitDecision],
    atomicityRepairs: [{
      action: "SPLIT_MICRONODE", topicSequence: 1, microNodeId: "t1:n0", reason: "ստուգում",
      splitMicroNodes: [
        { title: "A", learningObjective: "A", microNodeType: "knowledge", sourceBlockIndices: [0], exerciseBlockIndices: [] },
        { title: "B", learningObjective: "B", microNodeType: "knowledge", sourceBlockIndices: [1], exerciseBlockIndices: [] },
      ],
    }],
  }).size, 0);
  const mismatchedCriteria = decision("t1:n0", "SPLIT_REQUIRED", {
    evidenceSourceIndices: [0], exerciseReferences: [2], independentSuccessCriteria: ["unrelated a", "unrelated b"],
    proposedChildren: [
      { title: "A", learningObjective: "A", sourceBlockIndices: [0], independentSuccessCriterion: "child a" },
      { title: "B", learningObjective: "B", sourceBlockIndices: [1], independentSuccessCriterion: "child b" },
    ],
  });
  assert.equal(validateM32SemanticDecision({
    candidate: validationCandidate(), knownCandidateIds: new Set(["t1:n0"]), splitWasApplied: true,
    decision: mismatchedCriteria,
  }).valid, false);
  const matchingDecision = decision("t1:n0", "SPLIT_REQUIRED", {
    evidenceSourceIndices: [0], exerciseReferences: [2], independentSuccessCriteria: ["child a", "child b"],
    proposedChildren: [
      { title: "A", learningObjective: "A", sourceBlockIndices: [0], independentSuccessCriterion: "child a" },
      { title: "B", learningObjective: "B", sourceBlockIndices: [1], independentSuccessCriterion: "child b" },
    ],
  });
  const invalidFirstRepair = {
    action: "SPLIT_MICRONODE" as const, topicSequence: 1, microNodeId: "t1:n0", reason: "ստուգում",
    splitMicroNodes: [
      { title: "Wrong", learningObjective: "Wrong", microNodeType: "knowledge" as const, sourceBlockIndices: [0], exerciseBlockIndices: [] },
      { title: "B", learningObjective: "B", microNodeType: "knowledge" as const, sourceBlockIndices: [1], exerciseBlockIndices: [] },
    ],
  };
  const validSecondRepair = {
    action: "SPLIT_MICRONODE" as const, topicSequence: 1, microNodeId: "t1:n0", reason: "ստուգում",
    splitMicroNodes: [
      { title: "A", learningObjective: "A", microNodeType: "knowledge" as const, sourceBlockIndices: [0], exerciseBlockIndices: [] },
      { title: "B", learningObjective: "B", microNodeType: "knowledge" as const, sourceBlockIndices: [1], exerciseBlockIndices: [] },
    ],
  };
  const validatedEntries = getM32ValidatedSplitRepairs({
    topics: topics([node("t1:n0", "Ընդհանուր", [0, 1])]),
    semanticDecisions: [matchingDecision],
    atomicityRepairs: [invalidFirstRepair, validSecondRepair],
  });
  assert.equal(validatedEntries.has(invalidFirstRepair), false);
  assert.equal(validatedEntries.has(validSecondRepair), true);
});

it("M3-2-11 unique merge/support target preserves source-safe artifact", () => {
  const { result } = promote([
    node("t1:n0", "Ժամանակի մակբայ"),
    node("t1:n1", "Ժամանակի մակբայի օրինակ", [1], []),
  ], [decision("t1:n0", "KEEP_ATOMIC"), decision("t1:n1", "MERGE_OR_SUPPORT_EXISTING", { targetCandidateId: "t1:n0" })]);
  assert.equal(result.reviewCandidates[0].semanticDecision?.targetCandidateId, "t1:n0");
  assert.deepEqual(result.reviewCandidates[0].coreSourceBlockIndices, [1]);
});

it("M3-2-12 unresolved merge target is review required", () => {
  const { result } = promote([node("t1:n0", "Ժամանակի մակբայ")], [
    decision("t1:n0", "MERGE_OR_SUPPORT_EXISTING", { targetCandidateId: "missing" }),
  ]);
  assert.equal(result.reviewCandidates[0].promotion.state, "REVIEW_REQUIRED");
});

it("M3-2-13 cognitive variation creates no extra canonical target", () => {
  const { topics: resultTopics } = promote([
    node("t1:n0", "Ժամանակի մակբայ"),
    node("t1:n1", "Ճանաչել ժամանակի մակբայ", [1], []),
  ], [decision("t1:n0", "KEEP_ATOMIC"), decision("t1:n1", "COGNITIVE_PATH_VARIATION", { targetCandidateId: "t1:n0" })]);
  assert.equal(resultTopics[0].microNodes.length, 1);
});

it("M3-2-14 missing provider decision fails closed", () => {
  const { result } = promote([node("t1:n0", "Ժամանակի մակբայ")], []);
  assert.deepEqual(result.semanticDecisionDiagnostics.missingCandidateIds, ["t1:n0"]);
  assert.equal(result.reviewCandidates[0].promotion.state, "REVIEW_REQUIRED");
});

it("M3-2-15 unavailable provider preserves a review artifact", () => {
  const { result } = promote([node("t1:n0", "Ժամանակի մակբայ")], [], { unavailable: "REQUEST_FAILED" });
  assert.equal(result.reviewCandidateSummary.providerAtomicityReview, "UNAVAILABLE");
  assert.equal(result.reviewCandidates.length, 1);
  assert.deepEqual(result.semanticDecisionDiagnostics.missingCandidateIds, ["t1:n0"]);
});

it("M3-2-16 clean existing atomic candidate remains promotable", () => {
  const { result } = promote([node("t1:n0", "Ժամանակի մակբայ")], [decision("t1:n0", "KEEP_ATOMIC")]);
  assert.equal(result.promotedMicroNodeCount, 1);
});

it("M3-2-17 unresolved genuine under-split remains fail closed", () => {
  const { result } = promote([node("t1:n0", "Ժամանակի մակբայ")], [decision("t1:n0", "KEEP_ATOMIC")], {
    unresolvedAtomicityFindings: [{ topicTitle: "Մակբայ", microNodeTitle: "Ժամանակի մակբայ", microNodeId: "t1:n0", issue: "UNDER_SPLIT", confidence: "HIGH", reason: "անկախ նպատակներ" }],
  });
  assert.equal(result.reviewCandidates[0].promotion.state, "REVIEW_REQUIRED");
});

it("M3-2-18 exercise ownership remains with KEEP_ATOMIC candidate", () => {
  const { topics: resultTopics } = promote([node("t1:n0", "Ժամանակի մակբայ")], [decision("t1:n0", "KEEP_ATOMIC")]);
  assert.equal(resultTopics[0].microNodes[0].exercises[0].blockIndex, 2);
});

it("M3-2-19 source coverage placement remains exact once", () => {
  const { topics: resultTopics } = promote([node("t1:n0", "Ժամանակի մակբայ")], [decision("t1:n0", "KEEP_ATOMIC")]);
  assert.deepEqual(resultTopics[0].microNodes[0].sourceBlockIndices, [0]);
  assert.equal(resultTopics[0].unmappedBlockIndices.includes(0), false);
});

it("M3-2-20 review artifact is complete and source-safe", () => {
  const { result } = promote([node("t1:n0", "Ժամանակի մակբայ")], []);
  const artifact = result.reviewCandidates[0];
  assert.equal(artifact.candidateId, "t1:n0");
  assert.deepEqual(artifact.coreSourceBlockIndices, [0]);
  assert.deepEqual(artifact.practiceReferences.map((reference) => reference.blockIndex), [2]);
  assert.equal(artifact.semanticDecision, undefined);
});

it("M3-2-21 diagnostics do not retain raw provider responses", () => {
  const { result } = promote([node("t1:n0", "Ժամանակի մակբայ")], [decision("t1:n0", "REVIEW_REQUIRED")]);
  assert.equal(JSON.stringify(result).includes("rawProviderResponse"), false);
  assert.equal(JSON.stringify(result).includes(blocks[0].sourceText), false);
});

it("M3-2-22 promotion boundary is provider-free", () => {
  const { result } = promote([node("t1:n0", "Ժամանակի մակբայ")], [decision("t1:n0", "KEEP_ATOMIC")]);
  assert.equal(result.semanticDecisionDiagnostics.providedByReview, true);
});

it("M3-2-23 mapping decision carries no Cognitive Path payload", () => {
  const { result } = promote([node("t1:n0", "Ժամանակի մակբայ")], [decision("t1:n0", "KEEP_ATOMIC")]);
  assert.equal("cognitivePath" in result, false);
});

it("M3-2-24 discovery count is retained even when one variation is non-canonical", () => {
  const { result } = promote([
    node("t1:n0", "Ժամանակի մակբայ"),
    node("t1:n1", "Ճանաչել ժամանակի մակբայ", [1], []),
  ], [decision("t1:n0", "KEEP_ATOMIC"), decision("t1:n1", "COGNITIVE_PATH_VARIATION", { targetCandidateId: "t1:n0" })]);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.promotedMicroNodeCount, 1);
});

let passed = 0;
for (const [name, test] of tests) {
  try {
    test();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}
console.log(`\nM3-2 semantic decision contract: ${passed}/24 passed`);