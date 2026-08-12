/**
 * Phase 8 — Deterministic Sequential Dependencies tests
 * All tests use pure functions (no DB access) — imports from sequential-deps.ts.
 * Runner: npx tsx src/lib/__tests__/phase8-dependencies.test.ts
 */

import assert from "node:assert/strict";
import { buildSequentialChain, detectCycle, type NodeRef } from "../sequential-deps.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// ─────────────────────────────────────────────────────────────────────────────
// P8.S1: buildSequentialChain — basic invariants
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP8.S1: buildSequentialChain — basic invariants");

test("0 nodes → 0 edges", () => {
  assert.equal(buildSequentialChain([]).length, 0);
});

test("1 node → 0 edges", () => {
  const nodes: NodeRef[] = [{ id: 10, sequence: 1 }];
  assert.equal(buildSequentialChain(nodes).length, 0);
});

test("2 nodes → 1 edge", () => {
  const nodes: NodeRef[] = [{ id: 1, sequence: 1 }, { id: 2, sequence: 2 }];
  const edges = buildSequentialChain(nodes);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].fromNodeId, 1);
  assert.equal(edges[0].toNodeId,   2);
});

test("3 ordered nodes → 2 edges (N-1 rule)", () => {
  const nodes: NodeRef[] = [
    { id: 100, sequence: 1 },
    { id: 200, sequence: 2 },
    { id: 300, sequence: 3 },
  ];
  const edges = buildSequentialChain(nodes);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].fromNodeId, 100); assert.equal(edges[0].toNodeId, 200);
  assert.equal(edges[1].fromNodeId, 200); assert.equal(edges[1].toNodeId, 300);
});

test("4 nodes → 3 edges", () => {
  const nodes: NodeRef[] = [1, 2, 3, 4].map((seq) => ({ id: seq * 10, sequence: seq }));
  assert.equal(buildSequentialChain(nodes).length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// P8.S2: sequence order is respected
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP8.S2: Sequence order respected");

test("unsorted input is sorted by sequence before chaining", () => {
  const nodes: NodeRef[] = [
    { id: 300, sequence: 3 },
    { id: 100, sequence: 1 },
    { id: 200, sequence: 2 },
  ];
  const edges = buildSequentialChain(nodes);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].fromNodeId, 100); // seq 1 first
  assert.equal(edges[0].toNodeId,   200); // seq 2 second
  assert.equal(edges[1].fromNodeId, 200);
  assert.equal(edges[1].toNodeId,   300); // seq 3 last
});

test("direction: fromNode (lower seq) → toNode (higher seq)", () => {
  const nodes: NodeRef[] = [{ id: 5, sequence: 1 }, { id: 7, sequence: 2 }];
  const [edge] = buildSequentialChain(nodes);
  // fromNodeId = prerequisite (seq 1 must be taught BEFORE seq 2)
  assert.equal(edge.fromNodeId, 5); // earlier node = prerequisite
  assert.equal(edge.toNodeId,   7); // later node = dependent
});

test("reason string references correct sequence numbers", () => {
  const nodes: NodeRef[] = [{ id: 1, sequence: 3 }, { id: 2, sequence: 7 }];
  const [edge] = buildSequentialChain(nodes);
  assert.ok(edge.reason.includes("3"));
  assert.ok(edge.reason.includes("7"));
});

// ─────────────────────────────────────────────────────────────────────────────
// P8.S3: No self-edge, no duplicates
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP8.S3: No self-edge, no duplicate edge");

test("no self-edge: guard skips node when from.id === to.id", () => {
  // This can only arise from malformed input (same id, different seq).
  // The builder guards against it explicitly.
  const nodes: NodeRef[] = [
    { id: 42, sequence: 1 },
    { id: 42, sequence: 2 }, // same id, different seq — malformed
    { id: 99, sequence: 3 },
  ];
  const edges = buildSequentialChain(nodes);
  const selfEdges = edges.filter((e) => e.fromNodeId === e.toNodeId);
  assert.equal(selfEdges.length, 0);
});

test("no duplicate edges for 3 distinct nodes", () => {
  const nodes: NodeRef[] = [{ id: 1, sequence: 1 }, { id: 2, sequence: 2 }, { id: 3, sequence: 3 }];
  const edges = buildSequentialChain(nodes);
  const keys = edges.map((e) => `${e.fromNodeId}→${e.toNodeId}`);
  const unique = new Set(keys);
  assert.equal(unique.size, edges.length);
});

test("same call twice produces identical edges (deterministic)", () => {
  const nodes: NodeRef[] = [{ id: 10, sequence: 1 }, { id: 20, sequence: 2 }, { id: 30, sequence: 3 }];
  const first  = buildSequentialChain(nodes);
  const second = buildSequentialChain(nodes);
  assert.deepEqual(first, second);
});

// ─────────────────────────────────────────────────────────────────────────────
// P8.S4: Same-lesson scope (chain uses only provided nodes)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP8.S4: Lesson scope isolation");

test("nodes from another lesson not included — caller provides lesson-scoped list", () => {
  // The function is pure: it only chains what is passed in.
  // The route guarantees it only passes nodes for the target lesson.
  const lesson69Nodes: NodeRef[] = [
    { id: 1291, sequence: 1 },
    { id: 1292, sequence: 2 },
    { id: 1293, sequence: 3 },
  ];
  const edges = buildSequentialChain(lesson69Nodes);
  const ids = new Set(edges.flatMap((e) => [e.fromNodeId, e.toNodeId]));
  assert.ok(!ids.has(999)); // node from another lesson not present
  assert.equal(ids.has(1291), true);
  assert.equal(ids.has(1292), true);
  assert.equal(ids.has(1293), true);
});

test("empty lesson produces empty chain", () => {
  assert.equal(buildSequentialChain([]).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// P8.S5: Semantic dependency preservation contract
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP8.S5: Semantic dependency type preservation");

/**
 * Mirrors the refresh logic: delete SEQUENTIAL only, preserve others.
 * The pure simulation of the DB delete-filter.
 */
function simulateRefresh(
  existingDeps: { type: string }[],
  newChain: { from: number; to: number }[],
): { preserved: number; deleted: number; created: number } {
  const preserved = existingDeps.filter((d) => d.type !== "SEQUENTIAL").length;
  const deleted   = existingDeps.filter((d) => d.type === "SEQUENTIAL").length;
  return { preserved, deleted, created: newChain.length };
}

test("REQUIRED deps are preserved when SEQUENTIAL are rebuilt", () => {
  const deps = [
    { type: "REQUIRED" },
    { type: "SEQUENTIAL" },
    { type: "SEQUENTIAL" },
  ];
  const { preserved, deleted, created } = simulateRefresh(deps, [{ from: 1, to: 2 }]);
  assert.equal(preserved, 1); // REQUIRED survives
  assert.equal(deleted,   2); // old SEQUENTIAL gone
  assert.equal(created,   1); // new SEQUENTIAL inserted
});

test("CONCEPTUAL deps are preserved when SEQUENTIAL are rebuilt", () => {
  const deps = [{ type: "CONCEPTUAL" }, { type: "SEQUENTIAL" }];
  const { preserved } = simulateRefresh(deps, []);
  assert.equal(preserved, 1);
});

test("all-SEQUENTIAL lesson: all old deleted, new chain inserted", () => {
  const deps = [{ type: "SEQUENTIAL" }, { type: "SEQUENTIAL" }];
  const { preserved, deleted, created } = simulateRefresh(deps, [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
  assert.equal(preserved, 0);
  assert.equal(deleted,   2);
  assert.equal(created,   2);
});

test("no existing deps: delete=0, create=N-1", () => {
  const { preserved, deleted, created } = simulateRefresh([], [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
  assert.equal(preserved, 0);
  assert.equal(deleted,   0);
  assert.equal(created,   2);
});

// ─────────────────────────────────────────────────────────────────────────────
// P8.S6: Idempotent refresh
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP8.S6: Idempotency");

test("running chain builder twice on same nodes → identical edges", () => {
  const nodes: NodeRef[] = [{ id: 1, sequence: 1 }, { id: 2, sequence: 2 }, { id: 3, sequence: 3 }];
  const run1 = buildSequentialChain(nodes);
  const run2 = buildSequentialChain(nodes);
  assert.deepEqual(run1, run2);
  assert.equal(run1.length, 2);
});

test("refresh counts idempotency: first run created=2, second run deleted=2+created=2", () => {
  // After first run: seqDeps = [{seq1→seq2},{seq2→seq3}]
  const nodes: NodeRef[] = [{ id: 1, sequence: 1 }, { id: 2, sequence: 2 }, { id: 3, sequence: 3 }];
  const chain = buildSequentialChain(nodes);
  // Simulate second run: existing has the 2 sequential deps we just created
  const existing = chain.map(() => ({ type: "SEQUENTIAL" }));
  const { deleted, created, preserved } = simulateRefresh(existing, chain);
  assert.equal(deleted,   2); // remove old SEQUENTIAL
  assert.equal(created,   2); // add identical new SEQUENTIAL
  assert.equal(preserved, 0); // no non-SEQUENTIAL
  // Net count unchanged: 2 (delete 2, add 2)
  assert.equal(existing.length - deleted + created, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// P8.S7: Structural change test
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP8.S7: Structural change adapts correctly");

test("add a 4th node → chain grows from 2 to 3 edges", () => {
  const before: NodeRef[] = [{ id: 1, sequence: 1 }, { id: 2, sequence: 2 }, { id: 3, sequence: 3 }];
  const after:  NodeRef[] = [...before, { id: 4, sequence: 4 }];
  assert.equal(buildSequentialChain(before).length, 2);
  assert.equal(buildSequentialChain(after).length,  3);
  // New edge is 3→4
  const newEdges = buildSequentialChain(after);
  assert.equal(newEdges[2].fromNodeId, 3);
  assert.equal(newEdges[2].toNodeId,   4);
});

test("remove a node → chain contracts correctly", () => {
  const before: NodeRef[] = [{ id: 1, sequence: 1 }, { id: 2, sequence: 2 }, { id: 3, sequence: 3 }];
  const after:  NodeRef[] = [{ id: 1, sequence: 1 }, { id: 3, sequence: 3 }]; // node 2 removed
  const edges = buildSequentialChain(after);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].fromNodeId, 1);
  assert.equal(edges[0].toNodeId,   3);
});

test("reorder sequence → chain follows new sequence", () => {
  // Before: 1→2→3 (ids 10,20,30)
  // After reorder: node 20 is now seq=1, node 10 is seq=2, node 30 seq=3
  const reordered: NodeRef[] = [{ id: 10, sequence: 2 }, { id: 20, sequence: 1 }, { id: 30, sequence: 3 }];
  const edges = buildSequentialChain(reordered);
  assert.equal(edges[0].fromNodeId, 20); // seq=1 now comes first
  assert.equal(edges[0].toNodeId,   10); // seq=2 second
  assert.equal(edges[1].fromNodeId, 10);
  assert.equal(edges[1].toNodeId,   30);
});

// ─────────────────────────────────────────────────────────────────────────────
// P8.S8: Cycle detection
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP8.S8: Cycle detection");

test("no cycle in linear chain A→B→C", () => {
  assert.equal(detectCycle([{ from: 1, to: 2 }, { from: 2, to: 3 }]), false);
});

test("obvious cycle A→B→A detected", () => {
  assert.equal(detectCycle([{ from: 1, to: 2 }, { from: 2, to: 1 }]), true);
});

test("triangle cycle A→B→C→A detected", () => {
  assert.equal(detectCycle([{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 1 }]), true);
});

test("self-loop A→A detected as cycle", () => {
  assert.equal(detectCycle([{ from: 5, to: 5 }]), true);
});

test("disconnected graph without cycle — no cycle", () => {
  // Two separate chains: A→B and C→D
  assert.equal(detectCycle([{ from: 1, to: 2 }, { from: 3, to: 4 }]), false);
});

test("sequential chain from buildSequentialChain is always cycle-free", () => {
  const nodes: NodeRef[] = [
    { id: 100, sequence: 1 },
    { id: 200, sequence: 2 },
    { id: 300, sequence: 3 },
    { id: 400, sequence: 4 },
  ];
  const chain = buildSequentialChain(nodes);
  const edges = chain.map((e) => ({ from: e.fromNodeId, to: e.toNodeId }));
  assert.equal(detectCycle(edges), false);
});

test("empty edge set — no cycle", () => {
  assert.equal(detectCycle([]), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// P8.S9: AI Teacher direction semantics
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nP8.S9: AI Teacher direction convention");

/**
 * Mirrors the exact chat.ts:115-124 query:
 * "find fromNodeIds where toNodeId = nextNode AND type = REQUIRED"
 * → fromNodeId = prerequisite node that must be completed before toNode.
 *
 * For sequential chain 1→2→3:
 *   toNodeId=2 has fromNodeId=1 as prereq
 *   toNodeId=3 has fromNodeId=2 as prereq
 */
function getPrerequisiteIds(
  deps: { fromNodeId: number; toNodeId: number; dependencyType: string }[],
  toNodeId: number,
  type = "REQUIRED",
): number[] {
  return deps
    .filter((d) => d.toNodeId === toNodeId && d.dependencyType === type)
    .map((d) => d.fromNodeId);
}

const sampleDeps = [
  { fromNodeId: 1291, toNodeId: 1292, dependencyType: "REQUIRED" },
  { fromNodeId: 1292, toNodeId: 1293, dependencyType: "REQUIRED" },
];

test("toNode=1292 → prereq is 1291 (fromNodeId)", () => {
  assert.deepEqual(getPrerequisiteIds(sampleDeps, 1292), [1291]);
});

test("toNode=1293 → prereq is 1292 (fromNodeId)", () => {
  assert.deepEqual(getPrerequisiteIds(sampleDeps, 1293), [1292]);
});

test("toNode=1291 → no prereqs (first node)", () => {
  assert.deepEqual(getPrerequisiteIds(sampleDeps, 1291), []);
});

test("SEQUENTIAL type NOT read by AI Teacher (only REQUIRED)", () => {
  const seqDeps = [{ fromNodeId: 1291, toNodeId: 1292, dependencyType: "SEQUENTIAL" }];
  // AI Teacher queries with type="REQUIRED" — SEQUENTIAL deps ignored
  assert.deepEqual(getPrerequisiteIds(seqDeps, 1292, "REQUIRED"), []);
});

test("direction: lower seq node is prerequisite (fromNodeId), higher seq is dependent (toNodeId)", () => {
  // Node seq=1 (id=1291) must be taught before seq=2 (id=1292)
  const [prereq] = getPrerequisiteIds(sampleDeps, 1292);
  assert.equal(prereq, 1291); // seq=1 is prerequisite
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
