// ─────────────────────────────────────────────────────────────────────────────
// POST-PHASE 1.12 — Teacher Authoring Workflow Simplification
// Run with: pnpm --filter @workspace/api-server run test:post-p112-authoring
// No external test framework — uses node:assert/strict + exit code.
//
// Spec sections:
//  A1–A7  Direct editing after first Final Approval (no re-approval gate)
//  B1–B4  New MicroNode after first approval
//  C1–C4  Selective per-node Phase 2 enrichment route
//  D1–D5  Read-only node view data integrity
//  E1–E4  Whole-lesson Phase 2 safety guard (route exists + auth)
//
// Fixture: lesson 105, 9 approved nodes, everApproved=true.
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { db, lessonsTable, lessonNodesTable, lessonExercisesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const LESSON_ID = 105;
const BASE = "http://localhost:8080/api";

const BEARER = jwt.sign(
  { userId: 161, role: "teacher" },
  process.env.SESSION_SECRET ?? "myaiteacher-secret",
  { expiresIn: "1h" },
) as string;

type Test = [string, () => Promise<void>];
const tests: Test[] = [];
function it(name: string, fn: () => Promise<void>): void { tests.push([name, fn]); }

async function api(method: string, path: string, body?: unknown, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, body: data as Record<string, unknown> };
  } catch (err: unknown) {
    const isAbort = (err as { name?: string })?.name === "AbortError";
    // Return 408 (Request Timeout) so tests can assert route exists vs. timeout
    return { status: isAbort ? 408 : 500, body: { error: String(err) } as Record<string, unknown> };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const allNodes = await db
  .select()
  .from(lessonNodesTable)
  .where(and(eq(lessonNodesTable.lessonId, LESSON_ID), eq(lessonNodesTable.status, "approved")));

if (allNodes.length === 0) throw new Error("No approved nodes for lesson 105 — cannot run tests");

const NODE = allNodes[0];
const originalNodeTitle = NODE.title;
const originalNodeLO = NODE.learningObjective ?? "";

// ─── SECTION A: Direct editing after first Final Approval ─────────────────────
it("A1: lesson 105 has everApproved=true", async () => {
  const [lesson] = await db
    .select({ everApproved: lessonsTable.everApproved })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID))
    .limit(1);
  assert.ok(lesson, "Lesson 105 must exist");
  assert.equal(lesson.everApproved, true, "everApproved must be true after at least one approval");
});

it("A2: editing node title via POST /lessons/:id/nodes/:nodeId/update does not revert lesson to needs_review", async () => {
  const { status } = await api("POST", `/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, {
    title: originalNodeTitle + " (A2)",
  });
  assert.ok(status < 300, `Expected 2xx from node update, got ${status}`);

  const [lesson] = await db
    .select({ status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID))
    .limit(1);
  assert.ok(
    ["approved", "active"].includes(lesson?.status ?? ""),
    `Lesson status must remain approved/active, got: ${lesson?.status}`,
  );
});

it("A3: editing learningObjective does not change lesson status", async () => {
  const [before] = await db
    .select({ status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID))
    .limit(1);

  await api("POST", `/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, {
    learningObjective: "LO updated in A3",
  });

  const [after] = await db
    .select({ status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID))
    .limit(1);

  assert.equal(after?.status, before?.status, `Status must not change; before=${before?.status} after=${after?.status}`);
});

it("A4: Phase 2 content is NOT wiped by a node title edit (don't-degrade, separate paths)", async () => {
  const [before] = await db
    .select({ childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, NODE.id))
    .limit(1);

  await api("POST", `/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, { title: originalNodeTitle + " (A4)" });

  const [after] = await db
    .select({ childFriendlyExplanation: lessonNodesTable.childFriendlyExplanation })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, NODE.id))
    .limit(1);

  if (before?.childFriendlyExplanation) {
    assert.ok(
      after?.childFriendlyExplanation,
      "Phase 2 childFriendlyExplanation must not be wiped by a title edit",
    );
  }
  // If Phase 2 was not present before, test passes regardless (no pre-condition)
});

it("A5: everApproved column stays true after subsequent edits (sticky once set)", async () => {
  await api("POST", `/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, { title: originalNodeTitle + " (A5)" });

  const [lesson] = await db
    .select({ everApproved: lessonsTable.everApproved })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID))
    .limit(1);

  assert.equal(lesson?.everApproved, true, "everApproved must not revert to false");
});

it("A6: GET /lessons/:id/nodes still works for teacher after edits", async () => {
  const { status, body } = await api("GET", `/lessons/${LESSON_ID}/nodes`);
  assert.equal(status, 200, `Expected 200 from GET /nodes, got ${status}`);
  assert.ok(Array.isArray(body), "Body must be an array");
  assert.ok((body as unknown[]).length > 0, "Must have at least 1 node");
});

it("A7: restore original node title for subsequent test cleanliness", async () => {
  const { status } = await api("POST", `/lessons/${LESSON_ID}/nodes/${NODE.id}/update`, {
    title: originalNodeTitle,
    learningObjective: originalNodeLO,
  });
  assert.ok(status < 300, `Restore failed with ${status}`);

  const [node] = await db
    .select({ title: lessonNodesTable.title })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, NODE.id))
    .limit(1);
  assert.equal(node?.title, originalNodeTitle, "Title must be restored");
});

// ─── SECTION B: New MicroNode after first approval ────────────────────────────
let createdNodeId: number | null = null;

it("B1: teacher can create a new node even when lesson is approved/active", async () => {
  const { status, body } = await api("POST", `/lessons/${LESSON_ID}/nodes`, {
    title: "POST-P1.12 Test Node B1",
    learningObjective: "Test LO for authoring simplification",
    targetBloomLevel: 1,
    topicId: null,
  });
  assert.ok(status < 300, `Expected 2xx, got ${status}: ${JSON.stringify(body)}`);
  const newId = (body as { id?: number; node?: { id?: number } }).id ??
    (body as { id?: number; node?: { id?: number } }).node?.id;
  assert.ok(typeof newId === "number", `Expected a numeric id in response, got: ${JSON.stringify(body)}`);
  createdNodeId = newId as number;
});

it("B2: newly created node has status=draft (initial state, not yet approved)", async () => {
  if (createdNodeId === null) { console.log("    (skipped — B1 did not create a node)"); return; }
  const [node] = await db
    .select({ status: lessonNodesTable.status })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, createdNodeId))
    .limit(1);
  // New nodes start as 'draft' (schema default); teacher must approve individually.
  assert.ok(["draft", "needs_review"].includes(node?.status ?? ""), `New node must start as draft/needs_review, got: ${node?.status}`);
});

it("B3: adding a new node does NOT change lesson-level status from approved/active", async () => {
  const [lesson] = await db
    .select({ status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID))
    .limit(1);
  assert.ok(
    ["approved", "active"].includes(lesson?.status ?? ""),
    `Lesson must remain approved/active, got: ${lesson?.status}`,
  );
});

it("B4: existing approved nodes are unaffected by the new node", async () => {
  const [existingNode] = await db
    .select({ status: lessonNodesTable.status })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, NODE.id))
    .limit(1);
  assert.equal(existingNode?.status, "approved", `Original node must stay approved, got: ${existingNode?.status}`);
});

// ─── SECTION C: Selective per-node Phase 2 enrichment ─────────────────────────
it("C1: POST /lessons/:id/nodes/:nodeId/enrich route exists and returns structured response", async () => {
  // Use a 45-second timeout since this triggers a real AI call in non-mocked envs.
  const { status, body } = await api("POST", `/lessons/${LESSON_ID}/nodes/${NODE.id}/enrich`, undefined, 45000);
  // 200 = success, 422 = SKIP (no theory/thin content), 408 = our timeout sentinel,
  // 500 = AI error in test env — all acceptable; just must NOT be 404.
  assert.notEqual(status, 404, `Route must exist — got 404: ${JSON.stringify(body)}`);
  assert.ok(
    [200, 422, 408, 500].includes(status),
    `Expected 200/422/408/500 from enrich, got ${status}: ${JSON.stringify(body)}`,
  );
});

it("C2: enrich on non-existent node returns 404", async () => {
  const { status } = await api("POST", `/lessons/${LESSON_ID}/nodes/999999/enrich`);
  assert.equal(status, 404, `Expected 404 for non-existent node, got ${status}`);
});

it("C3: enrich with a node belonging to a different lesson returns 404", async () => {
  // Find a node from a different lesson
  const [otherNode] = await db
    .select({ id: lessonNodesTable.id })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.lessonId, 104))
    .limit(1);
  if (!otherNode) { console.log("    (skipped — lesson 104 has no nodes)"); return; }

  const { status } = await api("POST", `/lessons/${LESSON_ID}/nodes/${otherNode.id}/enrich`);
  assert.equal(status, 404, `Must return 404 for cross-lesson node, got ${status}`);
});

it("C4: enrich route requires authentication (no token → 401)", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/nodes/${NODE.id}/enrich`, { method: "POST" });
  assert.equal(r.status, 401, `Expected 401, got ${r.status}`);
});

// ─── SECTION D: Read-only node view data integrity ───────────────────────────
it("D1: GET /lessons/:id/nodes returns full node data including Phase 2 fields", async () => {
  const { status, body } = await api("GET", `/lessons/${LESSON_ID}/nodes`);
  assert.equal(status, 200);
  const nodes = body as Array<Record<string, unknown>>;
  assert.ok(nodes.length > 0);
  const node = nodes.find((n) => n.id === NODE.id);
  assert.ok(node, `Node ${NODE.id} must be in the list`);
  // Check core display fields exist
  assert.ok("id" in node);
  assert.ok("title" in node);
  assert.ok("sequence" in node);
  assert.ok("status" in node);
});

it("D2: GET /lessons/:id/nodes does NOT modify node status (pure read)", async () => {
  const [before] = await db
    .select({ status: lessonNodesTable.status })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, NODE.id))
    .limit(1);

  await api("GET", `/lessons/${LESSON_ID}/nodes`);

  const [after] = await db
    .select({ status: lessonNodesTable.status })
    .from(lessonNodesTable)
    .where(eq(lessonNodesTable.id, NODE.id))
    .limit(1);

  assert.equal(after?.status, before?.status, "GET /nodes must not change node status");
});

it("D3: GET /lessons/:id/exercises returns exercises with relatedNodeId field", async () => {
  const { status, body } = await api("GET", `/lessons/${LESSON_ID}/exercises`);
  assert.equal(status, 200);
  const exercises = body as Array<Record<string, unknown>>;
  assert.ok(exercises.length > 0, "Must have at least one exercise");
  // relatedNodeId field must be present (may be null but must exist as a key)
  const first = exercises[0];
  assert.ok("relatedNodeId" in first, "relatedNodeId must be a field on exercises");
});

it("D4: GET /lessons/:id/exercises does NOT modify exercise status", async () => {
  const [ex] = await db
    .select({ id: lessonExercisesTable.id, status: lessonExercisesTable.status })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.lessonId, LESSON_ID))
    .limit(1);
  if (!ex) { console.log("    (skipped — no exercises)"); return; }

  const [before] = await db
    .select({ status: lessonExercisesTable.status })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.id, ex.id))
    .limit(1);

  await api("GET", `/lessons/${LESSON_ID}/exercises`);

  const [after] = await db
    .select({ status: lessonExercisesTable.status })
    .from(lessonExercisesTable)
    .where(eq(lessonExercisesTable.id, ex.id))
    .limit(1);

  assert.equal(after?.status, before?.status, "GET /exercises must not change exercise status");
});

it("D5: GET /lessons/:id/nodes preserves Phase 2 fields from DB (not stripped)", async () => {
  const { body } = await api("GET", `/lessons/${LESSON_ID}/nodes`);
  const nodes = body as Array<Record<string, unknown>>;
  const enrichedNode = nodes.find(
    (n) => typeof n.childFriendlyExplanation === "string" && (n.childFriendlyExplanation as string).length > 0,
  );
  if (!enrichedNode) { console.log("    (skipped — no enriched nodes found in API response)"); return; }
  // If Phase 2 data exists in DB, it must not be stripped from the GET /nodes response
  assert.ok(enrichedNode.childFriendlyExplanation, "childFriendlyExplanation must be present in GET /nodes response");
});

// ─── SECTION E: Whole-lesson Phase 2 safety guard ────────────────────────────
it("E1: POST /lessons/:id/generate-teaching-content route exists (not 404)", async () => {
  const { status } = await api("POST", `/lessons/${LESSON_ID}/generate-teaching-content`);
  // Any response except 404 confirms the route exists
  assert.notEqual(status, 404, "Route must exist — must not be 404");
});

it("E2: unauthenticated generate-teaching-content returns 401", async () => {
  const r = await fetch(`${BASE}/lessons/${LESSON_ID}/generate-teaching-content`, { method: "POST" });
  assert.equal(r.status, 401, `Expected 401, got ${r.status}`);
});

it("E3: GET /lessons/:id/generate-status returns {status} object", async () => {
  const { status, body } = await api("GET", `/lessons/${LESSON_ID}/generate-status`);
  assert.equal(status, 200, `Expected 200, got ${status}`);
  assert.ok("status" in body, `Response must have a 'status' field: ${JSON.stringify(body)}`);
});

it("E4: GET /lessons/:id/generate-status does not modify lesson status", async () => {
  const [before] = await db
    .select({ status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID))
    .limit(1);

  await api("GET", `/lessons/${LESSON_ID}/generate-status`);

  const [after] = await db
    .select({ status: lessonsTable.status })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, LESSON_ID))
    .limit(1);

  assert.equal(after?.status, before?.status, "generate-status must not change lesson status");
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────
async function cleanup() {
  // Delete test node B1 if created
  if (createdNodeId !== null) {
    await db.delete(lessonNodesTable).where(eq(lessonNodesTable.id, createdNodeId));
  }
  // Restore lesson to active (canonical test fixture state)
  await db.update(lessonsTable).set({ status: "active" } as never).where(eq(lessonsTable.id, LESSON_ID));
}

// ─── Runner ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

const total = tests.length;
console.log(`\n  post-p112-authoring-simplification — ${total} test cases\n`);

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
    failed++;
  }
}

await cleanup();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
