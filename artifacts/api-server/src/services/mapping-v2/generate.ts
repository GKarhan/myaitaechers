import {openrouter} from '@workspace/integrations-openrouter-ai';
import {COMPLETE_MAP_VERSION,CompleteMapValidationError,CompleteMapSchemaError,CompleteMapCognitivePathError,validateCompleteMap,type SourceBlock} from './contract.js';
import {SourceReferenceValidationError} from './source-references.js';
import {buildCompleteMapRequest,type CompleteMapContext} from './complete-request.js';
type Completion={choices:{finish_reason:string|null;message:{content:string|null}}[];usage?:unknown};
function repairDiagnostics(error:unknown):unknown|null {
 if(error instanceof CompleteMapValidationError||error instanceof SourceReferenceValidationError||error instanceof CompleteMapSchemaError||error instanceof CompleteMapCognitivePathError)return error.diagnostics;
 if(error instanceof Error&&/^(DUPLICATE_|INVALID_|CYCLIC_PREREQUISITES|EXERCISE_LEVEL_NOT_IN_NODE_PATH|UNCOVERED_REQUIRED_OUTCOME)/u.test(error.message))return {code:error.message};
 return null;
}
export async function generateCompleteMap(blocks:SourceBlock[],context:CompleteMapContext,options:{complete?:(request:ReturnType<typeof buildCompleteMapRequest>['request'])=>Promise<Completion>;onDraft?:(draft:unknown)=>Promise<void>}={}){
 const built=buildCompleteMapRequest(blocks,context);let request=built.request;
 const usages:unknown[]=[];
 // One valid answer still uses one call. Only an invalid candidate receives one
 // bounded corrective request; no candidate can bypass the original validator.
 for(let attempt=0;attempt<2;attempt++){
  const response=await (options.complete??(request=>openrouter.chat.completions.create(request)))(request);
  usages.push(response.usage??null);
  if(response.choices[0]?.finish_reason!=='stop')throw Error('COMPLETE_MAP_INCOMPLETE_RESPONSE');
  let value:unknown;try{value=JSON.parse(response.choices[0].message.content??'');}catch{throw Error('COMPLETE_MAP_INVALID_JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('COMPLETE_MAP_INVALID_JSON_OBJECT');
  const serverPackage={...value,schemaVersion:COMPLETE_MAP_VERSION};
  if(options.onDraft)await options.onDraft(serverPackage);
  try{return {map:validateCompleteMap(serverPackage,blocks,context.outcomes.map(o=>o.id)),hash:built.hash,adapter:built.adapter,
   usage:response.usage??null,generationAttempts:attempt+1,attemptUsages:usages};}
  catch(error){
   const diagnostics=repairDiagnostics(error);if(attempt===1||!diagnostics)throw error;
   const feedback=JSON.stringify({validationErrors:diagnostics,rejectedCandidate:serverPackage});
   if(feedback.length+built.request.messages.reduce((n,m)=>n+m.content.length,0)>180000)throw error;
   request={...built.request,messages:[...built.request.messages,{role:'user' as const,content:
    'Correct the invalid candidate below using the SAME supplied source blocks and outcomes. Return the entire corrected map once. Do not invent source text or weaken constraints. Fix EVERY reported validation group in this ONE correction; a source error must not hide a cognitive-path error. A source block cannot be both used and excluded: for CONFLICTING_SOURCE_DISPOSITION inspect the WHOLE block, not just its heading. Keep current-lesson instructional paragraphs linked and remove their contradictory exclusion. Only exclude a whole block when its entire content warrants that exclusion; never discard a mixed heading-plus-theory block as HEADER_FOOTER. Preserve unrelated valid content. Every source task must have exactly one exercise owner or a NEIGHBOR_SECTION exclusion when it belongs to another lesson. Never duplicate a source index across different exercises. Match exercise cognitive levels to EVERY linked node path. For EACH cognitivePathIssues entry: use each Bloom level at most once, combine objectives and criteria belonging to the same level without losing required content, order levels strictly remember < understand < apply < analyze < evaluate < create, and make the last level equal targetBloom. Resolve depth from supplied outcomes and source; do not automatically raise the ceiling or drop required performance merely to pass validation. Recheck ALL nodes and linked exercises before returning. Validation data and candidate JSON follow:\n'+feedback}]};
  }
 }
 throw Error('COMPLETE_MAP_VALIDATION_FAILED');
}
