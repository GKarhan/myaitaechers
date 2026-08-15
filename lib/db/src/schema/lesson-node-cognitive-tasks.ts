import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonNodeCognitiveLevelsTable } from "./lesson-node-cognitive-levels";
import { lessonExercisesTable } from "./lesson-exercises";

/**
 * Phase 2A — Cognitive Enrichment
 *
 * lesson_node_cognitive_tasks
 *
 * Links exercise/task assets to a specific cognitive level of a MicroNode.
 *
 * ── Design principles ────────────────────────────────────────────────────
 *
 * 1. lesson_exercises is the canonical exercise record.
 *    Exercise text is NEVER duplicated here.
 *
 * 2. This table adds an ANNOTATION:
 *    "This exercise provides evidence for cognitive level X."
 *
 * 3. One cognitive level can have zero or more linked task assets.
 *
 * 4. One exercise cannot be linked more than once to the same cognitive
 *    level (unique constraint on cognitiveLevelId + lessonExerciseId).
 *
 * 5. AI-generated variants link back to their seed via seedExerciseId.
 *    AI material must NEVER be presented as textbook material.
 *
 * ── Task provenance values ────────────────────────────────────────────────
 *   source_derived  → exercise comes from the textbook
 *                     (lessonExerciseId should be set)
 *   ai_generated    → AI-generated equivalent variant
 *                     (seedExerciseId records the source seed)
 *   teacher_authored → teacher manually created
 *
 * ── AI-equivalent variant contract ───────────────────────────────────────
 * A textbook exercise may serve as a SEED TASK.
 * AI-generated variants MUST:
 *   - assess the same MicroNode and cognitive level
 *   - assess the same performance objective
 *   - preserve the same underlying cognitive demand
 *   - use different data / examples / context
 *   - NOT simply paraphrase the same answer
 *   - NOT change the difficulty or cognitive demand
 *
 * The future task-generation system uses minimumIndependentEvidence
 * (on the parent cognitive-level row) to determine how many variants to
 * generate: missing = minimum - existing source tasks.
 *
 * ── Three separate dimensions (MUST NOT be conflated) ────────────────────
 *   A. Cognitive demand  (from parent lesson_node_cognitive_levels row)
 *   B. Task difficulty   (from lesson_exercises.difficulty_level)
 *   C. Interaction format (from parent preferredInteractionTypes)
 * None of these may be derived automatically from the others.
 */
export const lessonNodeCognitiveTasksTable = pgTable(
  "lesson_node_cognitive_tasks",
  {
    id: serial("id").primaryKey(),

    // FK to the parent cognitive-level row.
    // CASCADE: removing a cognitive level removes its task annotations.
    cognitiveLevelId: integer("cognitive_level_id")
      .notNull()
      .references(() => lessonNodeCognitiveLevelsTable.id, { onDelete: "cascade" }),

    // FK to the canonical exercise record in lesson_exercises.
    // NULL is allowed:
    //   - for future AI-generated tasks not yet stored in lesson_exercises
    //   - for teacher-authored tasks tracked externally
    // For textbook tasks (taskProvenance = source_derived), this MUST be set.
    lessonExerciseId: integer("lesson_exercise_id")
      .references(() => lessonExercisesTable.id, { onDelete: "set null" }),

    // source_derived | ai_generated | teacher_authored
    // RULE: ai_generated tasks must NEVER be presented as source_derived.
    taskProvenance: text("task_provenance").notNull().default("source_derived"),

    // For ai_generated variants: the lesson_exercises.id of the seed/source
    // exercise that this variant was derived from.
    // Preserves lineage for traceability and curriculum auditing.
    // NULL for textbook and teacher-authored tasks.
    seedExerciseId: integer("seed_exercise_id")
      .references(() => lessonExercisesTable.id, { onDelete: "set null" }),

    // Free-form annotation — e.g. "variant 2: same skill with values 15/7",
    // or a short rationale for why this exercise was chosen for this level.
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Fast lookup of all tasks for a cognitive level
    index("lnct_cognitive_level_idx").on(t.cognitiveLevelId),

    // Prevent duplicate linkage of the same exercise to the same cognitive level.
    // PostgreSQL treats NULLs as distinct in unique indexes, so rows with
    // lessonExerciseId = NULL are not deduplicated (supports multiple AI variants
    // not yet linked to a lesson_exercises row).
    unique("lnct_level_exercise_uniq").on(t.cognitiveLevelId, t.lessonExerciseId),
  ]
);

export const insertLessonNodeCognitiveTaskSchema = createInsertSchema(
  lessonNodeCognitiveTasksTable
).omit({ id: true, createdAt: true });
export type InsertLessonNodeCognitiveTask = z.infer<
  typeof insertLessonNodeCognitiveTaskSchema
>;
export type LessonNodeCognitiveTask =
  typeof lessonNodeCognitiveTasksTable.$inferSelect;
