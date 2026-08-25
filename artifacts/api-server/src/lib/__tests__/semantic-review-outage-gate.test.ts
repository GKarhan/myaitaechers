import assert from "node:assert/strict";
import {
  assertSemanticReviewAvailabilityBeforePersistence,
  getSemanticReviewPrePersistenceDiagnostics,
  MappingSemanticReviewUnavailablePrePersistenceError,
  M3_SEMANTIC_REVIEW_UNAVAILABLE_PRE_PERSISTENCE,
  type KnowledgeCandidatePromotionDiagnostics,
} from "../../services/lesson-mapping.js";

type GateInput = Parameters<typeof assertSemanticReviewAvailabilityBeforePersistence>[0];
type Promotion = GateInput["candidatePromotion"];

function promotion(input: {
  states: KnowledgeCandidatePromotionDiagnostics["decisions"][number]["state"][];
  validCandidateIds?: string[];
  missingCandidateIds?: string[];
  invalidCandidateIds?: string[];
  providedByReview?: boolean;
}): Promotion {
  const candidateIds = input.states.map((_, index) => `t1:n${index}`);
  const validCandidateIds = input.validCandidateIds ?? [];
  const missingCandidateIds = input.missingCandidateIds ?? [];
  const invalidCandidateIds = input.invalidCandidateIds ?? [];
  return {
    candidateCount: candidateIds.length,
    promotedMicroNodeCount: input.states.filter((state) => state === "PROMOTE").length,
    semanticDecisionDiagnostics: {
      providedByReview: input.providedByReview ?? true,
      decisionCount: candidateIds.length,
      missingCandidateIds,
      invalidCandidateIds,
      decisions: candidateIds.map((candidateId) => ({
        candidateId,
        decision: missingCandidateIds.includes(candidateId) ? "MISSING" : "KEEP_ATOMIC",
        valid: validCandidateIds.includes(candidateId),
        reasonCode: missingCandidateIds.includes(candidateId)
          ? "MISSING_DECISION"
          : invalidCandidateIds.includes(candidateId)
            ? "INVALID_DECISION"
            : "VALID",
      })),
    },
    decisions: input.states.map((state, index) => ({
      candidateId: candidateIds[index],
      topicSequence: 1,
      state,
      reasonCodes: [],
    })),
  };
}

{
  const priorCanonicalMap = {
    topics: [{ id: 11, title: "Նախորդ թեմա" }],
    nodes: [{ id: 22, title: "Նախորդ MicroNode" }],
    exercises: [{ id: 33, title: "Նախորդ վարժություն" }],
    metadata: { version: "previous-map" },
  };
  const beforeGate = structuredClone(priorCanonicalMap);
  const input: GateInput = {
    candidatePromotion: promotion({
      states: ["REVIEW_REQUIRED", "UNRESOLVED"],
      missingCandidateIds: ["t1:n0", "t1:n1"],
    }),
    atomicityReviewUnavailableReason: "REQUEST_FAILED",
    canonicalMicroNodeCount: 0,
  };

  assert.throws(
    () => {
      assertSemanticReviewAvailabilityBeforePersistence(input);
      // A replacement caller would only mutate after this assertion succeeds.
      priorCanonicalMap.topics = [];
      priorCanonicalMap.nodes = [];
      priorCanonicalMap.exercises = [];
      priorCanonicalMap.metadata = { version: "replacement-map" };
    },
    (error: unknown) => {
      assert.ok(error instanceof MappingSemanticReviewUnavailablePrePersistenceError);
      assert.deepEqual(error.diagnostics, {
        candidateCount: 2,
        viableCandidateCount: 2,
        validSemanticDecisionCount: 0,
        missingSemanticDecisionCount: 2,
        invalidSemanticDecisionCount: 0,
        semanticReviewAvailability: "UNAVAILABLE",
        atomicityReviewAvailability: "UNAVAILABLE",
        atomicityReviewUnavailableReason: "REQUEST_FAILED",
        promotedMicroNodeCount: 0,
        canonicalMicroNodeCount: 0,
        technicalReason: M3_SEMANTIC_REVIEW_UNAVAILABLE_PRE_PERSISTENCE,
        existingMappingPreserved: true,
      });
      return true;
    },
  );
  assert.deepEqual(priorCanonicalMap, beforeGate);
  console.log("  ✓ technical M3-2 outage blocks zero-node replacement and preserves the prior canonical map");
}

{
  const input: GateInput = {
    candidatePromotion: promotion({
      states: ["REJECT_NON_KNOWLEDGE"],
      missingCandidateIds: ["t1:n0"],
    }),
    atomicityReviewUnavailableReason: "SCHEMA_INVALID",
    canonicalMicroNodeCount: 0,
  };
  assert.doesNotThrow(() => assertSemanticReviewAvailabilityBeforePersistence(input));
  console.log("  ✓ a legitimate structural-only zero-node result is not mislabeled as an outage");
}

{
  const input: GateInput = {
    candidatePromotion: promotion({
      states: ["REVIEW_REQUIRED"],
      validCandidateIds: ["t1:n0"],
    }),
    canonicalMicroNodeCount: 0,
  };
  const diagnostics = getSemanticReviewPrePersistenceDiagnostics(input);
  assert.equal(diagnostics.semanticReviewAvailability, "AVAILABLE");
  assert.equal(diagnostics.validSemanticDecisionCount, 1);
  assert.doesNotThrow(() => assertSemanticReviewAvailabilityBeforePersistence(input));
  console.log("  ✓ a valid semantic review rejection remains fail-closed without blocking review persistence");
}

{
  const input: GateInput = {
    candidatePromotion: promotion({
      states: ["PROMOTE", "REVIEW_REQUIRED"],
      validCandidateIds: ["t1:n0"],
      missingCandidateIds: ["t1:n1"],
    }),
    atomicityReviewUnavailableReason: "EMPTY_RESPONSE",
    canonicalMicroNodeCount: 1,
  };
  assert.doesNotThrow(() => assertSemanticReviewAvailabilityBeforePersistence(input));
  console.log("  ✓ partial canonical success is not blocked by an unrelated review outage");
}

{
  const diagnostics = getSemanticReviewPrePersistenceDiagnostics({
    candidatePromotion: promotion({
      states: ["REVIEW_REQUIRED"],
      missingCandidateIds: ["t1:n0"],
    }),
    atomicityReviewUnavailableReason: "SCHEMA_INVALID",
    canonicalMicroNodeCount: 0,
  });
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /sourceText|rawProviderResponse|textbook sentence/i);
  assert.equal(diagnostics.existingMappingPreserved, true);
  console.log("  ✓ outage diagnostics are machine-readable and source-safe");
}

console.log("\nSemantic review outage gate: 5/5 passing");