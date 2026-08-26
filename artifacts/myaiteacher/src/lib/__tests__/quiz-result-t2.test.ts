import assert from "node:assert/strict";
import {
  buildTargetedRetestRequest,
  formatAnswer,
  getRetestAuthorityUiState,
  parseTargetedRetestCreationPayload,
  STUDENT_RESULTS_FINISH_PATH,
  shouldShowExplanation,
  summarizeRetestAuthority,
  type RetestAuthorityPayload,
} from "../quiz-result-t2";

const authority = (
  strategy: RetestAuthorityPayload["strategy"],
  eligible: number,
  partial: number,
  notKnown: number,
): RetestAuthorityPayload => ({
  attemptId: 42,
  strategy,
  counts: { eligible, partial, notKnown },
});

const combined = authority("PARTIAL_AND_NOT_KNOWN", 5, 3, 2);
const notKnownOnly = authority("NOT_KNOWN_ONLY", 2, 3, 2);

assert.deepEqual(summarizeRetestAuthority(combined, notKnownOnly), {
  status: "ready",
  combinedCount: 5,
  notKnownOnlyCount: 2,
  hasActionableRetest: true,
});
console.log("PASS T2-1 — combined and not-known counts remain non-overlapping");

assert.deepEqual(
  summarizeRetestAuthority(
    authority("PARTIAL_AND_NOT_KNOWN", 2, 0, 2),
    authority("NOT_KNOWN_ONLY", 2, 0, 2),
  ),
  { status: "ready", combinedCount: 2, notKnownOnlyCount: 2, hasActionableRetest: true },
);
console.log("PASS T2-2 — no partial nodes keeps both counts at two");

assert.deepEqual(
  summarizeRetestAuthority(
    authority("PARTIAL_AND_NOT_KNOWN", 3, 3, 0),
    authority("NOT_KNOWN_ONLY", 0, 3, 0),
  ),
  { status: "ready", combinedCount: 3, notKnownOnlyCount: 0, hasActionableRetest: true },
);
console.log("PASS T2-3 — not-known-only is unavailable when its count is zero");

assert.deepEqual(
  summarizeRetestAuthority(
    authority("PARTIAL_AND_NOT_KNOWN", 0, 0, 0),
    authority("NOT_KNOWN_ONLY", 0, 0, 0),
  ),
  { status: "ready", combinedCount: 0, notKnownOnlyCount: 0, hasActionableRetest: false },
);
console.log("PASS T2-4 — both empty is a successful non-actionable completion state");

assert.deepEqual(
  getRetestAuthorityUiState({ loading: true, error: false, combined: null, notKnownOnly: null }),
  { status: "loading" },
);
console.log("PASS T2-5 — loading never becomes a false zero state");

assert.deepEqual(
  getRetestAuthorityUiState({ loading: false, error: true, combined, notKnownOnly }),
  { status: "error" },
);
console.log("PASS T2-6 — authority failure does not fall back to result grouping");

assert.equal(formatAnswer(["Ա", "Բ", "Գ", "Դ"], 1), "B. Բ");
assert.equal(shouldShowExplanation(null, null), false);
console.log("PASS T2-7 — correct review formats an explicit learner answer without an explanation");

assert.equal(shouldShowExplanation("Որովհետև...", null), true);
assert.equal(formatAnswer(["Ա", "Բ"], 8), "I. —");
console.log("PASS T2-8 — incorrect review uses only an existing explanation");

assert.equal(shouldShowExplanation("Ճիշտ է", "Ճիշտ է"), false);
console.log("PASS T2-9 — duplicate explanations render only once");

assert.deepEqual(
  summarizeRetestAuthority(
    authority("PARTIAL_AND_NOT_KNOWN", 2, 1, 1),
    authority("NOT_KNOWN_ONLY", 1, 1, 1),
  ),
  { status: "ready", combinedCount: 2, notKnownOnlyCount: 1, hasActionableRetest: true },
);
console.log("PASS T2-10 — duplicate question cards do not affect authority counts");

assert.deepEqual(
  summarizeRetestAuthority(
    authority("PARTIAL_AND_NOT_KNOWN", 1, 1, 0),
    authority("NOT_KNOWN_ONLY", 0, 1, 0),
  ),
  { status: "ready", combinedCount: 1, notKnownOnlyCount: 0, hasActionableRetest: true },
);
console.log("PASS T2-11 — authority counts win over any alternate grouping");

assert.equal(STUDENT_RESULTS_FINISH_PATH, "/dashboard");
console.log("PASS T2-12 — Finish uses the existing safe student destination");

assert.deepEqual(
  buildTargetedRetestRequest(42, "PARTIAL_AND_NOT_KNOWN"),
  { sourceAttemptId: 42, strategy: "PARTIAL_AND_NOT_KNOWN" },
);
console.log("PASS T3-F1 — create request contains only source attempt and strategy");

assert.deepEqual(
  parseTargetedRetestCreationPayload({
    created: true,
    reused: false,
    sourceAttemptId: 42,
    strategy: "NOT_KNOWN_ONLY",
    quizId: 91,
    assignmentId: 92,
  }),
  {
    created: true,
    reused: false,
    sourceAttemptId: 42,
    strategy: "NOT_KNOWN_ONLY",
    quizId: 91,
    assignmentId: 92,
  },
);
console.log("PASS T3-F2 — valid create/start response is accepted");

assert.deepEqual(
  parseTargetedRetestCreationPayload({
    created: false,
    reason: "NO_ELIGIBLE_NODES",
    sourceAttemptId: 42,
    strategy: "PARTIAL_AND_NOT_KNOWN",
  }),
  {
    created: false,
    reason: "NO_ELIGIBLE_NODES",
    sourceAttemptId: 42,
    strategy: "PARTIAL_AND_NOT_KNOWN",
  },
);
console.log("PASS T3-F3 — bounded empty eligibility remains a normal state");

assert.equal(
  parseTargetedRetestCreationPayload({
    created: true,
    sourceAttemptId: 42,
    strategy: "PARTIAL_AND_NOT_KNOWN",
    quizId: 91,
  }),
  null,
);
console.log("PASS T3-F4 — incomplete creation responses fail closed");

console.log("T2/T3 frontend/domain suite passed (16/16)");