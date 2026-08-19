---
name: Phase 2 route baseline
description: Provider-free real-route testing, isolated test-database drift, and known Phase 2 transition/evidence gaps.
---

## Provider-free orchestration tests

Exercise Phase 2 orchestration through the real Express routes and isolated test
database while intercepting only the OpenAI-compatible HTTP boundary with local,
deterministic responses. Keep pure-function and source-contract tests as a
second layer rather than treating source snapshots as proof of route behavior.

**Why:** Route-only ownership bugs can pass helper tests even when the visible
response and persisted task, evidence, or progression state disagree.

**How to apply:** Any orchestration refactor should keep both Stage 0 suites
green and extend the real-route harness when changing activation, scoring,
evidence, progression, or student response shaping. Never call a provider from
the baseline.

## Isolated test-database drift

The isolated test database can lag the application's current migrations even
when source and development schema declarations are current.

**Why:** Real-route tests initially failed on missing schema state unrelated to
the behavior under test.

**How to apply:** Before diagnosing a new route-test failure as application
logic, verify the isolated test schema is current. Apply missing schema changes
only to the test database; do not infer that development or production needs
the same manual update.

## Known current behavior gaps

After the Decision Engine advances to a new cognitive level, server state
returns to Phase 2 THEORY, but history-based teaching-cycle rule R1 still sees
the prior MICRO_CHECK and can reject the next server-canonicalized TEACH
envelope with a fail-closed 503.

Typed source correctness and evidence identity use the persisted active
exercise, but the evidence interaction type is currently inferred from the
learner's short answer token rather than copied from the persisted source
exercise.

**Why:** Both gaps were exposed only by provider-free real-route coverage and
were intentionally not changed while freezing the compatibility baseline.

**How to apply:** Treat these as production follow-ups, not reasons to weaken
the frozen tests. Preserve the fail-closed rule and persisted source authority
while correcting the conflicting transition and metadata wiring.