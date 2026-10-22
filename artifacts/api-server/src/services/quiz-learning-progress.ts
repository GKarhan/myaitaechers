import { db, quizQuestionsTable, quizAnswersTable, quizAttemptsTable, quizAssignmentsTable, quizzesTable } from "@workspace/db";
import { and, asc, eq, isNotNull, inArray } from "drizzle-orm";

export function summarizeLearningProgress(
  questions: readonly { id:number; nodeId:number|null }[],
  answers: readonly { questionId:number; nodeId:number|null; isCorrect:boolean; attemptId:number; attemptSequence:number }[],
) {
  const latest = new Map<number, typeof answers[number]>();
  const firstSequence = answers[0]?.attemptSequence;
  const first = new Map<number, typeof answers[number]>();
  const attempts = new Map<number, typeof answers[number][]>();
  for(const answer of answers) {
    latest.set(answer.questionId,answer);
    if(answer.attemptSequence===firstSequence)first.set(answer.questionId,answer);
    attempts.set(answer.attemptId,[...(attempts.get(answer.attemptId)??[]),answer]);
  }
  const totals=(ids:readonly number[], map:ReadonlyMap<number,typeof answers[number]>)=>{
    const total=ids.length, correct=ids.filter(id=>map.get(id)?.isCorrect===true).length;
    const answered=ids.filter(id=>map.has(id)).length;
    return {total,correct,incorrect:answered-correct,unanswered:total-answered,percent:total?Math.round(correct/total*100):0};
  };
  const ids=questions.map(q=>q.id);
  const nodes=[...new Set(questions.map(q=>q.nodeId).filter((id):id is number=>id!==null))].map(nodeId=>{
    const own=questions.filter(q=>q.nodeId===nodeId).map(q=>q.id);
    const current=totals(own,latest), initial=totals(own,first);
    const last=[...answers].reverse().find(a=>a.nodeId===nodeId);
    const lastAnswers=last?answers.filter(a=>a.nodeId===nodeId&&a.attemptId===last.attemptId):[];
    return {nodeId,initial,current,lastAttempt:last?{attemptId:last.attemptId,attemptSequence:last.attemptSequence,total:lastAnswers.length,correct:lastAnswers.filter(a=>a.isCorrect).length}:null,
      practiceComplete:current.total>0&&current.correct===current.total};
  });
  const history=[...attempts.entries()].map(([attemptId,rows])=>({attemptId,attemptSequence:rows[0]!.attemptSequence,total:rows.length,correct:rows.filter(a=>a.isCorrect).length,nodeIds:[...new Set(rows.map(a=>a.nodeId).filter((id):id is number=>id!==null))]}));
  // Flow is derived from immutable completed answers; it never changes scoring
  // or turns repeated questions into new independent evidence.
  const flowLatest=new Map<number,boolean>();
  let nextPhase:"INITIAL"|"PRACTICE"|"FINAL"|"COMPLETE"="INITIAL";
  let lastFinal:{attemptId:number;correct:number;total:number;percent:number}|null=null;
  const phasedHistory=history.map(item=>{
    const phase=nextPhase==="COMPLETE"?"FINAL":nextPhase;
    const rows=attempts.get(item.attemptId)!;
    for(const answer of rows)flowLatest.set(answer.questionId,answer.isCorrect);
    const allCorrect=ids.length>0 && ids.every(id=>flowLatest.get(id)===true);
    if(phase==="FINAL")lastFinal={attemptId:item.attemptId,correct:item.correct,total:item.total,percent:item.total?Math.round(item.correct/item.total*100):0};
    nextPhase=phase==="FINAL" && item.total===ids.length && item.correct===item.total ? "COMPLETE" : allCorrect?"FINAL":"PRACTICE";
    return {...item,phase};
  });
  const learningFlow:{nextPhase:"INITIAL"|"PRACTICE"|"FINAL"|"COMPLETE";completed:boolean;lastFinal:{attemptId:number;correct:number;total:number;percent:number}|null}={
    nextPhase:nextPhase as "INITIAL"|"PRACTICE"|"FINAL"|"COMPLETE",completed:(nextPhase as string)==="COMPLETE",lastFinal,
  };
  return {initial:totals(ids,first),current:totals(ids,latest),nodes,history:phasedHistory,learningFlow,
    remainingQuestionIds:ids.filter(id=>latest.get(id)?.isCorrect!==true)};
}

export async function getQuizLearningProgress(quizId:number,studentId:number) {
  const questions=await db.select({id:quizQuestionsTable.id,nodeId:quizQuestionsTable.nodeId}).from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId,quizId)).orderBy(asc(quizQuestionsTable.sequence));
  const answers=await db.select({questionId:quizAnswersTable.questionId,nodeId:quizAnswersTable.nodeId,isCorrect:quizAnswersTable.isCorrect,
    attemptId:quizAttemptsTable.id,attemptSequence:quizAttemptsTable.attemptSequence}).from(quizAnswersTable)
    .innerJoin(quizAttemptsTable,eq(quizAttemptsTable.id,quizAnswersTable.attemptId))
    .innerJoin(quizAssignmentsTable,eq(quizAssignmentsTable.id,quizAttemptsTable.quizAssignmentId))
    .where(and(eq(quizAssignmentsTable.quizId,quizId),eq(quizAssignmentsTable.studentId,studentId),isNotNull(quizAttemptsTable.completedAt)))
    .orderBy(asc(quizAttemptsTable.attemptSequence),asc(quizAttemptsTable.id),asc(quizAnswersTable.id));
  return summarizeLearningProgress(questions,answers);
}

/** One batched projection for tree nodes. Practice never grants independent mastery. */
export async function getLatestNodeLearningProgress(studentId:number,nodeIds:readonly number[]) {
  const result=new Map<number,{quizId:number;initial:ReturnType<typeof summarizeLearningProgress>["initial"];current:ReturnType<typeof summarizeLearningProgress>["current"];practiceComplete:boolean}>();
  if(!nodeIds.length)return result;
  const rows=await db.select({quizId:quizAssignmentsTable.quizId,questionId:quizAnswersTable.questionId,nodeId:quizAnswersTable.nodeId,isCorrect:quizAnswersTable.isCorrect,attemptId:quizAttemptsTable.id,attemptSequence:quizAttemptsTable.attemptSequence})
    .from(quizAnswersTable).innerJoin(quizAttemptsTable,eq(quizAttemptsTable.id,quizAnswersTable.attemptId))
    .innerJoin(quizAssignmentsTable,eq(quizAssignmentsTable.id,quizAttemptsTable.quizAssignmentId))
    .innerJoin(quizzesTable,eq(quizzesTable.id,quizAssignmentsTable.quizId))
    .where(and(eq(quizAssignmentsTable.studentId,studentId),inArray(quizAnswersTable.nodeId,[...nodeIds]),isNotNull(quizAttemptsTable.completedAt),isNotNull(quizzesTable.assessmentConfig)))
    .orderBy(asc(quizAttemptsTable.completedAt),asc(quizAttemptsTable.id),asc(quizAnswersTable.id));
  const latestQuiz=new Map<number,number>();for(const row of rows)if(row.nodeId!==null)latestQuiz.set(row.nodeId,row.quizId);
  const quizIds=[...new Set(latestQuiz.values())];if(!quizIds.length)return result;
  const questions=await db.select({id:quizQuestionsTable.id,nodeId:quizQuestionsTable.nodeId,quizId:quizQuestionsTable.quizId}).from(quizQuestionsTable).where(inArray(quizQuestionsTable.quizId,quizIds));
  for(const quizId of quizIds){
    const progress=summarizeLearningProgress(questions.filter(q=>q.quizId===quizId),rows.filter(r=>r.quizId===quizId).sort((a,b)=>a.attemptSequence-b.attemptSequence||a.attemptId-b.attemptId));
    for(const node of progress.nodes)if(latestQuiz.get(node.nodeId)===quizId)result.set(node.nodeId,{quizId,initial:node.initial,current:node.current,practiceComplete:node.practiceComplete});
  }return result;
}
