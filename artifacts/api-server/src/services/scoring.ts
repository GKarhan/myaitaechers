import { db, evidenceEventsTable, knowledgeNodesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { scheduleReview } from "./review-schedule";

/**
 * Scoring Engine — MVP Implementation Profile (Scoring_Engine_Specification_v1_0, Section 24)
 *
 * This module computes P (Performance Conditions), L (Learning Process Fit),
 * R (Retention), and K (Learning Efficiency Index = P × L × R) for a single
 * knowledge_nodes topic, using the raw evidence_events recorded for it.
 *
 * IMPORTANT — honest limitations of this MVP, beyond the spec's own MVP
 * simplifications:
 *
 * 1. R (Retention) requires at least one *delayed* review (Section 24.3.3).
 *    Spaced-repetition / review scheduling (review_schedule table) does not
 *    exist yet in this codebase — that is the next phase of work. Until it
 *    exists, there is no delayed-review evidence to compute R from, so R and
 *    (per Section 24.3.4) K will correctly remain `null` (NOT_ASSESSED /
 *    INSUFFICIENT_DATA). This is the spec-defined default, not a shortcut.
 *
 * 2. evidence_events currently only records: wasCorrect, responseTimeMs,
 *    hintUsed. It does not yet record pauses, independent classification
 *    tasks, or transfer tasks. So P and L below are approximated from what
 *    is actually available, using clearly-labeled proxies (see comments on
 *    each component). These proxies should be replaced with the fuller
 *    signals described in the spec as those evidence fields are added.
 *
 * 3. Mastery is defined in the spec as Understanding × Application ×
 *    Retention. Since Retention is not yet assessable (point 1), this MVP
 *    computes a *provisional* Mastery from Understanding × Application only,
 *    and marks isProvisional = true. Once review_schedule provides a real
 *    Retention value, Mastery should be recomputed with all three factors.
 */

const BASELINE_RESPONSE_MS = 20_000; // assumed "comfortable" response time
const DEFAULT_SCORE = 0.7; // spec default when data is insufficient (Section 24.3.1 / 24.3.2)

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function variance(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums)!;
  return mean(nums.map((n) => (n - m) ** 2))!;
}

interface EvidenceRow {
  wasCorrect: boolean | null;
  responseTimeMs: number | null;
  hintUsed: boolean;
  createdAt: Date;
}

/** P — Learner State and Performance Conditions (Section 24.3.1). */
function computeP(events: EvidenceRow[]): number {
  const responseTimes = events
    .map((e) => e.responseTimeMs)
    .filter((t): t is number => t !== null);

  if (responseTimes.length === 0) return DEFAULT_SCORE;

  const avgTime = mean(responseTimes)!;
  const attention = clamp01(1 - avgTime / BASELINE_RESPONSE_MS);

  const timeVariance = variance(responseTimes);
  const normalizedVariance = clamp01(timeVariance / (BASELINE_RESPONSE_MS ** 2));
  const workPace = clamp01(1 - normalizedVariance);

  const hintRate = events.filter((e) => e.hintUsed).length / events.length;
  const effortStability = clamp01(1 - hintRate);

  const mid = Math.floor(events.length / 2);
  const firstHalf = events.slice(0, mid);
  const secondHalf = events.slice(mid);
  const errorRate = (arr: EvidenceRow[]) => {
    const graded = arr.filter((e) => e.wasCorrect !== null);
    if (graded.length === 0) return 0;
    return graded.filter((e) => e.wasCorrect === false).length / graded.length;
  };
  const fatigueDelta = errorRate(secondHalf) - errorRate(firstHalf);
  const fatigueResistance = clamp01(1 - Math.max(0, fatigueDelta));

  return (
    0.3 * attention +
    0.25 * workPace +
    0.25 * effortStability +
    0.2 * fatigueResistance
  );
}

/** L — Learning Process Fit (Section 24.3.2). */
function computeL(events: EvidenceRow[]): number {
  const graded = events.filter((e) => e.wasCorrect !== null);
  if (graded.length === 0) return DEFAULT_SCORE;

  const successRate = graded.filter((e) => e.wasCorrect).length / graded.length;
  const difficultyMatch = clamp01(successRate);

  const hintRate = events.filter((e) => e.hintUsed).length / events.length;
  const presentationMatch = clamp01(1 - hintRate);

  const withoutHint = graded.filter((e) => !e.hintUsed);
  const explanationEfficiency =
    withoutHint.length > 0
      ? clamp01(withoutHint.filter((e) => e.wasCorrect).length / withoutHint.length)
      : DEFAULT_SCORE;

  const mid = Math.floor(events.length / 2);
  const firstHalfHintRate =
    events.slice(0, mid).filter((e) => e.hintUsed).length / Math.max(1, mid);
  const secondHalfHintRate =
    events.slice(mid).filter((e) => e.hintUsed).length / Math.max(1, events.length - mid);
  const scaffoldingEfficiency = clamp01(1 - Math.max(0, secondHalfHintRate - firstHalfHintRate));

  const errorRate = (arr: EvidenceRow[]) => {
    const g = arr.filter((e) => e.wasCorrect !== null);
    return g.length ? g.filter((e) => !e.wasCorrect).length / g.length : 0;
  };
  const feedbackEfficiency = clamp01(
    1 - Math.max(0, errorRate(events.slice(mid)) - errorRate(events.slice(0, mid)))
  );

  return (
    0.25 * difficultyMatch +
    0.2 * presentationMatch +
    0.2 * explanationEfficiency +
    0.2 * scaffoldingEfficiency +
    0.15 * feedbackEfficiency
  );
}

/**
 * R — Retention (Section 24.3.3).
 * Requires delayed-review evidence, which does not exist yet
 * (no review_schedule / spaced-repetition mechanism). Correctly returns
 * null (NOT_ASSESSED) until that phase of work is done.
 */
function computeR(): number | null {
  return null;
}

/** K — Learning Efficiency Index (Section 24.3.4): advisory only, null if any input is missing. */
function computeK(p: number | null, l: number | null, r: number | null): number | null {
  if (p === null || l === null || r === null) return null;
  return p * l * r;
}

/**
 * Provisional Mastery: Understanding × Application (Retention factor omitted
 * until it is assessable — see file header, point 3).
 */
function computeProvisionalMastery(events: EvidenceRow[]): number {
  const graded = events.filter((e) => e.wasCorrect !== null);
  if (graded.length === 0) return 0;

  const withoutHint = graded.filter((e) => !e.hintUsed);
  const understanding =
    withoutHint.length > 0
      ? withoutHint.filter((e) => e.wasCorrect).length / withoutHint.length
      : DEFAULT_SCORE;

  const application = graded.filter((e) => e.wasCorrect).length / graded.length;

  return clamp01(understanding * application) * 100;
}

/** Confidence proxy: independence from hints + steadiness of response time. */
function computeConfidence(events: EvidenceRow[]): number {
  const hintRate = events.filter((e) => e.hintUsed).length / events.length;
  const responseTimes = events
    .map((e) => e.responseTimeMs)
    .filter((t): t is number => t !== null);
  const steadiness =
    responseTimes.length > 1
      ? clamp01(1 - variance(responseTimes) / (BASELINE_RESPONSE_MS ** 2))
      : DEFAULT_SCORE;

  return clamp01(0.5 * (1 - hintRate) + 0.5 * steadiness) * 100;
}

/**
 * Recomputes scoring for one knowledge_nodes topic from its evidence_events,
 * and writes the result back to that row. Fire-and-forget safe — never
 * throws; logs and returns on any failure.
 */
export async function updateTopicScoring(topicId: number, userId: number): Promise<void> {
  try {
    const events = await db
      .select({
        wasCorrect: evidenceEventsTable.wasCorrect,
        responseTimeMs: evidenceEventsTable.responseTimeMs,
        hintUsed: evidenceEventsTable.hintUsed,
        createdAt: evidenceEventsTable.createdAt,
      })
      .from(evidenceEventsTable)
      .where(
        and(
          eq(evidenceEventsTable.topicId, topicId),
          eq(evidenceEventsTable.userId, userId),
          eq(evidenceEventsTable.eventType, "answer")
        )
      )
      .orderBy(evidenceEventsTable.createdAt);

    if (events.length === 0) return;

    const p = computeP(events);
    const l = computeL(events);
    const r = computeR();
    const k = computeK(p, l, r); // expected null until review_schedule exists — see file header

    const masteryScore = Math.round(computeProvisionalMastery(events));
    const confidenceScore = Math.round(computeConfidence(events));

    const status =
      masteryScore >= 80 ? "mastered" : masteryScore >= 50 ? "weak" : "not_started";

    await db
      .update(knowledgeNodesTable)
      .set({
        masteryScore,
        confidenceScore,
        retentionScore: r, // stays null until Phase B (review_schedule)
        status,
        isProvisional: true, // Retention factor still missing from Mastery — see file header
        updatedAt: new Date(),
      })
      .where(eq(knowledgeNodesTable.id, topicId));

    logger.info(
      { topicId, userId, p, l, r, k, masteryScore, confidenceScore },
      "scoring engine: topic updated"
    );

    // Schedule (or reschedule) this topic's next spaced-repetition review
    // based on the mastery score we just computed.
    await scheduleReview(topicId, userId, masteryScore);
  } catch (err) {
    logger.error({ err, topicId, userId }, "scoring engine: update failed");
  }
}