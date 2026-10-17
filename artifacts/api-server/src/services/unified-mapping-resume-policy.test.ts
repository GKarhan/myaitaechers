import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  decideUnifiedResume,
  type UnifiedResumeState,
} from "./unified-mapping-resume-policy.js";
const baseline = (): UnifiedResumeState => ({
  activeC1: "none",
  activeTeaching: "none",
  hasCanonicalNodes: false,
  c1SourceVerified: false,
  c2MissingCount: 0,
  teachingMissingCount: 0,
  hasTeacherEdits: false,
});
describe("unified map resume safety", () => {
  it("starts only when there is no canonical map", () =>
    assert.equal(decideUnifiedResume(baseline()).action, "START_C1"));
  it("waits on active jobs instead of double-submitting", () =>
    assert.equal(
      decideUnifiedResume({ ...baseline(), activeC1: "running" }).action,
      "WAIT",
    ));
  it("waits on active teaching work", () =>
    assert.equal(
      decideUnifiedResume({ ...baseline(), activeTeaching: "pending" }).action,
      "WAIT",
    ));
  it("does not overwrite partially mapped coverage failures", () =>
    assert.equal(
      decideUnifiedResume({
        ...baseline(),
        activeC1: "coverage_failed",
        hasCanonicalNodes: true,
      }).action,
      "REVIEW",
    ));
  it("requires source verification for resume", () =>
    assert.equal(
      decideUnifiedResume({
        ...baseline(),
        hasCanonicalNodes: true,
        c2MissingCount: 2,
      }).action,
      "REVIEW",
    ));
  it("resumes missing C2 from verified canonical map", () =>
    assert.equal(
      decideUnifiedResume({
        ...baseline(),
        hasCanonicalNodes: true,
        c1SourceVerified: true,
        c2MissingCount: 1,
      }).action,
      "START_C2",
    ));
  it("resumes teaching after C2", () =>
    assert.equal(
      decideUnifiedResume({
        ...baseline(),
        hasCanonicalNodes: true,
        c1SourceVerified: true,
        teachingMissingCount: 2,
      }).action,
      "START_TEACHING",
    ));
  it("requires explicit review if teacher edits would be touched", () =>
    assert.equal(
      decideUnifiedResume({
        ...baseline(),
        hasCanonicalNodes: true,
        c1SourceVerified: true,
        hasTeacherEdits: true,
        c2MissingCount: 1,
      }).action,
      "REVIEW",
    ));
  it("checks quality instead of regenerating completed stages", () =>
    assert.equal(
      decideUnifiedResume({
        ...baseline(),
        hasCanonicalNodes: true,
        c1SourceVerified: true,
      }).action,
      "QUALITY_CHECK",
    ));
});

describe("persisted recovery boundaries", () => {
  it("waits for an active C2 worker after navigation", () =>
    assert.equal(
      decideUnifiedResume({
        ...baseline(),
        activeC2: "running",
        hasCanonicalNodes: true,
        c1SourceVerified: true,
        c2MissingCount: 2,
      }).action,
      "WAIT",
    ));
  it("does not steal an old active claim", () =>
    assert.deepEqual(
      decideUnifiedResume({
        ...baseline(),
        activeC1: "running",
        staleActiveJob: true,
      }),
      { action: "REVIEW", reason: "STALE_JOB_REQUIRES_REVIEW" },
    ));
  it("does not regenerate a present but malformed C2 path", () =>
    assert.deepEqual(
      decideUnifiedResume({
        ...baseline(),
        hasCanonicalNodes: true,
        c1SourceVerified: true,
        invalidC2Count: 1,
      }),
      { action: "REVIEW", reason: "EXISTING_C2_PATH_INVALID" },
    ));
  it("checks a teacher-edited complete map without regenerating it", () =>
    assert.equal(
      decideUnifiedResume({
        ...baseline(),
        hasCanonicalNodes: true,
        c1SourceVerified: true,
        hasTeacherEdits: true,
      }).action,
      "QUALITY_CHECK",
    ));
  it("resumes missing C2 after a terminal C2 failure only on verified unedited content", () =>
    assert.equal(
      decideUnifiedResume({
        ...baseline(),
        activeC2: "failed",
        hasCanonicalNodes: true,
        c1SourceVerified: true,
        c2MissingCount: 1,
      }).action,
      "START_C2",
    ));
});

it("allows C1 retry only after explicit fenced retirement", () => {
  assert.equal(
    decideUnifiedResume({
      ...baseline(),
      activeC1: "failed",
      c1RetryConfirmed: true,
    }).action,
    "START_C1",
  );
  assert.equal(
    decideUnifiedResume({ ...baseline(), activeC1: "failed" }).action,
    "REVIEW",
  );
});
