import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isLearnerDeliveryEligible,
  resolveLearnerExerciseContent,
} from "../exercise-content-boundary.js";

const legacy = resolveLearnerExerciseContent({
  exerciseTextVerbatim: "Հաշվիր 2 + 2-ը։",
  exerciseTextEdited: null,
});
assert.equal(legacy.ok, true, "validated verbatim remains available for teacher review");
assert.equal(isLearnerDeliveryEligible(legacy), false, "legacy review content must not reach learners");

const remediated = resolveLearnerExerciseContent({
  exerciseTextVerbatim: "Աղբյուրի նյութ։",
  exerciseTextEdited: "Հաշվիր 2 + 2-ը։",
  successCriteria: "Սովորողը գրում է 4։",
});
assert.equal(isLearnerDeliveryEligible(remediated), true, "persisted edited text is learner-deliverable");

const lessonsRoute = readFileSync(new URL("../../routes/lessons.ts", import.meta.url), "utf8");
const chatRoute = readFileSync(new URL("../../routes/chat.ts", import.meta.url), "utf8");
assert.match(lessonsRoute, /student-package:[\s\S]*isLearnerDeliveryEligible/u);
assert.match(chatRoute, /filterLearnerSafeExercises[\s\S]*isLearnerDeliveryEligible/u);
assert.match(chatRoute, /activateSourceExercise[\s\S]*isLearnerDeliveryEligible/u);
assert.match(chatRoute, /resolveHelpTaskText[\s\S]*isLearnerDeliveryEligible/u);

console.log("Stage 4.1 learner-delivery eligibility: 6 passed, 0 failed");