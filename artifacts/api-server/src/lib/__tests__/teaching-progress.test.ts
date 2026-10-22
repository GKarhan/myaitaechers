import assert from "node:assert/strict";
import {summarizeTeachingProgress, type TeachingEvidence} from "../teaching-progress.js";
const target={lessonId:7,nodeId:11,levelIds:[1,2],ceilingId:2};
function event(ref:string,level:number,changes:Partial<TeachingEvidence>={}):TeachingEvidence{
 return {taskReference:ref,cognitiveLevelId:level,wasCorrect:true,hintUsed:false,attemptSequence:1,
 assistanceLevel:"none",qualificationStatus:"qualified",metadata:{evaluation:{status:"CORRECT"},evidence_quality:"MODERATE",
 c4ProjectionCompleted:true,assistanceAtEvaluation:{helpCount:0},
 c7ExecutionTarget:{lessonId:7,microNodeId:11,activeCognitiveLevelId:level},
 canonicalTaskSnapshot:{taskReference:ref,lessonNodeId:11,cognitiveLevelId:level,taskSource:"micro_check",
 targetCompatibleAtActivation:true,renderedPrompt:ref}},...changes};
}
const a=event("task-a",1),b=event("task-b",2);
assert.deepEqual(summarizeTeachingProgress([],target),{covered:false,nextLevelId:1,correctTasks:0});
assert.deepEqual(summarizeTeachingProgress([a],target),{covered:false,nextLevelId:2,correctTasks:1});
assert.deepEqual(summarizeTeachingProgress([a,b],target),{covered:true,nextLevelId:null,correctTasks:2});
assert.equal(summarizeTeachingProgress([a,a],target).correctTasks,1);
assert.equal(summarizeTeachingProgress([a,event("another",1)],target).covered,false);
for(const change of [{hintUsed:true},{attemptSequence:2},{assistanceLevel:"light"},
 {qualificationStatus:"unqualified"},{wasCorrect:false},{metadata:null}] as Partial<TeachingEvidence>[]){
 assert.equal(summarizeTeachingProgress([a,event("b",2,change)],target).covered,false);
}
const duplicateContent=event("different-reference",2);
(duplicateContent.metadata as any).canonicalTaskSnapshot.renderedPrompt="task-a";
assert.equal(summarizeTeachingProgress([a,duplicateContent],target).covered,false);
assert.equal(summarizeTeachingProgress([a,b],{...target,nodeId:12}).correctTasks,0);
assert.equal(summarizeTeachingProgress([a,b],{...target,lessonId:8}).correctTasks,0);
assert.equal(summarizeTeachingProgress([event("single",1)],{...target,levelIds:[1],ceilingId:1}).covered,false);
assert.equal(summarizeTeachingProgress([a,b],{...target,levelIds:[1,2,3],ceilingId:3}).nextLevelId,3);
const lowQuality=event("low",2);
(lowQuality.metadata as any).evidence_quality="WEAK";
assert.equal(summarizeTeachingProgress([a,lowQuality],target).covered,false);
const mismatched=event("wrong-ref",2);
(mismatched.metadata as any).canonicalTaskSnapshot.taskReference="other";
assert.equal(summarizeTeachingProgress([a,mismatched],target).covered,false);
console.log("Teaching progress: coverage, two different tasks, assistance, retries, scope, and path-depth checks passed.");
