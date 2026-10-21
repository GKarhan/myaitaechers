/** Current assessment accuracy, separate from cognitive mastery. Retrying a
 * question replaces its previous result; historical mistakes remain evidence. */
export type NodeAnswer = {
  id: number;
  wasCorrect: boolean | null;
  createdAt: Date | null;
  taskReference: string | null;
  quizQuestionId: number | null;
  lessonSessionId: number | null;
  metadata: unknown;
};
export function currentNodeResult(events: readonly NodeAnswer[]): number | null {
  const graded = events.filter(e => e.wasCorrect !== null).sort((a,b) =>
    (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.id - b.id);
  if (!graded.length) return null;
  const group = (e: NodeAnswer) => {
    const meta = e.metadata as { quizId?: number } | null;
    if (meta?.quizId != null) return `quiz:${meta.quizId}`;
    if (e.lessonSessionId != null) return `lesson:${e.lessonSessionId}`;
    return "legacy";
  };
  const latestGroup = group(graded[graded.length - 1]);
  const latest = new Map<string, boolean>();
  for (const event of graded) {
    if (group(event) !== latestGroup) continue;
    const task = event.quizQuestionId != null ? `question:${event.quizQuestionId}`
      : event.taskReference ?? "legacy-latest-answer";
    latest.set(task, event.wasCorrect!);
  }
  return Math.round([...latest.values()].filter(Boolean).length / latest.size * 100);
}

/** A stored reference can outlive deleted/replaced quiz questions. Revalidate
 * the exact persisted level from current qualified C3 evidence, never an ID alone. */
export function hasCurrentCeilingProvenance(input: {
  persistedLevelId: number | null;
  computedLevelId: number | null;
  hasValidStoredReference: boolean;
  hasComputedEvidence: boolean;
}): boolean {
  return input.hasValidStoredReference || (
    input.persistedLevelId !== null &&
    input.persistedLevelId === input.computedLevelId && input.hasComputedEvidence
  );
}
