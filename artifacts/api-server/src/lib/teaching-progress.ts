/** Instructional coverage, never canonical mastery or a demonstrated ceiling. */
export type TeachingEvidence = {
  taskReference: string | null;
  cognitiveLevelId: number | null;
  wasCorrect: boolean | null;
  hintUsed: boolean;
  attemptSequence: number | null;
  assistanceLevel: string | null;
  metadata: unknown;
  qualificationStatus: string | null;
};

export function summarizeTeachingProgress(
  evidence: readonly TeachingEvidence[],
  target: { lessonId: number; nodeId: number; levelIds: readonly number[]; ceilingId: number },
): { covered: boolean; nextLevelId: number | null; correctTasks: number } {
  const tasks = new Set<string>();
  const coveredLevels = new Set<number>();
  const taskContents = new Set<string>();
  for (const event of evidence) {
    const meta = event.metadata as any;
    const snapshot = meta?.canonicalTaskSnapshot;
    const execution = meta?.c7ExecutionTarget;
    if (event.qualificationStatus !== "qualified" || !event.taskReference || tasks.has(event.taskReference) || !event.wasCorrect || event.hintUsed ||
      event.attemptSequence !== 1 || event.assistanceLevel !== "none" ||
      meta?.evaluation?.status !== "CORRECT" ||
      !["MODERATE", "STRONG", "CONCLUSIVE"].includes(meta?.evidence_quality) || meta?.c4ProjectionCompleted !== true ||
      execution?.lessonId !== target.lessonId || execution?.microNodeId !== target.nodeId ||
      execution?.activeCognitiveLevelId !== event.cognitiveLevelId ||
      snapshot?.taskReference !== event.taskReference ||
      meta?.assistanceAtEvaluation?.helpCount !== 0 ||
      snapshot?.lessonNodeId !== target.nodeId || snapshot?.cognitiveLevelId !== event.cognitiveLevelId ||
      snapshot?.targetCompatibleAtActivation !== true ||
      !["micro_check", "source_exercise"].includes(snapshot?.taskSource) ||
      event.cognitiveLevelId === null || !target.levelIds.includes(event.cognitiveLevelId)) continue;
    if (snapshot.taskSource === "source_exercise" &&
      (!Number.isInteger(snapshot.lessonExerciseId) || snapshot.lessonExerciseId <= 0)) continue;
    const contentIdentity = snapshot.taskSource === "source_exercise"
      ? `source:${snapshot.lessonExerciseId}`
      : typeof snapshot.renderedPrompt === "string"
        ? snapshot.renderedPrompt.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim() : "";
    if (!contentIdentity || contentIdentity === "source:null" || taskContents.has(contentIdentity)) continue;
    taskContents.add(contentIdentity);
    tasks.add(event.taskReference);
    coveredLevels.add(event.cognitiveLevelId);
  }
  const missing = target.levelIds.find((id) => !coveredLevels.has(id));
  const covered = missing === undefined && tasks.size >= 2;
  return { covered, nextLevelId: covered ? null : missing ?? target.ceilingId, correctTasks: tasks.size };
}
