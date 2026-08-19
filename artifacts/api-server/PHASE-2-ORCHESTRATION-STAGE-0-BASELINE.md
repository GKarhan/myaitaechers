# Phase 2 Orchestration Refactor — Stage 0 Baseline

Status: frozen compatibility baseline. This document describes current behavior,
not the planned Stage 1 design.

## Frozen invariants and executable authority

| # | Frozen current contract | Primary executable coverage |
|---|---|---|
| 1 | No active `MICRO_CHECK` without a visible, answerable task. | Stage 0 HTTP baseline; `phase2-stage0-baseline.test.ts` Fixtures A, B, J; `micro-check-activation-fix.test.ts` A–C; `v2r1-state-machine.test.ts` T07–T13, T21, T30–T32 |
| 2 | `FEEDBACK` with `is_micro_check=false` cannot activate or replace a task. | Stage 0 HTTP baseline; Stage 0 Fixture C; V2-R1 T09–T16; `v2r1-1-closure.test.ts` feedback/task cases |
| 3 | Phase 2 `THEORY` has a server-owned `TEACH` + `is_micro_check=true` envelope; only validated task content activates. | Stage 0 HTTP baseline; Stage 0 Fixtures A–B; micro-check activation A–I |
| 4 | Controlled structured generation fails closed: no fallback, task, evidence, or progression mutation. | Stage 0 HTTP baseline; Stage 0 Fixture B; micro-check activation B, D, I |
| 5 | Delivered source identity equals persisted `activeLessonExerciseId`. | Stage 0 HTTP baseline; Stage 0 Fixtures E–F; `source-exercise-activation.test.ts` A–G |
| 6 | Source delivery has one visible owner and cannot be duplicated. | Stage 0 HTTP baseline; Stage 0 Fixture F; source activation F–G; `phase11-exercise-delivery.test.ts` |
| 7 | Supported typed source correctness is backend-owned. | Stage 0 HTTP baseline; Stage 0 Fixture E; `deterministic-source-exercise-evaluation.test.ts`; `source-exercise-answer-contract.test.ts` |
| 8 | `activeObjectiveTaskPayload` owns generated objective correctness. | Stage 0 HTTP baseline; Stage 0 Fixture D; V2-R1 active-task tests |
| 9 | Source and generated objective task authorities remain separate. | Stage 0 HTTP baseline; Stage 0 Fixtures D–E; deterministic source evaluation G–I |
| 10 | The Decision Engine owns cognitive-level advance and target-ceiling completion. | Stage 0 HTTP baseline; Stage 0 Fixtures G–H; `v2r3-decision-engine.test.ts` T06–T10, T34–T40 |
| 11 | Legacy `stageBecomesVerified` cannot complete an active Cognitive Path node. | Stage 0 Fixture I; V2-R1 T17 |
| 12 | Phase 2 advances only after legitimate MicroNode completion. | Stage 0 Fixtures H–I; `v2r1-1-closure.test.ts`; V2-R3 completion tests |
| 13 | Evidence thresholds remain authoritative. | V2-R3 T06–T15; `phase2b-round2.test.ts`; `phase2a-r3-closure.test.ts` |
| 14 | Time/budget exhaustion is not learner failure. | Stage 0 S0.4; `v2r4a-budget.test.ts` T12–T18 and edge cases; `v2r4a3-session-completion.test.ts` |
| 15 | Student-facing chat, session, lesson-detail, and student-package payloads expose no answer keys. | Stage 0 HTTP baseline; Stage 0 Fixture L |
| 16 | Source verbatim text is protected. | Stage 0 HTTP baseline; `phase11-exercise-delivery.test.ts`; source activation F–G |
| 17 | Fresh/relearn resets session-local state but preserves durable evidence/mastery. | Stage 0 S0.3 |
| 18 | The frontend sends only `message + lessonId`; backend/session state is authoritative. | Stage 0 S0.2; V2-R1 T19–T21, T27–T28 |

## Representative response/state fixtures

| Fixture | Frozen response/state pair |
|---|---|
| A | Valid THEORY explanation + generated MC → `MICRO_CHECK`, active objective payload, no evidence yet |
| B | Invalid structured THEORY content → safe failure; THEORY state and all task/evidence identities remain empty |
| C | Feedback-only response → no newly active task; cognitive level remains unchanged |
| D | Active objective MC, learner `բ`, payload answer `B` → backend `CORRECT` regardless of model status |
| E | Active source `EX-579-1` → internal ID 940 delivers/scores the exact row |
| F | Explicit eligible `EX-579-2` → internal ID 941 and only its visible text |
| G | `ADVANCE_COGNITIVE_LEVEL` → same node/Phase 2, next level, THEORY, stale task cleared |
| H | Confirmed target ceiling → `mayCompleteMicroNode=true` |
| I | `stageBecomesVerified=true` with `mayCompleteMicroNode=false` → no cognitive-path completion |
| J | Transition-only constructed response rejected; visible answerable prompt accepted |
| K | Legacy null typed metadata → existing AI-assisted path |
| L | Chat/session/lesson payloads contain no source/generated hidden answers |

## Current ownership boundaries

| Owner | Current authority |
|---|---|
| Database/session state | Current phase/node/stage, active cognitive level, active source ID, active objective payload, attempts/help |
| Exercise-delivery library | Eligible source resolution, exact active source text, single-owner delivery |
| Deterministic evaluators | Supported typed source answers and active generated objective answers |
| Decision Engine | Cognitive progression, evidence thresholds, remediation, target completion, budget/revisit outcomes |
| AI service | Legacy structured content/evaluation candidate under server canonicalization and validators |
| Chat route | Current orchestration, activation, persistence, evidence wiring, response shaping |
| Frontend | Learner intent only: `{ message, lessonId }`; renders server-persisted history |

`source_fidelity.exercise_id` is a request, never authority. The resolved persisted
internal exercise row remains authoritative for delivery and scoring.

## Legacy/transitional structured AI contract

The Stage 0 snapshot freezes these current top-level fields without endorsing
their future ownership:

`student_message`, `progress_indicator`, `teaching_mode`, `is_micro_check`,
`interaction_type`, `options`, `correct_option`, `answer_evaluation`,
`node_decision`, `source_fidelity`, `redirect_needed`,
`mentions_out_of_scope_topic`, `question_template`, `encouragement_used`,
`encouragement_focus`.

Do not remove or redesign them until a later refactor stage supplies an explicit
compatibility/rollback plan.

## Known current gaps — not fixed in Stage 0

1. `chat.ts` remains the single orchestration owner and has no focused provider
   injection seam. The HTTP harness therefore intercepts the local
   OpenAI-compatible fetch boundary; exact source snapshots remain only for
   contracts that do not need route execution.
2. Objective MICRO_CHECK scoring is deterministic but remains route-local
   rather than a focused evaluator module.
3. `computeLocalNodeBudget` is intentionally frozen as always false in the
   current V1 policy.
4. Generated runtime chat metadata exceeds the narrow generated
   `ChatResponse` type; Stage 0 does not change generated API types or frontend
   behavior.
5. Typed source evidence is linked to the authoritative persisted exercise and
   scored deterministically, but its `interactionType` is currently inferred
   from the learner token (`B` becomes `short_answer`) instead of copied from
   the active source row (`multiple_choice`).

## Required regression baseline for Stages 1–6

At minimum, keep these suites green:

- `test:phase2-stage0`
- `test:phase2-stage0-http`
- `micro-check-activation-fix.test.ts`
- `test:v2r1`
- `test:v2r1-1`
- `source-exercise-activation.test.ts`
- `deterministic-source-exercise-evaluation.test.ts`
- `test:source-answer-contract`
- `phase11-exercise-delivery.test.ts`
- `test:v2r3`
- `test:v2r4a`
- `test:v2r4a3`
- `test:phase2a-r3-closure`
- `test:phase2b-round2`

Provider-backed generation tests are deliberately outside this Stage 0
provider-free baseline.

`phase2-stage0-http.test.ts` adds provider-free integration coverage against
the real Express route and isolated test database. It intercepts only the
OpenAI-compatible HTTP boundary with deterministic local responses. The suite
verifies:

- deterministic intro without an AI request;
- real THEORY response ↔ persisted objective-task correspondence;
- chat, session-state, lesson-detail, and student-package answer-key privacy;
- backend-owned objective scoring despite a conflicting model decision;
- requested eligible source selection over first-row fallback;
- persisted source identity, exactly-once verbatim delivery, deterministic
  typed scoring, and one source-linked evidence event;
- one evidence event per evaluated task;
- Cognitive Path level advance without premature Phase 3 entry;
- feedback-only task clearing;
- two-attempt structured-generation failure returning 503 without a success
  response/state pair.

## Stage 0 verification — 2026-08-19

| Suite | Result |
|---|---:|
| Phase 2 Stage 0 contract baseline | 16/16 passed |
| Phase 2 Stage 0 provider-free HTTP baseline | 14/14 passed |
| Phase 2 MICRO_CHECK activation safety | 9/9 passed |
| V2-R1 state machine | 33/33 passed |
| V2-R1.1 closure | 21/21 passed |
| Source-exercise activation | 7/7 passed |
| Deterministic source-exercise evaluation | 10/10 passed |
| Source-exercise answer contract | 9/9 passed |
| Phase 1.1 source delivery | 16/16 passed |
| V2-R3 Decision Engine | 45/45 passed |
| V2-R4A budget | 35/35 passed |
| V2-R4A.3 session completion | 21/21 passed |
| Phase 2A R3 closure | 30/30 passed |
| Phase 2B Round 2 evidence model | 42/42 passed |
| Test-isolation safety | 7/7 passed |
| **Total** | **315/315 passed** |

Additional checks:

- API TypeScript typecheck: passed.
- `git diff --check`: passed.
- Provider/model calls: not run.
- Production workflow restart: not required because Stage 0 changes only tests,
  documentation, and a test command.

## Newly exposed current-behavior gaps

The real-route harness exposed a pre-existing transition conflict after
`ADVANCE_COGNITIVE_LEVEL`: the session correctly advances to the next Cognitive
Path level, stays in Phase 2, clears task state, and returns to `THEORY`; however,
the next request to generate that level's MICRO_CHECK is currently rejected by
teaching-cycle rule R1 because history still identifies the prior MICRO_CHECK
and rejects the server-canonicalized `TEACH` envelope. The route fails closed
with 503.

Stage 0 does not change this behavior. A later stage must reconcile the
server-owned `THEORY` state with history-based teaching-cycle validation before
the route can reliably generate the next level's task.

The same route harness also confirmed that source correctness and
`lessonExerciseId` are authoritative, but the resulting evidence event records
the learner-input heuristic `interactionType` (`B` → `short_answer`) rather than
the persisted source exercise's typed interaction (`multiple_choice`). Stage 0
freezes and documents this current metadata drift without changing production
behavior.