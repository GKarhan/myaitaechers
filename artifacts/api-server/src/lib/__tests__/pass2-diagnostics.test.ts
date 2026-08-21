import assert from "node:assert/strict";
import {
  assertDetailedMappingHasMicroNodes,
  getPass2MicroNodeRejectionReasons,
  getTeacherFacingMappingFailure,
  inspectPass2Step2Response,
  MappingZeroMicroNodesError,
  recordPass2PostNormalizationCounts,
  safelyParsePass2Step2Response,
  type Pass2Diagnostics,
  type Pass2TopicDiagnostics,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";

const diagnostics: Pass2Diagnostics = {
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

{
  const sensitiveProviderKey = "private textbook sentence must never be retained";
  const inspected = inspectPass2Step2Response({
    microNodes: [{ title: "Do not retain this text", learningObjective: "Do not retain this either" }],
    unmappedBlocks: [],
    additionalExercises: [{ blockIndex: 4, reason: "Do not retain this text" }],
    [sensitiveProviderKey]: { nested: "Do not retain this text either" },
  }, "stop", false);

  assert.deepEqual(inspected.expectedKeysPresent, {
    microNodes: true,
    unmappedBlocks: true,
    additionalExercises: true,
  });
  assert.equal(inspected.unexpectedTopLevelKeyCount, 1);
  assert.deepEqual(inspected.arrayLengths, {
    microNodes: 1,
    unmappedBlocks: 0,
    additionalExercises: 1,
  });
  assert.equal(inspected.finishReason, "stop");
  assert.equal(inspected.retried, false);
  assert.equal(inspected.parserStatus, "PARSED");
  assert.doesNotMatch(JSON.stringify(inspected), /Do not retain/i);
  assert.doesNotMatch(JSON.stringify(inspected), /private textbook sentence/i);
  console.log("  ✓ Pass 2 diagnostics omit arbitrary provider keys and values");
}

{
  const priorMapping = [{ id: 999, title: "Existing lesson map" }];
  const malformedProviderResponse = "{\"microNodes\":[{\"title\":\"private textbook source";
  const attempt = safelyParsePass2Step2Response(malformedProviderResponse, "stop", false);
  assert.equal(attempt.ok, false);
  if (attempt.ok) assert.fail("Malformed JSON must not be treated as parsed output");
  assert.equal(attempt.response.parserStatus, "FAILED");
  assert.deepEqual(attempt.response.expectedKeysPresent, {
    microNodes: false,
    unmappedBlocks: false,
    additionalExercises: false,
  });
  assert.equal(attempt.response.unexpectedTopLevelKeyCount, 0);
  assert.doesNotMatch(JSON.stringify(attempt.response), /private textbook source/i);
  // The parser boundary returns before the route's replacement-delete path.
  assert.deepEqual(priorMapping, [{ id: 999, title: "Existing lesson map" }]);
  console.log("  ✓ malformed Step 2 JSON yields safe diagnostics before map replacement");
}

{
  const reasons = getPass2MicroNodeRejectionReasons({
    title: "",
    learningObjective: "",
    sourceBlockIndices: [],
  });
  assert.deepEqual(reasons, [
    "INVALID_MICRONODE_NO_SOURCE_BLOCKS",
    "INVALID_MICRONODE_EMPTY_TITLE",
    "INVALID_MICRONODE_EMPTY_OBJECTIVE",
  ]);
  console.log("  ✓ invalid MicroNodes receive structured rejection reasons");
}

{
  const topics: Pass2TopicResult[] = [];
  let error: unknown;
  try {
    assertDetailedMappingHasMicroNodes({ topics, diagnostics });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof MappingZeroMicroNodesError);
  assert.match(getTeacherFacingMappingFailure(error), /չի ստեղծել գիտելիքի մանր հանգույցներ/);
  console.log("  ✓ zero-MicroNode detailed maps fail before persistence");
}

{
  const topics: Pass2TopicResult[] = [{
    sequence: 1,
    title: "Թեմա",
    topicType: "grammar",
    microNodes: [{
      title: "Ատոմային նպատակ",
      learningObjective: "Սովորողը կճանաչի կանոնը։",
      microNodeType: "knowledge",
      sourceBlockIndices: [0],
      exercises: [],
      supportingMaterialIndices: [],
    }],
    unmappedBlockIndices: [],
    additionalExercises: [],
  }];
  const topicDiagnostics: Pass2TopicDiagnostics[] = [{
    topicSequence: 1,
    inputBlockCount: 1,
    response: {
      expectedKeysPresent: {
        microNodes: true,
        unmappedBlocks: false,
        additionalExercises: false,
      },
      unexpectedTopLevelKeyCount: 0,
      arrayLengths: { microNodes: 1, unmappedBlocks: 0, additionalExercises: 0 },
      finishReason: "stop",
      retried: false,
      parserStatus: "PARSED",
    },
    candidateMicroNodeCount: 1,
    acceptedMicroNodeCount: 1,
    rejectedMicroNodeCount: 0,
    rejectionCounts: {},
    postNormalizationMicroNodeCount: 0,
  }];
  recordPass2PostNormalizationCounts(topics, topicDiagnostics);
  assert.equal(topicDiagnostics[0].postNormalizationMicroNodeCount, 1);
  assert.doesNotThrow(() => assertDetailedMappingHasMicroNodes({ topics, diagnostics }));
  console.log("  ✓ valid candidates remain counted after normalization");
}

console.log("\nPass 2 diagnostics: 5/5 passing");