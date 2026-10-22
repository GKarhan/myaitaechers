import assert from "node:assert/strict";
import {filterRequiredPrerequisites,allocateNodeQuestions,summarizeIndependentAnswers,currentIndependentAssessment,parseAssessmentConfig,resolveQuizGenerationMode,aggregateAssessments, type AssessmentEvent} from "../node-assessment-policy.js";
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
assert.equal(currentIndependentAssessment(events)?.percent,33);
assert.equal(currentIndependentAssessment([...events,e(5,true,"q1",{assessmentCycle:"retry",independentAssessment:false})])?.percent,33);
assert.equal(currentIndependentAssessment([...events,e(6,true,"new1",{assessmentCycle:"two"})])?.percent,100);
assert.equal(currentIndependentAssessment([e(1,true,"q"),e(2,true,"q")])?.attempted,1);
assert.equal(currentIndependentAssessment(events)?.attempted,3);
assert.equal(parseAssessmentConfig({version:"NODE_V1",purpose:"CHECK",context:"CLASS_THEN_HOME"})?.purpose,"CHECK");
assert.equal(parseAssessmentConfig({version:"NODE_V1",purpose:"bad",context:"ANYWHERE"}),null);
assert.equal(currentIndependentAssessment([{...e(1,true,"q"),metadata:{}}]),null);
console.log("PASS balanced N..3N allocations, all assessment ratios/certainties, support stop, no exposed/repeated inflation, cognitive scope, legacy preservation");

const required=[{fromNodeId:1,toNodeId:2},{fromNodeId:2,toNodeId:3}];
assert.deepEqual(filterRequiredPrerequisites([1,2,3],required,new Map([[1,{knowledgeState:"NOT_KNOWN"}],[2,{knowledgeState:"MASTERED"}]])),[1]);
assert.deepEqual(filterRequiredPrerequisites([3],required,new Map([[1,{knowledgeState:"MASTERED"}],[2,{knowledgeState:"MASTERED"}]])),[3]);
console.log("PASS unresolved direct and transitive prerequisites block automatic follow-up");

// Quiz 287: one remember and two understand questions per node all count.
const patterns=[[true,false,false],[true,false,false],[false,true,true],[false,false,false]];
const summaries=patterns.map((answers,n)=>currentIndependentAssessment(answers.map((correct,i)=>({...e(n*10+i+1,correct,`node${n}q${i}`),cognitiveLevelId:i===0?1:2})))!);
assert.deepEqual(summaries.map(s=>s.percent),[33,33,67,0]);
assert.deepEqual(aggregateAssessments(summaries.map(assessment=>({assessment}))),{totalCorrect:4,totalQuestions:12,scorePercent:33});
assert.equal(summaries.filter(s=>s.status==="SUCCESS").length,0);
assert.equal(summaries.filter(s=>s.status==="NEEDS_SUPPORT").length,1);
console.log("PASS quiz 287 mixed-level regression: 4/12, 33%, node scores 33/33/67/0");

const nodePilot={version:"NODE_V1",purpose:"LEARNING",context:"ANYWHERE"};
assert.equal(resolveQuizGenerationMode(undefined,nodePilot),"standard");
assert.equal(resolveQuizGenerationMode(undefined,null),"canonical");
assert.equal(resolveQuizGenerationMode("canonical",nodePilot),"canonical");
assert.equal(resolveQuizGenerationMode("standard",nodePilot),"standard");
assert.equal(resolveQuizGenerationMode("invalid",nodePilot),null);
console.log("PASS NODE_V1 defaults to standard; legacy and explicit canonical modes remain unchanged");
