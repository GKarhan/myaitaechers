import { parseAssessmentConfig } from "../services/node-assessment-policy.js";
import { normalizeQuestionText } from "../services/quiz-question-quality.js";

export type FinalAssessmentHandoff = {
  state: "NOT_READY" | "WAITING_FOR_QUIZ" | "READY" | "COMPLETED";
  quizId: number | null;
  href: string | null;
};
export function isTeachingReadyForFinal(session: {
  currentPhase: number; currentNodeId: number | null; nodeTeachingStage: string;
  activeTaskProvenance: string | null; activeTaskReference: string | null;
}): boolean {
  return session.currentPhase === 3 && session.currentNodeId === null &&
    session.nodeTeachingStage !== "FEEDBACK" && !session.activeTaskProvenance && !session.activeTaskReference;
}

/** Inputs contain only the current learner's assignments, newest first.
 * No quiz creation, answer exposure, or knowledge-state writes occur here. */
export function selectFinalAssessmentHandoff(
  targets: readonly { nodeId: number; cognitiveLevelId: number }[],
  candidates: readonly { id: number; status: string; assignmentStatus: string; assessmentConfig: unknown }[],
  questions: readonly { id: number; quizId: number; nodeId: number | null; cognitiveLevelId: number | null; questionText: string }[],
): FinalAssessmentHandoff {
  const waiting: FinalAssessmentHandoff = { state: "WAITING_FOR_QUIZ", quizId: null, href: null };
  if (!targets.length) return waiting;
  const scope = new Map(targets.map(t => [t.nodeId, t.cognitiveLevelId]));
  for (const quiz of candidates) {
    const config = parseAssessmentConfig(quiz.assessmentConfig);
    if (!config?.fullConfirmation || config.purpose !== "CHECK" ||
      !["ASSIGNED", "PUBLISHED"].includes(quiz.status) ||
      !["ASSIGNED", "IN_PROGRESS", "COMPLETED"].includes(quiz.assignmentStatus)) continue;
    const own = questions.filter(q => q.quizId === quiz.id);
    if (own.length !== scope.size * 3 || new Set(own.map(q => q.id)).size !== own.length ||
      own.some(q => q.nodeId === null || !scope.has(q.nodeId) || scope.get(q.nodeId) !== q.cognitiveLevelId)) continue;
    if ([...scope.keys()].some(nodeId => {
      const rows = own.filter(q => q.nodeId === nodeId);
      return rows.length !== 3 || new Set(rows.map(q => normalizeQuestionText(q.questionText))).size !== 3;
    })) continue;
    const completed = quiz.assignmentStatus === "COMPLETED";
    return { state: completed ? "COMPLETED" : "READY", quizId: quiz.id,
      href: `/quiz/${quiz.id}/${completed ? "result" : "take"}` };
  }
  return waiting;
}
