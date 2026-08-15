/**
 * V2-R2 Intent Router
 *
 * Classifies incoming student messages before they enter answer evaluation.
 *
 * Stage A  — deterministic phrase matching (no AI call).
 * Stage B  — AI classification for ambiguous ANSWER / CLARIFY / OFF_TOPIC cases.
 *
 * The same surface message can map to different intents depending on session
 * state (hasActiveTask, teachingStage, introConfirmed), so the full context
 * must be supplied on every call.
 *
 * IMPORTANT: this module must never write to the DB, advance session state,
 * or produce evidence.  It is a pure classification layer.
 */

import { callAI } from "./ai.js";
import { logger as baseLogger } from "../lib/logger.js";

const logger = baseLogger.child({ module: "intentRouter" });

// ── Public types ──────────────────────────────────────────────────────────────

export type IntentClass =
  | "ANSWER"
  | "READY"
  | "CONTINUE"
  | "HELP"
  | "CONFUSED"
  | "REPEAT"
  | "CLARIFY"
  | "OFF_TOPIC"
  | "OTHER";

export interface IntentContext {
  /** Current teaching stage: THEORY | MICRO_CHECK | EXERCISE | VERIFIED | null */
  teachingStage: string | null;
  /** True when the backend has an open assessable task for this student */
  hasActiveTask: boolean;
  /** Whether the student has confirmed the lesson intro */
  introConfirmed: boolean;
  /** The last question asked (used in Stage B prompt) */
  lastQuestionAsked: string | null;
  /** Active task provenance ("micro_check" | "source_exercise" | null) */
  activeTaskProvenance: string | null;
}

export interface IntentResult {
  intent: IntentClass;
  /** 0–1: 1.0 = deterministic, 0.8 = AI-classified, 0.5 = fallback */
  confidence?: number;
  /** Short human-readable rationale for logging/debugging only */
  reason?: string;
}

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * General input normalization: lowercase, trim, collapse whitespace,
 * strip trailing Armenian/Latin punctuation.
 * Does NOT substitute Armenian letters — use normalizeForOk() for that.
 */
function normalizeInput(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    // Strip trailing Armenian stop/comma/exclamation/question/ellipsis punctuation
    .replace(/[.,;!?։\u0589\u055b\u055c\u055d\u055e\u055f…]+$/g, "")
    .trim();
}

/**
 * Additional normalization for "ok" variant detection only.
 * Converts Armenian/Cyrillic O-lookalikes → Latin "o"
 * and Armenian/Cyrillic K-lookalikes → Latin "k".
 * Use only for === "ok" comparisons, not general matching.
 */
function normalizeForOk(s: string): string {
  return normalizeInput(s)
    .replace(/[\u0585\u0555\u041e\u043e]/g, "o") // Օ/օ Ого/о → o
    .replace(/[\u056f\u043a]/g, "k");              // կ/к → k
}

// ── Stage A: Deterministic phrase sets ───────────────────────────────────────
// All phrases stored in lowercase normalizeInput() form.

/** READY — acknowledgement / start signal */
const READY_EXACT = new Set<string>([
  "\u056c\u0561\u057e",                              // լav (good)
  "\u057a\u0561\u057f\u0580\u0561\u057d\u057f",      // պatrasт (ready)
  "\u057a\u0561\u057f\u0580\u0561\u057d\u057f \u0565\u0574", // պatrasт em (I'm ready)
  "ok", "okay", "okey",                              // Latin fallbacks
]);

/** CONTINUE — progression requests */
const CONTINUE_EXACT = new Set<string>([
  // sharunakenkh (let's continue)
  "\u0577\u0561\u0580\u0578\u0582\u0576\u0561\u056f\u0565\u0576\u0584",
  // arts sharunakenkh (come on, let's continue)
  "\u0561\u0580\u056b \u0577\u0561\u0580\u0578\u0582\u0576\u0561\u056f\u0565\u0576\u0584",
  // antsnenq araj (let's move forward)
  "\u0561\u0576\u0581\u0576\u0565\u0576\u0584 \u0561\u057c\u0561\u057b",
  // hajordhy (the next one)
  "\u0570\u0561\u057b\u0578\u0580\u0564\u0568",
  "continue", "next",
]);

/** HELP — explicit help requests */
const HELP_EXACT = new Set<string>([
  // ogni (help! — verb)
  "\u0585\u0563\u0576\u056b",
  // ognutyun (help — noun)
  "\u0585\u0563\u0576\u0578\u0582\u0569\u0575\u0578\u0582\u0576",
  // hushum tur (give a hint)
  "\u0570\u0578\u0582\u0577\u0578\u0582\u0574 \u057f\u0578\u0582\u0580",
  // hushum (hint)
  "\u0570\u0578\u0582\u0577\u0578\u0582\u0574",
  "help",
]);

/** CONFUSED — I don't know / I can't / you say it */
const CONFUSED_EXACT = new Set<string>([
  // chgidem (I don't know)
  "\u0579\u0563\u056b\u057f\u0565\u0574",
  // chem karogh (I can't)
  "\u0579\u0565\u0574 \u056f\u0561\u0580\u0578\u0572",
  // du asa (you say it)
  "\u0564\u0578\u0582 \u0561\u057d\u0561",
  // chem hasganum (I don't understand)
  "\u0579\u0565\u0574 \u0570\u0561\u057d\u056f\u0561\u0576\u0578\u0582\u0574",
]);

/** REPEAT — repeat / rephrase current explanation */
const REPEAT_EXACT = new Set<string>([
  // krkni (repeat)
  "\u056f\u0580\u056f\u0576\u056b",
  // norics asa (say again)
  "\u0576\u0578\u0580\u056b\u0581 \u0561\u057d\u0561",
  // krkin batsatri (explain again)
  "\u056f\u0580\u056f\u056b\u0576 \u0562\u0561\u0581\u0561\u057f\u0580\u056b",
  // norics batsatri (explain again)
  "\u0576\u0578\u0580\u056b\u0581 \u0562\u0561\u0581\u0561\u057f\u0580\u056b",
  // krkin (again)
  "\u056f\u0580\u056f\u056b\u0576",
  // norics (again) — short form
  "\u0576\u0578\u0580\u056b\u0581",
  "repeat",
]);

// ── Stage A: classifier ───────────────────────────────────────────────────────

function classifyDeterministic(
  normalized: string,
  normalizedOk: string,
  _ctx: IntentContext
): IntentResult | null {
  // READY — "ok" variants (after lookalike substitution) or known affirmative phrases
  if (normalizedOk === "ok" || READY_EXACT.has(normalized)) {
    return { intent: "READY", confidence: 1, reason: "deterministic:ready_phrase" };
  }

  // CONTINUE
  if (CONTINUE_EXACT.has(normalized)) {
    return { intent: "CONTINUE", confidence: 1, reason: "deterministic:continue_phrase" };
  }

  // HELP
  if (HELP_EXACT.has(normalized)) {
    return { intent: "HELP", confidence: 1, reason: "deterministic:help_phrase" };
  }

  // CONFUSED
  if (CONFUSED_EXACT.has(normalized)) {
    return { intent: "CONFUSED", confidence: 1, reason: "deterministic:confused_phrase" };
  }

  // REPEAT
  if (REPEAT_EXACT.has(normalized)) {
    return { intent: "REPEAT", confidence: 1, reason: "deterministic:repeat_phrase" };
  }

  return null; // needs Stage B
}

// ── Stage B: AI classifier ────────────────────────────────────────────────────

async function classifyWithAI(
  rawMessage: string,
  ctx: IntentContext
): Promise<IntentResult> {
  const taskLine = ctx.lastQuestionAsked
    ? `Active task: "${ctx.lastQuestionAsked.slice(0, 200)}"`
    : ctx.hasActiveTask
    ? "There is an active assessable task (no question text available)."
    : "No active task.";

  const stageLine = ctx.teachingStage ? `Teaching stage: ${ctx.teachingStage}.` : "";

  const systemPrompt = [
    "You are an intent classifier for an Armenian AI teacher.",
    "Output ONLY a JSON object with a single field — nothing else.",
    "",
    "Classify the student message into one intent:",
    "  ANSWER   — a genuine attempt to answer the active assessable task",
    "  CLARIFY  — a question or clarification request about the current topic/task",
    "  OFF_TOPIC — a request about a different lesson/topic entirely",
    "",
    stageLine,
    taskLine,
    "",
    'Respond with EXACTLY one of: {"intent":"ANSWER"} {"intent":"CLARIFY"} {"intent":"OFF_TOPIC"}',
  ].filter(Boolean).join("\n");

  try {
    const raw = await callAI(
      [{ role: "user" as const, content: rawMessage }],
      systemPrompt
    );
    const m = raw.trim().match(/"intent"\s*:\s*"(ANSWER|CLARIFY|OFF_TOPIC)"/);
    if (m) {
      return { intent: m[1] as IntentClass, confidence: 0.8, reason: "ai_classification" };
    }
    logger.warn(
      { raw: raw.slice(0, 120) },
      "V2-R2: AI classifier returned unparseable output — defaulting to ANSWER"
    );
    return { intent: "ANSWER", confidence: 0.5, reason: "ai_fallback_parse_error" };
  } catch (err) {
    logger.warn({ err }, "V2-R2: AI classifier call failed — defaulting to ANSWER");
    return { intent: "ANSWER", confidence: 0.5, reason: "ai_fallback_error" };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a student message into an IntentClass.
 *
 * Stage A (deterministic) is tried first — no AI call for obvious signals.
 * Stage B (AI) disambiguates ANSWER vs CLARIFY vs OFF_TOPIC when Stage A
 * returns null.
 *
 * Intent is state-aware: always supply the full IntentContext.
 * The same "ok" means READY during intro, NOT_ANSWER during an active task.
 */
export async function classifyIntent(
  rawMessage: string,
  ctx: IntentContext
): Promise<IntentResult> {
  const normalized   = normalizeInput(rawMessage);
  const normalizedOk = normalizeForOk(rawMessage);

  // Stage A — no AI call needed
  const det = classifyDeterministic(normalized, normalizedOk, ctx);
  if (det) return det;

  // Stage B — AI for ambiguous ANSWER / CLARIFY / OFF_TOPIC
  return classifyWithAI(rawMessage, ctx);
}

// ── Exported phrase sets (for tests) ─────────────────────────────────────────
export const _test = {
  normalizeInput,
  normalizeForOk,
  READY_EXACT,
  CONTINUE_EXACT,
  HELP_EXACT,
  CONFUSED_EXACT,
  REPEAT_EXACT,
};
