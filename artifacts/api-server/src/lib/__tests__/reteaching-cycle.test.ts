import assert from "node:assert/strict";
import {buildFeedbackReleaseUpdate,buildReteachStageUpdate,buildTerminalRevisitStageUpdate,derivePhase2ServerAction} from "../../services/phase2/orchestration.js";
import {decideNextPedagogicalAction,type PedagogicalDecisionInput} from "../../services/pedagogicalDecisionEngine.js";
const repair=buildReteachStageUpdate();
assert.equal(repair.nodeTeachingStage,"RETEACH_REQUIRED");
assert.equal(repair.activeTaskReference,null);
assert.equal(repair.activeTaskSnapshot,null);
assert.equal("currentNodeId" in repair,false);
assert.equal("activeCognitiveLevelId" in repair,false);
assert.deepEqual(buildFeedbackReleaseUpdate("RETEACH"),repair);
assert.equal(buildFeedbackReleaseUpdate("REVISIT_REQUIRED").nodeTeachingStage,"REVISIT_REQUIRED");
assert.equal(buildFeedbackReleaseUpdate(null).nodeTeachingStage,"TASK_REQUIRED");
const plan=derivePhase2ServerAction({currentPhase:2,currentNodeId:1,activeCognitiveLevelId:11,
 nodeTeachingStage:repair.nodeTeachingStage,activeTaskProvenance:null,activeLessonExerciseId:null,
 activeObjectiveTaskPayload:null,learnerIntent:"READY",evaluated:false,decision:null,progressionPlan:null});
assert.equal(plan.action,"DELIVER_THEORY");
assert.equal(plan.activeTaskMayBeCreated,false);
const level={id:11,cognitiveLevel:"understand",sequence:1,isApplicable:true,isTargetCeiling:true,
 performanceObjective:null,successCriterion:null,preferredInteractionTypes:[],minimumIndependentEvidence:3};
for(let failures=0;failures<3;failures++){
 const input:PedagogicalDecisionInput={lessonNodeId:1,lessonId:7,sessionId:9,userId:1,
 nodeTeachingStage:"MICRO_CHECK",remediationStep:failures,activeCognitiveLevelId:11,
 activeCognitiveLevelRow:level,cognitivePath:[level],answerStatus:"INCORRECT",evidenceQuality:"NONE",
 errorFamily:"CONCEPTUAL",errorStability:"FIRST_OCCURRENCE",activeHelpCount:0,activeAssistanceLevel:"none",
 activeAttemptSequence:1,activeTaskProvenance:"micro_check",levelEvidenceSummary:null,nextNodeId:2,
 nextNodeHasCriticalDependencyOnCurrentNode:true,sessionBudgetExhausted:false,localNodeBudgetExhausted:false,
 maxFailedTeachingAttempts:3};
 const decision=decideNextPedagogicalAction(input);
 assert.equal(decision.mayWriteMastery,false);
 const next=decision.revisitRequired?buildTerminalRevisitStageUpdate():buildReteachStageUpdate();
 assert.equal(next.nodeTeachingStage,failures===2?"REVISIT_REQUIRED":"RETEACH_REQUIRED");
}
console.log("Reteaching cycle: repair-before-task, target preservation and three-cycle stop passed.");
