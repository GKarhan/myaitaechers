/** Compare visible question text, independently of option keys and punctuation. */
export function normalizeTeachingQuestion(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export async function generateDistinctTask<T extends { student_message: string }>(
  history: readonly { role: string; content: string }[],
  generate: (correction: string) => Promise<T>,
): Promise<T> {
  const shown = history.filter(row => row.role === "assistant")
    .map(row => normalizeTeachingQuestion(row.content));
  let correction = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const task = await generate(correction);
    const question = normalizeTeachingQuestion(task.student_message);
    if (question && !shown.some(text => text.includes(question))) return task;
    correction = "The previous candidate repeated an already displayed question: " +
      task.student_message + "\nCreate a different question with a different concrete example within the SAME authorized node and level. Do not just reorder choices or change punctuation.";
  }
  throw new Error("TASK_DISTINCTNESS_EXHAUSTED");
}
