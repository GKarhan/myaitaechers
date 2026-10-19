import assert from 'node:assert/strict';
import {db,pool,lessonsTable,subjectsTable,lessonOutcomesTable,lessonNodesTable,lessonExercisesTable,lessonNodeCognitiveLevelsTable,lessonNodeTeachingPackageItemsTable,lessonSourceMaterialsTable,lessonNodeCognitiveTasksTable} from '@workspace/db';
import {eq} from 'drizzle-orm';
import {fixture} from './contract.test.js';
import {authoringSnapshot,persistCompleteMap} from './persist.js';
import {sourceHash} from './contract.js';
const [subject]=await db.insert(subjectsTable).values({name:`Mapping test ${Date.now()}`,grade:'7'}).returning();
let lessonId:number|undefined;
try{
 const [lesson]=await db.insert(lessonsTable).values({subjectId:subject.id,title:'Complete map integration test'}).returning();lessonId=lesson.id;
 const [outcome]=await db.insert(lessonOutcomesTable).values({lessonId,outcomeText:'Explain a body',sequence:1}).returning();
 const {blocks,map}=fixture(outcome.id),input={lessonId,resourceId:null,map,blocks,hash:sourceHash(blocks),adapter:'PHYSICS_V1',expectedSnapshot:await authoringSnapshot(lessonId),sourceSet:{titleMatch:{valid:true}},sourceScope:{valid:true},provenance:{}};
 const extra=structuredClone(map.topics[0].nodes[0]);extra.id='N2';extra.title='Second target';map.topics[0].nodes.push(extra);map.exercises[0].nodeIds.push('N2');
 const result=await persistCompleteMap(input);assert.equal(result.microNodesCreated,2);assert.equal(result.exercisesCreated,15);
 const [node]=await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId,lessonId));assert.equal(node.status,'draft');assert.equal(node.cogPathStatus,'needs_review');assert.ok(node.childFriendlyExplanation);
 const levels=await db.select().from(lessonNodeCognitiveLevelsTable).where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId,node.id));assert.equal(levels.length,1);assert.ok(levels[0].isTargetCeiling);
 const items=await db.select().from(lessonNodeTeachingPackageItemsTable).where(eq(lessonNodeTeachingPackageItemsTable.lessonId,lessonId));assert.equal(items.length,12);assert.ok(items.every(i=>i.status==='draft'));
 const exercises=await db.select().from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId,lessonId));const continuation=exercises.find(e=>e.sourceBlockIndex===15)!;assert.equal(continuation.sourcePage,'9,10');assert.match(continuation.exerciseTextVerbatim,/history and\ndescribe/);
 const tasks=await db.select({id:lessonNodeCognitiveTasksTable.id}).from(lessonNodeCognitiveTasksTable).innerJoin(lessonNodeCognitiveLevelsTable,eq(lessonNodeCognitiveLevelsTable.id,lessonNodeCognitiveTasksTable.cognitiveLevelId)).innerJoin(lessonNodesTable,eq(lessonNodesTable.id,lessonNodeCognitiveLevelsTable.lessonNodeId)).where(eq(lessonNodesTable.lessonId,lessonId));assert.equal(tasks.length,16);
 assert.equal((await db.select().from(lessonSourceMaterialsTable).where(eq(lessonSourceMaterialsTable.lessonId,lessonId))).length,17);
 const snapshot=await authoringSnapshot(lessonId);await db.update(lessonNodesTable).set({title:'Teacher edit'}).where(eq(lessonNodesTable.id,node.id));await assert.rejects(persistCompleteMap({...input,expectedSnapshot:snapshot}),/MAPPING_AUTHORING_CHANGED/);
 const before=await authoringSnapshot(lessonId),bad=structuredClone(map);bad.topics[0].nodes[0].outcomeIds=[2147483647];await assert.rejects(persistCompleteMap({...input,map:bad,expectedSnapshot:before}));assert.equal(await authoringSnapshot(lessonId),before);
 console.log('PASS: PostgreSQL complete package, 15 exercises, continuation, draft approval boundary, concurrent teacher edit protection and atomic rollback');
}finally{if(lessonId)await db.delete(lessonsTable).where(eq(lessonsTable.id,lessonId));await db.delete(subjectsTable).where(eq(subjectsTable.id,subject.id));await pool.end();}
