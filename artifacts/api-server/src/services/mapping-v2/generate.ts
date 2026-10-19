import {z} from 'zod/v4';
import {openrouter} from '@workspace/integrations-openrouter-ai';
import {completeMapSchema,validateCompleteMap,sourceHash,type SourceBlock} from './contract.js';
import {COMPLETE_MAPPING_PROMPT,selectAdapter} from './prompts.js';
export async function generateCompleteMap(blocks:SourceBlock[],context:{subject:string;grade:string|null;lessonTitle:string;teacherGoal:string|null;outcomes:{id:number;outcomeText:string}[];legacyOutcomes:string[]}){
 const adapter=selectAdapter(context.subject),hash=sourceHash(blocks);
 const input=JSON.stringify({context,adapter:adapter.id,sourceHash:hash,blocks:blocks.map((b,index)=>({index,...b})),outputSchema:z.toJSONSchema(completeMapSchema)});
 if(input.length>180000)throw Error('COMPLETE_MAP_CONTEXT_TOO_LARGE');
 const response=await openrouter.chat.completions.create({model:'google/gemini-2.5-flash',temperature:0.1,max_tokens:24000,response_format:{type:'json_object'},messages:[{role:'system',content:COMPLETE_MAPPING_PROMPT+'\n'+adapter.instructions},{role:'user',content:input}]});
 if(response.choices[0]?.finish_reason!=='stop')throw Error('COMPLETE_MAP_INCOMPLETE_RESPONSE');
 let value:unknown;try{value=JSON.parse(response.choices[0].message.content??'');}catch{throw Error('COMPLETE_MAP_INVALID_JSON');}
 return {map:validateCompleteMap(value,blocks,context.outcomes.map(o=>o.id)),hash,adapter:adapter.id,usage:response.usage??null};
}
