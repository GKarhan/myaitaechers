import {z} from 'zod/v4';
import {providerCognitivePathSchema} from './provider-cognitive-path.js';
import {completeMapSchema,sourceHash,type SourceBlock} from './contract.js';
import {sourceRoles} from './source-references.js';
import {COMPLETE_MAPPING_PROMPT,selectAdapter} from './prompts.js';
export type CompleteMapContext={subject:string;grade:string|null;lessonTitle:string;teacherGoal:string|null;outcomes:{id:number;outcomeText:string}[];legacyOutcomes:string[]};
export function buildCompleteMapRequest(blocks:SourceBlock[],context:CompleteMapContext){
 const roles=sourceRoles(blocks),adapter=selectAdapter(context.subject),hash=sourceHash(blocks);
 if(!roles.theory.length)throw Error('COMPLETE_MAP_NO_THEORY_SOURCE');
 const schema=z.toJSONSchema(completeMapSchema) as Record<string,any>;delete schema.$schema;
 // Protocol metadata belongs to the server, never to model generation.
 delete schema.properties.schemaVersion;
 schema.required=schema.required.filter((key:string)=>key!=='schemaVersion');
 const node=schema.properties.topics.items.properties.nodes.items.properties;
 const providerPath=z.toJSONSchema(providerCognitivePathSchema) as Record<string,any>;delete providerPath.$schema;
 node.cognitivePath=providerPath;
 delete node.targetBloom;
 const nodeSchema=schema.properties.topics.items.properties.nodes.items;
 nodeSchema.required=nodeSchema.required.filter((key:string)=>key!=='targetBloom');
 node.sourceBlockIndices.items={type:'integer',enum:roles.theory};
 node.sourceBlockIndices.description='Theory-source indices only. Exercise links belong in exercises[].nodeIds.';
 if(context.outcomes.length)node.outcomeIds.items={type:'integer',enum:context.outcomes.map(o=>o.id)};
 else node.outcomeIds.maxItems=0;
 const exercise=schema.properties.exercises.items.properties.sourceBlockIndices;
 if(roles.exercises.length)exercise.items={type:'integer',enum:roles.exercises};else exercise.maxItems=0;
 exercise.description='Only exercise/activity/homework source indices. AI-generated tasks use an empty array.';
 schema.properties.excludedBlocks.items.properties.blockIndex={type:'integer',enum:blocks.map((_,i)=>i)};
 const input=JSON.stringify({context,adapter:adapter.id,sourceHash:hash,sourceRoles:{theorySourceIndices:roles.theory,exerciseSourceIndices:roles.exercises},blocks:blocks.map((b,index)=>({index,...b}))});
 if(input.length+JSON.stringify(schema).length>180000)throw Error('COMPLETE_MAP_CONTEXT_TOO_LARGE');
 const request={model:'google/gemini-2.5-flash',temperature:0.1,max_tokens:24000,
  provider:{require_parameters:true},
  response_format:{type:'json_schema' as const,json_schema:{name:'complete_lesson_map',strict:true,schema}},
  messages:[{role:'system' as const,content:COMPLETE_MAPPING_PROMPT+'\n'+adapter.instructions+'\nClassify tasks belonging to a preceding OR following lesson as NEIGHBOR_SECTION, even if the block type is ACTIVITY. Never exclude a current-lesson task as NON_INSTRUCTIONAL. Each textbook exercise owns its source blocks exactly once. Link one source task to multiple nodes instead of duplicating it. An exercise cognitiveLevel MUST occur in EVERY linked node cognitivePath; otherwise choose a supported common level or leave uncertain node links empty and report the issue.'},{role:'user' as const,content:input}]};
 return {request,hash,adapter:adapter.id};
}
