import { z } from "zod/v4";
import assert from "node:assert/strict";
import { normalizeObjectiveMicroCheckAnswer } from "../../services/phase2/orchestration.js";
import { phase2TaskCandidateSchema, callPhase2FeedbackJob, serverOwnedFeedbackAcknowledgement } from "../../services/phase2/bounded-jobs.js";
for(const answer of ["Բ","բ","B","b)","2","Սխալ"])
  assert.equal(normalizeObjectiveMicroCheckAnswer(answer,"true_false"),"FALSE");
for(const answer of ["Ա","ա","A","1","Ճիշտ"])
  assert.equal(normalizeObjectiveMicroCheckAnswer(answer,"true_false"),"TRUE");
assert.notEqual(normalizeObjectiveMicroCheckAnswer("Գ","true_false"),"FALSE");
assert.doesNotThrow(() => z.toJSONSchema(phase2TaskCandidateSchema, {io:"input"}));
const candidate={student_message:"Ո՞ր տարբերակն է դիտում։",interaction_type:"multiple_choice",options:[{key:"A",text:"Տարբերակ մեկ"},{key:"B",text:"Տարբերակ երկու"}],correct_option:"Բ",question_template:null};
assert.equal(phase2TaskCandidateSchema.parse(candidate).correct_option,"B");
assert.equal(phase2TaskCandidateSchema.parse({...candidate,correct_option:candidate.options[1]!.text}).correct_option,"B");
assert.equal(phase2TaskCandidateSchema.parse({...candidate,interaction_type:"true_false",options:null,correct_option:"Բ"}).correct_option,"FALSE");
assert.equal(phase2TaskCandidateSchema.parse({...candidate,options:[{key:"Ա",text:"Մեկ"},{key:"Բ",text:"Երկու"}],correct_option:"բ)"}).correct_option,"B");
assert.equal(phase2TaskCandidateSchema.safeParse({...candidate,correct_option:"Գ"}).success,false);
assert.equal(phase2TaskCandidateSchema.safeParse({...candidate,options:[{key:"A",text:"Մեկ"},{key:"Ա",text:"Երկու"}],correct_option:"A"}).success,false);
const feedback=await callPhase2FeedbackJob([],"No provider call allowed",[],"INCORRECT");
assert.equal(feedback.student_message,serverOwnedFeedbackAcknowledgement("INCORRECT"));
assert.ok(!feedback.student_message.includes("Շատ լավ"));
assert.equal((await callPhase2FeedbackJob([],"No provider call allowed",[],"CORRECT")).student_message,serverOwnedFeedbackAcknowledgement("CORRECT"));
console.log("PASS pilot regression: displayed Armenian true/false labels, bounded key aliases, invalid-key rejection, deterministic gentle feedback without provider");
