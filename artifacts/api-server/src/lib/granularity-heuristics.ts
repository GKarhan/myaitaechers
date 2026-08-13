// ─────────────────────────────────────────────────────────────────────────────
// Granularity Heuristics — Phase 4 deterministic signal generators
//
// These are SIGNAL GENERATORS, not decision-makers.
// Every flag produced here is passed to the AI review model (Pass 2B) which
// makes the final semantic judgment.  Nothing here auto-splits or auto-merges.
//
// Two helpers:
//   detectCompoundLO  — flags a single LO that may contain two independent
//                       action verbs connected by a compound conjunction.
//   detectDuplicateLOs — finds pairs of LOs within a topic whose token sets
//                        overlap enough to suggest the same underlying objective.
// ─────────────────────────────────────────────────────────────────────────────

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Compound connectors in Armenian and English that may join two independent
 * predicate clauses.  We look for these anywhere in the LO text.
 */
const COMPOUND_CONNECTORS: string[] = [
  "և",   // Armenian "and"
  "եւ",  // Armenian "and" (older orthography)
  "ու",  // Armenian "and/or"
  "կամ", // Armenian "or"
  " and ",
  " or ",
];

/**
 * Armenian verb suffixes that typically end an infinitive or present-tense
 * conjugated verb form.  We use these to detect a second verb phrase on the
 * far side of a compound connector.
 *
 * Infinitive: -ել, -ալ  (e.g. սahmanil-ел, dasakargel-ел)
 * Present participle: -ում (e.g. ogtavordz-UM)
 * 2nd-person short form: -իր (e.g. kardir)
 * General conjugation endings (3rd sg): -ի, -ա
 *
 * These are intentionally broad — false positives from nouns with the same
 * endings are acceptable because the AI makes the final call.
 */
const ARM_VERB_SUFFIXES = ["ել", "ալ", "ում", "իր", "ի", "ա"];

/**
 * English action verbs commonly found in learning objectives.
 * Extend as needed.
 */
const EN_ACTION_VERBS = [
  "define", "identify", "classify", "compare", "explain", "apply",
  "calculate", "solve", "construct", "analyze", "describe", "recognize",
  "use", "find", "determine", "interpret", "demonstrate", "evaluate",
  "name", "list", "distinguish", "compose", "produce", "write",
];

// ── detectCompoundLO ──────────────────────────────────────────────────────────

export interface CompoundLOSignal {
  flagged: true;
  connector: string;
  /** The portion of the LO before the connector. */
  leftClause: string;
  /** The portion of the LO after the connector. */
  rightClause: string;
}

/**
 * Detects a potential compound learning objective.
 *
 * Returns a signal object when the LO appears to contain two independent
 * action clauses joined by a compound connector — e.g.:
 *   "Student can define a verb and identify verbs in text."
 *
 * Returns null when no compound signal is detected, or when the connector
 * appears only within a single procedure description — e.g.:
 *   "Student can decompose a number by grouping digits from right to left."
 *
 * IMPORTANT: This is a signal only.  The presence of a connector does NOT
 * automatically mean the LO is compound.  The AI review model decides.
 */
export function detectCompoundLO(learningObjective: string): CompoundLOSignal | null {
  if (!learningObjective || learningObjective.trim().length < 10) return null;

  const lo = learningObjective.trim();

  for (const connector of COMPOUND_CONNECTORS) {
    // Case-insensitive search for English connectors
    const searchLower = lo.toLowerCase();
    const connLower   = connector.toLowerCase();
    const pos = searchLower.indexOf(connLower);
    if (pos === -1) continue;

    const left  = lo.slice(0, pos).trim();
    const right = lo.slice(pos + connector.length).trim();

    // Both sides must be substantive (at least 8 chars) to avoid false signals
    // on short phrases like "5 and 10" or "a կամ b".
    if (left.length < 8 || right.length < 8) continue;

    // Check that the LEFT side contains at least one verb-like token.
    if (!hasVerbLikeToken(left)) continue;

    // Check that the RIGHT side also contains at least one verb-like token.
    // This distinguishes "define X and its components" (noun continuation, right
    // side has no new verb) from "define X and identify Y" (two predicates).
    if (!hasVerbLikeToken(right)) continue;

    return { flagged: true, connector: connector.trim(), leftClause: left, rightClause: right };
  }

  return null;
}

/** Returns true if the text segment contains at least one word that looks like
 *  an action verb (Armenian infinitive/conjugation suffix or English verb). */
function hasVerbLikeToken(text: string): boolean {
  // English action verb check
  const lower = text.toLowerCase();
  if (EN_ACTION_VERBS.some((v) => {
    const idx = lower.indexOf(v);
    if (idx === -1) return false;
    // Must be a whole-word match (not inside another word)
    const before = idx > 0 ? lower[idx - 1] : " ";
    const after  = idx + v.length < lower.length ? lower[idx + v.length] : " ";
    return /\W/.test(before) && /\W/.test(after);
  })) return true;

  // Armenian verb suffix check: any word ending in one of the suffixes
  const words = text.split(/[\s,;:!?.()\[\]{}»«"']+/).filter(Boolean);
  return words.some((w) => ARM_VERB_SUFFIXES.some((suf) => w.endsWith(suf) && w.length > suf.length + 1));
}

// ── detectDuplicateLOs ────────────────────────────────────────────────────────

export interface DuplicateLOCandidate {
  titleA: string;
  loA: string;
  titleB: string;
  loB: string;
  /** Jaccard token-overlap score 0..1. */
  similarity: number;
}

/**
 * Finds pairs of MicroNode learning objectives within a topic whose content-token
 * sets overlap substantially, suggesting they may describe the same underlying
 * learning objective (OVER_SPLIT candidate).
 *
 * Uses Jaccard similarity on normalized content tokens (stopwords removed).
 * Threshold: 0.35 — deliberately loose because the AI review model confirms.
 *
 * Example candidates:
 *   "find the unknown addend using inverse operations"
 *   "apply the rules for finding the unknown addend"
 *   → both mention addend + inverse/rule → similarity > 0.35
 *
 * Not candidates:
 *   "explain addition"
 *   "solve subtraction word problems"
 *   → low shared content tokens
 */
export function detectDuplicateLOs(
  microNodes: ReadonlyArray<{ title: string; learningObjective: string }>,
): DuplicateLOCandidate[] {
  const candidates: DuplicateLOCandidate[] = [];

  for (let i = 0; i < microNodes.length; i++) {
    for (let j = i + 1; j < microNodes.length; j++) {
      const a = microNodes[i];
      const b = microNodes[j];
      const sim = jaccardSimilarity(
        contentTokens(a.learningObjective),
        contentTokens(b.learningObjective),
      );
      // Threshold 0.25 — deliberately loose because the AI review model confirms.
      // Lower than 0.35 to account for morphological variants like "find"/"finding"
      // which share the same root but appear as different tokens.
      if (sim >= 0.25) {
        candidates.push({
          titleA: a.title,
          loA:    a.learningObjective,
          titleB: b.title,
          loB:    b.learningObjective,
          similarity: Math.round(sim * 100) / 100,
        });
      }
    }
  }

  return candidates;
}

// ── detectMegaNode ────────────────────────────────────────────────────────────

export interface MegaNodeSignal {
  flagged: true;
  reason: "long_lo";
  loWordCount: number;
  loCharCount: number;
}

/**
 * Detects a suspiciously broad MicroNode based on the length of its Learning
 * Objective — the single most reliable deterministic proxy for over-scoping.
 *
 * A standard single-objective Armenian LO is typically 10–25 words / <140 chars.
 * Thresholds (conservative to avoid false positives):
 *   - word count > 35
 *   - OR character count > 200
 *
 * Returns a signal object, or null when no signal is detected.
 * Does NOT call AI; does NOT auto-split the node.
 */
export function detectMegaNode(
  learningObjective: string | null | undefined,
): MegaNodeSignal | null {
  if (!learningObjective) return null;
  const lo = learningObjective.trim();
  if (lo.length === 0) return null;

  const loWordCount = lo.split(/\s+/).filter(Boolean).length;
  const loCharCount  = lo.length;

  if (loWordCount > 35 || loCharCount > 200) {
    return { flagged: true, reason: "long_lo", loWordCount, loCharCount };
  }
  return null;
}

// ── Token utilities ───────────────────────────────────────────────────────────

/**
 * Armenian and English stop words to exclude from similarity computation.
 * These are high-frequency words that carry no semantic content for this comparison.
 */
const STOPWORDS = new Set([
  // Armenian
  "ուuanołə", "karoɫ", "e", "ev", "du", "yev", "vor", "kam", "u", "im", "qo",
  "na", "men", "menak", "minchev", "ays", "ayd", "or", "ov", "inchpes", "erb",
  "bayts", "es", "da", "sа", "bolor", "mi", "her", "nor", "isk",
  // English
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "with", "by",
  "and", "or", "is", "are", "can", "be", "its", "their", "this", "that",
  "student", "can", "using", "use", "each", "all", "from",
  // Armenian common particles (transliterated approximations for safety)
  "ownacel", "karo", "xndrel",
]);

/** Splits an LO into normalized content-bearing tokens. */
function contentTokens(lo: string): Set<string> {
  return new Set(
    lo
      .toLowerCase()
      .replace(/[,;:.!?()»«"'[\]{}\-]/g, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B| */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) { if (b.has(t)) intersection++; }
  const union = a.size + b.size - intersection;
  return intersection / union;
}
