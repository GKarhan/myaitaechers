# Stage 5 Pre-Change Continuation Audit

Read-only audit of the Stage 3/4/4.1 Phase 2 implementation before Stage 5 changes. No data or runtime behavior was changed while producing this report.

## Current transition and ownership map

| Transition | Current server action / stage | Active task | Learner input required now? | Additional chat request required? | Same-request continuation safe? | Current persistence and side effects |
|---|---|---|---|---|---|---|
| A. Lesson start / READY | Initial intro gate; then `DELIVER_THEORY` in `THEORY` | None | Initial intentional READY: yes | Yes, for the initial READY only | Yes after READY | User message is stored; intro confirmation is persisted before normal Phase 2 handling. |
| B. DELIVER_THEORY | `DELIVER_THEORY`, `THEORY` → `TASK_REQUIRED` | Cleared | No after valid theory | **Yes currently** | Yes | Bounded THEORY validates, resets task fields, stores one assistant theory row, then returns. |
| C. THEORY success → TASK_REQUIRED | Persisted `TASK_REQUIRED` | None | No | **Yes currently** | Yes | Task-state reset happens before the theory response; no task is visible yet. |
| D. TASK_REQUIRED → source exercise | `DELIVER_SOURCE_EXERCISE` | Exact source exercise after activation | No until visible task exists; then yes | **Yes currently** when entered from theory | Yes | Eligible edited content is selected, validation succeeds, exact row is activated, then source text is stored/displayed. |
| E. TASK_REQUIRED → generated task | `GENERATE_TASK` | Generated objective/constructed task after activation | No until visible task exists; then yes | **Yes currently** when entered from theory | Yes | Bounded TASK validates, persists task identity and stage, then stores/displays the task. |
| F. Learner answer → evaluation | `EVALUATE_ACTIVE_TASK` | Existing authoritative task | Yes: this is the real answer | No | N/A | Deterministic source/objective scoring wins where available; bounded EVALUATION is used for constructed responses. |
| G. Evaluation → Decision Engine | Post-evaluation orchestration | Existing task until reset/progression | No | No | Yes | Counters persist, Decision Engine runs from server data, remediation/level state persists before response. |
| H. Decision Engine → FEEDBACK | Bounded FEEDBACK after evaluation | May be cleared or retained according to progression | No by itself | No | Yes | Feedback is separately validated and stored as its own assistant row. |
| I. CONTINUE_COGNITIVE_LEVEL | Usually `DELIVER_FEEDBACK` or `REMEDIATE` | Retained when retry/remediation needs an answer | Usually yes after visible remediation/task | Sometimes | Only until a learner-answerable task | Current route has no generalized continuation owner; remediation remains feedback-driven. |
| J. ADVANCE_COGNITIVE_LEVEL | `ADVANCE_COGNITIVE_LEVEL`, reset to `THEORY` | Cleared | No | **Yes currently** | Yes | Decision Engine owns advance; route clears task state and keeps the same node. A later learner acknowledgement triggers theory. |
| K. COMPLETE_MICRONODE | `COMPLETE_MICRONODE`, next node `THEORY` or Phase 3 | Cleared | No for a next Phase 2 node; Phase 3 behavior is out of scope | **Yes currently** | Yes only for a next Phase 2 node | Node/session progression persists before response. Phase 3 entry stays unchanged. |
| L. Remediation | `REMEDIATE` / `DELIVER_FEEDBACK` | Existing task unless authoritative progression clears it | Yes when remediation asks for an answer | No extra automatic turn should be consumed | No beyond producing non-answerable content | Decision Engine remains the action owner; HELP/evidence semantics are independent. |
| M. HELP | Dedicated endpoint or text intent while a task is active | Preserved | Yes: explicit learner action | Yes, by learner choice | No | Help validates active content, writes one help event, updates assistance state, and never advances or writes evidence. |
| N. Legacy compatibility | `DEFER_TO_COMPATIBILITY` only for old MICRO_CHECK state without payload | Compatibility task state | Depends on current task | Existing behavior | Not expanded in Stage 5 | Compatibility branch is explicitly scoped and must remain fail-closed for malformed state. |

## Existing continuation and persistence behavior

- The current `V2-R1.1` continuation is a one-step, per-request fallback: after a MICRO_CHECK evaluation transitions to a source exercise, it may insert one source-exercise row after the feedback row. It is not a general continuation loop.
- `chat_messages` already safely represents multiple bounded assistant outputs: the existing feedback-plus-source-exercise path stores distinct rows before the response returns. The frontend invalidates history after a successful real learner request and renders all stored rows; it does not synthesize learner messages.
- Source activation validates Stage 4/4.1 learner-delivery eligibility, persists the exact internal exercise ID and provenance, and only then exposes the task. Generated tasks validate before their active-task state is stored and displayed.
- Evidence is written only from the original evaluated learner turn after the response path. Internal theory/task/feedback work does not independently create evidence.

## Stop-condition check

| Stop condition | Result | Audit evidence |
|---|---|---|
| Requires fake frontend learner messages | Clear | The client posts only typed input and invalidates history; no auto-send path exists. |
| Chat persistence cannot represent multiple bounded outputs | Clear | Current feedback/source continuation already persists distinct assistant rows. |
| Evidence would duplicate | Clear | The durable evidence path is tied to the original evaluated answer; continuation actions are not evaluation turns. |
| Task activation would precede visible-task validation | Clear | Source and generated activation paths validate before task visibility. |
| Server action cannot determine learner-input requirement | Clear | Authoritative action, stage, and active-task state are already available to a pure rule. |
| Would alter Cognitive Path or Decision Engine policy | Clear | Continuation will consume existing decisions only; it will not derive new policy. |
| Would make Stage 4 blocked content deliverable | Clear | Class exercise filtering and source activation require persisted eligible learner text. |
| Would require Phase 1/3/4 redesign | Clear | Continuation remains Phase 2-only; Phase 3 entry stays unchanged. |
| Database migration required | Clear | Existing session and chat-message state is sufficient. |

## Audit result

**PASS — no Stage 5 stop condition is reached.** The implementation may add one bounded backend continuation owner and a pure learner-input-required rule while preserving all existing safety and pedagogical authorities.