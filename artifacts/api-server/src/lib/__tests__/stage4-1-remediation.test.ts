import assert from "node:assert/strict";
import { resolveLearnerExerciseContent } from "../exercise-content-boundary.js";
import { deriveStage41Remediation } from "../stage4-1-remediation.js";

const target941 = {
  id: 941,
  exerciseId: "EX-579-2",
  exerciseTextVerbatim: "Source text remains untouched.",
  exerciseTextEdited: "Վարժություն 2 — Ճիշտ / Սխալ\n\nՊնդում․ Մոլեկուլները շարժվում են։\n\nՃիշտ պատասխան՝ Ճիշտ",
  successCriteria: "Ճիշտ պատասխան՝ Ճիշտ",
  correctAnswer: "TRUE",
  interactionType: "true_false",
};
const target942 = {
  id: 942,
  exerciseId: "EX-579-3",
  exerciseTextVerbatim: "Source text remains untouched.",
  exerciseTextEdited: "Վարժություն 4 — Ընդարձակ պատասխան\n\nՀարց․ Ի՞նչ է ցույց տալիս փորձը։\n\nՍպասվող պատասխանի հիմնական միտքը․ Մոլեկուլները շարժվում են։",
  successCriteria: "Սպասվող պատասխանի հիմնական միտքը․ Մոլեկուլները շարժվում են։",
  correctAnswer: null,
  interactionType: null,
};

for (const row of [target941, target942]) {
  const remediation = deriveStage41Remediation(row);
  assert.ok(remediation, `${row.exerciseId} must have an exact structural proposal`);
  assert.ok(!remediation.learnerTextAfter.includes(row.successCriteria!), "hidden metadata must be removed only from learner text");
  const boundary = resolveLearnerExerciseContent({
    ...row,
    exerciseTextEdited: remediation.learnerTextAfter,
  });
  assert.equal(boundary.ok, true, `${row.exerciseId} proposal must pass the learner boundary`);
}

assert.equal(
  deriveStage41Remediation({ ...target941, correctAnswer: "FALSE" }),
  null,
  "no write occurs when deterministic evidence no longer matches",
);
assert.equal(
  deriveStage41Remediation({ ...target942, exerciseId: "EX-OTHER" }),
  null,
  "no generic text splitting is allowed",
);

console.log("Stage 4.1 deterministic remediation: 4 passed, 0 failed");