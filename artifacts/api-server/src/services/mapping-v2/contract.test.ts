import assert from 'node:assert/strict';
import {validateCompleteMap,sourceHash,type CompleteMap,type SourceBlock} from './contract.js';
import {selectAdapter} from './prompts.js';
export function fixture(outcomeId=1):{map:CompleteMap;blocks:SourceBlock[]}{
 const blocks:SourceBlock[]=[{sourceText:'A body is a particular object.',sourcePage:6,blockType:'DEFINITION'},...Array.from({length:14},(_,i)=>({sourceText:`${i+1}. Question or practical ${i+1}`,sourcePage:9,blockType:i===13?'ACTIVITY':'EXERCISE'})),{sourceText:'Research the history and',sourcePage:9,blockType:'ACTIVITY'},{sourceText:'describe the important contributions.',sourcePage:10,blockType:'ACTIVITY'}];
 const node={id:'N1',title:'Body',knowledge:blocks[0].sourceText,role:'CORE' as const,knowledgeType:'CONCEPT' as const,learningObjective:'Explain the meaning of a body',sourceBlockIndices:[0],prerequisiteNodeIds:[],outcomeIds:[outcomeId],targetBloom:'understand' as const,estimatedMinutes:5,
 cognitivePath:[{level:'understand' as const,performanceObjective:'Explain the meaning of a body',successCriterion:'Accurate distinction between body and substance',minimumIndependentEvidence:1,interactionTypes:['short_answer' as const]}],
 teaching:{explanation:'A body is a particular object.',explanationSteps:['Identify an object'],examples:[{text:'A ruler',sourceStatus:'AI_PROPOSED' as const}],nonExamples:[{text:'A substance name',sourceStatus:'AI_PROPOSED' as const}],misconception:'Confusing objects with substances',guidingQuestion:'Which object?',hint:'Name a particular object'}};
 const exercises=Array.from({length:15},(_,i)=>({id:`E${i+1}`,sourceBlockIndices:i===14?[15,16]:[i+1],sourceType:'textbook' as const,generatedText:'',nodeIds:['N1'],topicId:'T1',purpose:'PRACTICE' as const,successCriteria:'Correct distinction',cognitiveLevel:'understand' as const}));
 return {blocks,map:{schemaVersion:'P1.2.2',essentialQuestion:'How do we describe objects?',boundaries:['Only this section'],topics:[{id:'T1',title:'Bodies',bigIdea:'A body is a particular object.',nodes:[node]}],exercises,excludedBlocks:[],reviewIssues:[]}};
}
const {map,blocks}=fixture();assert.equal(validateCompleteMap(map,blocks,[1]).exercises.length,15);
assert.equal(sourceHash(blocks),sourceHash(structuredClone(blocks)));
const changed=structuredClone(blocks);changed[0].sourceText+=' changed';assert.notEqual(sourceHash(blocks),sourceHash(changed));
function rejects(fn:(m:CompleteMap)=>void,reason:RegExp){const m=structuredClone(map);fn(m);assert.throws(()=>validateCompleteMap(m,blocks,[1]),reason);}
rejects(m=>m.exercises.pop(),/UNCOVERED_SOURCE/);
rejects(m=>m.exercises[1].sourceBlockIndices=[1],/DUPLICATE_OR_INVALID/);
rejects(m=>m.topics[0].nodes[0].targetBloom='create',/INVALID_COGNITIVE/);
rejects(m=>m.topics[0].nodes[0].outcomeIds=[999],/INVALID_OUTCOME/);
rejects(m=>m.topics[0].nodes[0].prerequisiteNodeIds=['N1'],/INVALID_PREREQUISITE/);
rejects(m=>m.exercises[0].generatedText='Rewritten source',/INVALID_TEXTBOOK_PROVENANCE/);
rejects(m=>{m.exercises.splice(0,1);m.excludedBlocks.push({blockIndex:1,kind:'NON_INSTRUCTIONAL',reason:'skip'});},/LOST_SOURCE/);
assert.equal(selectAdapter('Physics').id,'PHYSICS_V1');assert.equal(selectAdapter('History').id,'UNIVERSAL_CORE_ONLY');
console.log('PASS: whole-lesson contract, 13 questions + 2 practicals, continuation, source hash, provenance, references, Bloom, outcomes and adapters');
