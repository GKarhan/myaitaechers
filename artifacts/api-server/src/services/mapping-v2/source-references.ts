import type {CompleteMap,SourceBlock} from './contract.js';
export function sourceRoles(blocks:SourceBlock[]){
 const theory:number[]=[],exercises:number[]=[];
 blocks.forEach((b,i)=>(['EXERCISE','ACTIVITY','HOMEWORK'].includes(b.blockType)?exercises:theory).push(i));
 return {theory,exercises};
}
type Finding={code:string;blockIndex:number;ownerKind:'node'|'exercise'|'exclusion'|'source';ownerIndex:number};
export class SourceReferenceValidationError extends Error{
 readonly diagnostics:{issues:Finding[];sourceBlocks:{index:number;blockType:string;physicalPage:number;lineRange:string|null}[]};
 constructor(issues:Finding[],blocks:SourceBlock[]){
  super(issues[0].code);this.name='SourceReferenceValidationError';
  this.diagnostics={issues,sourceBlocks:blocks.map((b,index)=>({index,blockType:b.blockType,physicalPage:b.sourcePage,lineRange:/^lines:\d+-\d+$/.test(b.sourceParagraph??'')?b.sourceParagraph!:null}))};
 }
}
export function assertSourceReferences(map:CompleteMap,blocks:SourceBlock[]){
 const roles=sourceRoles(blocks),activities=new Set(roles.exercises),used=new Set<number>(),exerciseUsed=new Set<number>(),excluded=new Set<number>(),issues:Finding[]=[];
 const add=(code:string,blockIndex:number,ownerKind:Finding['ownerKind'],ownerIndex:number)=>issues.push({code,blockIndex,ownerKind,ownerIndex});
 const valid=(i:number,kind:Finding['ownerKind'],owner:number)=>{if(!blocks[i]){add('INVALID_SOURCE_REFERENCE',i,kind,owner);return false;}return true;};
 map.topics.flatMap(t=>t.nodes).forEach((n,owner)=>n.sourceBlockIndices.forEach(i=>{
  if(!valid(i,'node',owner))return;
  if(activities.has(i))add('ACTIVITY_USED_AS_THEORY',i,'node',owner);used.add(i);
 }));
 map.exercises.forEach((e,owner)=>e.sourceBlockIndices.forEach(i=>{
  if(!valid(i,'exercise',owner))return;
  if(!activities.has(i)||exerciseUsed.has(i))add('DUPLICATE_OR_INVALID_SOURCE_EXERCISE',i,'exercise',owner);
  exerciseUsed.add(i);used.add(i);
 }));
 map.excludedBlocks.forEach((e,owner)=>{
  const i=e.blockIndex;if(!valid(i,'exclusion',owner))return;
  if(used.has(i)||excluded.has(i))add('CONFLICTING_SOURCE_DISPOSITION',i,'exclusion',owner);
  if(activities.has(i)&&e.kind!=='NEIGHBOR_SECTION')add('LOST_SOURCE_EXERCISE',i,'exclusion',owner);
  excluded.add(i);
 });
 blocks.forEach((_,i)=>{if(!used.has(i)&&!excluded.has(i))add('UNCOVERED_SOURCE_BLOCKS',i,'source',i);});
 if(issues.length)throw new SourceReferenceValidationError(issues,blocks);
}
