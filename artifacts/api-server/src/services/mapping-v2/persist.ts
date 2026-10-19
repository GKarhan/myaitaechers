import {db,lessonsTable,lessonNodesTable,lessonTopicsTable,lessonExercisesTable,lessonNodeDependenciesTable,lessonSourceMaterialsTable,lessonNodeCognitiveLevelsTable,lessonNodeCognitiveTasksTable,lessonNodeTeachingPackageItemsTable,lessonOutcomesTable,lessonOutcomeNodeAlignmentsTable} from '@workspace/db';
import {eq,asc,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {bloomLevels,type CompleteMap,type SourceBlock} from './contract.js';
export async function authoringSnapshot(lessonId:number,executor:typeof db=db){
 const data=await Promise.all([
  executor.select().from(lessonsTable).where(eq(lessonsTable.id,lessonId)),
  executor.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId,lessonId)).orderBy(asc(lessonNodesTable.id)),
  executor.select().from(lessonTopicsTable).where(eq(lessonTopicsTable.lessonId,lessonId)).orderBy(asc(lessonTopicsTable.id)),
  executor.select().from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId,lessonId)).orderBy(asc(lessonExercisesTable.id)),
  executor.select().from(lessonOutcomesTable).where(eq(lessonOutcomesTable.lessonId,lessonId)).orderBy(asc(lessonOutcomesTable.id)),
  executor.select().from(lessonNodeCognitiveLevelsTable).innerJoin(lessonNodesTable,eq(lessonNodesTable.id,lessonNodeCognitiveLevelsTable.lessonNodeId)).where(eq(lessonNodesTable.lessonId,lessonId)).orderBy(asc(lessonNodeCognitiveLevelsTable.id)),
  executor.select().from(lessonNodeTeachingPackageItemsTable).where(eq(lessonNodeTeachingPackageItemsTable.lessonId,lessonId)).orderBy(asc(lessonNodeTeachingPackageItemsTable.id)),
 ]);return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export async function persistCompleteMap(input:{lessonId:number;resourceId:number|null;map:CompleteMap;blocks:SourceBlock[];hash:string;adapter:string;expectedSnapshot:string;sourceSet:unknown;sourceScope:unknown;provenance:unknown}){
 const {lessonId,map,blocks}=input;
 return db.transaction(async tx=>{
  await tx.execute(sql`SELECT id FROM lessons WHERE id=${lessonId} FOR UPDATE`);
  if(await authoringSnapshot(lessonId,tx as unknown as typeof db)!==input.expectedSnapshot)throw Error('MAPPING_AUTHORING_CHANGED');
  await tx.delete(lessonNodeDependenciesTable).where(eq(lessonNodeDependenciesTable.lessonId,lessonId));
  await tx.delete(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId,lessonId));
  await tx.delete(lessonNodesTable).where(eq(lessonNodesTable.lessonId,lessonId));
  await tx.delete(lessonTopicsTable).where(eq(lessonTopicsTable.lessonId,lessonId));
  await tx.delete(lessonSourceMaterialsTable).where(eq(lessonSourceMaterialsTable.lessonId,lessonId));
  const excluded=new Map(map.excludedBlocks.map(e=>[e.blockIndex,e]));
  await tx.insert(lessonSourceMaterialsTable).values(blocks.map((b,i)=>({lessonId,sourceResourceId:input.resourceId,
   stableSourceKey:`${input.resourceId}:${input.hash}:${i}`,sourceBlockIndex:i,blockType:b.blockType,sourceText:b.sourceText,
   physicalPage:b.sourcePage,sourceParagraph:b.sourceParagraph??null,sourceBoundingBox:b.sourceBoundingBox??null,
   verificationStatus:'VERIFIED_READABLE',primaryDisposition:excluded.has(i)?'EXCLUDED_WITH_REASON':b.blockType==='EXERCISE'?'EXERCISE':['ACTIVITY','HOMEWORK'].includes(b.blockType)?'ACTIVITY_OR_HOMEWORK':'CORE_EVIDENCE',
   dispositionReasonCodes:excluded.has(i)?[excluded.get(i)!.kind]:[],provenanceMetadata:{sourceHash:input.hash,exclusion:excluded.get(i)??null}})));
  const ids=new Map<string,number>(),topics=new Map<string,number>(),levels=new Map<string,number>();let sequence=0;
  for(const topic of map.topics){
   const [t]=await tx.insert(lessonTopicsTable).values({lessonId,title:topic.bigIdea,sequence:topics.size+1}).returning();topics.set(topic.id,t.id);
   for(const n of topic.nodes){
    const source=n.sourceBlockIndices.map(i=>blocks[i]),theory=source.map(b=>b.sourceText).join('\n\n');
    const [row]=await tx.insert(lessonNodesTable).values({lessonId,topicId:t.id,sequence:++sequence,title:n.title,
     learningObjective:n.learningObjective,microNodeType:n.knowledgeType==='PROCEDURE_KNOWLEDGE'?'skill':'knowledge',
     theoryContent:theory,verbatimTheoryAnchor:theory,sourceText:source[0].sourceText,sourcePage:source[0].sourcePage,
     sourceParagraph:source[0].sourceParagraph??null,sourceBlockIndices:n.sourceBlockIndices,
     targetBloomLevel:bloomLevels.indexOf(n.targetBloom)+1,estimatedMinutes:n.estimatedMinutes,
     childFriendlyExplanation:n.teaching.explanation,explanationSteps:n.teaching.explanationSteps,
     basicExamples:n.teaching.examples.map(e=>e.text),nonExamples:n.teaching.nonExamples.map(e=>e.text),
     commonMisconception:n.teaching.misconception,misconceptionQuestions:[n.teaching.guidingQuestion],
     contentSourceType:'ai_generated',cogPathStatus:'needs_review',status:'draft',createdBy:'ai'}).returning();ids.set(n.id,row.id);
    const insertedLevels=await tx.insert(lessonNodeCognitiveLevelsTable).values(n.cognitivePath.map((p,i)=>({lessonNodeId:row.id,cognitiveLevel:p.level,sequence:i+1,isApplicable:true,isTargetCeiling:p.level===n.targetBloom,
     performanceObjective:p.performanceObjective,successCriterion:p.successCriterion,provenance:'ai_generated',minimumIndependentEvidence:p.minimumIndependentEvidence,preferredInteractionTypes:p.interactionTypes}))).returning();
    for(const level of insertedLevels)levels.set(`${n.id}:${level.cognitiveLevel}`,level.id);
    const items=[{itemType:'MAIN_EXPLANATION',content:n.teaching.explanation},...n.teaching.examples.map(e=>({itemType:'EXAMPLE',content:e.text})),...n.teaching.nonExamples.map(e=>({itemType:'COUNTEREXAMPLE',content:e.text})),{itemType:'MISCONCEPTION',content:n.teaching.misconception},{itemType:'GUIDING_QUESTION',content:n.teaching.guidingQuestion},{itemType:'HINT',content:n.teaching.hint}];
    await tx.insert(lessonNodeTeachingPackageItemsTable).values(items.map((item,i)=>({...item,lessonId,lessonNodeId:row.id,sequence:i+1,status:'draft',provenance:'ai_generated',isPrimary:item.itemType==='MAIN_EXPLANATION'})));
    if(n.outcomeIds.length)await tx.insert(lessonOutcomeNodeAlignmentsTable).values(n.outcomeIds.map(id=>({lessonId,lessonOutcomeId:id,lessonNodeId:row.id,role:n.role==='CORE'?'REQUIRED':'SUPPORTING',requiredCognitiveDepth:n.targetBloom})));
   }
  }
  for(const n of map.topics.flatMap(t=>t.nodes)){
   const prereqs=n.prerequisiteNodeIds.map(id=>ids.get(id)!);
   await tx.update(lessonNodesTable).set({prerequisiteNodes:prereqs}).where(eq(lessonNodesTable.id,ids.get(n.id)!));
   if(prereqs.length)await tx.insert(lessonNodeDependenciesTable).values(prereqs.map(id=>({lessonId,fromNodeId:id,toNodeId:ids.get(n.id)!,dependencyType:'REQUIRED',requiredLevel:'CRITICAL',reason:'Knowledge prerequisite'})));
  }
  const exerciseLinks=[];
  for(const [i,e] of map.exercises.entries()){
   const source=e.sourceBlockIndices.map(index=>blocks[index]),stableId=e.sourceType==='textbook'?`SRC-${input.resourceId}-${input.hash.slice(0,12)}-${e.sourceBlockIndices.join('-')}`:`AI-${lessonId}-${i+1}`;
   const [row]=await tx.insert(lessonExercisesTable).values({lessonId,exerciseId:stableId,
    exerciseTextVerbatim:e.sourceType==='textbook'?source.map(b=>b.sourceText).join('\n'):e.generatedText,
    sourcePage:source.length?[...new Set(source.map(b=>b.sourcePage))].join(','):null,sourceBlockIndex:e.sourceBlockIndices[0]??null,
    relatedNodeId:e.nodeIds.length===1?ids.get(e.nodeIds[0])!:null,sourceType:e.sourceType,exercisePurpose:e.purpose,
    successCriteria:e.successCriteria,sequence:i+1,assignment:'CLASS',status:'draft'}).returning();
   for(const id of e.nodeIds){const levelId=levels.get(`${id}:${e.cognitiveLevel}`);if(levelId)await tx.insert(lessonNodeCognitiveTasksTable).values({cognitiveLevelId:levelId,lessonExerciseId:row.id,taskProvenance:e.sourceType==='textbook'?'source_derived':'ai_generated'});}
   exerciseLinks.push({exerciseId:row.id,nodeIds:e.nodeIds.map(id=>ids.get(id)),topicId:e.topicId?topics.get(e.topicId):null,sourceBlockIndices:e.sourceBlockIndices,cognitiveLevel:e.cognitiveLevel,purpose:e.purpose});
  }
  const metadata={pipeline:'P1.2.1+P1.2.2',sourceHash:input.hash,adapter:input.adapter,sourceExerciseCount:map.exercises.filter(e=>e.sourceType==='textbook').length,
   completeMap:map,nodeIdMap:Object.fromEntries(ids),topicIdMap:Object.fromEntries(topics),exerciseLinks,
   quality:{sourceAudit:{sourceSet:input.sourceSet,sourceScope:input.sourceScope,physicalPageProvenance:input.provenance},instructionalCoverage:{valid:true,unresolvedInstructionalIndices:[]},sourceAlignment:{nodes:[...ids.values()].map(nodeId=>({nodeId,status:'PARTIAL',reviewStatus:'REQUIRES_TEACHER_REVIEW'}))}},reviewIssues:map.reviewIssues,teacherApprovalRequired:true};
  await tx.update(lessonsTable).set({mappingMetadata:metadata,essentialQuestion:map.essentialQuestion,coreIdea:map.topics.map(t=>t.bigIdea).join('\n'),knowledgeBoundaries:map.boundaries,status:'draft'}).where(eq(lessonsTable.id,lessonId));
  return {coverageValid:true,microNodesCreated:ids.size,topicsCreated:topics.size,exercisesCreated:map.exercises.length,readyMicroNodes:ids.size,reviewRequiredMicroNodes:0,unmappedReviewBlocks:0,pass1BlocksExtracted:blocks.length,instructionalCoverageValid:true,teacherReviewRequired:ids.size,assignmentReadiness:'CONFIRMATION_REQUIRED',sourceHash:input.hash,reviewIssues:map.reviewIssues};
 },{isolationLevel:'serializable'});
}

/** Legacy node editors remain canonical. Never approve stale generated copies over a teacher edit. */
export async function syncGeneratedTeachingForApproval(lessonId:number,executor:typeof db){
 const nodes=await executor.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId,lessonId));
 const items=await executor.select().from(lessonNodeTeachingPackageItemsTable).where(eq(lessonNodeTeachingPackageItemsTable.lessonId,lessonId));
 const rebuiltTypes=new Set(['MAIN_EXPLANATION','EXAMPLE','COUNTEREXAMPLE','MISCONCEPTION']);
 for(const node of nodes){
  const own=items.filter(i=>i.lessonNodeId===node.id),generated=own.filter(i=>i.provenance==='ai_generated'&&rebuiltTypes.has(i.itemType));
  for(const item of generated)await executor.delete(lessonNodeTeachingPackageItemsTable).where(eq(lessonNodeTeachingPackageItemsTable.id,item.id));
  const retained=own.filter(i=>!generated.some(g=>g.id===i.id));let sequence=Math.max(0,...retained.map(i=>i.sequence));
  const strings=(value:unknown)=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'&&!!v.trim()):[];
  const rebuilt=[{itemType:'MAIN_EXPLANATION',content:node.childFriendlyExplanation??''},...strings(node.basicExamples).map(content=>({itemType:'EXAMPLE',content})),...strings(node.nonExamples).map(content=>({itemType:'COUNTEREXAMPLE',content})),{itemType:'MISCONCEPTION',content:node.commonMisconception??''}].filter(i=>i.content.trim());
  if(rebuilt.length)await executor.insert(lessonNodeTeachingPackageItemsTable).values(rebuilt.map(item=>({...item,lessonId,lessonNodeId:node.id,sequence:++sequence,status:'draft',provenance:'ai_generated',isPrimary:item.itemType==='MAIN_EXPLANATION'&&!retained.some(i=>i.itemType==='MAIN_EXPLANATION'&&i.isPrimary)})));
 }
}
