# Phase 2 Orchestration Refactor — Stages 1–2 Architecture

Status: Stage 1 boundary extraction and Stage 2 server-owned action plan complete.

Stage 1 was behavior-preserving. Stage 2 intentionally changes one ownership
boundary: the backend now selects the current Phase 2 workflow action before
the bounded structured AI call. It does not split theory, task, and feedback
generation into separate provider contracts.

## A. Pre-change Phase 2 ownership map

Before Stage 1, `routes/chat.ts` directly owned or locally derived nearly every
Phase 2 concern:

| Concern | Pre-change owner |
|---|---|
| HTTP/auth/request validation | `routes/chat.ts` |
| Session, lesson, node, cognitive path, exercise, history, and progress reads | `routes/chat.ts` |
| Intent routing call and fast-return branches | `routes/chat.ts` calling `intentRouter.ts` |
| Structured provider call and validation | `routes/chat.ts` calling `services/ai.ts` |
| Generated objective task payload derivation | Route-local helper in `routes/chat.ts` |
| Objective answer normalization and deterministic correctness | Route-local helper/block in `routes/chat.ts` |
| Active source row read and typed deterministic correctness | `routes/chat.ts` calling the source evaluator |
| Source eligibility, exact-text enforcement, and single-delivery checks | `lib/exercise-delivery.ts`, applied by `routes/chat.ts` |
| Source activation write | Route-local `activateSourceExercise()` |
| Counter and stage-transition derivation | Inline in `routes/chat.ts` |
| Historical level-evidence reduction | Inline in `routes/chat.ts` |
| Decision Engine input and budget signal preparation | Inline in `routes/chat.ts` |
| Cognitive progression and completion-gate derivation | Inline in `routes/chat.ts` |
| Session/task/evidence/chat/knowledge writes | `routes/chat.ts` |
| Response shaping | `routes/chat.ts` |

The Decision Engine and source-exercise evaluator were already pure, but the
route prepared and normalized their inputs inline.

## B. Files changed

| File | Stage 1 role |
|---|---|
| `src/services/phase2/orchestration.ts` | New pure Phase 2 task, evaluation, turn-state, evidence-summary, decision-input, and progression boundary |
| `src/routes/chat.ts` | Uses the pure boundary while retaining all I/O and response ownership |
| `src/lib/__tests__/phase2-stage1-extraction.test.ts` | Direct A–J extraction contracts |
| `src/lib/__tests__/phase2-stage0-baseline.test.ts` | Points source-ownership assertions at the new pure owner |
| `src/lib/__tests__/micro-check-activation-fix.test.ts` | Points task-payload ownership assertion at the new pure owner |
| `package.json` | Adds `test:phase2-stage1` |

No database schema, generated API type, prompt, frontend, mapper, quiz, teacher
CRUD, or Knowledge Tree file changed.

## C. New pure orchestration boundaries

All functions below are in `services/phase2/orchestration.ts` and perform no
database, provider, chat-message, evidence, logging, or HTTP side effects.

| Function | Input | Output / authority |
|---|---|---|
| `objectivePayloadFromMicroCheck` | Validated structured response | Persistable generated objective answer payload or `null` |
| `deriveGeneratedMicroCheckActivation` | Validated structured response | Existing anticipatory MICRO_CHECK task-state update or `null` |
| `deriveCognitiveAdvanceTaskReset` | None | Existing THEORY/no-active-task reset values |
| `resolveAuthoritativeEvaluation` | Model candidate, learner intent, active task identity, optional exact active source row, student answer | Final evaluation, correctness, authority diagnostics, and optional typed source evaluation |
| `deriveTurnProgress` | Final evaluation plus current counters/stage/exercise count | `wasEval`, correctness flags, next counters, and stage-transition intent |
| `summarizeLevelEvidence` | Already-fetched historical evidence rows | Decision Engine `LevelEvidenceSummary` |
| `coordinatePedagogicalDecision` | Authoritative evaluation, session/cognitive/dependency/budget context | Exact `PedagogicalDecisionInput`, budget signals, and Decision Engine result |
| `deriveProgressionPlan` | Turn progress, cognitive path, class-exercise count, Decision Engine result | Cognitive reset, completion, safety-cap, and auto-delivery intent |

The module is a coordinator of pure decisions, not a wrapper around the route.
It composes existing deterministic evaluators and the existing Decision Engine.

## D. `chat.ts` responsibilities after extraction

`chat.ts` remains the HTTP/controller and side-effect adapter. It still owns:

- request authentication and validation;
- all Phase 1/3/4 and lesson-intro behavior;
- all database reads;
- chat-history and prompt-context assembly;
- intent-routing invocation and READY/CONTINUE/HELP fast returns;
- provider calls, structured failure handling, and response text handling;
- scope-drift handling;
- exact source selection, activation, delivery, and stale-delivery suppression;
- applying pure session/task/counter/remediation/progression decisions;
- all session, chat-message, evidence, and Knowledge Tree writes;
- progress-indicator and response shaping;
- fire-and-forget evidence timing after `res.json()`.

These blocks remain in the route because extracting them during Stage 1 would
move or duplicate side effects, alter response/write timing, or require a
larger behavior redesign.

## E. Side-effect ownership

There is still one effective owner for each write:

| Side effect | Owner |
|---|---|
| Session creation/intro/progress/counter/stage/task/remediation/cognitive-level writes | `routes/chat.ts` |
| Source-exercise activation write | `routes/chat.ts` → `activateSourceExercise()` |
| Help-event and help-state writes | `routes/chat.ts` → `executeHelpRequest()` |
| User/assistant chat-message writes | `routes/chat.ts` |
| Evidence-event writes | Fire-and-forget block in `routes/chat.ts`, after the response |
| Knowledge-node demonstrated-level/revisit writes | Fire-and-forget block in `routes/chat.ts` |
| Scoring update trigger | Fire-and-forget block in `routes/chat.ts` |
| Provider calls | `services/ai.ts` / `intentRouter.ts`, invoked by `routes/chat.ts` |
| HTTP response | `routes/chat.ts` |

`services/phase2/orchestration.ts` owns no side effects.

## F. Preserved authority invariants

1. The validated `activeObjectiveTaskPayload` owns generated objective
   MICRO_CHECK correctness.
2. The persisted `activeLessonExerciseId` selects the exact source row used for
   typed source correctness.
3. The pure evaluator additionally requires the supplied source row ID to equal
   `activeLessonExerciseId`; mismatched input fails closed to the existing model
   candidate.
4. `source_fidelity.exercise_id` remains a request only. Eligibility resolution
   and persisted internal identity remain authoritative.
5. Source and generated objective authorities remain separate.
6. Non-answer intents still suppress evaluation and lock an open task to the
   current node.
7. Final authoritative evaluation is computed before counter, evidence,
   Decision Engine, and progression consumers.
8. Feedback-only output cannot derive generated task activation.
9. Cognitive-level advance retains the same node/phase, resets to THEORY, and
   clears stale task state.
10. Cognitive Path completion cannot be bypassed by the legacy VERIFIED gate.
11. Source delivery still has one effective visible owner.
12. Budget signals remain backend-derived and never come from model output.

## G. Post-change runtime architecture map

### Main Phase 2 request path

```text
HTTP REQUEST
→ authenticate + validate
→ load authoritative lesson/session/node/exercise/cognitive/history context
→ classify learner intent
→ build prompt context
→ AI/provider structured call + validation
→ load exact active source row when source scoring is eligible
→ resolve final authoritative evaluation
→ select/activate/enforce source delivery when current flow requires it
→ derive counters and teaching-stage intent
→ persist counters and task/stage changes
→ load + summarize historical cognitive-level evidence
→ prepare and run Pedagogical Decision Engine
→ persist remediation/cognitive-level/session-budget state
→ derive cognitive reset/completion/auto-delivery intent
→ apply progression writes and response-delivery effects
→ persist assistant chat message
→ HTTP RESPONSE
→ fire-and-forget evidence + Knowledge Tree/scoring writes
```

### Step-by-step owner/input/output map

| Step | Owner | Input | Output | Kind |
|---|---|---|---|---|
| 1. Receive/authenticate/validate | `routes/chat.ts` POST `/chat` | HTTP body and authenticated user | Validated `message`, optional `lessonId` | Side-effecting boundary |
| 2. Load context | `routes/chat.ts` | User and lesson IDs | Authoritative session, lesson, node, class exercises, cognitive path, history, progress | Side-effecting DB reads |
| 3. Classify intent | `intentRouter.ts` `classifyIntent`, called by route | Message + session task context | `IntentResult` | Pure for deterministic matches; provider side effect for ambiguous Stage B |
| 4. Handle fast returns | `routes/chat.ts` | Intent + active task/help state | Reminder/help response or continuation to provider path | Side-effecting when taken |
| 5. Build teaching context | `routes/chat.ts` | Loaded authoritative content | Prompt/history/provider inputs | Computation in side-effecting controller |
| 6. Structured generation | `services/ai.ts` `callAIStructured` | History, lesson context, turn state | Validated/canonical structured response or controlled failure | Provider side effect plus pure validation |
| 7. Load active source row | `routes/chat.ts` | Persisted `activeLessonExerciseId` | Exact row metadata or `null` | Side-effecting DB read |
| 8. Final evaluation | `phase2/orchestration.ts` `resolveAuthoritativeEvaluation` | Candidate evaluation, intent, active authorities, student answer | Final evaluation consumed downstream | Pure |
| 9. Source delivery | `exercise-delivery.ts` helpers + route-local `activateSourceExercise` | Eligible rows and requested/persisted identity | Exact activated ID and exactly-once visible text | Pure selection/enforcement plus route DB write |
| 10. Turn-state derivation | `phase2/orchestration.ts` `deriveTurnProgress` | Final evaluation and current session counters | Counter/stage transition intent | Pure |
| 11. Apply turn state | `routes/chat.ts` | Pure turn/task update | Persisted counters, attempts, stage, active task | Side-effecting DB writes |
| 12. Prepare evidence summary | Route DB query + `summarizeLevelEvidence` | Historical rows for active cognitive level | `LevelEvidenceSummary` excluding current turn | Side-effecting read then pure reduction |
| 13. Pedagogical decision | `coordinatePedagogicalDecision` → `pedagogicalDecisionEngine.ts` | Authoritative evaluation and session/cognitive/budget context | Budget signals, exact engine input, `PedagogicalDecision` | Pure |
| 14. Apply decision state | `routes/chat.ts` | `PedagogicalDecision` | Persisted remediation, active cognitive level, required-session completion | Side-effecting DB writes |
| 15. Derive progression | `phase2/orchestration.ts` `deriveProgressionPlan` | Turn progress + path + decision | Reset/completion/auto-delivery intent | Pure |
| 16. Apply progression | `routes/chat.ts` | Progression intent | THEORY reset, node advancement, progress indicator, delivery fallback | Side-effecting DB writes |
| 17. Persist/respond | `routes/chat.ts` | Final learner-visible message and state | Assistant chat row and JSON response | Side-effecting DB/HTTP |
| 18. Durable evidence | Fire-and-forget block in `routes/chat.ts` | Final authoritative evaluation + captured session/decision | Evidence row, KN state, scoring trigger | Side-effecting after response |

## H. Remaining Phase 2 logic in `chat.ts`

The following coupling is intentionally deferred:

- context loading and prompt assembly;
- intro and intent fast-return branches;
- provider invocation and structured-failure response;
- source activation/delivery and same-turn stale-delivery suppression;
- ordering of session/task/progression writes;
- assistant-message persistence and response shaping;
- post-response evidence and Knowledge Tree writes;
- help persistence;
- Phase 1/3/4 interleaving in the same route.

Moving these safely requires explicit I/O ports or a transactional application
service and is outside Stage 1. No Stage 2 behavior has been implemented.

## I. Verification

Stage 1 adds the provider-free pure A–J suite:

- successful THEORY response/task state;
- safe structured THEORY failure;
- objective task activation;
- deterministic objective correctness;
- exact source selection identity;
- deterministic source correctness;
- feedback-only continuation without phantom task;
- cognitive advance to next level with THEORY/task reset;
- exactly-once source delivery;
- behaviorally equivalent remediation.

| Verification | Result |
|---|---:|
| Frozen Stage 0 matrix (including real route and test-isolation safety) | 315/315 passed |
| New Stage 1 extraction contracts | 10/10 passed |
| Additional affected intent-router regression | 41/41 passed |
| Additional Phase 2A R3 acceptance | 30/30 passed |
| API TypeScript typecheck | passed |
| `git diff --check` | passed |
| API restart | passed; listening on port 8080 |
| Web preview smoke check | passed; page rendered and browser console was clean |

Provider/model-backed generation tests were not run. The Stage 0 provider-free
HTTP harness intercepted the OpenAI-compatible boundary and exercised the real
route against the isolated test database.

## J. Stage 2 readiness before implementation

Stage 1 exposes a testable pure seam around authoritative evaluation and
Pedagogical Decision Engine preparation while leaving all I/O timing stable.
That is the intended prerequisite for a later Stage 2 design.

Readiness meant the seam existed; it did not itself implement Stage 2.

---

# Stage 2 — Server-Owned Action Plan

## K. Stage 1 seam used by Stage 2

Stage 2 extends `services/phase2/orchestration.ts`; it does not add a second
orchestrator. The existing Stage 1 functions remain responsible for task
payload derivation, authoritative evaluation, turn progress, evidence
summaries, Decision Engine coordination, and progression planning.

The new pure entry point, `derivePhase2ServerAction`, consumes:

- `currentPhase`;
- `currentNodeId`;
- `activeCognitiveLevelId`;
- `nodeTeachingStage`;
- `activeTaskProvenance`;
- `activeLessonExerciseId`;
- `activeObjectiveTaskPayload`;
- learner intent;
- evaluated/not-evaluated state;
- the Decision Engine result and derived progression plan when available.

AI `teaching_mode`, `is_micro_check`, and `node_decision` are intentionally not
inputs to action selection.

## L. Action-plan contract

Every `Phase2ServerActionPlan` declares:

- the selected action and a stable reason code;
- whether another AI generation is needed;
- whether an active task may be created;
- whether evaluation is expected;
- whether progression may occur;
- a safe server-owned response `teachingMode` override, when unambiguous;
- the task authority;
- the next cognitive-level ID and node teaching stage for cognitive advance.

The minimum action set supported by the current runtime is:

| Action | Required authoritative state | AI generation | May create task | Evaluation expected | Progression may occur |
|---|---|---:|---:|---:|---:|
| `OUTSIDE_PHASE_2` | Phase is not 2, or there is no current node | No Stage-2 requirement | No | No | No |
| `DELIVER_THEORY` | Phase 2, current node + cognitive level, THEORY, no active task | Yes, bounded content/task candidate | Yes, after validation | No | No |
| `EVALUATE_ACTIVE_TASK` | Authoritative objective payload or persisted source exercise + ANSWER | Yes, bounded feedback/evaluation candidate | No | Yes | Yes, only through Decision Engine |
| `PRESERVE_ACTIVE_TASK` | Authoritative task + non-answer intent reaching provider path | Yes | No | No | No |
| `REMEDIATE` | Evaluated turn + Decision Engine same-level remediation | No additional call | No | Already complete | No |
| `DELIVER_FEEDBACK` | Evaluated turn + no reset/completion/source-delivery action | No additional call | No | Already complete | No |
| `DELIVER_SOURCE_EXERCISE` | Evaluated turn + server progression plan selects auto-delivery | No additional call | Yes | Already complete | No node/level progression |
| `ADVANCE_COGNITIVE_LEVEL` | Decision Engine advance + progression reset gate | No additional call | No | Already complete | Yes |
| `COMPLETE_MICRONODE` | Decision Engine explicitly grants `COMPLETE_NODE` and progression gate allows it | No additional call | No | Already complete | Yes |
| `DEFER_TO_COMPATIBILITY` | Legacy MICRO_CHECK without a persisted objective payload | Current behavior | Possible source transition | Model-candidate legacy evaluation | Existing server policy only |
| `INVALID_PHASE2_STATE` | Any other incomplete or inconsistent Phase-2 state | No | No | No | No |

## M. State-to-action ownership

1. Phase 2 + THEORY + current cognitive level + no task selects
   `DELIVER_THEORY`.
2. Generated objective task identity requires both `micro_check` provenance and
   `activeObjectiveTaskPayload`.
3. Source task identity requires both `source_exercise` provenance and
   `activeLessonExerciseId`.
4. An ANSWER to either authoritative task selects `EVALUATE_ACTIVE_TASK`.
5. A non-answer that reaches the provider path selects `PRESERVE_ACTIVE_TASK`.
6. After authoritative evaluation, `deriveProgressionPlan` and the Decision
   Engine select remediation, feedback, source delivery, cognitive advance, or
   MicroNode completion.
7. A legacy MICRO_CHECK with provenance but no objective payload remains
   `DEFER_TO_COMPATIBILITY`; this preserves the frozen source transition without
   pretending deterministic generated-task correctness exists.
8. THEORY without a cognitive path is still unambiguously
   `DELIVER_THEORY`; it does not require a compatibility action.
9. The frozen no-path completion predicate is derived from deterministic turn
   state and passed into the Decision Engine as `legacyCompletionAllowed`. The
   engine converts that signal into the explicit `COMPLETE_NODE` grant, so the
   route never completes from a legacy gate alone.
10. A completion flag cannot select `COMPLETE_MICRONODE` unless the Decision
    Engine result is `COMPLETE_NODE`.
11. All other malformed or partial task states select `INVALID_PHASE2_STATE`
    and stop before provider generation.

## N. AI compatibility fields after Stage 2

For Phase 2:

- `teaching_mode` is content/response compatibility metadata. For
  `DELIVER_THEORY`, the server canonicalizes the envelope to `TEACH` and maps
  the response metadata from the action plan.
- `is_micro_check` is a validated task-candidate field, not an action selector.
  It can activate a generated task only when `DELIVER_THEORY` or an explicit
  compatibility action authorizes task creation.
- `node_decision` remains in the provider schema and validation/logging path,
  but it does not select remediation, cognitive advance, completion, or phase
  progression.
- `source_fidelity.exercise_id` remains an eligible-row request. It may suggest
  a source candidate, but the backend resolver and persisted internal row ID
  remain authoritative.

`validatePhase2ResponseForServerAction` is separate from action selection. It
rejects a theory envelope that is not canonical THEORY + visible MICRO_CHECK +
no evaluation, and rejects a new MICRO_CHECK on active-task evaluation or
preservation actions. Existing language, content, node-lock, visible-task,
objective-answer, teaching-cycle, and source-fidelity validators remain active.

## O. Stage 2 runtime architecture map

```text
HTTP request
→ authoritative session/context load
→ learner-intent classification and deterministic fast returns
→ pure server action planner
→ bounded existing structured AI call
→ schema + semantic + server-action content validation
→ authoritative task identity/evaluation resolution
→ pure turn-progress derivation
→ pure Pedagogical Decision Engine
→ pure progression plan
→ pure server action planner from evaluated state
→ route-owned state/evidence/chat persistence
→ response mapping
```

| Step | Owner | Input | Output | Kind |
|---|---|---|---|---|
| Request/auth/context | `routes/chat.ts` | HTTP request, user, lesson ID | Session, node, path, eligible exercises, history | DB reads / controller side effects |
| Intent | `intentRouter.ts`, called by route | Message + active-task context | `IntentResult` | Pure deterministic or bounded classifier call |
| Pre-generation action | `derivePhase2ServerAction` | Authoritative state + intent | `Phase2ServerActionPlan` | Pure |
| Structured content | `callAIStructured` | Existing prompt/history + turn state | Canonical validated response or failure | Provider side effect + pure validation |
| Action/content compatibility | `validatePhase2ResponseForServerAction` | Selected action + response | Accept or controlled error | Pure |
| Task/evaluation authority | Stage 1 helpers + route source-row read | Active payload/ID, intent, candidate response | Final authoritative evaluation | Pure, except route DB read |
| Turn policy | `deriveTurnProgress` | Final evaluation + session counters | Counter/stage intent | Pure |
| Progression policy | Decision Engine + `deriveLegacyCompletionAllowed` + `deriveProgressionPlan` | Final evaluation, evidence/path/budgets and behavior-preserving no-path completion predicate | Deterministic pedagogical decision and gates | Pure |
| Post-evaluation action | `derivePhase2ServerAction` | Decision + progression plan | Remediate/feedback/source/advance/complete action | Pure |
| Persistence | `routes/chat.ts` | Pure decisions and selected identities | Session/task/chat/evidence/KN state | DB writes / side effects |
| Response | `routes/chat.ts` | Final message, action-safe metadata, progress | Existing JSON contract | HTTP side effect |

## P. Failure and rollback semantics

- Invalid generation during `DELIVER_THEORY` returns the existing controlled
  `STRUCTURED_AI_REQUIRED` failure.
- No active task, evidence, progression, or assistant success message is
  created on that failure.
- A contradictory envelope does not mutate the selected server action into a
  different workflow branch.
- Phase 1, 3, and 4 receive `OUTSIDE_PHASE_2`, so their existing behavior is not
  overridden.
- `INVALID_PHASE2_STATE` returns HTTP 409 before any provider call, task
  activation, assistant success message, evidence, or progression write.
- No migration or schema change is involved. The Stage 1 seam is the rollback
  boundary.

Final Stage 2 verification:

| Verification | Result |
|---|---:|
| Frozen Stage 0 matrix | 315/315 passed |
| Stage 0 provider-free HTTP route baseline | 14/14 passed |
| Stage 1 extraction contracts | 10/10 passed |
| Stage 2 server-owned action plan | 12/12 passed |
| V2-R2 learner intent | 41/41 passed |
| Phase 2A R3 acceptance | 30/30 passed |
| API TypeScript typecheck / `git diff --check` | passed |
| Independent architecture review | PASS, no material findings |
| Restarted API + student-dashboard browser smoke | passed |

## Q. Remaining AI workflow coupling and next-stage readiness

AI still owns content generation inside the bounded server-selected action:

- THEORY explanation and generated MICRO_CHECK candidate wording;
- interaction type, options, and correct answer for a generated objective task,
  subject to existing validation before persistence;
- model evaluation as a candidate where no deterministic objective/source
  scorer applies;
- eligible source-exercise request metadata, with server fallback and persisted
  identity authority;
- response `teachingMode` on actions where an exact server mapping is ambiguous
  and changing it could affect current clients;
- legacy MICRO_CHECK-without-payload `DEFER_TO_COMPATIBILITY`; malformed states
  and other Phase-2 states do not receive compatibility fallback.

The next full theory/task/feedback schema split is **not implemented**. It needs
an explicit candidate-generation contract and a deliberate legacy-session
strategy before the compatibility fields or route branches can be removed.