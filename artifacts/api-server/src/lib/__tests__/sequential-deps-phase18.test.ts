/**
 * Phase 1.8 — Sequential Dependency Sync Tests
 * Covers all 15 required cases from the spec.
 * Pure-function tests use no DB.  Integration tests use isolated throwaway
 * lessons cleaned up in the finally block.
 *
 * Runner: pnpm --filter @workspace/api-server run test:phase18-seq
 */

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { db, lessonsTable, lessonNodesTable, lessonNodeDependenciesTable } from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";
import { buildSequentialChain, refreshSequentialDependencies, type NodeRef } from "../sequential-deps.js";

// ── test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}: ${msg}`);
    failed++;
  }
}

// ── API helpers ───────────────────────────────────────────────────────────────
const BASE   = "http://localhost:8080/api";
const BEARER = jwt.sign(
  { userId: 1, role: "teacher" },
  process.env.SESSION_SECRET ?? "myaiteacher-secret",
  { expiresIn: "1h" },
) as string;

async function apiPost(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function seqEdges(lessonId: number) {
  return db.select().from(lessonNodeDependenciesTable)
    .where(and(
      eq(lessonNodeDependenciesTable.lessonId, lessonId),
      eq(lessonNodeDependenciesTable.dependencyType, "SEQUENTIAL"),
    ))
    .orderBy(asc(lessonNodeDependenciesTable.id));
}

async function allDeps(lessonId: number) {
  return db.select().from(lessonNodeDependenciesTable)
    .where(eq(lessonNodeDependenciesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodeDependenciesTable.id));
}

async function nodes(lessonId: number) {
  return db.select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence));
}

/** Create a throwaway lesson and N nodes, return { lessonId, nodeIds[] }. */
async function makeTestLesson(nodeCount: number): Promise<{ lessonId: number; nodeIds: number[] }> {
  const [lesson] = await db.insert(lessonsTable).values({
    title: `_phase18_test_${Date.now()}`,
    subjectId: 18, // Physics 7 — same subject as lesson 105, guaranteed to exist
    status: "draft",
  }).returning({ id: lessonsTable.id });
  const lessonId = lesson.id;

  const nodeIds: number[] = [];
  for (let i = 1; i <= nodeCount; i++) {
    const [n] = await db.insert(lessonNodesTable).values({
      lessonId,
      sequence: i,
      title: `Test node ${i}`,
      createdBy: "teacher",
    }).returning({ id: lessonNodesTable.id });
    nodeIds.push(n.id);
  }
  await refreshSequentialDependencies(lessonId);
  return { lessonId, nodeIds };
}

async function cleanLesson(lessonId: number) {
  await db.delete(lessonNodesTable).where(eq(lessonNodesTable.lessonId, lessonId));
  await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId));
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1 — Pure-function tests (no DB)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nGroup 1 — Pure function invariants");

await test("T01: zero-node lesson → zero SEQUENTIAL edges", async () => {
  assert.equal(buildSequentialChain([]).length, 0);
});

await test("T02: one-node lesson → zero SEQUENTIAL edges", async () => {
  const nodes: NodeRef[] = [{ id: 10, sequence: 1 }];
  assert.equal(buildSequentialChain(nodes).length, 0);
});

await test("T03: two-node lesson → exactly one SEQUENTIAL edge", async () => {
  const nodes: NodeRef[] = [{ id: 1, sequence: 1 }, { id: 2, sequence: 2 }];
  const edges = buildSequentialChain(nodes);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].fromNodeId, 1);
  assert.equal(edges[0].toNodeId,   2);
});

await test("T04: three nodes A,B,C → A→B, B→C", async () => {
  const ns: NodeRef[] = [{ id: 1, sequence: 1 }, { id: 2, sequence: 2 }, { id: 3, sequence: 3 }];
  const edges = buildSequentialChain(ns);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].fromNodeId, 1); assert.equal(edges[0].toNodeId, 2);
  assert.equal(edges[1].fromNodeId, 2); assert.equal(edges[1].toNodeId, 3);
});

await test("T05: reorder A,C,B → A→C, C→B (stale A→B, B→C removed)", async () => {
  // After reorder: node IDs 1,3,2 get sequences 1,2,3
  const reordered: NodeRef[] = [{ id: 1, sequence: 1 }, { id: 3, sequence: 2 }, { id: 2, sequence: 3 }];
  const edges = buildSequentialChain(reordered);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].fromNodeId, 1); assert.equal(edges[0].toNodeId, 3);
  assert.equal(edges[1].fromNodeId, 3); assert.equal(edges[1].toNodeId, 2);
  // Old edges A→B (1→2) and B→C (2→3) must not appear
  const pairs = edges.map(e => `${e.fromNodeId}→${e.toNodeId}`);
  assert.ok(!pairs.includes("1→2"), "stale 1→2 must not exist");
  assert.ok(!pairs.includes("2→3"), "stale 2→3 must not exist");
});

await test("T06: edge count always = max(nodeCount-1, 0)", async () => {
  for (let n = 0; n <= 6; n++) {
    const ns: NodeRef[] = Array.from({ length: n }, (_, i) => ({ id: i + 1, sequence: i + 1 }));
    assert.equal(buildSequentialChain(ns).length, Math.max(n - 1, 0), `n=${n}`);
  }
});

await test("T07: no duplicate edges in chain", async () => {
  const ns: NodeRef[] = [1, 2, 3, 4, 5].map(i => ({ id: i, sequence: i }));
  const edges = buildSequentialChain(ns);
  const seen = new Set<string>();
  for (const e of edges) {
    const key = `${e.fromNodeId}→${e.toNodeId}`;
    assert.ok(!seen.has(key), `Duplicate edge: ${key}`);
    seen.add(key);
  }
});

await test("T08: no self-edge in chain", async () => {
  // Force duplicate IDs to ensure the guard fires
  const ns: NodeRef[] = [{ id: 5, sequence: 1 }, { id: 5, sequence: 2 }];
  const edges = buildSequentialChain(ns);
  for (const e of edges) {
    assert.notEqual(e.fromNodeId, e.toNodeId, "Self-edge detected");
  }
});

await test("T09: cross-lesson nodes never joined (buildSequentialChain is pure — lesson-scope is caller's responsibility)", async () => {
  // Two separate lessons each pass their own node set; chains don't mix.
  const lessonA: NodeRef[] = [{ id: 10, sequence: 1 }, { id: 11, sequence: 2 }];
  const lessonB: NodeRef[] = [{ id: 20, sequence: 1 }, { id: 21, sequence: 2 }];
  const edgesA = buildSequentialChain(lessonA);
  const edgesB = buildSequentialChain(lessonB);
  for (const e of edgesA) {
    assert.ok(e.fromNodeId < 20 && e.toNodeId < 20, "Lesson A edge references lesson B node");
  }
  for (const e of edgesB) {
    assert.ok(e.fromNodeId >= 20 && e.toNodeId >= 20, "Lesson B edge references lesson A node");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2 — DB integration tests (isolated throwaway lessons)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nGroup 2 — DB integration (isolated lessons)");

await test("T10: REQUIRED dependency preserved across refreshSequentialDependencies", async () => {
  const { lessonId, nodeIds } = await makeTestLesson(3);
  try {
    // Insert a REQUIRED edge between node[0] and node[2]
    const [req] = await db.insert(lessonNodeDependenciesTable).values({
      lessonId,
      fromNodeId:     nodeIds[0],
      toNodeId:       nodeIds[2],
      dependencyType: "REQUIRED",
      requiredLevel:  "CRITICAL",
      reason:         "T10 test required dep",
    }).returning({ id: lessonNodeDependenciesTable.id });

    // Refresh SEQUENTIAL (simulating a reorder)
    await refreshSequentialDependencies(lessonId);

    const deps = await allDeps(lessonId);
    const reqDep = deps.find(d => d.id === req.id);
    assert.ok(reqDep, "REQUIRED dependency was deleted by refresh — must be preserved");
    assert.equal(reqDep!.dependencyType, "REQUIRED");
    assert.equal(reqDep!.fromNodeId,     nodeIds[0]);
    assert.equal(reqDep!.toNodeId,       nodeIds[2]);

    const seqDeps = deps.filter(d => d.dependencyType === "SEQUENTIAL");
    assert.equal(seqDeps.length, 2, "3 nodes must produce 2 SEQUENTIAL edges");
  } finally {
    await cleanLesson(lessonId);
  }
});

await test("T11: non-SEQUENTIAL type (CONCEPTUAL) preserved", async () => {
  const { lessonId, nodeIds } = await makeTestLesson(2);
  try {
    const [con] = await db.insert(lessonNodeDependenciesTable).values({
      lessonId,
      fromNodeId:     nodeIds[0],
      toNodeId:       nodeIds[1],
      dependencyType: "CONCEPTUAL",
      requiredLevel:  "SUPPORTING",
      reason:         "T11 conceptual dep",
    }).returning({ id: lessonNodeDependenciesTable.id });

    await refreshSequentialDependencies(lessonId);

    const deps = await allDeps(lessonId);
    assert.ok(deps.find(d => d.id === con.id), "CONCEPTUAL dep must survive refresh");
    assert.equal(deps.filter(d => d.dependencyType === "SEQUENTIAL").length, 1);
  } finally {
    await cleanLesson(lessonId);
  }
});

await test("T12: create node via API refreshes SEQUENTIAL chain atomically", async () => {
  const { lessonId, nodeIds } = await makeTestLesson(2);
  try {
    // 2 nodes → 1 edge before
    const before = await seqEdges(lessonId);
    assert.equal(before.length, 1);

    // Create a 3rd node via the real API route (which now wraps in transaction)
    const r = await apiPost(`/lessons/${lessonId}/nodes`, { title: "New node T12" });
    assert.equal(r.status, 201, `Create failed: ${JSON.stringify(r.json)}`);

    // Must now have 2 SEQUENTIAL edges
    const after = await seqEdges(lessonId);
    assert.equal(after.length, 2, `Expected 2 SEQUENTIAL edges after create, got ${after.length}`);
  } finally {
    await cleanLesson(lessonId);
  }
});

await test("T13: delete node via API refreshes SEQUENTIAL chain (no stale edges, chain heals)", async () => {
  const { lessonId, nodeIds } = await makeTestLesson(3);
  try {
    // MN1→MN2, MN2→MN3 before
    const before = await seqEdges(lessonId);
    assert.equal(before.length, 2);

    // Delete middle node (nodeIds[1])
    const r = await apiPost(`/lessons/${lessonId}/nodes/${nodeIds[1]}/delete`);
    assert.equal(r.status, 200, `Delete failed: ${JSON.stringify(r.json)}`);

    const after = await seqEdges(lessonId);
    assert.equal(after.length, 1, "2 remaining nodes → 1 SEQUENTIAL edge");
    // The single remaining edge must join nodeIds[0] → nodeIds[2]
    assert.equal(after[0].fromNodeId, nodeIds[0]);
    assert.equal(after[0].toNodeId,   nodeIds[2]);

    // Old edges involving deleted node must be gone
    const stale = after.filter(e => e.fromNodeId === nodeIds[1] || e.toNodeId === nodeIds[1]);
    assert.equal(stale.length, 0, "Stale edges referencing deleted node remain");
  } finally {
    await cleanLesson(lessonId);
  }
});

await test("T14: transaction atomicity — failure rolls back both sequence update and dep rebuild", async () => {
  const { lessonId, nodeIds } = await makeTestLesson(3);
  try {
    // Record original sequences and SEQUENTIAL edges
    const origNodes = await nodes(lessonId);
    const origEdges = await seqEdges(lessonId);

    // Simulate a failure inside a transaction (throw after sequence update, before deps written)
    try {
      await db.transaction(async (tx) => {
        // Update sequences in reverse
        await tx.update(lessonNodesTable).set({ sequence: 99 }).where(eq(lessonNodesTable.id, nodeIds[0]));
        throw new Error("simulated failure");
      });
    } catch {
      // expected
    }

    // Sequences must be unchanged
    const afterNodes = await nodes(lessonId);
    assert.deepEqual(
      afterNodes.map(n => ({ id: n.id, sequence: n.sequence })),
      origNodes.map(n => ({ id: n.id, sequence: n.sequence })),
      "Sequences were not rolled back after transaction failure",
    );

    // SEQUENTIAL graph must be unchanged
    const afterEdges = await seqEdges(lessonId);
    assert.equal(afterEdges.length, origEdges.length, "Edge count changed after rollback");
  } finally {
    await cleanLesson(lessonId);
  }
});

await test("T15: cross-lesson isolation — refreshSequentialDependencies only touches target lesson", async () => {
  const A = await makeTestLesson(3);
  const B = await makeTestLesson(3);
  try {
    const edgesB_before = await seqEdges(B.lessonId);
    // Refresh only lesson A
    await refreshSequentialDependencies(A.lessonId);
    const edgesB_after = await seqEdges(B.lessonId);
    assert.deepEqual(
      edgesB_after.map(e => e.id),
      edgesB_before.map(e => e.id),
      "Refreshing lesson A altered lesson B's SEQUENTIAL edges",
    );
  } finally {
    await cleanLesson(A.lessonId);
    await cleanLesson(B.lessonId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3 — Real Lesson 105 acceptance test
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nGroup 3 — Real Lesson 105 acceptance");

const L105 = 105;

// Capture baseline
const baselineNodes = await db
  .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence, title: lessonNodesTable.title })
  .from(lessonNodesTable)
  .where(eq(lessonNodesTable.lessonId, L105))
  .orderBy(asc(lessonNodesTable.sequence));

const baselineSeqEdges = await seqEdges(L105);
const baselineRequiredEdges = (await allDeps(L105)).filter(d => d.dependencyType !== "SEQUENTIAL");

await test("T16: Lesson 105 baseline — 10 nodes, 9 SEQUENTIAL, 0 REQUIRED", async () => {
  assert.equal(baselineNodes.length, 10, `Expected 10 nodes, got ${baselineNodes.length}`);
  assert.equal(baselineSeqEdges.length, 9, `Expected 9 SEQUENTIAL, got ${baselineSeqEdges.length}`);
  // Verify chain is contiguous: edge i connects node[i] → node[i+1]
  for (let i = 0; i < baselineSeqEdges.length; i++) {
    assert.equal(baselineSeqEdges[i].fromNodeId, baselineNodes[i].id, `Edge ${i} fromNode mismatch`);
    assert.equal(baselineSeqEdges[i].toNodeId,   baselineNodes[i + 1].id, `Edge ${i} toNode mismatch`);
  }
});

// Insert a temporary REQUIRED dep (to test preservation across reorder)
const [tempRequired] = await db.insert(lessonNodeDependenciesTable).values({
  lessonId:       L105,
  fromNodeId:     baselineNodes[0].id,
  toNodeId:       baselineNodes[2].id,
  dependencyType: "REQUIRED",
  requiredLevel:  "SUPPORTING",
  reason:         "Phase 1.8 temp test dep — will be removed",
}).returning({ id: lessonNodeDependenciesTable.id });

// Swap positions 1 and 2 (0-indexed) — nodes[1] ↔ nodes[2]
const reorderedIds = baselineNodes.map(n => n.id);
[reorderedIds[1], reorderedIds[2]] = [reorderedIds[2], reorderedIds[1]];

await test("T17: reorder via API changes SEQUENTIAL graph; REQUIRED dep preserved", async () => {
  const r = await apiPost(`/lessons/${L105}/nodes/reorder`, { orderedNodeIds: reorderedIds });
  assert.equal(r.status, 200, `Reorder failed: ${JSON.stringify(r.json)}`);

  const afterEdges = await seqEdges(L105);
  assert.equal(afterEdges.length, 9, "9 SEQUENTIAL edges must remain after reorder");

  const afterNodes = await db
    .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, L105))
    .orderBy(asc(lessonNodesTable.sequence));

  // Verify each SEQUENTIAL edge links adjacent nodes in new order
  for (let i = 0; i < afterEdges.length; i++) {
    assert.equal(afterEdges[i].fromNodeId, afterNodes[i].id,     `Reorder: edge ${i} from mismatch`);
    assert.equal(afterEdges[i].toNodeId,   afterNodes[i + 1].id, `Reorder: edge ${i} to mismatch`);
  }

  // Stale edges from old order at swapped positions must be gone
  const oldEdge = baselineSeqEdges[1]; // was nodes[1]→nodes[2]
  const stale = afterEdges.find(
    e => e.fromNodeId === oldEdge.fromNodeId && e.toNodeId === oldEdge.toNodeId,
  );
  assert.equal(stale, undefined, "Stale SEQUENTIAL edge from old order still present");

  // REQUIRED dep must be intact
  const allD = await allDeps(L105);
  const req  = allD.find(d => d.id === tempRequired.id);
  assert.ok(req, "Temporary REQUIRED dep was deleted by reorder");
  assert.equal(req!.dependencyType, "REQUIRED");
});

await test("T18: restore original order → original SEQUENTIAL graph rebuilt", async () => {
  const origIds = baselineNodes.map(n => n.id);
  const r = await apiPost(`/lessons/${L105}/nodes/reorder`, { orderedNodeIds: origIds });
  assert.equal(r.status, 200, `Restore reorder failed: ${JSON.stringify(r.json)}`);

  const restoredEdges = await seqEdges(L105);
  assert.equal(restoredEdges.length, 9);
  for (let i = 0; i < restoredEdges.length; i++) {
    assert.equal(restoredEdges[i].fromNodeId, baselineNodes[i].id,     `Restored: edge ${i} from`);
    assert.equal(restoredEdges[i].toNodeId,   baselineNodes[i + 1].id, `Restored: edge ${i} to`);
  }
});

// Clean up temporary REQUIRED dep
await db.delete(lessonNodeDependenciesTable)
  .where(eq(lessonNodeDependenciesTable.id, tempRequired.id));

await test("T19: after restore, Final Approval passes and lesson returns to approved", async () => {
  const fa = await apiPost(`/lessons/${L105}/final-approve`);
  assert.equal(fa.status, 200, `Final Approval failed: ${JSON.stringify(fa)}`);
  const body = fa.json as { approved?: boolean };
  assert.equal(body.approved, true, "Final Approval did not return approved=true");
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
