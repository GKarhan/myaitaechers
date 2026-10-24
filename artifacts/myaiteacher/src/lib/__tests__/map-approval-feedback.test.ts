import assert from "node:assert/strict";
import {getMapApprovalFeedback} from "../map-approval-feedback.js";
assert.deepEqual(getMapApprovalFeedback({hardBlockers:[{messageArm:"արգելք"}],errors:[{messageArm:"արգելք"}],reviewIssues:[{messageArm:"զգուշացում"}],confirmationRequired:false}),{messages:["արգելք","զգուշացում"],canConfirm:false});
assert.deepEqual(getMapApprovalFeedback({errors:[{messageArm:"արգելք"}],reviewIssues:[],confirmationRequired:true}),{messages:["արգելք"],canConfirm:false});
assert.deepEqual(getMapApprovalFeedback({errors:[],hardBlockers:[],reviewIssues:[{messageArm:"զգուշացում"}],confirmationRequired:true}),{messages:["զգուշացում"],canConfirm:true});
console.log("PASS approval feedback: blockers shown before warnings, empty warning arrays cannot hide errors, blockers never offered for override");
