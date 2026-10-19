import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {db,pool,lessonsTable,subjectsTable,usersTable,lessonOutcomesTable,lessonNodesTable,lessonExercisesTable,lessonNodeCognitiveLevelsTable,lessonNodeTeachingPackageItemsTable} from '@workspace/db';
import {eq} from 'drizzle-orm';
import {fixture} from './contract.test.js';
import {sourceHash} from './contract.js';
import {persistCompleteMap,authoringSnapshot} from './persist.js';
import {signToken} from '../../middlewares/auth.js';
import {assessAcceptedCognitivePath} from '../../lib/cognitive-path-grounding.js';
import app from '../../app.js';
const [subject]=await db.insert(subjectsTable).values({name:`Approval test ${Date.now()}`,grade:'7'}).returning();
const [user]=await db.insert(usersTable).values({username:`map-approval-${Date.now()}`,fullName:'Mapping test',passwordHash:'unused-in-test',role:'teacher'}).returning();
let lessonId:number|undefined;
const server=app.listen(0);await new Promise<void>(resolve=>server.on('listening',resolve));
try{
 const [lesson]=await db.insert(lessonsTable).values({subjectId:subject.id,title:'Approval integration',teacherId:user.id}).returning();lessonId=lesson.id;
 const [outcome]=await db.insert(lessonOutcomesTable).values({lessonId,outcomeText:'Test outcome',sequence:1}).returning();
 const {blocks,map}=fixture(outcome.id);
 // Copy existing Armenian fixture text instead of retyping/transliterating it.
 const existing=readFileSync(new URL('../../lib/__tests__/fix6-granularity-grounding.test.ts',import.meta.url),'utf8');
 const armenian=existing.match(/node\("[^"]+", "([^"]+)", 0\)/)![1];
 blocks[0].sourceText=armenian;const node=map.topics[0].nodes[0];node.learningObjective=armenian;
 node.cognitivePath[0].performanceObjective=armenian;node.cognitivePath[0].successCriterion=armenian;
 await persistCompleteMap({lessonId,resourceId:null,map,blocks,hash:sourceHash(blocks),adapter:'PHYSICS_V1',expectedSnapshot:await authoringSnapshot(lessonId),sourceSet:{titleMatch:{valid:true}},sourceScope:{valid:true},provenance:{}});
 const [saved]=await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId,lessonId));
 await db.update(lessonNodesTable).set({childFriendlyExplanation:'Teacher revised explanation'}).where(eq(lessonNodesTable.id,saved.id));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}/api/lessons/${lessonId}/final-approve`;
 const post=(body:object)=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${signToken(user.id,'teacher')}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const initial=await post({});assert.equal(initial.status,409);assert.equal(((await initial.json()) as {confirmationRequired:boolean}).confirmationRequired,true);
 assert.equal((await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.id,saved.id)))[0].status,'draft');
 const approved=await post({overrideWarnings:true});assert.equal(approved.status,200);assert.equal(((await approved.json()) as {approved:boolean}).approved,true);
 const [current]=await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.id,saved.id));assert.equal(current.status,'approved');assert.equal(current.cogPathStatus,'confirmed');
 assert.ok((await db.select().from(lessonExercisesTable).where(eq(lessonExercisesTable.lessonId,lessonId))).every(e=>e.status==='approved'));
 const teaching=await db.select().from(lessonNodeTeachingPackageItemsTable).where(eq(lessonNodeTeachingPackageItemsTable.lessonId,lessonId));
 assert.equal(teaching.find(i=>i.itemType==='MAIN_EXPLANATION')?.content,'Teacher revised explanation');assert.ok(teaching.every(i=>i.status==='approved'));
 const levels=await db.select().from(lessonNodeCognitiveLevelsTable).where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId,current.id));
 assert.equal(assessAcceptedCognitivePath({cogPathStatus:current.cogPathStatus,theoryContent:current.theoryContent,learningObjective:current.learningObjective,levels}).accepted,true);
 console.log('PASS: one teacher approval accepts C1+C2+teaching+exercises, preserves edits, and produces runtime-accepted cognitive paths');
}finally{
 await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 if(lessonId)await db.delete(lessonsTable).where(eq(lessonsTable.id,lessonId));
 await db.delete(usersTable).where(eq(usersTable.id,user.id));await db.delete(subjectsTable).where(eq(subjectsTable.id,subject.id));await pool.end();
}
