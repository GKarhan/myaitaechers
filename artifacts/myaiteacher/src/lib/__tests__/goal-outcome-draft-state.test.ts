import assert from "node:assert/strict";
import { getGoalOutcomeDraftState } from "../goal-outcome-draft-state.js";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test("an empty lesson makes source proposal creation available", () => {
  const state = getGoalOutcomeDraftState({ lessonGoal: "", outcomes: [], hasProposal: false });
  assert.equal(state.canCreateOrPropose, true);
  assert.equal(state.canImportProposal, false);
  assert.equal(state.canEditOrDelete, false);
});

test("a complete saved draft shows edit/delete and hides proposal controls", () => {
  const state = getGoalOutcomeDraftState({
    lessonGoal: "Դասի նպատակ",
    outcomes: ["Առաջին վերջնարդյունք", "Երկրորդ վերջնարդյունք"],
    hasProposal: true,
  });
  assert.equal(state.hasSavedDraft, true);
  assert.equal(state.canCreateOrPropose, false);
  assert.equal(state.canImportProposal, false);
  assert.equal(state.canEditOrDelete, true);
  assert.deepEqual(state.outcomes, ["Առաջին վերջնարդյունք", "Երկրորդ վերջնարդյունք"]);
});

test("a Goal without outcomes is explicitly partial and recoverable by edit/delete", () => {
  const state = getGoalOutcomeDraftState({ lessonGoal: "Կիսատ նպատակ", outcomes: [] });
  assert.equal(state.hasPartialSavedDraft, true);
  assert.equal(state.canCreateOrPropose, false);
  assert.equal(state.canEditOrDelete, true);
});

test("after deletion, create is active again without a separate approval state", () => {
  const state = getGoalOutcomeDraftState({ lessonGoal: null, outcomes: null, hasProposal: false });
  assert.equal(state.hasSavedDraft, false);
  assert.equal(state.canCreateOrPropose, true);
  assert.equal(state.canEditOrDelete, false);
});

console.log(`\nGoal/Outcome draft UI state: ${passed}/4 passed`);