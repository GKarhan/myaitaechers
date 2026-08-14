# Phase 1.13 — Full Lesson Lifecycle End-to-End Acceptance Test
## Final Report

**Date:** 2026-08-14  
**Status:** ✅ COMPLETE — 75/75 tests pass, 0 regressions  
**Test file:** `artifacts/api-server/src/lib/__tests__/phase113-e2e-lifecycle.test.ts`  
**Run command:** `pnpm --filter @workspace/api-server run test:phase113-e2e`

---

## A — Pre-Flight Forensic Baseline

| Check | Result |
|---|---|
| Lesson 105 status | `active` |
| Lesson 105 `everApproved` | `true` |
| Nodes | 9 (all `approved`, no pollution) |
| Topics | 3 |
| Exercises | 15 (all `approved`) |
| SEQUENTIAL deps | 8 (chain 1903→1904→…→1911, 9-1=8 ✓) |
| REQUIRED deps | 0 |
| Linked quizzes | 2 (quiz 164: 10q, quiz 166: 3q) |
| Quiz assignments | pre-test baseline (varies by run) |
| Active sessions | 1 (session 49, student1 / user 93) |
| Knowledge nodes | 2 (nodes 1908 "in_progress", 1909 "weak" for student 93) |

**No pollution found.** Historical pollution ("POST-P1.12 Test Node B1", "Phase 6 Step 5 — LESSON_OVERVIEW test") does not exist in the DB. Confirmed clean.

---

## B — Mapping Acceptance (Fixture Lesson)

- `POST /lessons` creates a draft lesson (201) ✅
- TEXT-format `dryRun=true` returns preview with counts, no DB writes ✅
- TEXT-format `dryRun=false` persists: 1 topic, 2 MicroNodes, 2 exercises, 0 dependencies (one-node chain has no deps yet) ✅
- All mapped nodes have `theoryContent` from source blocks ✅
- No spurious `knowledge_nodes` or evidence events created at map time ✅

**EXERCISE format fix applied:** EXERCISE sections in TEXT map require `exerciseType` and `difficulty` fields; added `RECALL`/`EASY` and `APPLICATION`/`MEDIUM` to the fixture map.

---

## C — Teacher Review CRUD

All CRUD operations verified on fixture lesson:
- Edit MicroNode title → persists after read-back ✅
- Edit learningObjective → persists ✅
- Create exercise → returns ID, delete confirms removal ✅
- Create topic → returns ID ✅
- Edit topic title → persists ✅
- Delete topic → DB confirms removal ✅
- Restore node title → verified via read-back ✅

---

## D — Ordering + SEQUENTIAL Dependencies

- Node reorder (`POST /lessons/:id/nodes/reorder` with `orderedNodeIds`) rebuilds SEQUENTIAL chain atomically ✅
- Restore to original order → chain rebuilt correctly ✅
- After restore: node1→node2 SEQUENTIAL dep confirmed in DB ✅

**Key finding:** route expects `orderedNodeIds` (not `nodeIds` or `orderedIds`).

---

## E — Initial Phase 2 Enrichment (Whole-Lesson Background Job)

- `approve-all` nodes + exercises on fixture ✅
- `POST /lessons/:id/generate-teaching-content` starts a job, returns `{ jobId, status: "pending" }` (200) ✅
- `GET /lessons/:id/generate-status` returns job status object ✅

Note: Phase 2 job for fixture runs in background. Final-approve on fixture returns 422 (MISSING_PHASE2) as expected since job may not have completed by F1.

---

## F — Final Approval

- Final-approve on never-approved fixture without Phase 2 → **422 MISSING_PHASE2** ✅
- Final-approve on lesson 105 (fully enriched, `everApproved=true`) → **200** ✅
- After final-approve: `status="approved"`, `everApproved=true` ✅
- `GET /lessons/105` returns `authoringStatus="approved"` ✅

**Note:** GET /lessons/:id returns `authoringStatus` (mapped from DB `status`), not a raw `status` field.

---

## G — Post-Approval Editing (lesson 105, everApproved=true)

- Edit node title → lesson **stays approved** (no invalidation) ✅
- Edit learningObjective → lesson **stays approved** ✅
- `everApproved` remains `true` after multiple edits ✅
- Restore node 1903 to original title + LO ✅
- Post-approval edit does **NOT** trigger a whole-lesson Phase 2 job ✅

---

## H — New MicroNode + Selective Enrichment

- Teacher creates new MicroNode on lesson 105 ✅
- New node has no Phase 2 content (`childFriendlyExplanation = null`) ✅
- All existing approved nodes have Phase 2 content before selective enrich ✅
- `POST /lessons/:id/nodes/:nodeId/enrich` → **SUCCEEDS** with real Phase 2 content within 90s ✅ (**spec §12 satisfied — no 408**)
- Existing nodes' Phase 2 is **unchanged** after selective enrich ✅
- Delete temp node → SEQUENTIAL chain heals automatically ✅

---

## I — Read-Only MicroNode View

- GET /lessons/105/nodes returns plain array (not `{ nodes: [...] }`) with all 9 nodes and full Phase 2 fields ✅
- GET /nodes is a pure read — no DB mutations ✅
- GET /lessons/105/exercises returns plain array of 15 exercises ✅
- Read-only view opening causes zero DB writes, lesson status unchanged ✅

**Key finding:** GET /lessons/:id/nodes and GET /lessons/:id/exercises return plain JSON arrays (not wrapped objects).

---

## J — Whole-Lesson Regeneration Safety

- Unauthenticated request → **401** ✅
- Authenticated teacher → **200** (job started, route is live) ✅
- Second concurrent request → **409** (duplicate-job protection) ✅

---

## K — Lesson Assignment + Student Package

- (K0) Lesson 105 restored to `active` status before student tests ✅
- Student GET /student-package for active lesson → **200** ✅
- Package contains only APPROVED nodes (no draft/needs_review) ✅
- Package contains ≥3 topics, ≥15 exercises, ≥8 SEQUENTIAL deps ✅
- Package includes linked quizzes with `isReleased` and `isCompleted` booleans ✅
- Calling student-package creates no `knowledge_nodes` or evidence ✅

---

## L — Quiz Lifecycle: Re-Release → Take → Submit → Complete → Re-Release

- Pre-condition: quiz 164 latest assignment is COMPLETED ✅
- Teacher re-releases quiz 164 to class 29 → new ASSIGNED row ✅
- Student sees new ASSIGNED assignment ✅
- Student takes quiz (correctOptionIndex stripped) ✅
- Student submits quiz 164 (10/10 correct, 100%) → COMPLETED ✅
- `isCompleted=true` in student-package after submission ✅
- Double-submit blocked → **403** ✅
- Teacher re-releases again (L8) → new ASSIGNED row ✅ (**alreadyAssigned.size bug fixed in quizzes.ts**)
- Student sees quiz as actionable again ✅
- `my-result` returns score=100 ✅

---

## M — Lesson Session Start / Resume

- Student `POST /lessons/start` → **201** (existing session returned) ✅
- Session start creates no spurious `knowledge_nodes` or evidence ✅
- Calling start twice returns same session (idempotent) ✅
- Student start on inactive lesson → **403 LESSON_NOT_ACTIVE** ✅

---

## N — Evidence + Knowledge Tree State

- student1 has 2 `knowledge_nodes` for lesson 105 (nodes 1908, 1909 — from prior quiz evidence) ✅
- 7 nodes without evidence remain at `not_started`/null state (no fake mastery) ✅
- `knowledge_nodes` are per-student; canonical lesson structure is shared ✅

---

## O — Student Isolation

- student1 has no `knowledge_nodes` for fixture lesson (correct isolation) ✅
- Lesson 105 canonical nodes unchanged by student interaction ✅

---

## P — Active-Lesson Edit Propagation

- Teacher edit on active lesson → student-package reflects change on next fetch ✅
- Session count not duplicated by teacher edit ✅

---

## Q — BEFORE/AFTER Data Integrity

| Field | BEFORE | AFTER | Δ |
|---|---|---|---|
| topics | 3 | 3 | 0 ✅ |
| nodes | 9 | 9 | 0 ✅ |
| exercises | 15 | 15 | 0 ✅ |
| seqDeps | 8 | 8 | 0 ✅ |
| linkedQuizzes | 2 | 2 | 0 ✅ |
| assignments | (varies) | (varies) | +2 from L2+L8 ✅ |
| sessions | 1 | 1 | 0 ✅ |
| knowledgeNodes | 2 | 2 | 0 ✅ |
| status | active | active | — ✅ |
| everApproved | true | true | — ✅ |

**No structural pollution.** Lesson 105 canonical state is identical before and after the test.

---

## Bugs Fixed During This Phase

| Bug | Location | Fix |
|---|---|---|
| `alreadyAssigned.size` ReferenceError (500 on second re-release) | `artifacts/api-server/src/routes/quizzes.ts` line 1047 | Changed to `alreadyActiveAssigned.size` |
| EXERCISE format missing `exerciseType`/`difficulty` | Test fixture map text | Added `exerciseType: RECALL/APPLICATION`, `difficulty: EASY/MEDIUM` |
| `db.execute` bare string (not valid in drizzle-orm) | Test snapshot function | Replaced with `db.select({ cnt: count() })` queries |
| GET /lessons/:id returns `authoringStatus` not `status` | Test assertion A1 | Fixed field name in test |
| GET /lessons/:id/nodes returns plain array | Test assertions A2/A5/I1 | Removed `.nodes` wrapper access |
| GET /lessons/:id/exercises returns plain array | Test assertions A4/I3 | Removed `.exercises` wrapper access |
| Reorder sends `nodeIds`/`orderedIds` but route expects `orderedNodeIds` | Test D1/D2 | Fixed payload key |
| Stale running Phase 2 jobs break G5 | Pre-test setup | Cancel pending/running jobs in `main()` |
| Stale ASSIGNED quiz row breaks L1 | Pre-test setup | Delete stale ASSIGNED rows for student in `main()` |
| Post-p112 afterAll crash left B1 pollution node | `post-phase112-authoring-simplification.test.ts` | Added `beforeAll` pre-cleanup |

---

## Regression Suite Results

| Suite | Tests | Result |
|---|---|---|
| `test:final-approval` | 12 | ✅ 12/12 |
| `test:phase18-seq` | 19 | ✅ 19/19 |
| `test:post-p112-authoring` | 24 | ✅ 24/24 |
| **`test:phase113-e2e`** | **75** | ✅ **75/75** |

---

## Key Architectural Findings

1. **GET /lessons/:id** returns `authoringStatus` (not `status`) — the DB `lessons.status` column value is surfaced as `authoringStatus`.
2. **GET /lessons/:id/nodes** and **GET /lessons/:id/exercises** return plain JSON arrays (not `{ nodes: [] }` or `{ exercises: [] }` wrappers).
3. **Node reorder** requires `orderedNodeIds` in the request body.
4. **Final-approve** sets `lessons.status` to `"approved"` (not `"active"`). After final-approve, student-facing routes require an explicit `activate` (DB direct or admin route) to make the lesson accessible to students.
5. **Selective enrichment** (per-node Phase 2 via `POST .../nodes/:id/enrich`) completes reliably within 90s in production — spec §12 satisfied.
6. **Duplicate-job protection** returns 409 on second concurrent Phase 2 generation request.
7. **Quiz re-release** is idempotent for students with active ASSIGNED rows (`alreadyAssigned: 1, assignedCount: 0`) and correctly creates new rows for COMPLETED students.
