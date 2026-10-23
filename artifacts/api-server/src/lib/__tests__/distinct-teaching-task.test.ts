import assert from "node:assert/strict";
import { generateDistinctTask } from "../distinct-teaching-task.js";
const history = [{role:"assistant",content:"Which is observation? A) Watching ice B) Heating ice"}];
let calls = 0;
const result = await generateDistinctTask(history, async correction => {
  calls++;
  if (calls === 1) return {student_message:"Which is observation?"};
  assert.match(correction, /repeated/);
  return {student_message:"A pupil records the Moon position. What method is used?"};
});
assert.equal(calls, 2);
assert.match(result.student_message, /Moon/);
await assert.rejects(generateDistinctTask(history, async () => ({student_message:"WHICH IS OBSERVATION!"})), /TASK_DISTINCTNESS_EXHAUSTED/);
let freshCalls = 0;
await generateDistinctTask(history, async () => {freshCalls++; return {student_message:"What distinguishes an experiment?"};});
assert.equal(freshCalls, 1);
console.log("distinct teaching task: fresh accepted, repeat regenerated, exhausted repeats rejected");
