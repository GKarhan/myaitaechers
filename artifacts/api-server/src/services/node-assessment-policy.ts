/** Versioned assessment outcomes. Certainty labels are product rules, not
 * calibrated probabilities. Never count a repeated, exposed answer as new proof. */
export type AssessmentConfig = { version: "NODE_V1"; purpose: "LEARNING" | "CHECK"; context: "IN_CLASS" | "AT_HOME" | "CLASS_THEN_HOME" | "ANYWHERE" };
export function parseAssessmentConfig(value: unknown): AssessmentConfig | null {
  const v = value as Partial<AssessmentConfig> | null;
  if (!v || v.version !== "NODE_V1" || !["LEARNING", "CHECK"].includes(v.purpose ?? "") ||
    !["IN_CLASS", "AT_HOME", "CLASS_THEN_HOME", "ANYWHERE"].includes(v.context ?? "")) return null;
  return v as AssessmentConfig;
}
export function allocateNodeQuestions(nodeIds: readonly number[], count: number): Map<number, number> {
  const ids = [...new Set(nodeIds)];
  if (!ids.length || !Number.isInteger(count) || count < ids.length || count > Math.min(50, ids.length * 3))
    throw new Error("QUESTION_COUNT_OUTSIDE_NODE_RANGE");
  return new Map(ids.map((id, i) => [id, Math.floor(count / ids.length) + (i < count % ids.length ? 1 : 0)]));
}
export type AssessmentSummary = {
  correct: number; attempted: number; percent: number | null;
  certainty: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  status: "NOT_ASSESSED" | "SUCCESS" | "PARTIAL" | "NOT_KNOWN" | "NEEDS_SUPPORT";
  nextAction: "ASSESS" | "RECONFIRM" | "REVIEW" | "TARGETED_PRACTICE" | "LEARN" | "TEACHER_REVIEW";
  confirmation: string;
};
export function summarizeIndependentAnswers(answers: readonly boolean[]): AssessmentSummary {
  const sample = answers.slice(0, 3), attempted = sample.length;
  const correct = sample.filter(Boolean).length;
  const status = !attempted ? "NOT_ASSESSED" : !correct ? (attempted === 3 ? "NEEDS_SUPPORT" : "NOT_KNOWN")
    : correct === attempted ? "SUCCESS" : "PARTIAL";
  return { correct, attempted, percent: attempted ? Math.round(correct / attempted * 100) : null,
    certainty: !correct ? "NONE" : correct === 1 ? "LOW" : correct === 2 ? "MEDIUM" : "HIGH",
    status, confirmation: `${Math.min(correct, 3)}/3`,
    nextAction: status === "NEEDS_SUPPORT" ? "TEACHER_REVIEW" : status === "NOT_ASSESSED" ? "ASSESS"
      : status === "NOT_KNOWN" ? "LEARN" : status === "PARTIAL" ? (correct === 1 ? "LEARN" : "TARGETED_PRACTICE")
      : attempted === 3 ? "REVIEW" : "RECONFIRM" };
}
export type AssessmentEvent = { id: number; wasCorrect: boolean | null; createdAt: Date | null;
  taskReference: string | null; metadata: unknown; cognitiveLevelId: number | null };
export function currentIndependentAssessment(events: readonly AssessmentEvent[], targetLevelId?: number | null): AssessmentSummary | null {
  const versioned = events.filter(e => (e.metadata as any)?.assessmentVersion === "NODE_V1" && e.wasCorrect !== null && (e.metadata as any)?.independentAssessment === true)
    .sort((a,b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.id - b.id);
  if (!versioned.length) return null;
  const latest = versioned.at(-1)!;
  const cycle = (latest.metadata as any).assessmentCycle;
  // An unsupported historical/foreign event must not manufacture a cycle.
  if (!cycle) return null;
  const first = new Map<string, boolean>();
  for (const e of versioned) {
    const m = e.metadata as any;
    if (m.assessmentCycle !== cycle || m.independentAssessment !== true || m.answerPreviouslyExposed === true ||
      !e.taskReference || (targetLevelId != null && e.cognitiveLevelId !== targetLevelId)) continue;
    const family = m.assessmentFamily ?? e.taskReference;
    if (!first.has(family)) first.set(family, e.wasCorrect!);
  }
  return summarizeIndependentAnswers([...first.values()]);
}
export function aggregateAssessments(nodes: readonly {assessment?:AssessmentSummary|null}[]) {
  const assessments=nodes.flatMap(n=>n.assessment?[n.assessment]:[]);
  if(!assessments.length)return null;
  const totalCorrect=assessments.reduce((sum,a)=>sum+a.correct,0);
  const totalQuestions=assessments.reduce((sum,a)=>sum+a.attempted,0);
  return {totalCorrect,totalQuestions,scorePercent:totalQuestions?Math.round(totalCorrect/totalQuestions*100):0};
}
