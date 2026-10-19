import {z} from 'zod/v4';
import {createHash} from 'node:crypto';
export const bloomLevels=['remember','understand','apply','analyze','evaluate','create'] as const;
const text=z.string().trim().min(1),indices=z.array(z.number().int().nonnegative());
const example=z.object({text,sourceStatus:z.enum(['SOURCE_DERIVED','AI_PROPOSED'])});
export const completeMapSchema=z.object({
 schemaVersion:z.literal('P1.2.2'),essentialQuestion:text,boundaries:z.array(text),
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
export function validateCompleteMap(value:unknown,blocks:SourceBlock[],outcomes:number[]):CompleteMap{
 const parsed=completeMapSchema.safeParse(value);if(!parsed.success)throw Error('COMPLETE_MAP_SCHEMA_INVALID:'+parsed.error.issues.map(i=>i.path.join('.')).slice(0,10).join(','));
 const m=parsed.data,nodes=m.topics.flatMap(t=>t.nodes),ids=new Set(nodes.map(n=>n.id)),topics=new Set(m.topics.map(t=>t.id));
 const unique=(values:unknown[],reason:string)=>{if(new Set(values).size!==values.length)throw Error(reason);};
 unique(nodes.map(n=>n.id),'DUPLICATE_NODE_ID');unique(m.topics.map(t=>t.id),'DUPLICATE_TOPIC_ID');unique(m.exercises.map(e=>e.id),'DUPLICATE_EXERCISE_ID');
 const used=new Set<number>(),exerciseUsed=new Set<number>(),excluded=new Set<number>();
 const check=(i:number)=>{if(!blocks[i])throw Error('INVALID_SOURCE_REFERENCE');};
 const activity=(i:number)=>['EXERCISE','ACTIVITY','HOMEWORK'].includes(blocks[i].blockType);
 for(const n of nodes){
  unique(n.cognitivePath.map(p=>p.level),'DUPLICATE_COGNITIVE_LEVEL');unique(n.prerequisiteNodeIds,'DUPLICATE_PREREQUISITE');unique(n.outcomeIds,'DUPLICATE_OUTCOME');
  const ranks=n.cognitivePath.map(p=>bloomLevels.indexOf(p.level));if(ranks.some((r,i)=>i>0&&r<=ranks[i-1])||n.cognitivePath.at(-1)?.level!==n.targetBloom)throw Error('INVALID_COGNITIVE_CEILING');
  for(const i of n.sourceBlockIndices){check(i);if(activity(i))throw Error('ACTIVITY_USED_AS_THEORY');used.add(i);}
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
  for(const i of e.sourceBlockIndices){check(i);if(!activity(i)||exerciseUsed.has(i))throw Error('DUPLICATE_OR_INVALID_SOURCE_EXERCISE');exerciseUsed.add(i);used.add(i);}
 }
 for(const e of m.excludedBlocks){check(e.blockIndex);if(used.has(e.blockIndex)||excluded.has(e.blockIndex))throw Error('CONFLICTING_SOURCE_DISPOSITION');if(activity(e.blockIndex)&&e.kind!=='NEIGHBOR_SECTION')throw Error('LOST_SOURCE_EXERCISE');excluded.add(e.blockIndex);}
 if(blocks.some((_,i)=>!used.has(i)&&!excluded.has(i)))throw Error('UNCOVERED_SOURCE_BLOCKS');
 if(outcomes.some(id=>!nodes.some(n=>n.outcomeIds.includes(id))))throw Error('UNCOVERED_REQUIRED_OUTCOME');
 return m;
}
