import assert from "node:assert/strict";
import {
  decideKnowledgeCandidatePromotion,
  SOURCE_MATERIAL_DISPOSITIONS,
  validateVerifiedSourcePrimaryDispositions,
  type KnowledgeCandidate,
  type KnowledgeCandidateAssessment,
  type Pass1Block,
  type SourceMaterialDispositionRecord,
} from "../../services/lesson-mapping.js";

let passed = 0;

function test(name: string, check: () => void): void {
  check();
  passed++;
  console.log(`  ✓ ${name}`);
}

const defaultAssessment: KnowledgeCandidateAssessment = {
  meaningfulKnowledgeIdentity: "PASS",
  independentlyTeachable: "PASS",
  independentlyAssessable: "PASS",
  atomicity: "ATOMIC",
  nonDuplication: "UNIQUE",
  sourceOwnership: "VALID",
  supportingOnly: false,
};

function source(
  sourceText: string,
  blockType: Pass1Block["blockType"] = "RULE",
): Pass1Block {
  return {
    blockType,
    sourceText,
    sourcePage: 11,
    sourceParagraph: null,
    sourceBoundingBox: null,
  };
}

type CandidateOverrides =
  & Omit<Partial<KnowledgeCandidate>, "assessment">
  & { assessment?: Partial<KnowledgeCandidateAssessment> };

function candidate(
  overrides: CandidateOverrides = {},
): KnowledgeCandidate {
  return {
    candidateId: "topic-1-candidate-1",
    provisionalTopic: { sequence: 1, title: "Կոտորակներ", topicType: "grammar" },
    title: "Կոտորակի նշանը",
    learningObjective: "Բացատրում է կոտորակի նշանի որոշումը համարիչի և հայտարարի նշաններով։",
    coreSourceBlockIndices: [0],
    supportingSourceBlockIndices: [],
    practiceReferences: [],
    semanticStatus: "UNASSESSED",
    sourceSupport: "UNASSESSED",
    reviewReasonCodes: [],
    ...overrides,
    assessment: { ...defaultAssessment, ...overrides.assessment },
  };
}

function decision(
  current: KnowledgeCandidate,
  blocks: ReadonlyArray<Pass1Block>,
) {
  return decideKnowledgeCandidatePromotion(current, blocks);
}

test("A. clean definition/rule promotes", () => {
  const result = decision(candidate(), [
    source("Կոտորակի նշանը որոշվում է համարիչի և հայտարարի նշաններով։"),
  ]);
  assert.equal(result.state, "PROMOTE");
  assert.equal(result.sourceSupport, "DIRECT");
  assert.equal(result.checks.directReadableSource, "PASS");
});

test("B. definition, explanation, and example remain one candidate", () => {
  const blocks = [
    source("Կոտորակի նշանը որոշվում է համարիչի և հայտարարի նշաններով։", "DEFINITION"),
    source("Եթե համարիչն ու հայտարարն ունեն նույն նշանը, կոտորակը դրական է։"),
    source("Օրինակ՝ նույն նշանների դեպքում ստացվում է դրական կոտորակ։", "EXAMPLE"),
  ];
  const result = decision(candidate({
    coreSourceBlockIndices: [0, 1],
    supportingSourceBlockIndices: [2],
  }), blocks);
  assert.equal(result.state, "PROMOTE");
  assert.deepEqual(result.coreSourceBlockIndices, [0, 1]);
  assert.deepEqual(candidate({
    coreSourceBlockIndices: [0, 1],
    supportingSourceBlockIndices: [2],
  }).supportingSourceBlockIndices, [2]);
  const dispositions: SourceMaterialDispositionRecord[] = [
    { blockIndex: 0, disposition: "CORE_EVIDENCE", isPrimary: true, reasonCodes: ["DIRECT_INSTRUCTIONAL_SUPPORT"], candidateId: "topic-1-candidate-1" },
    { blockIndex: 1, disposition: "CORE_EVIDENCE", isPrimary: true, reasonCodes: ["DIRECT_INSTRUCTIONAL_SUPPORT"], candidateId: "topic-1-candidate-1" },
    { blockIndex: 2, disposition: "SUPPORTING_MATERIAL", isPrimary: true, reasonCodes: ["SUPPORTS_EXISTING_KNOWLEDGE"], candidateId: "topic-1-candidate-1" },
  ];
  assert.equal(validateVerifiedSourcePrimaryDispositions(blocks, dispositions).valid, true);
});

test("C. a NOTE that directly states a new rule may promote", () => {
  const result = decision(candidate({
    title: "Կոտորակի նշանի կանոնը",
    learningObjective: "Բացատրում է կոտորակի նշանի կանոնը համարիչի և հայտարարի նշաններով։",
  }), [
    source("Նշում. կոտորակի նշանի կանոնը որոշվում է համարիչի և հայտարարի նշաններով։", "NOTE"),
  ]);
  assert.equal(result.state, "PROMOTE");
});

test("D. a NOTE that only clarifies existing knowledge is support-only", () => {
  const result = decision(candidate({
    coreSourceBlockIndices: [0],
    supportingSourceBlockIndices: [],
    assessment: { supportingOnly: true },
  }), [
    source("Այս նշումը միայն պարզաբանում է արդեն ներկայացված կոտորակի նշանի կանոնը։", "NOTE"),
  ]);
  assert.equal(result.state, "SUPPORT_ONLY");
  assert.equal(result.sourceSupport, "SUPPORTING_ONLY");
  assert.ok(result.reasonCodes.includes("SUPPORTING_ONLY"));
});

test("E. unreadable formula/diagram material is unresolved", () => {
  const result = decision(candidate(), [
    source("?ա?ա?ա?ա?ա?ա?ա", "IMAGE"),
  ]);
  assert.equal(result.state, "UNRESOLVED");
  assert.equal(result.sourceSupport, "UNREADABLE");
  assert.ok(result.reasonCodes.includes("UNREADABLE_CORE_SOURCE"));
});

test("F. provisional Topic difference does not force distinct knowledge", () => {
  const first = candidate({
    candidateId: "topic-1-candidate-1",
    provisionalTopic: { sequence: 1, title: "Կոտորակի նշան", topicType: "grammar" },
  });
  const second = candidate({
    candidateId: "topic-2-candidate-1",
    provisionalTopic: { sequence: 2, title: "Նշանների կանոն", topicType: "grammar" },
  });
  assert.equal(decision(first, [source("Կոտորակի նշանը որոշվում է համարիչի և հայտարարի նշաններով։")]).state, "PROMOTE");
  assert.equal(decision(second, [source("Կոտորակի նշանը որոշվում է համարիչի և հայտարարի նշաններով։")]).state, "PROMOTE");
  assert.equal(first.learningObjective, second.learningObjective);
});

test("G. similar wording can still represent distinct assessable knowledge", () => {
  const sign = candidate({
    candidateId: "topic-1-candidate-1",
    title: "Կոտորակի նշան",
    learningObjective: "Բացատրում է կոտորակի դրական կամ բացասական նշանը։",
  });
  const domain = candidate({
    candidateId: "topic-1-candidate-2",
    title: "Թույլատրելի արժեքներ",
    learningObjective: "Որոշում է կոտորակային արտահայտության թույլատրելի արժեքները։",
  });
  assert.equal(decision(sign, [source("Կոտորակի նշանը որոշվում է համարիչի և հայտարարի նշաններով։")]).state, "PROMOTE");
  assert.equal(decision(domain, [source("Թույլատրելի արժեքները որոշվում են հայտարարի զրո չլինելու պայմանով։")]).state, "PROMOTE");
});

test("H. one paragraph can support two separately assessed atomic candidates", () => {
  const shared = source("Կոտորակի նշանը որոշվում է համարիչի նշանով, իսկ հայտարարի նշանը որոշում է վերջնական արդյունքը։");
  const numerator = candidate({
    candidateId: "topic-1-candidate-1",
    title: "Համարիչի նշան",
    learningObjective: "Բացատրում է համարիչի նշանի դերը կոտորակի նշանում։",
  });
  const denominator = candidate({
    candidateId: "topic-1-candidate-2",
    title: "Հայտարարի նշան",
    learningObjective: "Բացատրում է հայտարարի նշանի դերը կոտորակի նշանում։",
  });
  assert.equal(decision(numerator, [shared]).state, "PROMOTE");
  assert.equal(decision(denominator, [shared]).state, "PROMOTE");
});

test("I. Remember/Understand/Apply practice remains one knowledge candidate", () => {
  const oneCandidate = candidate({
    practiceReferences: [
      { blockIndex: 1, sourceParagraph: null, kind: "EXERCISE" },
      { blockIndex: 2, sourceParagraph: null, kind: "EXERCISE" },
      { blockIndex: 3, sourceParagraph: null, kind: "ACTIVITY_OR_HOMEWORK" },
    ],
  });
  const result = decision(oneCandidate, [
    source("Կոտորակի նշանը որոշվում է համարիչի և հայտարարի նշաններով."),
    source("Գտնել կոտորակի նշանը։", "EXERCISE"),
    source("Բացատրել կոտորակի նշանը։", "EXERCISE"),
    source("Կիրառել կանոնը նոր օրինակում։", "HOMEWORK"),
  ]);
  assert.equal(result.state, "PROMOTE");
  assert.equal("cognitiveLevel" in oneCandidate, false);
});

test("J. an exercise using several concepts does not create a candidate", () => {
  const exerciseAttached = decision(candidate({
    practiceReferences: [{ blockIndex: 1, sourceParagraph: null, kind: "EXERCISE" }],
  }), [
    source("Կոտորակի նշանը որոշվում է համարիչի և հայտարարի նշաններով։"),
    source("Համեմատել մի քանի կոտորակների նշանները։", "EXERCISE"),
  ]);
  assert.equal(exerciseAttached.state, "PROMOTE");

  const exerciseOnly = decision(candidate({
    coreSourceBlockIndices: [],
    practiceReferences: [{ blockIndex: 0, sourceParagraph: null, kind: "EXERCISE" }],
  }), [source("Լուծել վարժությունը։", "EXERCISE")]);
  assert.equal(exerciseOnly.state, "REJECT_NON_KNOWLEDGE");
  assert.ok(exerciseOnly.reasonCodes.includes("EXERCISE_CANNOT_CREATE_CANDIDATE"));
});

test("K. supporting-only material is preserved without automatic promotion", () => {
  const result = decision(candidate({
    coreSourceBlockIndices: [],
    supportingSourceBlockIndices: [0],
    assessment: { supportingOnly: true },
  }), [source("Օրինակն օգնում է հասկանալ արդեն ներկայացված կանոնը։", "EXAMPLE")]);
  assert.equal(result.state, "SUPPORT_ONLY");
  assert.deepEqual(result.coreSourceBlockIndices, []);
});

test("L. uncertain duplicate or atomicity decisions require review", () => {
  const result = decision(candidate({
    semanticStatus: "DUPLICATE_CANDIDATE",
    assessment: {
      atomicity: "UNCERTAIN",
    },
  }), [
    source("Կոտորակի նշանը որոշվում է համարիչի և հայտարարի նշաններով։"),
  ]);
  assert.equal(result.state, "REVIEW_REQUIRED");
  assert.ok(result.reasonCodes.includes("ATOMICITY_UNCERTAIN"));
  assert.ok(result.reasonCodes.includes("DUPLICATE_UNCERTAIN"));
});

test("source coverage requires exactly one primary disposition per verified block", () => {
  const blocks = [
    source("Առաջին կանոնը բացատրում է հասկացությունը։"),
    source("Երկրորդ կանոնը բացատրում է հասկացությունը։"),
  ];
  const valid: SourceMaterialDispositionRecord[] = [
    { blockIndex: 0, disposition: "CORE_EVIDENCE", isPrimary: true, reasonCodes: ["DIRECT_INSTRUCTIONAL_SUPPORT"] },
    { blockIndex: 1, disposition: "STRUCTURAL_MATERIAL", isPrimary: true, reasonCodes: ["STRUCTURAL_ONLY"] },
  ];
  assert.equal(validateVerifiedSourcePrimaryDispositions(blocks, valid).valid, true);

  const missing = validateVerifiedSourcePrimaryDispositions(blocks, [valid[0]]);
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.missingBlockIndices, [1]);

  const duplicate = validateVerifiedSourcePrimaryDispositions(blocks, [
    ...valid,
    { blockIndex: 0, disposition: "SUPPORTING_MATERIAL", isPrimary: true, reasonCodes: ["SUPPORTS_EXISTING_KNOWLEDGE"] },
  ]);
  assert.equal(duplicate.valid, false);
  assert.deepEqual(duplicate.duplicatePrimaryBlockIndices, [0]);

  const secondaryOnly = validateVerifiedSourcePrimaryDispositions(blocks, [
    { blockIndex: 0, disposition: "SUPPORTING_MATERIAL", isPrimary: false, reasonCodes: ["SUPPORTS_EXISTING_KNOWLEDGE"] },
    valid[1],
  ]);
  assert.equal(secondaryOnly.valid, false);
  assert.deepEqual(secondaryOnly.nonPrimaryOnlyBlockIndices, [0]);

  const invalid = validateVerifiedSourcePrimaryDispositions(blocks, [
    ...valid,
    { blockIndex: 9, disposition: "CORE_EVIDENCE", isPrimary: true, reasonCodes: ["DIRECT_INSTRUCTIONAL_SUPPORT"] },
  ]);
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.invalidBlockIndices, [2]);

  assert.equal(SOURCE_MATERIAL_DISPOSITIONS.length, 8);
});

console.log(`\nKnowledge Candidate contract: ${passed}/13 passed`);