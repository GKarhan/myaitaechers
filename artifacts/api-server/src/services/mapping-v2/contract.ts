import {assertSourceReferences} from './source-references.js';
import {z} from 'zod/v4';
import {createHash} from 'node:crypto';
export const COMPLETE_MAP_VERSION='P1.2.2' as const;
export const bloomLevels=['remember','understand','apply','analyze','evaluate','create'] as const;
const text=z.string().trim().min(1),indices=z.array(z.number().int().nonnegative());
const example=z.object({text,sourceStatus:z.enum(['SOURCE_DERIVED','AI_PROPOSED'])});
export const completeMapSchema=z.object({
 schemaVersion:z.literal(COMPLETE_MAP_VERSION),essentialQuestion:text,boundaries:z.array(text),
 topics:z.array(z.object({id:text,title:text,bigIdea:text,nodes:z.array(z.object({
  id:text,title:text,knowledge:text,role:z.enum(['CORE','SUPPORTING','EXTENSION']),
  knowledgeType:z.enum(['CONCEPT','FACT','RULE','RELATIONSHIP','REPRESENTATION','PROCEDURE_KNOWLEDGE','PRINCIPLE','VOCABULARY','MODEL']),
  learningObjective:text,sourceBlockIndices:indices.min(1),prerequisiteNodeIds:z.array(text),
  outcomeIds:z.array(z.number().int().positive()),targetBloom:z.enum(bloomLevels),estimatedMinutes:z.number().int().min(1).max(45),
  cognitivePath:z.array(z.object({level:z.enum(bloomLevels),performanceObjective:text,successCriterion:text,
   minimumIndependentEvidence:z.number().int().min(1).max(5),interactionTypes:z.array(z.enum(['multiple_choice','multi_select','true_false','matching','classification','ordering','numeric_answer','short_answer','constructed_response','problem_solving'])).min(1)})).min(1),
  teaching:z.object({explanation:text,explanationSteps:z.array(text).min(1),examples:z.array(example).min(1),nonExamples:z.array(example),misconception:text,guidingQuestion:text,hint:text})
 })).min(1)})).min(1),
 exercises:z.array(z.object({id:text,sourceBlockIndices:indices,sourceType:z.enum(['textbook','ai_generated']),generatedText:z.string(),nodeIds:z.array(text),topicId:z.string().nullable(),purpose:z.enum(['PRACTICE','NODE_CHECK','TOPIC_CHECK','LESSON_CHECK']),successCriteria:text,cognitiveLevel:z.enum(bloomLevels)})),
 excludedBlocks:z.array(z.object({blockIndex:z.number().int().nonnegative(),reason:text,kind:z.enum(['NEIGHBOR_SECTION','HEADER_FOOTER','DUPLICATE_SUMMARY','NON_INSTRUCTIONAL'])})),reviewIssues:z.array(text)
});
export type CompleteMap=z.infer<typeof completeMapSchema>;
export type SourceBlock={sourceText:string;sourcePage:number;blockType:string;sourceParagraph?:string|null;sourceBoundingBox?:unknown};
export function sourceHash(blocks:SourceBlock[]){return createHash('sha256').update(JSON.stringify(blocks.map(b=>[b.sourcePage,b.blockType,b.sourceText]))).digest('hex');}
export class CompleteMapSchemaError extends Error{
 readonly diagnostics:{schemaIssues:{path:(string|number)[];code:string}[]};
 constructor(issues:ReadonlyArray<{path:PropertyKey[];code:string}>){
  super('COMPLETE_MAP_SCHEMA_INVALID');this.name='CompleteMapSchemaError';
  this.diagnostics={schemaIssues:issues.map(i=>({path:i.path.map(p=>typeof p==='symbol'?String(p):p),code:i.code}))};
 }
}
export class CompleteMapCognitivePathError extends Error {
 readonly diagnostics: { cognitivePathIssues: Array<{
  nodeId:string; targetBloom:string; pathLevels:string[];
  duplicateLevels:string[]; ascending:boolean; finalLevelMatchesTarget:boolean;
 }> };
 constructor(issues:CompleteMapCognitivePathError['diagnostics']['cognitivePathIssues']) {
  super('INVALID_COGNITIVE_CEILING');this.name='CompleteMapCognitivePathError';
  this.diagnostics={cognitivePathIssues:issues};
 }
}
export function validateCompleteMap(value:unknown,blocks:SourceBlock[],outcomes:number[]):CompleteMap{
 const parsed=completeMapSchema.safeParse(value);if(!parsed.success)throw new CompleteMapSchemaError(parsed.error.issues);
 const m=parsed.data,nodes=m.topics.flatMap(t=>t.nodes),ids=new Set(nodes.map(n=>n.id)),topics=new Set(m.topics.map(t=>t.id));
 const unique=(values:unknown[],reason:string)=>{if(new Set(values).size!==values.length)throw Error(reason);};
 unique(nodes.map(n=>n.id),'DUPLICATE_NODE_ID');unique(m.topics.map(t=>t.id),'DUPLICATE_TOPIC_ID');unique(m.exercises.map(e=>e.id),'DUPLICATE_EXERCISE_ID');
 assertSourceReferences(m,blocks);
 const cognitivePathIssues=nodes.flatMap(n=>{
  const pathLevels=n.cognitivePath.map(p=>p.level),ranks=pathLevels.map(level=>bloomLevels.indexOf(level));
  const duplicateLevels=[...new Set(pathLevels.filter((level,index)=>pathLevels.indexOf(level)!==index))];
  const ascending=ranks.every((rank,index)=>index===0||rank>ranks[index-1]);
  const finalLevelMatchesTarget=pathLevels.at(-1)===n.targetBloom;
  return duplicateLevels.length||!ascending||!finalLevelMatchesTarget
   ?[{nodeId:n.id,targetBloom:n.targetBloom,pathLevels,duplicateLevels,ascending,finalLevelMatchesTarget}]:[];
 });
 if(cognitivePathIssues.length)throw new CompleteMapCognitivePathError(cognitivePathIssues);
 for(const n of nodes){
  unique(n.prerequisiteNodeIds,'DUPLICATE_PREREQUISITE');unique(n.outcomeIds,'DUPLICATE_OUTCOME');
  if(n.outcomeIds.some(id=>!outcomes.includes(id)))throw Error('INVALID_OUTCOME_REFERENCE');
  if(n.prerequisiteNodeIds.some(id=>!ids.has(id)||id===n.id))throw Error('INVALID_PREREQUISITE');
 }
 const visiting=new Set<string>(),done=new Set<string>(),byId=new Map(nodes.map(n=>[n.id,n]));
 const visit=(id:string)=>{if(visiting.has(id))throw Error('CYCLIC_PREREQUISITES');if(done.has(id))return;visiting.add(id);byId.get(id)!.prerequisiteNodeIds.forEach(visit);visiting.delete(id);done.add(id);};nodes.forEach(n=>visit(n.id));
 for(const e of m.exercises){
  unique(e.nodeIds,'DUPLICATE_EXERCISE_NODE_LINK');if(e.nodeIds.some(id=>!ids.has(id))||e.topicId!==null&&!topics.has(e.topicId))throw Error('INVALID_EXERCISE_LINK');
  if(e.sourceType==='textbook'&&(!e.sourceBlockIndices.length||e.generatedText.trim()))throw Error('INVALID_TEXTBOOK_PROVENANCE');
  if(e.sourceType==='ai_generated'&&(e.sourceBlockIndices.length||!e.generatedText.trim()))throw Error('INVALID_AI_PROVENANCE');
  if(e.nodeIds.some(id=>!byId.get(id)!.cognitivePath.some(p=>p.level===e.cognitiveLevel)))throw Error('EXERCISE_LEVEL_NOT_IN_NODE_PATH');
 }
 if(outcomes.some(id=>!nodes.some(n=>n.outcomeIds.includes(id))))throw Error('UNCOVERED_REQUIRED_OUTCOME');
 return m;
}
