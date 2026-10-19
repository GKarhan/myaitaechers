import {openrouter} from '@workspace/integrations-openrouter-ai';
import {validateCompleteMap,type SourceBlock} from './contract.js';
import {buildCompleteMapRequest,type CompleteMapContext} from './complete-request.js';
type Completion={choices:{finish_reason:string|null;message:{content:string|null}}[];usage?:unknown};
export async function generateCompleteMap(blocks:SourceBlock[],context:CompleteMapContext,options:{complete?:(request:ReturnType<typeof buildCompleteMapRequest>['request'])=>Promise<Completion>}={}){
 const {request,hash,adapter}=buildCompleteMapRequest(blocks,context);
 const response=await (options.complete??(request=>openrouter.chat.completions.create(request)))(request);
 if(response.choices[0]?.finish_reason!=='stop')throw Error('COMPLETE_MAP_INCOMPLETE_RESPONSE');
 let value:unknown;try{value=JSON.parse(response.choices[0].message.content??'');}catch{throw Error('COMPLETE_MAP_INVALID_JSON');}
 return {map:validateCompleteMap(value,blocks,context.outcomes.map(o=>o.id)),hash,adapter,usage:response.usage??null};
}
