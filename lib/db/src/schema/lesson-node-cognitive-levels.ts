import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonNodesTable } from "./lesson-nodes";

/**
 * Phase 2A — Cognitive Enrichment
 *
 * lesson_node_cognitive_levels
 * One row per (MicroNode × applicable cognitive level).
 *
 * This table describes CURRICULUM cognitive structure only.
 * It carries NO learner-specific data.
 *
 * ── Cognitive Level values (revised Bloom, 2001) ────────────────────────
 *   remember   → recall / recognise facts
 *   understand → explain, classify, paraphrase
 *   apply      → use concept in a new situation / solve a problem
 *   analyze    → break down, compare, differentiate
 *   evaluate   → judge, critique, justify
 *   create     → design, construct, produce
 *
 * Not every MicroNode requires all six levels.
 * Definition-type MicroNode: remember → understand
 * Procedural MicroNode:      remember → understand → apply
 * Analytical MicroNode:      remember → understand → apply → analyze
 *
 * ── Provenance values ───────────────────────────────────────────────────
 *   source_derived  → level/objective inferred directly from textbook content
 *   teacher_authored → teacher manually set or edited
 *   ai_generated     → produced by Phase 2A AI enrichment pipeline
 *
 * ── Target Ceiling ──────────────────────────────────────────────────────
 * Exactly one applicable level should have isTargetCeiling = true.
 * This is the highest cognitive demand the curriculum expects the learner
 * to demonstrate for this MicroNode.
 *
 * ── Backward compatibility with lesson_nodes.target_bloom_level ─────────
 * lesson_nodes.target_bloom_level is the legacy integer (1=remember…6=create).
 * When a MicroNode is cognitively enriched, the enrichment writer MUST keep
 * target_bloom_level in sync using COGNITIVE_LEVEL_TO_BLOOM_INT so that all
 * existing consumers (AI Teacher prompt, quiz evidence pipeline, KT API,
 * frontend) remain correct. lesson_node_cognitive_levels.isTargetCeiling is
 * the canonical field for all new Phase 2A consumers. The integer on
 * lesson_nodes is a derived copy and must never be updated independently.
 *
 * ── Interaction format vs cognitive demand ───────────────────────────────
 * preferredInteractionTypes lists formats suitable for evidence tasks at this
 * level. Format and cognitive demand are SEPARATE dimensions — do not infer
 * one from the other. A multiple-choice question may still assess Apply if
 * the learner independently solved a novel problem before selecting.
 *
 * Allowed interaction type values:
 *   multiple_choice | multi_select | true_false | matching | classification |
 *   ordering | numeric_answer | short_answer | constructed_response |
 *   problem_solving
 *
 * ── Minimum independent evidence ────────────────────────────────────────
 * minimumIndependentEvidence is a curriculum design target — how many
 * independent evidence opportunities should normally be available for this
 * level. It is NOT a confidence formula input.
 * 3 correct tasks ≠ 100% confidence; future Confidence V2 considers
 * additional factors (strength, diversity, assistance, temporal stability).
 *
 * ── Three separate dimensions (MUST NOT be conflated) ───────────────────
 *   A. Cognitive demand  (this table: cognitiveLevel)
 *   B. Task difficulty   (lesson_exercises.difficulty_level, quiz_questions.difficulty_level)
 *   C. Interaction format (preferredInteractionTypes)
 */
export const lessonNodeCognitiveLevelsTable = pgTable(
  "lesson_node_cognitive_levels",
  {
    id: serial("id").primaryKey(),

    // FK to the parent MicroNode. CASCADE: removing a node removes its cognitive path.
    lessonNodeId: integer("lesson_node_id")
      .notNull()
      .references(() => lessonNodesTable.id, { onDelete: "cascade" }),

    // One of: remember | understand | apply | analyze | evaluate | create
    // Repository convention: text column with documented allowed values,
    // consistent with difficulty_level, status, block_type, etc.
    cognitiveLevel: text("cognitive_level").notNull(),

    // Determines the cognitive path order within this MicroNode.
    // Lower sequence = earlier in the learning progression.
    // Two rows for the same MicroNode must not share the same sequence.
    sequence: integer("sequence").notNull(),

    // Whether this level is part of the applicable path for this MicroNode.
    // true  → included in the learning progression
    // false → formally excluded (exists as a record but not expected of learner)
    isApplicable: boolean("is_applicable").notNull().default(true),

    // The highest cognitive demand the curriculum expects the learner to
    // demonstrate for this MicroNode. Exactly one row per enriched MicroNode
    // should have isTargetCeiling = true (enforced in application code).
    isTargetCeiling: boolean("is_target_ceiling").notNull().default(false),

    // What the learner should be able to DO at this cognitive level.
    // Must be concrete and observable (starts with an action verb).
    // Example: "Ուսանողը կարող է սեփական բառերով բացատրել, թե ինչ է
    //   մոլեկուլը և ինչ կապ ունի այն նյութի հատկությունների հետ։"
    // Bad:  "Understand molecules."
    // Good: the Armenian example above.
    performanceObjective: text("performance_objective"),

    // What counts as acceptable evidence at this cognitive level.
    // This is curriculum/evidence-design metadata — NOT the learner's score.
    // Example (apply): "uses the concept correctly in an appropriate new problem."
    successCriterion: text("success_criterion"),

    // source_derived | teacher_authored | ai_generated
    provenance: text("provenance").notNull().default("ai_generated"),

    // Curriculum design target: how many independent evidence opportunities
    // should normally be available/required for this cognitive level.
    // Minimum: 1. Default: 3 (common pedagogical standard for Apply+).
    // NOT a confidence formula — it is evidence-design metadata only.
    minimumIndependentEvidence: integer("minimum_independent_evidence")
      .notNull()
      .default(3),

    // JSON array of preferred interaction formats for evidence tasks at this level.
    // Empty array = no preference specified.
    // Allowed values: multiple_choice | multi_select | true_false | matching |
    //   classification | ordering | numeric_answer | short_answer |
    //   constructed_response | problem_solving
    // IMPORTANT: interaction format ≠ cognitive demand (see header comment).
    preferredInteractionTypes: jsonb("preferred_interaction_types")
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // No duplicate cognitive levels per MicroNode
    uniqueIndex("lncl_node_level_uidx").on(t.lessonNodeId, t.cognitiveLevel),

    // No duplicate sequences per MicroNode (makes path order unambiguous)
    uniqueIndex("lncl_node_sequence_uidx").on(t.lessonNodeId, t.sequence),

    // Fast lookup of all levels for a given node
    index("lncl_lesson_node_idx").on(t.lessonNodeId),

    // At-most-one target ceiling per MicroNode (DB-enforced).
    // The enrichment writer is responsible for ensuring exactly-one
    // ceiling exists when enriching a node (clear old ceiling before
    // setting a new one, or set isTargetCeiling transactionally).
    uniqueIndex("lncl_ceiling_per_node_uidx")
      .on(t.lessonNodeId)
      .where(sql`${t.isTargetCeiling} = true`),

    // Canonical cognitive level values (revised Bloom 2001)
    check(
      "lncl_cognitive_level_chk",
      sql`${t.cognitiveLevel} IN ('remember','understand','apply','analyze','evaluate','create')`,
    ),

    // Canonical provenance values
    check(
      "lncl_provenance_chk",
      sql`${t.provenance} IN ('source_derived','teacher_authored','ai_generated')`,
    ),

    // Evidence-count lower bound
    check(
      "lncl_min_evidence_chk",
      sql`${t.minimumIndependentEvidence} >= 1`,
    ),
  ]
);

export const insertLessonNodeCognitiveLevelSchema = createInsertSchema(
  lessonNodeCognitiveLevelsTable,
  {
    // Enforce canonical domain values at the Zod layer in addition to DB CHECK
    cognitiveLevel: z.enum(["remember", "understand", "apply", "analyze", "evaluate", "create"]),
    provenance: z.enum(["source_derived", "teacher_authored", "ai_generated"]),
    minimumIndependentEvidence: z.number().int().min(1).optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLessonNodeCognitiveLevel = z.infer<
  typeof insertLessonNodeCognitiveLevelSchema
>;
export type LessonNodeCognitiveLevel =
  typeof lessonNodeCognitiveLevelsTable.$inferSelect;

// ── Domain constants ──────────────────────────────────────────────────────────

/** Canonical ordered list of cognitive levels (Phase 2A, revised Bloom 2001). */
export const COGNITIVE_LEVELS = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;
export type CognitiveLevel = (typeof COGNITIVE_LEVELS)[number];

/** Allowed provenance values for cognitive enrichment rows. */
export const COGNITIVE_PROVENANCE_VALUES = [
  "source_derived",
  "teacher_authored",
  "ai_generated",
] as const;
export type CognitiveProvenance = (typeof COGNITIVE_PROVENANCE_VALUES)[number];

/** Allowed interaction format types for preferredInteractionTypes. */
export const INTERACTION_TYPE_VALUES = [
  "multiple_choice",
  "multi_select",
  "true_false",
  "matching",
  "classification",
  "ordering",
  "numeric_answer",
  "short_answer",
  "constructed_response",
  "problem_solving",
] as const;
export type InteractionType = (typeof INTERACTION_TYPE_VALUES)[number];

/**
 * Maps cognitive level name → Bloom integer (1-based) for backward
 * compatibility with lesson_nodes.target_bloom_level.
 *
 * When writing isTargetCeiling = true, also write this integer to
 * lesson_nodes.target_bloom_level so existing consumers stay correct.
 *
 * DO NOT derive cognitive meaning from the integer alone — always use
 * the canonical cognitiveLevel string for Phase 2A logic.
 */
export const COGNITIVE_LEVEL_TO_BLOOM_INT: Record<CognitiveLevel, number> = {
  remember:  1,
  understand: 2,
  apply:     3,
  analyze:   4,
  evaluate:  5,
  create:    6,
};
