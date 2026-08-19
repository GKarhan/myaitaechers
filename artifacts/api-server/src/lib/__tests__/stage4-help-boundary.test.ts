import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildActiveTaskReminder, resolveHelpTaskText } from "../../routes/chat.js";

const unsafe = {
  exerciseTextVerbatim: "Բացատրիր փորձը։",
  exerciseTextEdited: "Բացատրիր փորձը։ Սպասվող պատասխան՝ դիֆուզիա։",
  successCriteria: "Սովորողը նշում է դիֆուզիան։",
  correctAnswer: null,
};

console.log("\n▶ Stage 4 HELP content boundary\n");

const inlineHelp = resolveHelpTaskText(unsafe, "fallback task");
assert.equal(inlineHelp.ok, false);
assert.equal("taskText" in inlineHelp, false);
console.log("  ✓ inline HELP cannot prompt or disclose an unsafe active exercise");

const dedicatedHelp = resolveHelpTaskText(unsafe, "fallback task");
assert.equal(dedicatedHelp.ok, false);
assert.equal("taskText" in dedicatedHelp, false);
console.log("  ✓ POST /chat/help cannot prompt or disclose an unsafe active exercise");

const safe = resolveHelpTaskText({
  ...unsafe,
  exerciseTextEdited: "Բացատրիր, թե փորձը ինչ է ցույց տալիս։",
}, null);
assert.deepEqual(safe, {
  ok: true,
  taskText: "Բացատրիր, թե փորձը ինչ է ցույց տալիս։",
});
console.log("  ✓ safe edited learner text remains available for hints");

assert.equal(
  buildActiveTaskReminder("Անվտանգ առաջադրանք"),
  "Ընթացիկ առաջադրանքը դեռ բաց է։ Խնդրում եմ պատասխանել։\nԱնվտանգ առաջադրանք",
);
assert.equal(
  buildActiveTaskReminder(null),
  "Ընթացիկ առաջադրանքը դեռ բաց է։ Խնդրում եմ պատասխանել։",
);
console.log("  ✓ active-task reminder uses coherent Armenian and safe task text");

const source = readFileSync(new URL("../../routes/chat.ts", import.meta.url), "utf8");
assert.match(source, /_intentResult\.intent === "HELP"[\s\S]*executeHelpRequest\(/u);
assert.match(source, /router\.post\("\/chat\/help"[\s\S]*executeHelpRequest\(/u);
assert.match(
  source,
  /_evaluatedTaskEvidenceContext[\s\S]*activeHelpCount: session\.activeHelpCount[\s\S]*activeAssistanceLevel: session\.activeAssistanceLevel/u,
);
console.log("  ✓ inline HELP and /chat/help both delegate to the guarded executor");

console.log("\n4 passed, 0 failed\n");