import {z} from 'zod/v4';
import {openrouter} from '@workspace/integrations-openrouter-ai';
import {TEXT_SOURCE_SPAN_PROMPT,sourceLines,spanSchema,materializeSourceSpans} from './source-spans.js';
export async function prepareTextSource(text:string,pageNumber:number,precedingPageTail:string|null=null){
 if(!text.trim())return {blocks:[]};
 const input=JSON.stringify({physicalPage:pageNumber,precedingPageTail,lines:sourceLines(text)});
 if(input.length>100000)throw Error('SOURCE_SPAN_CONTEXT_TOO_LARGE');
 const response=await openrouter.chat.completions.create({model:'openai/gpt-5.4-mini',temperature:0,max_tokens:8000,
  response_format:{type:'json_schema',json_schema:{name:'source_line_spans',strict:true,schema:z.toJSONSchema(spanSchema)}},
  messages:[{role:'system',content:TEXT_SOURCE_SPAN_PROMPT},{role:'user',content:input}]});
 if(response.choices[0]?.finish_reason!=='stop')throw Error('SOURCE_SPAN_RESPONSE_INCOMPLETE');
 let value:unknown;try{value=JSON.parse(response.choices[0].message.content??'');}catch{throw Error('SOURCE_SPAN_RESPONSE_INVALID_JSON');}
 return materializeSourceSpans(text,pageNumber,value,precedingPageTail);
}
