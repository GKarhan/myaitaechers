import assert from "node:assert/strict";
import { currentNodeResult, hasCurrentCeilingProvenance, type NodeAnswer } from "../current-node-result.js";
const event = (id: number, correct: boolean, question = 544, quiz = 286): NodeAnswer => ({
  id, wasCorrect: correct, createdAt: new Date(id * 1000),
  taskReference: `quiz_question:${question}`, quizQuestionId: question,
  lessonSessionId: null, metadata: { quizId: quiz },
});
assert.equal(currentNodeResult([event(1,false),event(2,true)]),100);
assert.equal(currentNodeResult([event(1,false),event(2,false),event(3,true)]),100);
assert.equal(currentNodeResult([event(1,true)]),100);
assert.equal(currentNodeResult([event(1,true),event(2,false)]),0);
assert.equal(currentNodeResult([event(1,true,1),event(2,false,2)]),50);
assert.equal(currentNodeResult([event(1,false,1,100),event(2,true,2,200)]),100);
assert.equal(currentNodeResult([]),null);
assert.equal(currentNodeResult([event(2,true),event(1,false)]),100);
const chat = { ...event(3,false), quizQuestionId:null, lessonSessionId:10,
  taskReference:"chat:task:1", metadata:{source:"lesson"} };
assert.equal(currentNodeResult([event(1,true),chat]),0);
const input={persistedLevelId:286,computedLevelId:286,hasValidStoredReference:false,hasComputedEvidence:true};
assert.equal(hasCurrentCeilingProvenance(input),true);
assert.equal(hasCurrentCeilingProvenance({...input,hasComputedEvidence:false}),false);
assert.equal(hasCurrentCeilingProvenance({...input,persistedLevelId:999}),false);
console.log("PASS final node results replace retries, isolate assessments, include chat, and revalidate stale references from real evidence");
