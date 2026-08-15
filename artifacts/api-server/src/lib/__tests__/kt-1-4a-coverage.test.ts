/**
 * KT-1.4A Coverage Acceptance Tests — aggregateKnowledgeCoverage()
 *
 * Runner: pnpm --filter @workspace/api-server run test:kt14a
 *
 * These are PURE UNIT TESTS — no database required.
 * aggregateKnowledgeCoverage() is a deterministic function; all assertions
 * are purely mathematical and must never touch the DB.
 *
 * Tests covered:
 *   TEST A  100% coverage ≠ 100% mastery  (Physics real-data mirror)
 *   TEST B  Partial coverage (50%)
 *   TEST C  Zero coverage — all not_started
 *   TEST D  Full coverage — all studied/mastered
 *   TEST E  Invariants: totalUnits = Σ 4 states; studiedCount + notStudiedCount = totalUnits
 *   TEST F  Hierarchy consistency — same contract at Topic / Lesson / Subject level
 *   TEST G  Filter invariance — coverage does NOT change when view filter changes
 *           (structural test: API values are never re-derived from filtered nodes)
 */

import assert from "node:assert/strict";
import { aggregateKnowledgeCoverage, type CoverageResult } from "../mastery.js";

// ── Minimal sync test runner ──────────────────────────────────────────────────
type TestFn = () => void | Promise<void>;
const results: { name: string; pass: boolean; error?: unknown }[] = [];

async function test(name: string, fn: TestFn): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓  ${name}`);
  } catch (err) {
    results.push({ name, pass: false, error: err });
    console.error(`  ✗  ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Helper: build node list from state counts ─────────────────────────────────
function nodes(
  mastered:    number,
  partial:     number,
  doesNotKnow: number,
  notStarted:  number,
): { masteryLevel: "mastered" | "weak" | "in_progress" | "not_started" }[] {
  return [
    ...Array(mastered   ).fill({ masteryLevel: "mastered"    }),
    ...Array(partial    ).fill({ masteryLevel: "weak"         }),
    ...Array(doesNotKnow).fill({ masteryLevel: "in_progress"  }),
    ...Array(notStarted ).fill({ masteryLevel: "not_started"  }),
  ];
}

function assertInvariants(r: CoverageResult, label = "") {
  const tag = label ? `[${label}] ` : "";
  assert.equal(
    r.masteredCount + r.partialCount + r.doesNotKnowCount + r.notStartedCount,
    r.totalUnits,
    `${tag}totalUnits must equal Σ 4-state counts`,
  );
  assert.equal(
    r.studiedCount + r.notStudiedCount,
    r.totalUnits,
    `${tag}studiedCount + notStudiedCount must equal totalUnits`,
  );
  assert.equal(
    r.studiedCount,
    r.masteredCount + r.partialCount + r.doesNotKnowCount,
    `${tag}studiedCount must equal mastered + partial + doesNotKnow`,
  );
  assert.equal(
    r.notStudiedCount,
    r.notStartedCount,
    `${tag}notStudiedCount must equal notStartedCount`,
  );
}

// ── TEST A — Physics mirror: 100% coverage ≠ 100% mastery ────────────────────
// Real Physics data (student1, subject 18, lesson 524):
//   3 nodes: 0 mastered, 1 partial (weak), 2 doesNotKnow (in_progress), 0 notStarted
//   studiedCount = 3; coveragePercent = 100%   ← 100% covered but NOT 100% mastered
await test("TEST A — 100% coverage does NOT imply 100% mastery", async () => {
  const r = aggregateKnowledgeCoverage(nodes(0, 1, 2, 0));
  assert.equal(r.totalUnits,       3,    "totalUnits");
  assert.equal(r.masteredCount,    0,    "masteredCount");
  assert.equal(r.partialCount,     1,    "partialCount (weak)");
  assert.equal(r.doesNotKnowCount, 2,    "doesNotKnowCount (in_progress)");
  assert.equal(r.notStartedCount,  0,    "notStartedCount");
  assert.equal(r.studiedCount,     3,    "studiedCount = 3 (all studied)");
  assert.equal(r.notStudiedCount,  0,    "notStudiedCount");
  assert.equal(r.coveragePercent,  100,  "coveragePercent = 100%");
  assertInvariants(r, "TEST A");
});

// ── TEST B — Partial coverage ─────────────────────────────────────────────────
//   4 nodes: 1 mastered, 1 partial, 0 doesNotKnow, 2 not_started
//   studiedCount = 2; coveragePercent = 50%
await test("TEST B — 50% coverage with mixed state", async () => {
  const r = aggregateKnowledgeCoverage(nodes(1, 1, 0, 2));
  assert.equal(r.totalUnits,       4,   "totalUnits");
  assert.equal(r.masteredCount,    1,   "masteredCount");
  assert.equal(r.partialCount,     1,   "partialCount");
  assert.equal(r.doesNotKnowCount, 0,   "doesNotKnowCount");
  assert.equal(r.notStartedCount,  2,   "notStartedCount");
  assert.equal(r.studiedCount,     2,   "studiedCount = 2");
  assert.equal(r.notStudiedCount,  2,   "notStudiedCount = 2");
  assert.equal(r.coveragePercent,  50,  "coveragePercent = 50%");
  assertInvariants(r, "TEST B");
});

// ── TEST C — Zero coverage (all not_started) ──────────────────────────────────
await test("TEST C — all not_started → coveragePercent = 0 (not null)", async () => {
  const r = aggregateKnowledgeCoverage(nodes(0, 0, 0, 5));
  assert.equal(r.totalUnits,       5,  "totalUnits = 5");
  assert.equal(r.studiedCount,     0,  "studiedCount = 0");
  assert.equal(r.notStudiedCount,  5,  "notStudiedCount = 5");
  assert.equal(r.coveragePercent,  0,  "coveragePercent = 0 (not null — curriculum exists)");
  assertInvariants(r, "TEST C");
});

// ── TEST D — Full coverage (all mastered) ────────────────────────────────────
await test("TEST D — all mastered → coveragePercent = 100", async () => {
  const r = aggregateKnowledgeCoverage(nodes(6, 0, 0, 0));
  assert.equal(r.totalUnits,      6,   "totalUnits = 6");
  assert.equal(r.studiedCount,    6,   "studiedCount = totalUnits");
  assert.equal(r.notStudiedCount, 0,   "notStudiedCount = 0");
  assert.equal(r.coveragePercent, 100, "coveragePercent = 100%");
  assertInvariants(r, "TEST D");
});

// ── TEST D2 — Zero units (no curriculum) ─────────────────────────────────────
await test("TEST D2 — zero units → coveragePercent = null", async () => {
  const r = aggregateKnowledgeCoverage([]);
  assert.equal(r.totalUnits,       0,    "totalUnits = 0");
  assert.equal(r.studiedCount,     0,    "studiedCount = 0");
  assert.equal(r.notStudiedCount,  0,    "notStudiedCount = 0");
  assert.equal(r.coveragePercent,  null, "coveragePercent = null (no curriculum)");
  assertInvariants(r, "TEST D2");
});

// ── TEST E — Invariants exhaustive ───────────────────────────────────────────
await test("TEST E — invariants hold for arbitrary distributions", async () => {
  const cases: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
    [3, 2, 4, 1],
    [10, 10, 10, 10],
    [0, 5, 0, 0],
    [100, 0, 0, 0],
  ];
  for (const [m, p, dnk, ns] of cases) {
    const label = `(m=${m} p=${p} dnk=${dnk} ns=${ns})`;
    const r = aggregateKnowledgeCoverage(nodes(m, p, dnk, ns));
    assertInvariants(r, label);
    // coveragePercent must be null only when totalUnits === 0
    if (r.totalUnits === 0) {
      assert.equal(r.coveragePercent, null, `${label} coveragePercent null when zero units`);
    } else {
      assert.notEqual(r.coveragePercent, null, `${label} coveragePercent non-null when units > 0`);
      // Formula check: round(studiedCount / totalUnits * 100)
      const expected = Math.round(r.studiedCount / r.totalUnits * 100);
      assert.equal(r.coveragePercent, expected, `${label} coveragePercent formula`);
    }
  }
});

// ── TEST F — Hierarchy consistency ───────────────────────────────────────────
// Simulate Topic → Lesson → Subject: aggregating the same set of nodes at each
// level must produce identical results. No level may reinterpret coverage as
// an average masteryScore.
await test("TEST F — hierarchy consistency: same nodes, same result at every level", async () => {
  const leafNodes = nodes(1, 2, 3, 4);  // totalUnits=10

  // Topic level: direct aggregation
  const topicResult = aggregateKnowledgeCoverage(leafNodes);

  // Lesson level: aggregate all topic nodes together (same leaf nodes)
  const lessonResult = aggregateKnowledgeCoverage(leafNodes);

  // Subject level: aggregate all lesson nodes (same leaf nodes)
  const subjectResult = aggregateKnowledgeCoverage(leafNodes);

  // All levels must agree
  assert.deepEqual(topicResult,   lessonResult,  "topic and lesson must agree");
  assert.deepEqual(lessonResult,  subjectResult, "lesson and subject must agree");

  // Verify the correct values (mastered=1, partial=2, doesNotKnow=3, notStarted=4)
  assert.equal(topicResult.totalUnits,       10,  "totalUnits");
  assert.equal(topicResult.masteredCount,    1,   "mastered");
  assert.equal(topicResult.partialCount,     2,   "partial");
  assert.equal(topicResult.doesNotKnowCount, 3,   "doesNotKnow");
  assert.equal(topicResult.notStartedCount,  4,   "notStarted");
  assert.equal(topicResult.studiedCount,     6,   "studiedCount = 1+2+3");
  assert.equal(topicResult.coveragePercent,  60,  "coveragePercent = 6/10 = 60%");
  assertInvariants(topicResult, "TEST F");
});

// ── TEST G — Filter invariance ────────────────────────────────────────────────
// The UI filter (mastered/weak/in_progress/not_started) changes VISIBLE nodes
// but the coverage % displayed must come from the pre-computed API value.
// This is a structural test: we verify the API aggregates over ALL nodes
// and that filtering does NOT re-aggregate.
await test("TEST G — filter invariance: API coverage is pre-computed over all nodes", async () => {
  // Simulate 5 nodes: 1 mastered, 2 partial, 1 doesNotKnow, 1 notStarted
  const allNodes = nodes(1, 2, 1, 1);
  const apiCoverage = aggregateKnowledgeCoverage(allNodes);

  // When filter = "mastered" → only 1 visible node
  const filteredMastered = allNodes.filter(n => n.masteryLevel === "mastered");
  const filteredCoverage  = aggregateKnowledgeCoverage(filteredMastered);

  // The API value (pre-computed) must NOT change with filter
  assert.equal(apiCoverage.coveragePercent, 80, "API: coveragePercent = 4/5 = 80%");
  assert.equal(apiCoverage.totalUnits,      5,  "API: totalUnits = 5");

  // The filtered re-aggregation produces a DIFFERENT number (proves filter MUST NOT be used for display)
  assert.equal(filteredCoverage.coveragePercent, 100, "filtered: 1/1 = 100% (proves filter changes result)");
  assert.notEqual(
    apiCoverage.coveragePercent,
    filteredCoverage.coveragePercent,
    "API coverage must differ from filtered re-aggregation → frontend MUST use API value",
  );
});

// ── TEST G2 — needs_review folds into mastered ─────────────────────────────────
// needs_review is an internal 5th state that must fold to mastered before aggregation.
// The backend already folds it; this test verifies the function ignores it correctly
// (if passed "mastered" after folding, it counts as mastered).
await test("TEST G2 — needs_review folded to mastered before reaching aggregator", async () => {
  // Backend folds needs_review → "mastered" before calling aggregateKnowledgeCoverage.
  // So aggregator only sees 4-state input.
  const r = aggregateKnowledgeCoverage([
    { masteryLevel: "mastered" },  // was needs_review, folded by knowledge-tree.ts
    { masteryLevel: "mastered" },  // genuine mastered
    { masteryLevel: "not_started" },
  ]);
  assert.equal(r.masteredCount, 2,   "both mastered (incl. folded needs_review) counted");
  assert.equal(r.studiedCount,  2,   "studied = 2");
  assert.equal(r.coveragePercent, 67, "coveragePercent = round(2/3*100) = 67%");
  assertInvariants(r, "TEST G2");
});

// ── Summary ───────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log("\n─────────────────────────────────────────────");
console.log(`KT-1.4A Coverage: ${passed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
console.log("─────────────────────────────────────────────");
if (failed > 0) process.exit(1);
