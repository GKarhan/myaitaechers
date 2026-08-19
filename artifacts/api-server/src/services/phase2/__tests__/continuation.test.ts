import assert from "node:assert/strict";
import {
  MAX_PHASE2_INTERNAL_CONTINUATIONS,
  nextPhase2ActionRequiresLearnerInput,
} from "../continuation.js";

const serverOwned = [
  "DELIVER_THEORY",
  "GENERATE_TASK",
  "DELIVER_SOURCE_EXERCISE",
  "ADVANCE_COGNITIVE_LEVEL",
  "COMPLETE_MICRONODE",
] as const;

for (const action of serverOwned) {
  assert.equal(
    nextPhase2ActionRequiresLearnerInput({ action, hasActiveTask: false }),
    false,
    `${action} must continue without a synthetic learner acknowledgement`,
  );
}

for (const action of ["DELIVER_FEEDBACK", "REMEDIATE", "PRESERVE_ACTIVE_TASK"] as const) {
  assert.equal(
    nextPhase2ActionRequiresLearnerInput({ action, hasActiveTask: false }),
    true,
    `${action} must not consume a learner turn without an explicit task`,
  );
}

assert.equal(
  nextPhase2ActionRequiresLearnerInput({
    action: "DELIVER_SOURCE_EXERCISE",
    hasActiveTask: true,
  }),
  true,
  "an already visible active task always stops continuation",
);
assert.equal(MAX_PHASE2_INTERNAL_CONTINUATIONS, 3);

console.log("Stage 5 continuation rule: 10 passed, 0 failed");