import assert from "node:assert/strict";
import {allocateNodeQuestions,summarizeIndependentAnswers,currentIndependentAssessment,parseAssessmentConfig, type AssessmentEvent} from "../node-assessment-policy.js";
for(let n=1;n<=16;n++) for(let count=n;count<=n*3;count++) {
  const allocation=[...allocateNodeQuestions(Array.from({length:n},(_,i)=>i+1),count).values()];
  assert.equal(allocation.reduce((s,v)=>s+v,0),count);assert.ok(allocation.every(v=>v>=1&&v<=3));
  assert.ok(Math.max(...allocation)-Math.min(...allocation)<=1);
}
assert.throws(()=>allocateNodeQuestions([1,2],1));assert.throws(()=>allocateNodeQuestions([1],4));assert.throws(()=>allocateNodeQuestions(Array.from({length:51},(_,i)=>i),51));
for(const [answers,percent,certainty,status] of [
  [[true],100,"LOW","SUCCESS"],[[true,true],100,"MEDIUM","SUCCESS"],[[true,true,true],100,"HIGH","SUCCESS"],
  [[true,false,false],33,"LOW","PARTIAL"],[[true,true,false],67,"MEDIUM","PARTIAL"],
  [[false],0,"NONE","NOT_KNOWN"],[[false,false],0,"NONE","NOT_KNOWN"],[[false,false,false],0,"NONE","NEEDS_SUPPORT"],
] as const){const result=summarizeIndependentAnswers(answers);assert.equal(result.percent,percent);assert.equal(result.certainty,certainty);assert.equal(result.status,status);}
assert.equal(summarizeIndependentAnswers([]).percent,null);
assert.equal(summarizeIndependentAnswers([false,false,false]).nextAction,"TEACHER_REVIEW");
const e=(id:number,correct:boolean,ref:string,meta:Record<string,unknown>={}):AssessmentEvent=>({id,wasCorrect:correct,taskReference:ref,cognitiveLevelId:1,createdAt:new Date(id*1000),metadata:{assessmentVersion:"NODE_V1",assessmentCycle:"one",independentAssessment:true,assessmentFamily:ref,...meta}});
const events=[e(1,false,"q1"),e(2,false,"q2"),e(3,true,"q3"),e(4,true,"q1",{answerPreviouslyExposed:true,independentAssessment:false})];
assert.equal(currentIndependentAssessment(events,1)?.percent,33);
assert.equal(currentIndependentAssessment([...events,e(5,true,"q1",{assessmentCycle:"retry",independentAssessment:false})],1)?.percent,33);
assert.equal(currentIndependentAssessment([...events,e(6,true,"new1",{assessmentCycle:"two"})],1)?.percent,100);
assert.equal(currentIndependentAssessment([e(1,true,"q"),e(2,true,"q")],1)?.attempted,1);
assert.equal(currentIndependentAssessment(events,99)?.attempted,0);
assert.equal(parseAssessmentConfig({version:"NODE_V1",purpose:"CHECK",context:"CLASS_THEN_HOME"})?.purpose,"CHECK");
assert.equal(parseAssessmentConfig({version:"NODE_V1",purpose:"bad",context:"ANYWHERE"}),null);
assert.equal(currentIndependentAssessment([{...e(1,true,"q"),metadata:{}}]),null);
console.log("PASS balanced N..3N allocations, all assessment ratios/certainties, support stop, no exposed/repeated inflation, cognitive scope, legacy preservation");
