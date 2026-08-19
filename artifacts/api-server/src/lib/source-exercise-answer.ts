export const SOURCE_EXERCISE_INTERACTION_TYPES = [
  "multiple_choice",
  "true_false",
  "constructed_response",
] as const;

export type SourceExerciseInteractionType =
  typeof SOURCE_EXERCISE_INTERACTION_TYPES[number];

export interface SourceExerciseAnswerContractInput {
  interactionType: unknown;
  correctAnswer: unknown;
}

export type SourceExerciseAnswerContractResult =
  | {
      ok: true;
      interactionType: SourceExerciseInteractionType | null;
      correctAnswer: string | null;
    }
  | {
      ok: false;
      error: string;
    };

function nullableExplicitText(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function normalizeMultipleChoiceAnswer(value: string): "A" | "B" | "C" | "D" | null {
  const token = value.trim().replace(/\)$/, "").trim();
  const normalizedByToken: Record<string, "A" | "B" | "C" | "D"> = {
    A: "A", a: "A", Ա: "A", ա: "A",
    B: "B", b: "B", Բ: "B", բ: "B",
    C: "C", c: "C", Գ: "C", գ: "C",
    D: "D", d: "D", Դ: "D", դ: "D",
  };
  return normalizedByToken[token] ?? null;
}

export function normalizeTrueFalseAnswer(value: string): "TRUE" | "FALSE" | null {
  const token = value.trim().toLocaleLowerCase();
  if (token === "ճիշտ" || token === "true" || token === "այո") return "TRUE";
  if (token === "սխալ" || token === "false" || token === "ոչ") return "FALSE";
  return null;
}

/**
 * Validates and canonicalizes only explicit source-exercise answer metadata.
 * It never inspects exercise text or success criteria and therefore never
 * infers an answer. Legacy rows with both fields null remain valid.
 */
export function normalizeSourceExerciseAnswerContract(
  input: SourceExerciseAnswerContractInput,
): SourceExerciseAnswerContractResult {
  const interactionType = nullableExplicitText(input.interactionType);
  const explicitAnswer = nullableExplicitText(input.correctAnswer);

  if (interactionType === undefined) {
    return { ok: false, error: "interactionType must be a string or null" };
  }
  if (explicitAnswer === undefined) {
    return { ok: false, error: "correctAnswer must be a string or null" };
  }

  if (interactionType === null) {
    if (explicitAnswer !== null) {
      return { ok: false, error: "correctAnswer requires an interactionType" };
    }
    return { ok: true, interactionType: null, correctAnswer: null };
  }

  if (!(SOURCE_EXERCISE_INTERACTION_TYPES as readonly string[]).includes(interactionType)) {
    return {
      ok: false,
      error: `interactionType must be one of: ${SOURCE_EXERCISE_INTERACTION_TYPES.join(", ")}`,
    };
  }

  if (interactionType === "constructed_response") {
    if (explicitAnswer !== null) {
      return {
        ok: false,
        error: "constructed_response requires correctAnswer to be null",
      };
    }
    return {
      ok: true,
      interactionType: "constructed_response",
      correctAnswer: null,
    };
  }

  if (explicitAnswer === null) {
    return {
      ok: false,
      error: `${interactionType} requires an explicit correctAnswer`,
    };
  }

  if (interactionType === "multiple_choice") {
    const normalized = normalizeMultipleChoiceAnswer(explicitAnswer);
    if (!normalized) {
      return {
        ok: false,
        error: "multiple_choice correctAnswer must be an explicit A/B/C/D or Ա/Բ/Գ/Դ option token",
      };
    }
    return {
      ok: true,
      interactionType: "multiple_choice",
      correctAnswer: normalized,
    };
  }

  const normalized = normalizeTrueFalseAnswer(explicitAnswer);
  if (!normalized) {
    return {
      ok: false,
      error: "true_false correctAnswer must be explicit true/false, ճիշտ/սխալ, or այո/ոչ",
    };
  }
  return {
    ok: true,
    interactionType: "true_false",
    correctAnswer: normalized,
  };
}