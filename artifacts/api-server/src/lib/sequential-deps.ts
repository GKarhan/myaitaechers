/**
 * Phase 8 — Structural sequential dependency utilities.
 *
 * All core functions are pure (no DB access) so they can be unit-tested
 * independently.  The DB refresh function is exported for use in routes.
 *
 * Convention (matches existing chat.ts / advanceNodeInSession):
 *   fromNodeId → toNodeId  means "fromNode must be taught BEFORE toNode".
 *   Sequential: node[seq=1] → node[seq=2] → node[seq=3]
 */

export interface NodeRef {
  id: number;
  sequence: number;
}

export interface SequentialEdge {
  fromNodeId: number;
  toNodeId: number;
  reason: string;
}

export interface RefreshResult {
  nodeCount: number;
  deletedSequentialDependencies: number;
  createdSequentialDependencies: number;
  preservedNonSequentialDependencies: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (no DB)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given nodes sorted by sequence, returns the deterministic sequential chain.
 * Properties guaranteed:
 *  - deterministic (same input → same output)
 *  - no self-edge
 *  - no duplicate edges (each pair appears exactly once)
 *  - preserves sequence order
 *  - 0 nodes → [] edges, 1 node → [] edges
 */
export function buildSequentialChain(nodes: NodeRef[]): SequentialEdge[] {
  const sorted = [...nodes].sort((a, b) => a.sequence - b.sequence);
  const edges: SequentialEdge[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to   = sorted[i + 1];
    if (from.id === to.id) continue;            // guard: no self-edge
    edges.push({
      fromNodeId: from.id,
      toNodeId:   to.id,
      reason:     `Sequential teaching order: seq ${from.sequence} → seq ${to.sequence}`,
    });
  }
  return edges;
}

/**
 * DFS-based cycle detection.
 * Returns true if the edge set contains a directed cycle.
 * For a pure sequential chain the answer is always false (the builder
 * produces a DAG), but this is also run on the full dep graph which may
 * include hand-authored REQUIRED edges.
 */
export function detectCycle(edges: { from: number; to: number }[]): boolean {
  const adj = new Map<number, number[]>();
  for (const { from, to } of edges) {
    const list = adj.get(from) ?? [];
    list.push(to);
    adj.set(from, list);
  }

  const UNVISITED = 0, IN_STACK = 1, DONE = 2;
  const state = new Map<number, 0 | 1 | 2>();

  function dfs(node: number): boolean {
    const s = state.get(node) ?? UNVISITED;
    if (s === IN_STACK) return true;  // back-edge → cycle
    if (s === DONE)     return false; // already fully explored
    state.set(node, IN_STACK);
    for (const neighbour of adj.get(node) ?? []) {
      if (dfs(neighbour)) return true;
    }
    state.set(node, DONE);
    return false;
  }

  const allNodes = new Set([...edges.map((e) => e.from), ...edges.map((e) => e.to)]);
  for (const n of allNodes) {
    if ((state.get(n) ?? UNVISITED) === UNVISITED && dfs(n)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB refresh (called from lessons.ts routes — keeps lessons.ts clean)
// ─────────────────────────────────────────────────────────────────────────────

import { db as defaultDb } from "@workspace/db";
import { lessonNodesTable, lessonNodeDependenciesTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

export async function refreshSequentialDependencies(
  lessonId: number,
  dbInstance: typeof defaultDb = defaultDb,
): Promise<RefreshResult> {
  // 1. Read existing dep types so we can report preserved count.
  const existingDeps = await dbInstance
    .select({ type: lessonNodeDependenciesTable.dependencyType })
    .from(lessonNodeDependenciesTable)
    .where(eq(lessonNodeDependenciesTable.lessonId, lessonId));

  const nonSeqPreserved = existingDeps.filter((d) => d.type !== "SEQUENTIAL").length;
  const seqDeleted      = existingDeps.filter((d) => d.type === "SEQUENTIAL").length;

  // 2. Delete only SEQUENTIAL deps for this lesson — preserve REQUIRED/CONCEPTUAL/etc.
  await dbInstance
    .delete(lessonNodeDependenciesTable)
    .where(
      and(
        eq(lessonNodeDependenciesTable.lessonId, lessonId),
        eq(lessonNodeDependenciesTable.dependencyType, "SEQUENTIAL"),
      ),
    );

  // 3. Read all nodes ordered by sequence.
  const nodes = await dbInstance
    .select({ id: lessonNodesTable.id, sequence: lessonNodesTable.sequence })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, lessonId))
    .orderBy(asc(lessonNodesTable.sequence));

  // 4. Build chain and insert.
  const chain = buildSequentialChain(nodes);

  if (chain.length > 0) {
    await dbInstance
      .insert(lessonNodeDependenciesTable)
      .values(
        chain.map((e) => ({
          lessonId,
          fromNodeId:     e.fromNodeId,
          toNodeId:       e.toNodeId,
          dependencyType: "SEQUENTIAL",
          requiredLevel:  "SUPPORTING",
          reason:         e.reason,
        })),
      );
  }

  return {
    nodeCount:                       nodes.length,
    deletedSequentialDependencies:   seqDeleted,
    createdSequentialDependencies:   chain.length,
    preservedNonSequentialDependencies: nonSeqPreserved,
  };
}
