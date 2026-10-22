import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateGeneratedQuestionCandidate, type NormalizedQuestionCandidate } from "../../services/quiz-question-quality.js";
import { selectFinalAssessmentHandoff } from "../final-assessment-handoff.js";
const fixture=JSON.parse(readFileSync(new URL("../../../pilot/lesson-819-final-v1.json",import.meta.url),"utf8"));
assert.equal(fixture.questions.length,15);
const targets=[2580,2581,2582,2583,2584].map((nodeId,i)=>({nodeId,cognitiveLevelId:295+2*i}));
const accepted:NormalizedQuestionCandidate[]=[];
for(const question of fixture.questions){
 const context={canonicalNodeId:question.nodeId,canonicalCognitiveLevelId:question.cognitiveLevelId,cognitiveLevel:"understand" as const,microNodeTitle:"Pilot",instructionalContent:"Mapped lesson 819",performanceObjective:null,successCriterion:null,preferredInteractionTypes:["short_answer"],deliveryInteractionType:"multiple_choice" as const};
 const result=validateGeneratedQuestionCandidate(question,context,accepted);
 assert.equal(result.passed,true,`${question.sequence}: ${result.reasonCodes.join(",")}`);
 assert.ok(question.solutionExplanation.length>20);
 assert.equal(question.sourceExerciseId,null);
 assert.ok(!/[A-Za-z\u0400-\u04ff]/u.test([question.questionText,...question.options,question.solutionExplanation].join(" ")));
 accepted.push(question);
}
const handoff=selectFinalAssessmentHandoff(targets,[{id:1,status:"ASSIGNED",assignmentStatus:"ASSIGNED",assessmentConfig:fixture.assessmentConfig}],fixture.questions.map((q:any,i:number)=>({...q,id:i+1,quizId:1})));
assert.equal(handoff.state,"READY");
console.log("PASS lesson 819 final: 15 distinct Armenian MC questions, 3 per target, answer indices/options/explanations and ready handoff");
