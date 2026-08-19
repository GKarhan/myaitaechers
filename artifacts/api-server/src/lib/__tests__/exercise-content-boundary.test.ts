import assert from "node:assert/strict";
import {
  EXERCISE_CONTENT_ISSUE,
  isLearnerDeliveryEligible,
  resolveLearnerExerciseContent,
  validateLearnerExerciseText,
} from "../exercise-content-boundary.js";

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("\n▶ Stage 4 exercise content boundary\n");

test("safe learner text stays separate from hidden objective metadata", () => {
  const result = resolveLearnerExerciseContent({
    exerciseTextVerbatim: "Ո՞ր պնդումն է ճիշտ։\nԱ) Առաջին\nԲ) Երկրորդ",
    exerciseTextEdited: "Ո՞ր պնդումն է ճիշտ։\nԱ) Առաջին\nԲ) Երկրորդ",
    successCriteria: "Ճիշտ պատասխան՝ Բ",
    correctAnswer: "B",
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.learnerText.includes("Ճիշտ պատասխան՝ Բ"), false);
});

test("explicit answer key in learner text is rejected", () => {
  const result = validateLearnerExerciseText({
    learnerText: "Պնդումը ճիշտ է։ Ճիշտ պատասխան՝ Ճիշտ",
    correctAnswer: "TRUE",
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === EXERCISE_CONTENT_ISSUE.EXPLICIT_ANSWER_KEY));
});

test("expected-answer material in learner text is rejected", () => {
  const result = resolveLearnerExerciseContent({
    exerciseTextVerbatim: "Բացատրիր փորձը։",
    exerciseTextEdited: "Բացատրիր փորձը։ Սպասվող պատասխանի հիմնական միտքը․ նյութերը խառնվում են։",
    successCriteria: "Նյութերը խառնվում են մոլեկուլների շարժման պատճառով։",
  });
  assert.equal(result.ok, false);
});

test("safe edited text overrides unsafe source verbatim", () => {
  const result = resolveLearnerExerciseContent({
    exerciseTextVerbatim: "Բացատրիր փորձը։ Ճիշտ պատասխան՝ դիֆուզիա։",
    exerciseTextEdited: "Բացատրիր, թե փորձը ինչ է ցույց տալիս մոլեկուլների շարժման մասին։",
    successCriteria: "Կապում է դիտարկումը դիֆուզիայի հետ։",
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.source, "edited");
});

test("legacy verbatim is usable only after validation", () => {
  const safe = resolveLearnerExerciseContent({
    exerciseTextVerbatim: "Գրիր մեկ օրինակ։",
    exerciseTextEdited: null,
  });
  assert.equal(safe.ok, true);
  assert.equal(isLearnerDeliveryEligible(safe), false);
  assert.deepEqual(safe.reviewWarnings, ["learner-text-not-persisted"]);

  const unsafe = resolveLearnerExerciseContent({
    exerciseTextVerbatim: "Գրիր մեկ օրինակ։ Պատասխանի բանալին՝ օրինակ։",
    exerciseTextEdited: null,
  });
  assert.equal(unsafe.ok, false);
});

console.log(`\n${passed} passed, 0 failed\n`);