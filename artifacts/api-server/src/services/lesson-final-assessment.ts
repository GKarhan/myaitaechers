import { db, lessonNodesTable, lessonNodeCognitiveLevelsTable, quizAssignmentsTable,
  quizLessonLinksTable, quizzesTable, quizQuestionsTable } from "@workspace/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { resolveCanonicalQuizTarget } from "../lib/cognitive-path-grounding.js";
import { isTeachingReadyForFinal, selectFinalAssessmentHandoff, type FinalAssessmentHandoff } from "../lib/final-assessment-handoff.js";

type Session = Parameters<typeof isTeachingReadyForFinal>[0] & { userId: number; lessonId: number; learningScope?:{mode:string;nodeIds:number[]}|null };
export async function getLessonFinalAssessmentHandoff(session: Session) {
  if (!isTeachingReadyForFinal(session)) return { state: "NOT_READY" as const, quizId: null, href: null };
  const finish = (result:FinalAssessmentHandoff):FinalAssessmentHandoff => session.learningScope?.mode === "NODES" && result.state === "WAITING_FOR_QUIZ"
    ? {...result,state:"SCOPE_COMPLETE"} : result;
  const nodes = await db.select().from(lessonNodesTable).where(and(
    eq(lessonNodesTable.lessonId, session.lessonId), eq(lessonNodesTable.status, "approved"),
    ...(session.learningScope ? [inArray(lessonNodesTable.id,session.learningScope.nodeIds)] : [])));
  if (!nodes.length) return selectFinalAssessmentHandoff([], [], []);
  const levels = await db.select().from(lessonNodeCognitiveLevelsTable)
    .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, nodes.map(n => n.id)))
    .orderBy(asc(lessonNodeCognitiveLevelsTable.sequence));
  const targets: { nodeId: number; cognitiveLevelId: number }[] = [];
  for (const node of nodes) {
    const target = resolveCanonicalQuizTarget(node, levels.filter(l => l.lessonNodeId === node.id));
    if (!target.valid) return selectFinalAssessmentHandoff([], [], []);
    targets.push(target.target);
  }
  const candidates = await db.select({ id: quizzesTable.id, status: quizzesTable.status,
    assignmentStatus: quizAssignmentsTable.status, assessmentConfig: quizzesTable.assessmentConfig })
    .from(quizAssignmentsTable).innerJoin(quizzesTable, eq(quizzesTable.id, quizAssignmentsTable.quizId))
    .innerJoin(quizLessonLinksTable, eq(quizLessonLinksTable.quizId, quizzesTable.id))
    .where(and(eq(quizAssignmentsTable.studentId, session.userId), eq(quizLessonLinksTable.lessonId, session.lessonId)))
    .orderBy(desc(quizAssignmentsTable.assignedAt), desc(quizAssignmentsTable.id));
  if (!candidates.length) return finish(selectFinalAssessmentHandoff(targets, [], []));
  const questions = await db.select({ id: quizQuestionsTable.id, quizId: quizQuestionsTable.quizId,
    nodeId: quizQuestionsTable.nodeId, cognitiveLevelId: quizQuestionsTable.cognitiveLevelId,
    questionText: quizQuestionsTable.questionText }).from(quizQuestionsTable)
    .where(inArray(quizQuestionsTable.quizId, [...new Set(candidates.map(q => q.id))]));
  return finish(selectFinalAssessmentHandoff(targets, candidates, questions));
}
