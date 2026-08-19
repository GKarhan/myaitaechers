export type HelpActionState = {
  isCompleted: boolean;
  currentPhase: number;
  hasActiveTask: boolean;
  activeHelpCount: number;
  showCompletionCard: boolean;
};

/**
 * The HELP action is available only for an authoritative answerable task.
 * The API provides `hasActiveTask`; the client must not infer it from chat text.
 */
export function shouldShowExplicitHelpAction(state: HelpActionState): boolean {
  return (
    !state.isCompleted &&
    state.currentPhase >= 2 &&
    state.hasActiveTask &&
    state.activeHelpCount < 4 &&
    !state.showCompletionCard
  );
}