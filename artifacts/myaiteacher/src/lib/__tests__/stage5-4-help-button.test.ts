import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldShowExplicitHelpAction } from "../help-action-state.js";

console.log("\n▶ Stage 5.4 explicit HELP action\n");

assert.equal(
  shouldShowExplicitHelpAction({
    isCompleted: false,
    currentPhase: 2,
    hasActiveTask: true,
    activeHelpCount: 0,
    showCompletionCard: false,
  }),
  true,
);
console.log("  ✓ active source exercise state shows HELP");

assert.equal(
  shouldShowExplicitHelpAction({
    isCompleted: false,
    currentPhase: 2,
    hasActiveTask: true,
    activeHelpCount: 2,
    showCompletionCard: false,
  }),
  true,
);
console.log("  ✓ active generated task state shows HELP");

assert.equal(
  shouldShowExplicitHelpAction({
    isCompleted: false,
    currentPhase: 2,
    hasActiveTask: false,
    activeHelpCount: 0,
    showCompletionCard: false,
  }),
  false,
);
assert.equal(
  shouldShowExplicitHelpAction({
    isCompleted: false,
    currentPhase: 2,
    hasActiveTask: true,
    activeHelpCount: 0,
    showCompletionCard: true,
  }),
  false,
);
console.log("  ✓ THEORY/feedback/completed/no-task states hide HELP");

const lessonPage = readFileSync(
  new URL("../../pages/lesson-page.tsx", import.meta.url),
  "utf8",
);
assert.match(lessonPage, /\/api\/chat\/session-state\?lessonId=/u);
assert.match(lessonPage, /fetch\("\/api\/chat\/help"/u);
assert.match(lessonPage, /helpRequestInFlightRef\.current/u);
assert.match(lessonPage, /💡 Հուշում/u);
const requestHelpStart = lessonPage.indexOf("const requestHelp");
const requestHelpEnd = lessonPage.indexOf("const handleKeyDown", requestHelpStart);
const requestHelpBlock = lessonPage.slice(requestHelpStart, requestHelpEnd);
assert.doesNotMatch(requestHelpBlock, /handleSend|sendMessage\.mutate/u);
console.log("  ✓ direct HELP request has authoritative state, pending guard, and no synthetic learner message");

console.log("\n4 passed, 0 failed\n");