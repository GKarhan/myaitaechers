export type Stage41Exercise = {
  id: number;
  exerciseId: string;
  exerciseTextEdited: string | null;
  successCriteria: string | null;
  correctAnswer: string | null;
  interactionType: string | null;
};

export type Stage41Remediation = {
  learnerTextAfter: string;
  authority: string;
};

/**
 * Returns a write proposal only for explicitly audited, exact field splits.
 * This intentionally does not attempt a generic text cleanup.
 */
export function deriveStage41Remediation(
  row: Stage41Exercise,
): Stage41Remediation | null {
  const edited = row.exerciseTextEdited?.trimEnd();
  const criteria = row.successCriteria?.trim();
  if (!edited || !criteria) return null;

  if (
    row.id === 941 &&
    row.exerciseId === "EX-579-2" &&
    row.interactionType === "true_false" &&
    row.correctAnswer === "TRUE" &&
    criteria === "Ճիշտ պատասխան՝ Ճիշտ" &&
    edited.endsWith(`\n\n${criteria}`)
  ) {
    return {
      learnerTextAfter: edited.slice(0, -(`\n\n${criteria}`).length).trimEnd(),
      authority: "The exact terminal labeled answer is independently persisted in successCriteria and correctAnswer=TRUE; removing only that identical terminal segment preserves the original learner statement verbatim.",
    };
  }

  if (
    row.id === 942 &&
    row.exerciseId === "EX-579-3" &&
    criteria.startsWith("Սպասվող պատասխանի հիմնական միտքը․") &&
    edited.endsWith(`\n\n${criteria}`)
  ) {
    return {
      learnerTextAfter: edited.slice(0, -(`\n\n${criteria}`).length).trimEnd(),
      authority: "The exact terminal expected-answer section is independently persisted as successCriteria; removing only that identical terminal segment preserves the original learner question verbatim.",
    };
  }

  return null;
}