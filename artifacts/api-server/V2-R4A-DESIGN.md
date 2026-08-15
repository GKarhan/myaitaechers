# AI Teacher V2-R4A: Learning Budget, Pace & Session Completion
## Architecture / Design Report

**Status: DESIGN ONLY — No code changed**
**Date: 2026-08-15**

---

## A. Current Runtime Audit

### A1. lesson_sessions schema (verified from source)

| Column | Type | Default | Nullable | Current Semantics |
|---|---|---|---|---|
| `id` | serial | — | NO | PK |
| `userId` | integer | — | NO | FK users.id |
| `lessonId` | integer | — | NO | FK lessons.id |
| `currentPhase` | integer | `1` | NO | Phase machine (1=review, 2=teaching, 3=done) |
| `status` | text | `'active'` | NO | **Never written to 'completed'** — gap confirmed |
| `masteryScore` | integer | — | YES | Written at session end |
| `currentNodeId` | integer | — | YES | FK lesson_nodes.id; set null when all done |
| `nodeStartedAt` | timestamp(tz) | — | YES | When current node began; reset per node advance ✅ |
| `nodeAttemptCount` | integer | `0` | NO | AI turns on current node (safety cap) |
| `startedAt` | timestamp(tz) | `now()` | NO | **Session wall-clock start — reliable ✅** |
| `completedAt` | timestamp(tz) | — | YES | **In schema but NEVER WRITTEN — gap** |
| `remediationStep` | integer | `0` | NO | V2-R3 escalation step |
| `activeCognitiveLevelId` | integer | — | YES | FK lesson_node_cognitive_levels.id |
| `activeHelpCount` | integer | `0` | NO | Help events on current task |
| `activeAssistanceLevel` | text | `'none'` | NO | Max help level reached |
| (all other active task fields) | — | — | — | Phase 2B task identity |

**Not present in lesson_sessions:** `activeLearningSeconds`, `lastActivityAt`, `requiredSessionMinutes`, `optionalContinuation`, `requiredSessionCompletedAt`. Zero time/budget fields exist.

### A2. lessons schema (verified)

| Column | Type | Semantics | R4 Relevant? |
|---|---|---|---|
| `completedAt` | timestamp(tz) nullable | Lesson-level completion date | No — not session-specific |
| `assignedAt` | timestamp(tz) nullable | When lesson was assigned | No |
| (estimatedMinutes) | **ABSENT** | Not on lessons table | Gap for R4 |

**No `estimatedMinutes`, `requiredSessionMinutes`, or any duration field on `lessons`.**

### A3. lesson_nodes schema (verified)

| Column | Type | Default | Semantics |
|---|---|---|---|
| `estimatedMinutes` | integer | `5` | **Per-node pedagogical duration estimate** — teacher-editable in dashboard |

This is the **only** duration signal in the entire system. It lives at node granularity, not lesson granularity.

### A4. knowledge_nodes schema (verified)

| Column | Type | Default | Semantics |
|---|---|---|---|
| `demonstratedCognitiveLevel` | text | NULL | Highest confirmed Bloom level (V2-R3 write-through) |
| `revisitRequired` | boolean | `false` | Set when remediation budget exhausted |

`revisitRequired` has **no reason field**. Its current only meaning is "remediation_exhausted". R4 needs to distinguish this from "deferred due to time budget". See Section J.

### A5. Time signals currently available

| Signal | Where | Resolution | Reliable? | Notes |
|---|---|---|---|---|
| `startedAt` | lesson_sessions | Per-session | ✅ | `defaultNow()`, set once at insert |
| `nodeStartedAt` | lesson_sessions | Per-node | ✅ | Reset on every `advanceNodeInSession()` |
| `lesson_nodes.estimatedMinutes` | lessons | Per-node | Estimate | Teacher-entered; not measured time |
| `userMessageAt = Date.now()` | chat.ts (local only) | Per-request | ✅ | Never persisted — discarded after response-time log |
| `chatMessagesTable.createdAt` | chat_messages | Per-message | ✅ | Persisted but not used for time accounting |

**No elapsed, active, or budgeted time is tracked anywhere.**

### A6. Session lifecycle — actual runtime paths

**Creation:** `startSession.mutate({ lessonId })` → backend inserts lesson_sessions with `startedAt=now(), status='active', currentPhase=1`. `startedAt` is reliable.

**Resume (refresh/re-open):** `lesson.currentSession` fetched via GET lesson detail. No timestamp is updated. The session row's `startedAt` is **not reset** on resume — it reflects the original start correctly.

**Phase advance:** `advancePhase` route increments `currentPhase`. When all nodes complete and `currentPhase=2`, `advanceNodeInSession` sets `currentPhase=3, currentNodeId=null`.

**Completion path — critical gap:**  
- `status` is **never written to 'completed'** by any backend route in chat.ts or any visible route.  
- `completedAt` is **never written**.  
- The frontend checks `session?.status === "completed"` — this can never be true from the current backend. The completion screen is currently unreachable via the normal flow (likely a legacy code path from an older explicit completion API). The P6 summary is triggered manually by the "Finish lesson" button, which calls `advancePhase`, but `status` still stays `'active'`.  
- This is a **pre-existing gap R4 must address**.

**`advanceNodeInSession()` resets:** `currentNodeId`, `nodeStartedAt` (new Date()), `nodeAttemptCount=0`, `currentPhase`, all node counters, all active task state, `remediationStep=0`. Does NOT touch `startedAt`, `completedAt`, or any time budget.

### A7. Teacher configuration surface (verified)

- **Only per-node `estimatedMinutes`** is configurable in the teacher dashboard (`teacher-dashboard.tsx` lines 848–855, 1302, 1323, 1691–1698).
- **No lesson-level duration**, **no assignment-level required time**, **no session budget UI** exists.
- Teacher assignment list contains id/title/status/course/class/assignedAt only — **no duration fields**.

### A8. Student frontend time/session UI (verified)

- **No timer, countdown, or remaining-time indicator** of any kind.
- **No optional continuation button**. The completion screen has only "Վերադառնալ Առարկային →".
- Dashboard "Շարունակել" button exists when `mySessionStatus === 'active'` — generic resume, no time context.
- `estimatedMinutes` is not displayed to students anywhere.
- **No `setInterval`, heartbeat, or activity detection** in `src/`.

### A9. Decision engine (verified from pedagogicalDecisionEngine.ts)

Current `PedagogicalDecisionInput` has **zero time/budget fields**. Current `PedagogicalMetaAction` enum:
```
NON_ANSWER | NO_COGNITIVE_PATH | CONTINUE_COGNITIVE_LEVEL | REQUEST_INDEPENDENT_CHECK
| MARK_LEVEL_CONFIRMED | ADVANCE_COGNITIVE_LEVEL | MARK_TARGET_NOT_REACHED
| REVISIT_LATER | COMPLETE_NODE
```

**Not present:** `STOP_LEVEL_AND_REVISIT`, `END_REQUIRED_SESSION`, `OFFER_OPTIONAL_CONTINUATION`.

---

## B. Existing Time/Session Fields

### B1. Fields that CAN be reused for R4

| Field | Why reusable |
|---|---|
| `lesson_sessions.startedAt` | Reliable wall-clock session start. Use for elapsed-time calculation. |
| `lesson_sessions.nodeStartedAt` | Per-node start time. Enables per-node effort measurement without a new field. |
| `lesson_nodes.estimatedMinutes` | Sum across lesson nodes gives a crude initial `requiredSessionMinutes` estimate. Can be used as the lesson default via `SUM(estimatedMinutes)` if no explicit override is set. |
| `chat_messages.createdAt` | Turn-level timestamps exist. Inter-turn interval can be computed from consecutive rows. Never used for budget but the data is available. |

### B2. Fields that CANNOT be safely reused

| Field | Why not |
|---|---|
| `lessons.completedAt` | Lesson-level timestamp, not session-specific. Multiple students' sessions cannot share one value. |
| `lesson_sessions.completedAt` | In schema, never written — semantics undefined. R4 should define and write it, but it cannot be read as a meaningful signal today. |
| `lesson_sessions.status` | Never set to 'completed'. Treating 'active' as open-ended is the current implicit semantic. |

---

## C. Current Session Lifecycle

```
INSERT lesson_sessions (startedAt=now(), status='active', phase=1)
  ↓
Phase 1 — Review turns (chat.ts)
  ↓ [PHASE1_CAP or early exit]
Phase 2 — Teaching turns (advanceNodeInSession per node)
  ↓ [all nodes done]
  → currentPhase=3, currentNodeId=null
  ↓
advancePhase route → currentPhase=4 (?)
  ↓
handleFinishLesson (frontend) → advancePhase + POST /p6-summary
  ↓
[completion screen shown — but status NEVER = 'completed']
```

**Missing from current lifecycle:**
- No `status='completed'` write
- No `completedAt` write
- No required-session vs optional distinction
- No time budget consumption tracking
- No "session budget exhausted" event

---

## D. Active-Time Measurement Options

| Approach | Description | Pros | Cons |
|---|---|---|---|
| **D1. Raw wall-clock** | `now() - startedAt` | Zero new fields | Completely wrong after idle. Student leaves browser open → 40 min credited. |
| **D2. Turn-based capped intervals** | Each chat response: `min(now() - lastActivityAt, CAP)` added to `activeLearningSeconds` | Simple, persisted, resumable, no client code | Some over-counting if student stares at the screen. Still over-counts slow-readers. |
| **D3. Client heartbeat** | Frontend sends periodic alive signal | More accurate | Requires frontend polling, server-side dedup, offline risk, adds complexity. |
| **D4. Explicit pause/resume** | UI button to pause timer | Perfectly accurate | Students won't use it; adds UI friction; irrelevant for most sessions. |
| **D5. Turn-count × estimated-cost** | `nodeAttemptCount × estimated_minutes_per_turn` | No timer needed | Too synthetic; doesn't reflect real time. |
| **D6. Cognitive-cost-weighted turns** | Future (Part 12) | Richer | Not for R4. |

**Comparison summary:**

D1 is broken and must be rejected.  
D3–D4 require significant client changes or add friction.  
D5 is synthetic and wrong.  
**D2 (capped-interval) is the minimum safe V1 approach.** It will over-count if a student is slow but reads continuously; it will not credit idle time beyond `CAP`. A cap of 3–4 minutes per inter-turn interval is a reasonable V1 choice: a student who takes 3+ minutes between turns is likely not actively learning.

---

## E. Recommended Minimal Active-Time Model (for R4)

**Model: Turn-based capped intervals**

- `lesson_sessions.lastActivityAt` — timestamp of when the last chat response was sent (written at the END of each `POST /api/chat` handler before `res.json()`).
- `lesson_sessions.activeLearningSeconds` — running sum of credited active seconds (integer, NOT NULL, DEFAULT 0).
- **Per-turn accounting:** `interval = now() - lastActivityAt`. Credit `min(interval, CAP_SECONDS)` seconds. Update `activeLearningSeconds += credit`, then update `lastActivityAt = now()`.
- **CAP_SECONDS:** 180 seconds (3 minutes) recommended for V1.
- **First turn:** `lastActivityAt` is null → credit `min(now() - startedAt, CAP_SECONDS)` for the first turn's interval.
- **Resume safety:** Because `lastActivityAt` is persisted, a student who closes the browser and returns has a large gap between the last stored `lastActivityAt` and the next turn's timestamp. This gap is capped, so idle time is absorbed correctly.

This model requires **two new persisted fields** and **two lines of code per chat turn**.

**What it does not solve:**
- Very slow readers who are actively reading but haven't typed yet (over-counts time slightly).
- AFK students who return within the cap window (counts up to CAP even if student was away).

Both are acceptable for a V1 learning-time model.

---

## F. Teacher/Assignment Budget Ownership

### F1. Current architecture

- No lesson-level duration exists.
- No assignment-level duration exists.
- Per-node `estimatedMinutes` is the only configuration point.
- No class-schedule-level session duration (schedule table has day/time/startTime/endTime but is generic class scheduling, not lesson-specific budget).

### F2. What minimal hierarchy does R4 need?

**Option 1 (minimal):** `lessons.requiredSessionMinutes` INT nullable
- Teacher sets once per lesson. Null = no budget (unlimited, existing behavior).
- Snapshotted into `lesson_sessions.requiredSessionMinutes` at session creation.
- **No assignment-level override for R4.**

**Option 2:** `lessons.requiredSessionMinutes` + per-assignment override
- Requires a lesson_assignments table that doesn't exist.
- **Rejected for R4 — over-engineering.**

**Option 3:** `lessons.estimatedMinutes` (pedagogical estimate) + `lessons.requiredSessionMinutes` (student required budget) as separate fields
- These ARE semantically different:
  - `estimatedMinutes` = "how long this lesson takes a typical student" (teacher's pedagogical estimate, may be used in curriculum planning, could vary per student)
  - `requiredSessionMinutes` = "how many minutes the student must actively engage before required learning is complete"
- They should remain separate fields to avoid future semantic confusion.
- BUT for V1: a single `requiredSessionMinutes` is sufficient. The SUM of `lesson_nodes.estimatedMinutes` is already derivable and can serve as a suggested default in the UI.

**Recommendation for R4:**

Add `requiredSessionMinutes` to `lessons` only (integer nullable, null = no budget).  
Snapshot into `lesson_sessions.requiredSessionMinutes` at session creation (so mid-lesson teacher edits don't change the student's in-progress contract).  
Do NOT add assignment-level override in R4.

Fallback chain for "what is the required session budget?":
```
lesson_sessions.requiredSessionMinutes (snapshot)
  → set from lessons.requiredSessionMinutes at session creation
  → null = no required budget (unlimited — existing behavior preserved)
```

### F3. estimatedMinutes vs requiredSessionMinutes distinction

| Field | Proposed owner | Semantics | Used for |
|---|---|---|---|
| `lesson_nodes.estimatedMinutes` | curriculum | Pedagogical time per node | AI prompt context, teacher planning |
| `lessons.requiredSessionMinutes` | teacher | Required student session time | Budget gate, session completion trigger |

Do NOT silently reuse `estimatedMinutes` as a required-session budget. They are different concepts.

---

## G. Decision Engine Integration

### G1. Architecture principle

**The decision engine must remain the single pedagogical state machine.** R4 must NOT create a parallel timer-based state machine. Time budget becomes a new **deterministic input** to the existing `decideNextPedagogicalAction()` function.

### G2. New inputs to PedagogicalDecisionInput

Add two boolean signals computed by the caller (chat.ts) before calling the engine:

```typescript
// ── R4 Budget signals (computed by chat.ts before call) ─────────────────
/**
 * true when session activeLearningSeconds >= requiredSessionMinutes * 60.
 * Computed deterministically by backend; AI never sees or overrides this.
 */
sessionBudgetExhausted: boolean;

/**
 * true when the local effort on this node exceeds the local node budget.
 * V1: computed as (now() - nodeStartedAt) >= LOCAL_NODE_BUDGET_SECONDS
 *     AND sessionBudgetExhausted = false (session budget takes priority)
 * Future: also considers remediationStep, node estimatedMinutes, remaining session.
 */
localNodeBudgetExhausted: boolean;
```

Both are backend-computed. The AI never owns either signal.

### G3. New metaActions

```typescript
type PedagogicalMetaAction =
  // ... existing R3 actions ...
  | "STOP_LEVEL_AND_REVISIT"    // local node budget exhausted; defer this level
  | "END_REQUIRED_SESSION"      // session budget exhausted; end required portion
```

`OFFER_OPTIONAL_CONTINUATION` is NOT a metaAction — it is a frontend UX state triggered by `END_REQUIRED_SESSION` or natural lesson completion. The decision engine does not own UX.

### G4. New decision flow (R4 extended)

```
[Start — wasEval=true]

1. answerStatus null/NOT_APPLICABLE/OFF_TOPIC → NON_ANSWER [R3]

2. Session budget check (NEW R4 — checked FIRST after guard):
   IF sessionBudgetExhausted → END_REQUIRED_SESSION
   (return immediately; do not process further)

3. Cognitive path check → NO_COGNITIVE_PATH if missing [R3]

4. Independence + quality + evidence gates [R3]
   → ADVANCE / COMPLETE / REQUEST_INDEPENDENT_CHECK [R3]

5. Incorrect path:
   5a. Local node budget check (NEW R4):
       IF localNodeBudgetExhausted → STOP_LEVEL_AND_REVISIT
   5b. Remediation budget check [R3]:
       IF nextStep > MAX_REMEDIATION_STEPS → REVISIT_LATER / MARK_TARGET_NOT_REACHED
   5c. CONTINUE_COGNITIVE_LEVEL [R3]
```

**Critical ordering:** Session budget gate (step 2) fires BEFORE any pedagogical logic. This ensures that even a correct answer does not get processed if the required session is already over — the response should complete the current interaction safely (step 13 below) and then signal END_REQUIRED_SESSION.

### G5. Future cognitive-cost integration point

The `localNodeBudgetExhausted` signal is computed by chat.ts today as a simple elapsed-time check. In a future round, this computation becomes:

```typescript
localNodeBudgetExhausted = computeLocalNodeBudget({
  nodeStartedAt,
  activeLearningSeconds,           // from session
  remediationStep,                 // from session
  estimatedMinutes,                // from lesson_nodes
  requiredSessionMinutes,          // from lesson_sessions
  learnerReadinessP: null,         // future R-round input
  observedPace: null,              // future
  cognitiveLevel: activeCognLevel, // future weighting
})
```

The interface slot exists now; the logic inside is a future concern. R4 should define the function signature but use a simple elapsed-time implementation.

---

## H. Remediation + Budget Ordering

Current R3 engine ordering:

```
1. Evaluate evidence
2. Check cognitive level confirmation
3. If not confirmed and incorrect → check MAX_REMEDIATION_STEPS
4. If within budget → CONTINUE_COGNITIVE_LEVEL
5. If budget exhausted → REVISIT_LATER / MARK_TARGET_NOT_REACHED
```

R4 insertion:

```
1. Evaluate evidence
2. Check session budget (NEW) → END_REQUIRED_SESSION if exhausted
3. Check cognitive level confirmation [R3]
4. If not confirmed and incorrect:
   4a. Check local node budget (NEW) → STOP_LEVEL_AND_REVISIT if exhausted
   4b. Check MAX_REMEDIATION_STEPS [R3] → REVISIT_LATER / MARK_TARGET_NOT_REACHED
   4c. → CONTINUE_COGNITIVE_LEVEL [R3]
```

**Invariant:** `MAX_REMEDIATION_STEPS` remains the absolute hard ceiling. Learning budget may stop remediation EARLIER (step 4a fires before 4b). The hard ceiling (4b) still fires even if local budget logic doesn't detect exhaustion.

The two budget checks are COMPLEMENTARY:
- **Session budget** (step 2): global ceiling on the entire session.
- **Local node budget** (step 4a): per-node soft ceiling that allows the session to advance to remaining nodes.

---

## I. Time Limit ≠ Failure Invariants

**The following is mandatory for R4:**

### I1. Session expiry before a level is attempted

Situation: Session budget exhausted while student is on node B at level "remember". Node A's "apply" level was never reached.

Correct behavior:
- `knowledge_nodes.demonstratedCognitiveLevel` for node A stays at `'understand'` (or wherever it was last confirmed).
- Node A's "apply" level gets no write at all — neither confirmed NOR failed.
- `knowledge_nodes.revisitRequired` for node A is NOT set to `true` due to time expiry (see Section J).

Rule: **END_REQUIRED_SESSION must never write `revisitRequired=true`.** It must only write `requiredSessionCompletedAt` on the session.

### I2. Session expiry in the middle of an active task

Situation: Budget exhausted mid-MICRO_CHECK. Student has typed a partial answer.

Correct behavior:
- Finish evaluating the current turn normally.
- THEN check `sessionBudgetExhausted` — this is why the session budget check fires at the TOP of the decision engine (after evaluation completes), not before.
- If the current turn's evidence confirms a level, write it. Evidence during a session that runs over is still valid evidence.
- Return `END_REQUIRED_SESSION` as metaAction after writing valid state.

Rule: **A valid evaluated answer at session-budget-exhaustion time MUST be recorded.** Time expiry does not invalidate an answer already evaluated.

### I3. STOP_LEVEL_AND_REVISIT (local node budget)

Situation: Local node budget exhausted before MAX_REMEDIATION_STEPS.

Correct behavior:
- Set `knowledge_nodes.revisitRequired = true` with `reason = 'LOCAL_BUDGET'` (see Section J).
- Do NOT set `demonstratedCognitiveLevel` beyond what was actually confirmed.
- Advance to the next node normally (same as MARK_TARGET_NOT_REACHED).

### I4. Implementation guardrail

To enforce I1 at the code level: The `_decisionHasKNState` gate in chat.ts's fire-and-forget block must explicitly exclude `END_REQUIRED_SESSION` from triggering `revisitRequired` writes. The gate becomes:

```typescript
const _decisionHasKNState =
  !!(_pedagogicalDecision?.levelConfirmed ||
     (_pedagogicalDecision?.revisitRequired &&
      _pedagogicalDecision?.metaAction !== "END_REQUIRED_SESSION"));
```

---

## J. Revisit / Defer Semantics

Current `knowledge_nodes.revisitRequired` is a boolean with a single implied reason: "remediation_exhausted". R4 introduces a second reason: "local_budget_exhausted". A future reason will be "session_time_limit" (distinct from local budget — this is "never attempted due to session end").

### J1. Reason taxonomy

| Reason | Description | Evidence status | Priority |
|---|---|---|---|
| `REMEDIATION_EXHAUSTED` | Step counter exceeded MAX_REMEDIATION_STEPS | Student tried, failed repeatedly | Higher priority for intervention |
| `LOCAL_BUDGET_EXHAUSTED` | Time spent on node exceeded local budget ceiling | Student tried but not enough time | Medium priority |
| `SESSION_TIME_LIMIT` | Session ended before this level was attempted | Not tried at all | Lower priority (deferred, not failed) |

### J2. Recommendation

Add `revisitReason` (text nullable) to `knowledge_nodes`. Allowed values: `'REMEDIATION_EXHAUSTED'`, `'LOCAL_BUDGET_EXHAUSTED'`, `'SESSION_TIME_LIMIT'`.

`SESSION_TIME_LIMIT` is different from both others: it does NOT set `revisitRequired=true`. Instead it should be a separate signal. But to avoid a third new field, a clean approach is:

- Keep `revisitRequired` for "actively needs intervention" (REMEDIATION_EXHAUSTED + LOCAL_BUDGET_EXHAUSTED only).
- Use `revisitReason` to record WHY.
- For "never attempted due to session time": do not set `revisitRequired`; the absence of `demonstratedCognitiveLevel` plus a session `requiredSessionCompletedAt` before the node was reached is sufficient information.

**Decision: Add `revisitReason` TEXT nullable to `knowledge_nodes`.** No additional boolean needed.

---

## K. Required vs Optional Session State

### K1. Where does this state live?

The required/optional distinction is a **session-level** property, not a node-level or lesson-level property.

| State | Owner | Persisted | Lifetime |
|---|---|---|---|
| Required session budget | `lesson_sessions.requiredSessionMinutes` (snapshot) | Yes | Entire session |
| Required session completed? | `lesson_sessions.requiredSessionCompletedAt` IS NOT NULL | Yes | Set once, never reset |
| Optional continuation active? | `lesson_sessions.optionalContinuation` boolean | Yes | Set when student clicks [Շարունակել կամավոր] |
| Active learning seconds | `lesson_sessions.activeLearningSeconds` | Yes | Accumulates throughout session including optional |

### K2. Evidence during optional continuation

Evidence gathered during optional continuation is **valid evidence**. It must be written to `evidence_events` with no special flag. The `lesson_sessions.optionalContinuation` flag on the session is enough to reconstruct whether an evidence event came from required or optional learning, by joining on session and comparing `evidence_events.createdAt` to `lesson_sessions.requiredSessionCompletedAt`.

There is no need for an `is_optional` column on `evidence_events`.

### K3. How `status` changes in R4

R4 must fix the current bug where `status` is never set to 'completed'. Proposed lifecycle:

```
'active'
  → on END_REQUIRED_SESSION: status stays 'active' (session is still open for optional)
  → on optional completion or explicit finish: status = 'completed', completedAt = now()
  → on required session only (no optional): status = 'completed', completedAt = now()
    + requiredSessionCompletedAt = now() (same write)
```

---

## L. State Ownership Table

| State | Purpose | Authoritative Source | Persisted or Derived | Lifetime | Reset Rule |
|---|---|---|---|---|---|
| **Required session budget** | How many minutes the student must actively engage | `lesson_sessions.requiredSessionMinutes` (snapshot from `lessons.requiredSessionMinutes`) | Persisted (snapshotted at session start) | Entire session | Never reset after set |
| **Active learning time** | Creditable engaged learning time | `lesson_sessions.activeLearningSeconds` | Persisted (accumulated per turn) | Entire session (including optional) | Never reset |
| **Remaining required time** | Budget remaining | DERIVED: `requiredSessionMinutes * 60 - activeLearningSeconds` | Derived at read time | N/A | N/A |
| **Session budget exhausted** | Is required portion done? | DERIVED: `activeLearningSeconds >= requiredSessionMinutes * 60` | Derived | N/A | N/A |
| **Required session completed** | Timestamp of budget exhaustion | `lesson_sessions.requiredSessionCompletedAt` | Persisted | Set once when budget hits; survives refresh | Never reset |
| **Optional continuation mode** | Student chose to continue beyond required | `lesson_sessions.optionalContinuation` | Persisted | Set on student choice | Never reset to false within a session |
| **Current MicroNode effort** | Elapsed time on current node | DERIVED: `now() - nodeStartedAt` | Derived (nodeStartedAt persisted) | Per-node; reset on node advance | Reset in `advanceNodeInSession()` |
| **Remediation step** | Escalation step for current level | `lesson_sessions.remediationStep` | Persisted | Per cognitive level | Reset on level advance/node advance (V2-R3) |
| **Demonstrated cognitive level** | Highest confirmed Bloom level on this node | `knowledge_nodes.demonstratedCognitiveLevel` | Persisted (write-through cache) | Permanent (cross-session) | Only upgraded, never downgraded |
| **Revisit required** | Node needs intervention in future session | `knowledge_nodes.revisitRequired` | Persisted | Permanent until cleared | Cleared when target level is eventually demonstrated |
| **Revisit/defer reason** | WHY the node needs revisit | `knowledge_nodes.revisitReason` | Persisted | Permanent until cleared | Cleared with revisitRequired |
| **Last activity** | Inter-turn interval anchor | `lesson_sessions.lastActivityAt` | Persisted | Per-session | Written per chat turn; survives resume |
| **Session status** | Lifecycle state | `lesson_sessions.status` | Persisted | Session lifetime | Written 'completed' at explicit end |

---

## M. Minimal Schema Gap

### Existing fields we CAN reuse without change

| Field | How reused |
|---|---|
| `lesson_sessions.startedAt` | Fallback if `lastActivityAt` is null (first turn) |
| `lesson_sessions.nodeStartedAt` | Local node effort = `now() - nodeStartedAt` |
| `lesson_sessions.completedAt` | Write when status becomes 'completed' (already in schema, just never written) |
| `lesson_nodes.estimatedMinutes` | UI suggestion for default required session budget; AI prompt context |
| `knowledge_nodes.revisitRequired` | Keep; extend with `revisitReason` |

### New fields that are truly required

**Table: `lessons`**

| Column | Type | Default | Nullable | Who Writes | Who Reads | Reset Rule | Why can't be derived |
|---|---|---|---|---|---|---|---|
| `requiredSessionMinutes` | integer | — | YES (null = no budget) | Teacher via UI | chat.ts at session creation | Never | Lesson default for student session contract; cannot derive from per-node estimates (teacher may intend a different total) |

**Table: `lesson_sessions`**

| Column | Type | Default | Nullable | Who Writes | Who Reads | Reset Rule | Why can't be derived |
|---|---|---|---|---|---|---|---|
| `requiredSessionMinutes` | integer | — | YES | chat.ts at session creation (snapshot) | chat.ts per turn | Never after set | Must survive teacher edits to lesson mid-session; snapshot isolates the student's contract |
| `activeLearningSeconds` | integer | `0` | NO | chat.ts per turn (accumulated) | chat.ts per turn (budget check) | Never reset | Cannot derive from message timestamps without replay; must persist across refreshes |
| `lastActivityAt` | timestamp(tz) | — | YES | chat.ts per turn (end of handler) | chat.ts next turn (interval start) | Never reset | Cannot reconstruct from chat_messages without querying a separate table per turn |
| `requiredSessionCompletedAt` | timestamp(tz) | — | YES | chat.ts when budget exhausted | frontend (completion detection) | Never reset | Marks the moment required learning ended; needed to distinguish pre/post required evidence |
| `optionalContinuation` | boolean | `false` | NO | chat.ts / session API on student choice | chat.ts (governs mode) | Never reset to false | Explicit student intent; survives refresh |

**Table: `knowledge_nodes`**

| Column | Type | Default | Nullable | Who Writes | Who Reads | Reset Rule | Why can't be derived |
|---|---|---|---|---|---|---|---|
| `revisitReason` | text | — | YES | chat.ts fire-and-forget (same time as revisitRequired) | Knowledge Tree, dashboard | Cleared with revisitRequired | Reason code cannot be reconstructed from evidence without replaying all session decisions |

### Fields considered but rejected

| Field | Reason rejected |
|---|---|
| `lesson_sessions.sessionBudgetExhausted` (bool) | Fully derived: `activeLearningSeconds >= requiredSessionMinutes * 60`. Storing it adds a sync risk. |
| `evidence_events.isOptional` | Not needed. `evidence_events.createdAt` vs `session.requiredSessionCompletedAt` gives the same information. |
| `lessons.estimatedMinutes` (lesson-level) | Derivable as `SUM(lesson_nodes.estimatedMinutes)`. Not the same as `requiredSessionMinutes`. Don't add it. |
| `lesson_sessions.pausedAt` / `pauseCount` | Explicit pause/resume is UX over-engineering for V1. Interval cap handles idle time adequately. |
| `lesson_sessions.turnCount` | Already derivable from COUNT(chat_messages). |
| A new `session_budgets` table | No assignment-override requirement in R4. Single column on `lessons` suffices. |

### Future fields — NOT for R4

| Field | Future use |
|---|---|
| `lesson_sessions.learnerReadinessP` | P/readiness input for Adaptive Readiness layer |
| `lesson_sessions.cognitiveLoadScore` | Future cognitive cost accumulator |
| `lesson_assignments.requiredSessionMinutes` | Assignment-level override when assignment table exists |
| `knowledge_nodes.deferredAt` | When a deferred node should be revisited |

---

## N. Fields Explicitly Rejected

See Section M (Fields considered but rejected).

Additionally:

- **Do NOT add `activeLearningMinutes`** (use seconds to avoid rounding errors in sub-minute sessions).
- **Do NOT add a `timerVersion` or cache-key field** for the time budget (no derived caching needed).
- **Do NOT add `sessionBudgetPercent`** (always derivable).
- **Do NOT use `lesson_nodes.estimatedMinutes` as the required session budget** without explicit teacher intent. The sum of per-node estimates is an input to a suggested default in the teacher UI, not an authoritative contract.

---

## O. Future P/Readiness Integration Point

R4 must not implement readiness (P), but should not assume `activeLearningSeconds >= required*60` is the only budget check. The integration point:

In chat.ts's budget computation block (before calling the decision engine), the check will become:

```typescript
const sessionBudgetExhausted = computeSessionBudgetExhausted({
  activeLearningSeconds: session.activeLearningSeconds,
  requiredSessionMinutes: session.requiredSessionMinutes,
  learnerReadinessP: null,   // <-- future slot; null for R4
});
```

The `computeSessionBudgetExhausted` function is introduced in R4 as:

```typescript
function computeSessionBudgetExhausted(params): boolean {
  if (params.requiredSessionMinutes == null) return false;          // no budget
  const baseExhausted = params.activeLearningSeconds >= params.requiredSessionMinutes * 60;
  // Future: baseExhausted && learnerReadinessP > HIGH → extend by factor
  return baseExhausted;
}
```

The function exists in R4 in a minimal form. Future rounds add the `learnerReadinessP` path without changing the call site in chat.ts.

---

## P. Future Cognitive-Cost Integration Point

`localNodeBudgetExhausted` will be computed by a `computeLocalNodeBudget()` helper. In R4:

```typescript
function computeLocalNodeBudget(params: {
  nodeStartedAt: Date | null;
  activeLearningSeconds: number;
  remediationStep: number;
  estimatedMinutes: number;
  requiredSessionMinutes: number | null;
  // future:
  learnerReadinessP?: number | null;
  cognitiveLevel?: string | null;
}): boolean {
  if (!params.nodeStartedAt) return false;
  if (!params.requiredSessionMinutes) return false;  // no budget = no local budget
  const nodeElapsedSeconds = (Date.now() - params.nodeStartedAt.getTime()) / 1000;
  const nodeEstimatedSeconds = params.estimatedMinutes * 60;
  // V1: true when elapsed > 2× estimated AND at least one remediation step done
  return nodeElapsedSeconds > nodeEstimatedSeconds * 2 && params.remediationStep >= 1;
  // Future: incorporate cognitiveLevel weight, learnerReadinessP, remaining session time
}
```

The `2×` multiplier and the `remediationStep >= 1` guard are **V1 defaults only** — they must be treated as configurable, not hardcoded in the decision engine logic. A named constant `LOCAL_BUDGET_MULTIPLIER = 2` and `LOCAL_BUDGET_MIN_REMEDIATION_STEP = 1` should be exported alongside `MAX_REMEDIATION_STEPS`.

This function lives in `pedagogicalDecisionEngine.ts` as an exported helper. Its signature is the integration point for cognitive cost: future rounds add `cognitiveLevel` weighting without changing chat.ts.

---

## Q. Proposed R4 Implementation Rounds

### R4A.1 — Persistence & Time Accounting

**Scope:**
- DB migration: add `lessons.requiredSessionMinutes`, `lesson_sessions.requiredSessionMinutes` (snapshot), `lesson_sessions.activeLearningSeconds`, `lesson_sessions.lastActivityAt`, `lesson_sessions.requiredSessionCompletedAt`, `lesson_sessions.optionalContinuation`.
- Add `knowledge_nodes.revisitReason`.
- Fix `lesson_sessions.status` write: write `'completed'` and `completedAt` at lesson end.
- chat.ts: accumulate `activeLearningSeconds` per turn using capped-interval model. Write `lastActivityAt`. Snapshot `requiredSessionMinutes` at session creation.
- Expose `activeLearningSeconds`, `requiredSessionMinutes`, `requiredSessionCompletedAt`, `optionalContinuation` in session API responses.
- **No decision engine changes yet.**
- **Tests:** T01, T02, T03, T04, T12.

### R4A.2 — Decision Engine Budget Integration

**Scope:**
- Add `sessionBudgetExhausted` and `localNodeBudgetExhausted` to `PedagogicalDecisionInput`.
- Add `END_REQUIRED_SESSION` and `STOP_LEVEL_AND_REVISIT` to `PedagogicalMetaAction`.
- Implement `computeSessionBudgetExhausted()` and `computeLocalNodeBudget()` as exported helpers.
- Update decision flow in `decideNextPedagogicalAction()`.
- chat.ts: compute both signals before calling the engine.
- chat.ts: handle `END_REQUIRED_SESSION` — write `requiredSessionCompletedAt`, do NOT write `revisitRequired`.
- chat.ts: handle `STOP_LEVEL_AND_REVISIT` — write `revisitRequired=true`, `revisitReason='LOCAL_BUDGET_EXHAUSTED'`, advance node.
- Write `revisitReason='REMEDIATION_EXHAUSTED'` for existing MARK_TARGET_NOT_REACHED / REVISIT_LATER paths.
- **Tests:** T05, T06, T07, T08, T09, T10, T11, T17.

### R4A.3 — Required Session Completion & Optional Continuation

**Scope:**
- New session endpoint: `POST /api/lessons/:id/session/continue-optional` → sets `optionalContinuation=true`.
- Session state machine: when `requiredSessionCompletedAt IS NOT NULL AND optionalContinuation=false`, return a signal to the frontend to show the completion/offer screen.
- When `optionalContinuation=true` and lesson fully complete: set `status='completed'`, `completedAt=now()`.
- Frontend integration: add `requiredSessionCompletedAt` to session response; render the Armenian completion screen with [Ավարտել] / [Շարունակել կամավոր].
- **Tests:** T12, T13, T14, T15.

### R4A.4 — Teacher Configuration UI & Student UX Polish

**Scope:**
- Teacher dashboard: add `requiredSessionMinutes` input on lesson edit form, with suggested default from SUM(node estimatedMinutes).
- Student chat: subtle budget indicator (not a disruptive countdown — a soft progress indicator if `requiredSessionMinutes` is set).
- No redesign of lesson page; additive only.
- **Tests:** UAT scenarios.

---

## R. Test Plan

**Unit tests (tsx runner, same pattern as V2-R3):**

| Test | Description | Round |
|---|---|---|
| T01 | Session creation snapshots `requiredSessionMinutes` from lesson (null when lesson has no budget) | R4A.1 |
| T02 | Page refresh (resume) does NOT reset `activeLearningSeconds` or `lastActivityAt` | R4A.1 |
| T03 | Idle gap > CAP between turns: credited time = CAP, not actual interval | R4A.1 |
| T04 | Normal turns < CAP: credited time = actual interval; accumulates correctly | R4A.1 |
| T05 | `remediationStep=2`, `nodeElapsedSeconds > 2×estimatedMinutes` → STOP_LEVEL_AND_REVISIT before MAX_REMEDIATION_STEPS | R4A.2 |
| T06 | `remediationStep=5` (MAX): MAX_REMEDIATION_STEPS still fires even if local budget not exhausted | R4A.2 |
| T07 | `sessionBudgetExhausted=true` + evaluated correct answer: evidence IS written; metaAction = END_REQUIRED_SESSION | R4A.2 |
| T08 | `sessionBudgetExhausted=true` + node B's cognitive level never attempted: node B's `demonstratedCognitiveLevel` unchanged | R4A.2 |
| T09 | END_REQUIRED_SESSION does NOT set `revisitRequired=true` on knowledge_nodes | R4A.2 |
| T10 | `revisitRequired=true` + `revisitReason='REMEDIATION_EXHAUSTED'` survives new session (persisted, not reset at session start) | R4A.2 |
| T11 | Active task not corrupted when budget expires mid-MICRO_CHECK: current turn evaluated normally, then END_REQUIRED_SESSION | R4A.2 |
| T12 | `requiredSessionCompletedAt` written exactly once when budget first exhausted | R4A.2/3 |
| T13 | Optional continuation: setting `optionalContinuation=true` does NOT reset `activeLearningSeconds`, `remediationStep`, or any node state | R4A.3 |
| T14 | Evidence event during optional continuation: written to `evidence_events` normally; `is_optional` column NOT required | R4A.3 |
| T15 | Refresh during optional continuation: `optionalContinuation=true` persists; session correctly resumes in optional mode | R4A.3 |
| T16 | V2-R1 (33), V2-R1.1 (21), V2-R2 (41), V2-R3 (45) regression suites remain green after all R4 changes | All |
| T17 | No AI-returned field can override `sessionBudgetExhausted`; decision engine receives it as a pre-computed boolean | R4A.2 |

**Browser UAT scenarios (manual):**

| Scenario | Steps |
|---|---|
| UAT-A | Teacher sets `requiredSessionMinutes=2` on lesson 524. Student starts session, chats for 2 minutes. Verify `activeLearningSeconds >= 120` and session shows required-complete screen. |
| UAT-B | Student leaves browser open for 10 minutes (idle), returns, sends one message. Verify `activeLearningSeconds` credited ≤ CAP (180s), not 600s. |
| UAT-C | Required budget exhausted mid-node. Verify correct answer on current turn IS recorded in evidence_events. Verify unattempted nodes have no `revisitRequired`. |
| UAT-D | Student clicks [Շարունակել կամավոր]. Verify `optionalContinuation=true`, session continues, evidence valid. |
| UAT-E | Student clicks [Ավարտել] after required completion. Verify `status='completed'`, `completedAt` written. |
| UAT-F | Refresh during optional continuation. Verify optional mode preserved, no state reset. |

---

## S. Risks / Edge Cases

| Risk | Severity | Mitigation |
|---|---|---|
| **`lastActivityAt` null on first turn** — `startedAt` must be used as fallback | Medium | `interval = lastActivityAt ? now()-lastActivityAt : now()-startedAt`. Cap applies in both cases. |
| **Multiple browser tabs** — two simultaneous chat turns create a race on `activeLearningSeconds` | Low (rare) | Use `UPDATE lesson_sessions SET activeLearningSeconds = activeLearningSeconds + ? WHERE id=?` (atomic increment), not read-modify-write. |
| **Cap too short** — students who read slowly lose time credit | Medium | 180s cap is conservative. Consider 240s–300s. Configurable constant `ACTIVE_TIME_CAP_SECONDS`. |
| **Cap too long** — brief AFK credited | Low | 180s is acceptable. A 3-minute bathroom break being credited does not meaningfully affect budget. |
| **`requiredSessionMinutes` null** (teacher hasn't set it) | Must work | `computeSessionBudgetExhausted` returns `false` when null. Entire R4 layer is a no-op. Existing behavior preserved. |
| **Clock skew between request and DB** | Low | Use `Date.now()` consistently within one request handler rather than `now()` at different code points. |
| **Session budget completes while AI is generating** | Medium | Apply the budget check AFTER evaluation in the decision engine (Step 2 in Section G4). A turn already in-flight is not interrupted. |
| **advanceNodeInSession resets nodeStartedAt** — local budget timer resets on each node | Correct behavior | This is intentional. Each node gets a fresh budget. The global session budget (activeLearningSeconds) continues accumulating. |
| **Optional continuation evidence retroactively affects mastery gates** | Low | All evidence is valid. The mastery gate already runs regardless of mode. No special case needed. |
| **Teacher changes `requiredSessionMinutes` mid-session** | Handled | Snapshot into `lesson_sessions.requiredSessionMinutes` at creation. Teacher's edit affects only future sessions. |

---

## T. Final Recommendation

### Approved design decisions

1. **Active-time model: turn-based capped intervals** (D2, Section E). Cap = 180 seconds. Two new fields: `lastActivityAt`, `activeLearningSeconds`.

2. **Budget source: `lessons.requiredSessionMinutes` (nullable)**, snapshotted into `lesson_sessions.requiredSessionMinutes` at session creation. No assignment-level override in R4. Null = no budget (unlimited, existing behavior preserved).

3. **New session fields: 5** — `requiredSessionMinutes`, `activeLearningSeconds`, `lastActivityAt`, `requiredSessionCompletedAt`, `optionalContinuation`. Each justified in Section M.

4. **New lesson field: 1** — `lessons.requiredSessionMinutes`. Separates it from `lesson_nodes.estimatedMinutes` which has different semantics.

5. **New knowledge_nodes field: 1** — `revisitReason` (text nullable). Distinguishes REMEDIATION_EXHAUSTED from LOCAL_BUDGET_EXHAUSTED. SESSION_TIME_LIMIT is inferrable without an explicit flag.

6. **Decision engine integration:** two new boolean inputs (`sessionBudgetExhausted`, `localNodeBudgetExhausted`), two new metaActions (`END_REQUIRED_SESSION`, `STOP_LEVEL_AND_REVISIT`), two new exported helper functions.

7. **Fix existing gap:** Write `status='completed'` and `completedAt` when session ends. Currently this never happens.

8. **Implementation rounds: 4 (R4A.1–R4A.4)**, independently testable. Each round can be reviewed and approved before proceeding.

9. **P/readiness and cognitive cost: integration points defined, not implemented.** `computeSessionBudgetExhausted()` and `computeLocalNodeBudget()` accept future parameters as null for R4.

### What must NOT be implemented in R4

- Readiness/P input (🔴 future)
- Cognitive-cost weighting (🔴 future)
- Assignment-level budget override (🔴 future — requires assignment table)
- Explicit pause/resume UI (🔴 future — interval cap is sufficient for V1)
- `isOptional` flag on evidence_events (🔴 rejected — derivable from timestamps)
- Any AI-owned time-budget decision (🔴 hard invariant — deterministic backend only)
