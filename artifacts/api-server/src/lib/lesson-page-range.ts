export const PAGE_RANGE_ERROR_MESSAGE =
  "Էջերի միջակայքը սխալ է։ Նշեք դրական ամբողջ թվեր, և սկզբի էջը չպետք է մեծ լինի ավարտի էջից։";

export type PageRangeValidation =
  | { valid: true; pagesFrom: number | null; pagesTo: number | null }
  | { valid: false; error: string };

export type RequiredPageRangeValidation =
  | { valid: true; pagesFrom: number; pagesTo: number }
  | { valid: false; error: string };

function toOptionalPage(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  const page = typeof value === "number" ? value : Number(value);
  return Number.isInteger(page) && page >= 1 ? page : "invalid";
}

/**
 * Lesson pages are optional while authoring, but they must be supplied as one
 * ordered pair before a PDF-backed mapping can run.
 */
export function validateOptionalLessonPageRange(
  rawPagesFrom: unknown,
  rawPagesTo: unknown,
): PageRangeValidation {
  const pagesFrom = toOptionalPage(rawPagesFrom);
  const pagesTo = toOptionalPage(rawPagesTo);
  if (pagesFrom === "invalid" || pagesTo === "invalid") {
    return { valid: false, error: PAGE_RANGE_ERROR_MESSAGE };
  }
  if (pagesFrom === null && pagesTo === null) {
    return { valid: true, pagesFrom: null, pagesTo: null };
  }
  if (pagesFrom === null || pagesTo === null || pagesFrom > pagesTo) {
    return { valid: false, error: PAGE_RANGE_ERROR_MESSAGE };
  }
  return { valid: true, pagesFrom, pagesTo };
}

export function validateRequiredLessonPageRange(
  rawPagesFrom: unknown,
  rawPagesTo: unknown,
): RequiredPageRangeValidation {
  const range = validateOptionalLessonPageRange(rawPagesFrom, rawPagesTo);
  if (!range.valid || range.pagesFrom === null || range.pagesTo === null) {
    return { valid: false, error: PAGE_RANGE_ERROR_MESSAGE };
  }
  return { valid: true, pagesFrom: range.pagesFrom, pagesTo: range.pagesTo };
}