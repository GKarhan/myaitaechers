/** Learner delivery selection only; never imports legacy node teaching fields. */
export type PreparedTeachingItem = {
  id: number;
  lessonId: number;
  lessonNodeId: number;
  itemType: string;
  content: string;
  status: string;
  cognitiveLevel: string | null;
  isPrimary: boolean;
  sequence: number;
};

export type PreparedTeachingTarget = {
  lessonId: number;
  microNodeId: number;
  cognitiveLevel: string;
};

export function selectPreparedTeachingItems(
  items: readonly PreparedTeachingItem[],
  target: PreparedTeachingTarget,
  itemType: string,
): PreparedTeachingItem[] {
  return items.filter((item) =>
    item.lessonId === target.lessonId && item.lessonNodeId === target.microNodeId &&
    item.status === "approved" && item.itemType === itemType && item.content.trim() &&
    (item.cognitiveLevel === null || item.cognitiveLevel === target.cognitiveLevel),
  ).sort((a, b) =>
    Number(b.isPrimary) - Number(a.isPrimary) ||
    Number(b.cognitiveLevel === target.cognitiveLevel) - Number(a.cognitiveLevel === target.cognitiveLevel) ||
    a.sequence - b.sequence || a.id - b.id,
  );
}

export class PreparedTeachingUnavailableError extends Error {
  constructor() { super("APPROVED_TEACHING_MATERIAL_UNAVAILABLE"); }
}

export function composePreparedTheory(
  items: readonly PreparedTeachingItem[],
  target: PreparedTeachingTarget,
  title: string,
): { student_message: string; itemIds: number[] } {
  const main = selectPreparedTeachingItems(items, target, "MAIN_EXPLANATION")[0];
  if (!main) throw new PreparedTeachingUnavailableError();
  const examples = selectPreparedTeachingItems(items, target, "EXAMPLE").slice(0, 2);
  return {
    student_message: [title, main.content, ...examples.map((item) => item.content)].join("\n\n"),
    itemIds: [main.id, ...examples.map((item) => item.id)],
  };
}

export function preparedTeachingContext(
  items: readonly PreparedTeachingItem[], target: PreparedTeachingTarget,
): string {
  const types = ["MAIN_EXPLANATION", "KEY_FACT", "RULE_OR_FORMULA", "EXAMPLE", "COUNTEREXAMPLE", "MISCONCEPTION"];
  return types.flatMap((type) => selectPreparedTeachingItems(items, target, type)
    .map((item) => `${type} [approved package item ${item.id}]:\n${item.content}`)).join("\n\n");
}
