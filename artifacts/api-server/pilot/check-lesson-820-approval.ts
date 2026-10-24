import assert from 'node:assert/strict';
import fs from 'node:fs';
import {db,pool,lessonNodesTable,lessonNodeCognitiveLevelsTable} from '@workspace/db';
import {eq,inArray} from 'drizzle-orm';
import {validateLessonForFinalApproval} from '../src/lib/lesson-final-approval.js';
import {resolveLessonAssignmentReadiness} from '../src/lib/lesson-assignment-readiness.js';
import {assessAcceptedCognitivePath} from '../src/lib/cognitive-path-grounding.js';
// Optionally replay a database snapshot through the actual Drizzle validator.
// This is read-only and avoids requiring a direct Postgres network connection.
if(process.argv[2]) {
 const snapshot=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 pool.query=(async(config:any)=>{
  const text=typeof config==='string'?config:config.text;
  assert.ok(text.startsWith('select '),'snapshot replay forbids writes');
  const from=text.indexOf(' from ');
  const table=text.slice(from).match(/from "([a-z_]+)"/)?.[1];
  assert.ok(table&&table in snapshot,'unexpected table in approval replay');
  const columns=text.slice(7,from).split(',').map((column:string)=>{
   const names=[...column.matchAll(/"([a-z_]+)"/g)].map(match=>match[1]);
   assert.ok(names.length===1,'unexpected select expression');return names[0];
  });
  const rows=snapshot[table].map((row:any)=>columns.map((column:string)=>row[column]));
  return {rows,rowCount:rows.length};
 }) as any;
}

try {
 const validation=await validateLessonForFinalApproval(820);
 const readiness=resolveLessonAssignmentReadiness(validation);
 const nodes=await db.select().from(lessonNodesTable).where(eq(lessonNodesTable.lessonId,820));
 const levels=await db.select().from(lessonNodeCognitiveLevelsTable).where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId,nodes.map(n=>n.id)));
 const paths=nodes.map(n=>({nodeId:n.id,path:assessAcceptedCognitivePath({
  cogPathStatus:'confirmed',theoryContent:n.theoryContent,learningObjective:n.learningObjective,
  levels:levels.filter(c=>c.lessonNodeId===n.id),
 })}));
 console.log(JSON.stringify({lessonId:820,readiness:readiness.readiness,hardBlockers:readiness.hardBlockers.map(i=>({code:i.code,nodeId:i.nodeId})),
  nodes:nodes.length,acceptedPaths:paths.filter(p=>p.path.accepted).length,
  rejectedPaths:paths.filter(p=>!p.path.accepted).map(p=>({nodeId:p.nodeId,reason:p.path.reason,grounding:p.path.grounding})),
  teacherConfirmationRequired:readiness.warnings.length>0}));
 assert.equal(readiness.hardBlockers.length,0);
 assert.equal(nodes.length,10);assert.ok(paths.every(p=>p.path.accepted));
} finally {await pool.end();}
