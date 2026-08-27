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
  "CONFIRMATION_REQUIRED",
  "Source verification findings remain visible but do not make a usable lesson impossible to assign",
);

assert.equal(
  classifyMappingAssignmentReadiness({
    sourceScopeVerified: true,
    sourceSetVerified: true,
    structuralCoverageValid: false,
    microNodeCount: 5,
    reviewFindingCount: 5,
  }),
  "CONFIRMATION_REQUIRED",
  "Readable unowned source blocks must require confirmation rather than block assignment",
);

assert.equal(
  classifyMappingAssignmentReadiness({
    sourceScopeVerified: true,
    sourceSetVerified: true,
    structuralCoverageValid: false,
    microNodeCount: 0,
    reviewFindingCount: 5,
  }),
  "BLOCKED",
  "A lesson with no MicroNodes remains structurally impossible to assign",
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

console.log("lesson-mapping-readiness: 5 passed, 0 failed");