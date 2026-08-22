import assert from "node:assert/strict";
import {
  bindTextBlocksToPhysicalPages,
  filterVerifiedTextBlocks,
  validateBlocksAgainstLessonSourceSet,
  buildLessonSourceSet,
} from "../lesson-source-set.js";
import {
  assertPass2PersistenceGates,
  MappingInstructionalCoverageError,
} from "../../services/lesson-mapping.js";
import {
  validateInstructionalCoverage,
  validateSourceCoverage,
} from "../coverage-validator.js";

type TestBlock = {
  blockType: "RULE" | "EXERCISE";
  sourceText: string;
  sourcePage: number;
};

function createVerifiedCase(count: number, pageNumber = 14): {
  page: { pageNumber: number; text: string };
  blocks: TestBlock[];
} {
  const blocks = Array.from({ length: count }, (_, index) => ({
    blockType: "RULE" as const,
    sourceText: `Ստուգելի աղբյուրային կանոն ${index + 1}։`,
    sourcePage: pageNumber,
  }));
  return {
    page: {
      pageNumber,
      text: blocks.map((block) => block.sourceText).join("\n"),
    },
    blocks,
  };
}

function topicOwningAllBlocks(blocks: ReadonlyArray<TestBlock>) {
  return [{
    microNodes: [{
      title: "Ստուգելի կանոններ",
      sourceBlockIndices: blocks.map((_, index) => index),
      exercises: [],
      supportingMaterialIndices: [],
    }],
    unmappedBlockIndices: [],
    additionalExercises: [],
  }];
}

const safeSourceAlignment = {
  valid: true,
  sufficientCount: 1,
  partialCount: 0,
  insufficientCount: 0,
  unreadableCount: 0,
  nodes: [],
};
const safeDuplicateResolution = {
  candidatePairCount: 0,
  resolvedDistinctCount: 0,
  mergedCount: 0,
  unresolvedPairIds: [],
  rejectedDecisionCount: 0,
  actions: [],
};
const emptyDiagnostics = {
  detectedGroupCount: 0,
  groupsAfterTheoryMergeCount: 0,
  topics: [],
  totals: {
    candidateMicroNodes: 0,
    acceptedBeforeNormalization: 0,
    acceptedAfterNormalization: 0,
    rejectedMicroNodes: 0,
  },
};

// §19 — all verified candidates preserve the successful-path source universe.
{
  const { page, blocks } = createVerifiedCase(35);
  const bound = bindTextBlocksToPhysicalPages([page], blocks);
  const verified = filterVerifiedTextBlocks(bound.blocks);
  assert.equal(bound.audit.providerBlockCount, 35);
  assert.equal(bound.audit.verifiedBlockCount, 35);
  assert.equal(bound.audit.quarantinedBlockCount, 0);
  assert.equal(verified.length, 35);
  console.log("  ✓ all-verified candidates retain all 35 Pass 2 inputs");
}

// §20 + §22 + §28 — only server-contained blocks continue; quarantine is safe.
{
  const { page, blocks } = createVerifiedCase(33);
  const sensitiveMarker = "RAW_PROVIDER_SECRET_DO_NOT_PERSIST";
  const providerBlocks = [
    ...blocks.slice(0, 3),
    { blockType: "RULE" as const, sourceText: sensitiveMarker, sourcePage: 14 },
    ...blocks.slice(3, 16),
    { blockType: "RULE" as const, sourceText: "Կեղծված երկրորդ աղբյուր", sourcePage: 14 },
    ...blocks.slice(16),
  ];
  const bound = bindTextBlocksToPhysicalPages([page], providerBlocks);
  const verified = filterVerifiedTextBlocks(bound.blocks);

  assert.equal(bound.audit.providerBlockCount, 35);
  assert.equal(bound.audit.verifiedBlockCount, 33);
  assert.equal(bound.audit.quarantinedBlockCount, 2);
  assert.equal(bound.audit.quarantineReasonCounts.SOURCE_TEXT_NOT_CONTAINED, 2);
  assert.deepEqual(bound.audit.quarantinedBlockIndices, [3, 17]);
  assert.equal(verified.length, 33);
  assert.equal(JSON.stringify(bound.audit).includes(sensitiveMarker), false);
  assert.equal(verified.some((block) => block.sourceText === sensitiveMarker), false);
  console.log("  ✓ partial verification sends exactly 33 blocks onward and persists no raw quarantine text");
}

// §21 — zero verified blocks reaches no canonical Pass 1 source subset.
{
  const page = { pageNumber: 14, text: "Միայն սերվերի աղբյուրային տեքստ։" };
  const bound = bindTextBlocksToPhysicalPages([page], [
    { blockType: "RULE" as const, sourceText: "Չստուգված թեկնածու 1", sourcePage: 14 },
    { blockType: "RULE" as const, sourceText: "Չստուգված թեկնածու 2", sourcePage: 14 },
  ]);
  const verified = filterVerifiedTextBlocks(bound.blocks);
  assert.equal(verified.length, 0);
  assert.equal(bound.audit.quarantinedBlockCount, 2);
  console.log("  ✓ zero verified candidates leave no source subset for the route's pre-Pass-2 hard fail");
}

// §23 — a fabricated provider-only exercise cannot become a canonical exercise.
{
  const page = { pageNumber: 14, text: "Վարժություն 1. Հաշվիր 2 + 2։" };
  const bound = bindTextBlocksToPhysicalPages([page], [
    { blockType: "EXERCISE", sourceText: "Վարժություն 1. Հաշվիր 2 + 2։", sourcePage: 14 },
    { blockType: "EXERCISE", sourceText: "Չստուգված կեղծ վարժություն", sourcePage: 14 },
  ]);
  const verified = filterVerifiedTextBlocks(bound.blocks);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].blockType, "EXERCISE");
  assert.equal(verified.some((block) => block.sourceText.includes("կեղծ")), false);
  console.log("  ✓ an unverified exercise candidate is excluded while a verified exercise remains usable");
}

// §24 + §27 — existing persistence gates reject unresolved verified-source
// coverage before the route's destructive replacement boundary.
{
  const { page, blocks } = createVerifiedCase(2);
  const verified = filterVerifiedTextBlocks(bindTextBlocksToPhysicalPages([page], blocks).blocks);
  const topics = [{
    microNodes: [{
      title: "Միայն առաջին կանոնը",
      sourceBlockIndices: [0],
      exercises: [],
      supportingMaterialIndices: [],
    }],
    unmappedBlockIndices: [1],
    additionalExercises: [],
  }];
  const coverageValidation = validateSourceCoverage(verified.length, topics);
  const instructionalCoverage = validateInstructionalCoverage(verified, topics);
  assert.equal(coverageValidation.valid, true);
  assert.equal(instructionalCoverage.valid, false);
  assert.throws(
    () => assertPass2PersistenceGates({
      coverageValidation,
      instructionalCoverage,
      sourceAlignment: safeSourceAlignment as any,
      duplicateResolution: safeDuplicateResolution as any,
      diagnostics: emptyDiagnostics as any,
    }),
    MappingInstructionalCoverageError,
  );
  console.log("  ✓ incomplete verified-source coverage blocks persistence, preserving the old mapping");
}

// §25 — a complete verified subset may pass the existing coverage gates.
{
  const { page, blocks } = createVerifiedCase(2);
  const verified = filterVerifiedTextBlocks(bindTextBlocksToPhysicalPages([page], blocks).blocks);
  const topics = topicOwningAllBlocks(verified);
  assert.equal(validateSourceCoverage(verified.length, topics).valid, true);
  assert.equal(validateInstructionalCoverage(verified, topics).valid, true);
  console.log("  ✓ complete verified-source ownership remains eligible for normal mapping");
}

// §26 — a MicroNode cannot refer to an excluded block because Pass 2 only sees
// the reindexed verified subset; any out-of-range reference still fails coverage.
{
  const { page, blocks } = createVerifiedCase(1);
  const verified = filterVerifiedTextBlocks(bindTextBlocksToPhysicalPages([page], blocks).blocks);
  const invalidTopics = [{
    microNodes: [{
      title: "Չստուգված հղում",
      sourceBlockIndices: [1],
      exercises: [],
      supportingMaterialIndices: [],
    }],
    unmappedBlockIndices: [],
    additionalExercises: [],
  }];
  const coverage = validateSourceCoverage(verified.length, invalidTopics);
  assert.deepEqual(coverage.invalidIndices, [1]);
  assert.equal(coverage.valid, false);
  console.log("  ✓ excluded-source references are invalid against the verified Pass 2 input");
}

// The normal source-scope validator still rejects fabricated text if it is ever
// passed directly, independently of the verified-subset partition.
{
  const page = { pageNumber: 14, text: "Բնական թվերի շարքը։" };
  const sourceSet = buildLessonSourceSet({
    resourceId: 19,
    resourceFileUrl: "/uploads/math5.pdf",
    pagesFrom: 14,
    pagesTo: 14,
    lessonTitle: "Բնական թվերի շարքը",
    extractedPages: [page],
  });
  const scope = validateBlocksAgainstLessonSourceSet(sourceSet, [page], [{
    sourcePage: 14,
    sourceText: "Չգոյություն ունեցող աղբյուր",
  }]);
  assert.equal(scope.valid, false);
  console.log("  ✓ deterministic containment remains strict for direct source-scope validation");
}

console.log("Verified source subset continuation: provider-free checks passing");