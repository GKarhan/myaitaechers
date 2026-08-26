import assert from "node:assert/strict";
import {
  assertCompletedRetestAttempt,
  parseRetestStrategy,
  selectCanonicalRetestNodes,
  RetestAuthorityError,
  type RetestScopedNode,
} from "../quiz-retest-authority.js";

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function nodes(...scopedNodes: RetestScopedNode[]): RetestScopedNode[] {
  return scopedNodes;
}

test("T1 — PARTIAL_AND_NOT_KNOWN returns partial and not-known in scope order", () => {
  const result = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    scopedNodes: nodes(
      { nodeId: 11, canonicalState: "PARTIAL" },
      { nodeId: 12, canonicalState: "NOT_KNOWN" },
      { nodeId: 13, canonicalState: "MASTERED" },
    ),
  });

  assert.deepEqual(result.eligibleNodes, [
    { nodeId: 11, canonicalState: "PARTIAL" },
    { nodeId: 12, canonicalState: "NOT_KNOWN" },
  ]);
  assert.deepEqual(result.counts, { partial: 1, notKnown: 1, eligible: 2 });
});

test("T2 — NOT_KNOWN_ONLY excludes partial nodes", () => {
  const result = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "NOT_KNOWN_ONLY",
    scopedNodes: nodes(
      { nodeId: 11, canonicalState: "PARTIAL" },
      { nodeId: 12, canonicalState: "NOT_KNOWN" },
    ),
  });

  assert.deepEqual(result.eligibleNodes, [
    { nodeId: 12, canonicalState: "NOT_KNOWN" },
  ]);
  assert.deepEqual(result.counts, { partial: 1, notKnown: 1, eligible: 1 });
});

test("T3 — NOT_STUDIED is excluded from both strategies", () => {
  for (const strategy of ["PARTIAL_AND_NOT_KNOWN", "NOT_KNOWN_ONLY"] as const) {
    const result = selectCanonicalRetestNodes({
      attemptId: 100,
      strategy,
      scopedNodes: nodes({ nodeId: 13, canonicalState: "NOT_STUDIED" }),
    });
    assert.deepEqual(result.eligibleNodes, []);
    assert.deepEqual(result.counts, { partial: 0, notKnown: 0, eligible: 0 });
  }
});

test("T4 — duplicate questions for one node return one node", () => {
  const result = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    scopedNodes: nodes(
      { nodeId: 11, canonicalState: "PARTIAL" },
      { nodeId: 11, canonicalState: "PARTIAL" },
      { nodeId: 12, canonicalState: "NOT_KNOWN" },
    ),
  });

  assert.deepEqual(result.eligibleNodes.map((node) => node.nodeId), [11, 12]);
  assert.deepEqual(result.counts, { partial: 1, notKnown: 1, eligible: 2 });
});

test("T5 — null node IDs are ignored safely", () => {
  const result = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    scopedNodes: nodes(
      { nodeId: 11, canonicalState: "PARTIAL" },
      { nodeId: null, canonicalState: "NOT_KNOWN" },
    ),
  });

  assert.deepEqual(result.eligibleNodes.map((node) => node.nodeId), [11]);
});

test("T6 — incomplete attempts are rejected with a bounded domain error", () => {
  assert.throws(
    () => assertCompletedRetestAttempt(
      { attemptId: 100, learnerId: 7, completedAt: null },
      7,
    ),
    (error: unknown) =>
      error instanceof RetestAuthorityError &&
      error.code === "RETEST_ATTEMPT_INCOMPLETE",
  );
});

test("T7 — another learner's attempt is rejected", () => {
  assert.throws(
    () => assertCompletedRetestAttempt(
      { attemptId: 100, learnerId: 8, completedAt: new Date(0) },
      7,
    ),
    (error: unknown) =>
      error instanceof RetestAuthorityError &&
      error.code === "RETEST_ATTEMPT_NOT_OWNED",
  );
});

test("T8 — canonical C5 wins over materialized knowledge_nodes state", () => {
  const divergentNode = {
    nodeId: 11,
    canonicalState: "PARTIAL" as const,
    materializedState: "MASTERED",
  };
  const result = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    scopedNodes: nodes(divergentNode),
  });

  assert.deepEqual(result.eligibleNodes, [
    { nodeId: 11, canonicalState: "PARTIAL" },
  ]);
});

test("T9 — canonical C5 wins over results-page fallback state", () => {
  const divergentNode = {
    nodeId: 11,
    canonicalState: "NOT_KNOWN" as const,
    resultPageState: "MASTERED",
  };
  const result = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "NOT_KNOWN_ONLY",
    scopedNodes: nodes(divergentNode),
  });

  assert.deepEqual(result.eligibleNodes, [
    { nodeId: 11, canonicalState: "NOT_KNOWN" },
  ]);
});

test("T10 — no eligible nodes is a successful empty result", () => {
  const result = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    scopedNodes: nodes({ nodeId: 13, canonicalState: "MASTERED" }),
  });

  assert.equal(result.attemptId, 100);
  assert.deepEqual(result.eligibleNodes, []);
  assert.deepEqual(result.counts, { partial: 0, notKnown: 0, eligible: 0 });
});

test("T11 — current C5 state is used when later evidence changes it", () => {
  const before = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    scopedNodes: nodes({ nodeId: 11, canonicalState: "PARTIAL" }),
  });
  const after = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    scopedNodes: nodes({ nodeId: 11, canonicalState: "MASTERED" }),
  });

  assert.deepEqual(before.eligibleNodes, [
    { nodeId: 11, canonicalState: "PARTIAL" },
  ]);
  assert.deepEqual(after.eligibleNodes, []);
});

test("T12 — unresolved canonical state fails closed", () => {
  const result = selectCanonicalRetestNodes({
    attemptId: 100,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    scopedNodes: nodes(
      { nodeId: 11, canonicalState: null },
      { nodeId: 12, canonicalState: "NOT_KNOWN" },
    ),
  });

  assert.deepEqual(result.eligibleNodes, [
    { nodeId: 12, canonicalState: "NOT_KNOWN" },
  ]);
  assert.deepEqual(result.counts, { partial: 0, notKnown: 1, eligible: 1 });
});

test("strategy parser rejects free-form values", () => {
  assert.equal(parseRetestStrategy("PARTIAL_AND_NOT_KNOWN"), "PARTIAL_AND_NOT_KNOWN");
  assert.equal(parseRetestStrategy("NOT_KNOWN_ONLY"), "NOT_KNOWN_ONLY");
  assert.equal(parseRetestStrategy("MASTERED"), null);
  assert.equal(parseRetestStrategy(undefined), null);
});

test("missing attempts are rejected with a bounded domain error", () => {
  assert.throws(
    () => assertCompletedRetestAttempt(undefined, 7),
    (error: unknown) =>
      error instanceof RetestAuthorityError &&
      error.code === "RETEST_ATTEMPT_NOT_FOUND",
  );
});

for (const { name, fn } of tests) {
  fn();
  console.log(`PASS ${name}`);
}
console.log(`Canonical retest authority suite passed (${tests.length}/${tests.length})`);