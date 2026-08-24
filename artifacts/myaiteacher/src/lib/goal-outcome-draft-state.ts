export function getGoalOutcomeDraftState(input: {
  lessonGoal?: string | null;
  outcomes?: string[] | null;
  hasProposal?: boolean;
}) {
  const lessonGoal = input.lessonGoal?.trim() ?? "";
  const outcomes = (input.outcomes ?? []).map((outcome) => outcome.trim()).filter(Boolean);
  const hasSavedGoal = lessonGoal.length > 0;
  const hasSavedOutcomes = outcomes.length > 0;
  const hasSavedDraft = hasSavedGoal && hasSavedOutcomes;
  const hasPartialSavedDraft = hasSavedGoal !== hasSavedOutcomes;
  const canCreateOrPropose = !hasSavedDraft && !hasPartialSavedDraft;

  return {
    outcomes,
    hasSavedGoal,
    hasSavedOutcomes,
    hasSavedDraft,
    hasPartialSavedDraft,
    canCreateOrPropose,
    canImportProposal: canCreateOrPropose && Boolean(input.hasProposal),
    canEditOrDelete: hasSavedGoal || hasSavedOutcomes,
  };
}