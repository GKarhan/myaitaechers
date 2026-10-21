import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db,pool,usersTable,subjectsTable,lessonsTable,lessonNodesTable,lessonNodeCognitiveLevelsTable,quizzesTable,quizQuestionsTable,quizAssignmentsTable,reviewScheduleTable } from "@workspace/db";
import app from "../../app.js";
import { assertTestDb } from "../../lib/__tests__/helpers/test-db.js";
import { resolveKnowledgeTreeStates } from "../knowledge-tree-state.js";
assertTestDb();
const tag=`assessment_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const server=app.listen(0);await once(server,"listening");
const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
const userIds:number[]=[],quizIds:number[]=[];
let subjectId:number|undefined;
try {
  for (const role of (["teacher","student"] as const)){const [u]=await db.insert(usersTable).values({username:`${tag}_${role}`,fullName:role,passwordHash:"unused",role}).returning();userIds.push(u.id);}
  const [teacherId,studentId]=userIds;
  const auth=(id:number,role:string)=>({Authorization:`Bearer ${jwt.sign({userId:id,role},process.env.SESSION_SECRET??"myaiteacher-secret")}`,"Content-Type":"application/json"});
  const headers=auth(studentId!,"student");
  const [subject]=await db.insert(subjectsTable).values({name:tag}).returning();subjectId=subject.id;
  const [lesson]=await db.insert(lessonsTable).values({subjectId,title:tag,teacherId,status:"approved"}).returning();
  // Armenian anchors are copied verbatim from canonical-quiz-generation.test.ts.
  const objective="Սովորողը բացատրում է ջրի կարևորությունը կյանքի համար։";
  const [node]=await db.insert(lessonNodesTable).values({lessonId:lesson.id,sequence:1,title:tag,status:"approved",theoryContent:"Ջուրը կարևոր է կյանքի համար և անհրաժեշտ է բույսերի աճի համար։",learningObjective:objective,cogPathStatus:"confirmed"}).returning();
  const [level]=await db.insert(lessonNodeCognitiveLevelsTable).values({lessonNodeId:node.id,cognitiveLevel:"remember",sequence:1,isApplicable:true,isTargetCeiling:true,performanceObjective:objective,successCriterion:"Ճիշտ է ներկայացնում ջրի կարևորությունը կյանքի համար։",minimumIndependentEvidence:3,preferredInteractionTypes:["multiple_choice"]}).returning();
  await db.update(lessonNodeCognitiveLevelsTable).set({isTargetCeiling:false}).where(eq(lessonNodeCognitiveLevelsTable.id,level.id));
  const [targetLevel]=await db.insert(lessonNodeCognitiveLevelsTable).values({...level,id:undefined,cognitiveLevel:"understand",sequence:2,isTargetCeiling:true}).returning();
  async function createQuiz(purpose:"CHECK"|"LEARNING", family:string, count=3) {
    const [q]=await db.insert(quizzesTable).values({teacherId,subjectId:subjectId!,title:tag,nodeIds:[node.id],questionCount:count,status:"ASSIGNED",assessmentConfig:{version:"NODE_V1",purpose,context:"CLASS_THEN_HOME"}}).returning();quizIds.push(q.id);
    await db.insert(quizQuestionsTable).values(Array.from({length:count},(_,i)=>i+1).map(i=>({quizId:q.id,nodeId:node.id,cognitiveLevelId:i===1?level.id:targetLevel.id,questionText:`${family} water task ${i}?`,options:["Correct","Wrong"],correctOptionIndex:0,optionExplanations:["Correct explanation","Wrong explanation"],difficultyLevel:"MEDIUM",interactionType:"multiple_choice",sequence:i})));
    await db.insert(quizAssignmentsTable).values({quizId:q.id,studentId,status:"ASSIGNED"});return q.id;
  }
  async function answer(quizId:number,correct:boolean[],deferred:boolean){
    const takeRes=await fetch(`${base}/quizzes/${quizId}/take`,{headers});assert.equal(takeRes.status,200);const take:any=await takeRes.json();
    assert.equal(take.assessmentConfig.context,"CLASS_THEN_HOME");
    const answers=[];
    for(const [i,q] of take.questions.entries()){
      assert.equal(q.correctOptionIndex,undefined);
      const selectedOptionIndex=q.options.indexOf(correct[i]?"Correct":"Wrong");answers.push({questionId:q.id,selectedOptionIndex});
      const r=await fetch(`${base}/quizzes/${quizId}/attempts/${take.attemptId}/feedback`,{method:"POST",headers,body:JSON.stringify(answers.at(-1))});assert.equal(r.status,200);const f:any=await r.json();
      assert.equal(f.deferred,deferred);assert.equal(f.isCorrect,deferred?null:correct[i]);
      if(deferred){assert.equal(f.correctAnswer,null);assert.equal(f.correctOptionIndex,null);assert.equal(f.feedback.whyCorrect,null);}
    }
    const resume:any=await(await fetch(`${base}/quizzes/${quizId}/take`,{headers})).json();
    assert.equal(resume.attemptId,take.attemptId);assert.equal(resume.finalizedAnswers.length,take.questions.length);
    if(deferred)for(const f of resume.finalizedAnswers){assert.equal(f.isCorrect,null);assert.equal(f.correctAnswer,null);}
    const hidden=await fetch(`${base}/quizzes/${quizId}/my-result?attemptId=${take.attemptId}`,{headers});assert.equal(hidden.status,404);
    const submit=await fetch(`${base}/quizzes/${quizId}/submit`,{method:"POST",headers,body:JSON.stringify({attemptId:take.attemptId,answers})});assert.equal(submit.status,200,await submit.text());
    const r=await fetch(`${base}/quizzes/${quizId}/my-result`,{headers});assert.equal(r.status,200);return await r.json() as any;
  }
  for (const [count,certainty] of [[1,"LOW"],[2,"MEDIUM"]] as const) {
    const q=await createQuiz("CHECK",`initial ${count}`,count);
    const r=await answer(q,Array(count).fill(true),true);
    assert.equal(r.scorePercent,100);assert.equal(r.nodeBreakdown[0].assessment.certainty,certainty);
    assert.equal(r.nodeBreakdown[0].masteryLevel,"mastered");
    const teacherResponse=await fetch(`${base}/quizzes/${q}/results/${studentId}`,{headers:auth(teacherId!,"teacher")});
    assert.equal(teacherResponse.status,200);const teacherResult:any=await teacherResponse.json();
    assert.equal(teacherResult.scorePercent,100);assert.equal(teacherResult.nodeBreakdown[0].assessment.certainty,certainty);
    assert.equal(teacherResult.assessmentConfig.purpose,"CHECK");
  }
  const first=await createQuiz("CHECK","independent");
  const result=await answer(first,[true,true,false],true);
  assert.equal(result.scorePercent,67);assert.equal(result.nodeBreakdown[0].assessment.certainty,"MEDIUM");
  let state=(await resolveKnowledgeTreeStates(studentId!,[node.id])).get(node.id)!;
  assert.equal(state.masteryScore,67);assert.equal(state.knowledgeState,"PARTIAL");
  // A newly stored copy with a different question ID is still an exposed task.
  const copy=await createQuiz("LEARNING","independent");
  await answer(copy,[true,true,true],false);
  state=(await resolveKnowledgeTreeStates(studentId!,[node.id])).get(node.id)!;assert.equal(state.masteryScore,67);assert.equal(state.assessment?.certainty,"MEDIUM");
  const support=await createQuiz("CHECK","fresh support");await answer(support,[false,false,false],true);
  state=(await resolveKnowledgeTreeStates(studentId!,[node.id])).get(node.id)!;assert.equal(state.assessment?.status,"NEEDS_SUPPORT");assert.equal(state.assessment?.nextAction,"TEACHER_REVIEW");
  const denied=await fetch(`${base}/quizzes/${support}/reconfirm`,{method:"POST",headers});assert.equal(denied.status,409);
  const success=await createQuiz("CHECK","fresh success");await answer(success,[true,true,true],true);
  state=(await resolveKnowledgeTreeStates(studentId!,[node.id])).get(node.id)!;assert.equal(state.knowledgeState,"MASTERED");assert.equal(state.masteryScore,100);assert.equal(state.assessment?.certainty,"HIGH");
  const reviews=await db.select().from(reviewScheduleTable);const review=reviews.find(r=>r.userId===studentId);assert.ok(review);assert.equal(review.intervalDays,1);
  const later=await createQuiz("CHECK","same day success");await answer(later,[true,true,true],true);
  const [unchanged]=await db.select().from(reviewScheduleTable).where(eq(reviewScheduleTable.id,review.id));assert.equal(unchanged.reviewCount,review.reviewCount);assert.equal(unchanged.dueAt.getTime(),review.dueAt.getTime());
  // Full quiz summary survives a later practice attempt limited to one node.
  const roots=[node.id];
  for(let i=1;i<4;i++){
    const [extra]=await db.insert(lessonNodesTable).values({lessonId:lesson.id,sequence:i+1,title:`${tag}_${i}`,status:"approved",theoryContent:node.theoryContent,learningObjective:objective,cogPathStatus:"confirmed"}).returning();roots.push(extra.id);
    for(const source of [level,targetLevel])await db.insert(lessonNodeCognitiveLevelsTable).values({...source,id:undefined,lessonNodeId:extra.id,isTargetCeiling:source.id===targetLevel.id});
  }
  const full=await createQuiz("CHECK","full root");
  await db.update(quizzesTable).set({nodeIds:roots,questionCount:12}).where(eq(quizzesTable.id,full));
  for(let n=1;n<4;n++){
    const levels=await db.select().from(lessonNodeCognitiveLevelsTable).where(eq(lessonNodeCognitiveLevelsTable.lessonNodeId,roots[n]!));
    await db.insert(quizQuestionsTable).values(Array.from({length:3},(_,i)=>({quizId:full,nodeId:roots[n]!,cognitiveLevelId:levels.find(l=>l.cognitiveLevel===(i===0?"remember":"understand"))!.id,questionText:`full root ${n} task ${i}?`,options:["Correct","Wrong"],correctOptionIndex:0,optionExplanations:["Correct explanation","Wrong explanation"],difficultyLevel:"MEDIUM",interactionType:"multiple_choice",sequence:n*3+i+1})));
  }
  const fullResult=await answer(full,[true,false,false,true,false,false,false,true,true,false,false,false],true);
  assert.equal(fullResult.scorePercent,33);assert.equal(fullResult.totalCorrect,4);assert.equal(fullResult.totalQuestions,12);
  assert.deepEqual(fullResult.nodeBreakdown.map((n:any)=>n.assessment.percent),[33,33,67,0]);
  assert.equal(fullResult.session.knowsCount,0);assert.equal(fullResult.session.learningCount,3);assert.equal(fullResult.session.supportCount,1);
  const fullTeacher:any=await(await fetch(`${base}/quizzes/${full}/results/${studentId}`,{headers:auth(teacherId!,"teacher")})).json();assert.equal(fullTeacher.scorePercent,33);assert.equal(fullTeacher.nodeBreakdown.length,4);
  const practice=await answer(full,Array(9).fill(true),true);
  assert.equal(practice.practiceScorePercent,100);assert.equal(practice.practiceTotalQuestions,9);
  assert.equal(practice.scorePercent,33);assert.equal(practice.totalQuestions,12);assert.equal(practice.nodeBreakdown.length,4);
  const subset=await createQuiz("LEARNING","subset",1);
  await db.update(quizzesTable).set({nodeIds:roots}).where(eq(quizzesTable.id,subset));
  const subsetResult=await answer(subset,[true],false);
  assert.equal(subsetResult.nodeBreakdown.length,4);
  assert.equal(subsetResult.totalQuestions,10); // latest one-question cycle plus the other three nodes
  assert.equal(subsetResult.totalCorrect,4);
  console.log("PASS mixed-level full-root student/teacher summary, learning/support counts, narrow-attempt root preservation");
  console.log("PASS HTTP CHECK secrecy/resume, LEARNING feedback, 2/3 result-tree agreement, copied-task non-inflation, 0/3 stop, 3/3 mastery, delayed-only review advancement");
}finally{
  for(const id of quizIds)await db.delete(quizzesTable).where(eq(quizzesTable.id,id));
  if(subjectId)await db.delete(subjectsTable).where(eq(subjectsTable.id,subjectId));
  for(const id of userIds.reverse())await db.delete(usersTable).where(eq(usersTable.id,id));
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await pool.end();
}
