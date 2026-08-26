import assert from "node:assert/strict";
import { classifyMappingAssignmentReadiness } from "../lesson-mapping-readiness.js";

assert.equal(
  classifyMappingAssignmentReadiness({
    sourceScopeVerified: true,
    sourceSetVerified: true,
    structuralCoverageValid: true,
    microNodeCount: 3,
    reviewFindingCount: 4,
  }),
  "CONFIRMATION_REQUIRED",
  "A technically completed map with four safe review findings must remain completed but require confirmation",
);

assert.equal(
  classifyMappingAssignmentReadiness({
    sourceScopeVerified: false,
    sourceSetVerified: true,
    structuralCoverageValid: true,
    microNodeCount: 3,
    reviewFindingCount: 4,
  }),
  "BLOCKED",
  "Unverified source scope must remain non-overridable",
);

assert.equal(
  classifyMappingAssignmentReadiness({
    sourceScopeVerified: true,
    sourceSetVerified: true,
    structuralCoverageValid: true,
    microNodeCount: 3,
    reviewFindingCount: 0,
  }),
  "READY",
  "A safe map without findings must be directly ready",
);

console.log("lesson-mapping-readiness: 3 passed, 0 failed");