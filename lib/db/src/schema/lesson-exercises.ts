import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonsTable } from "./lessons";
import { lessonNodesTable } from "./lesson-nodes";

// P1 STEP 17 — Textbook Exercise Map
// Stores exercises in a structured, queryable form so chat.ts can fetch
// verbatim textbook text for the current node and pass it to the AI.
export const lessonExercisesTable = pgTable("lesson_exercises", {
  id: serial("id").primaryKey(),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessonsTable.id, { onDelete: "cascade" }),
  exerciseId: text("exercise_id").notNull(),            // e.g. "EX-67-2"
  sourcePage: text("source_page"),
  exerciseTextVerbatim: text("exercise_text_verbatim").notNull(), // word-for-word from textbook
  exercisePurpose: text("exercise_purpose"),             // CONCEPT_DISCOVERY | GUIDED_PRACTICE | ... | AI_ADAPTED
  relatedNodeId: integer("related_node_id")
    .references(() => lessonNodesTable.id, { onDelete: "set null" }),
  successCriteria: text("success_criteria"),
  difficultyLevel: text("difficulty_level"),             // LOW | MEDIUM | HIGH
  assignment: text("assignment"),                        // CLASS | HOMEWORK
  sequence: integer("sequence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // ── Authoring provenance & review fields (mirrors lesson_nodes pattern) ─
  // 0-based index into the Pass-1 blocks[] array that produced this exercise.
  // Populated for all exercises created by the mapping pipeline (both MicroNode-linked
  // and additionalExercises). NULL on manually-created exercises (no Pass-1 source).
  // Enables MAPPING → SOURCE traceability: join with mapping_jobs.result->>'pass1Blocks'
  // using this index to recover the original blockType / sourceText / page metadata.
  sourceBlockIndex: integer("source_block_index"),
  // Origin of this exercise: "textbook" (extracted) | "ai_generated" (created by AI).
  sourceType: text("source_type").notNull().default("textbook"),
  // Verbatim passage from the textbook this exercise is based on
  // (distinct from exerciseTextVerbatim which is the exercise itself).
  sourceText: text("source_text"),
  // AI confidence 0–100 in the extraction/classification (nullable).
  confidenceScore: integer("confidence_score"),
  // Authoring lifecycle: "draft" → "reviewed" → "approved"
  status: text("status").notNull().default("draft"),
});

export const insertLessonExerciseSchema = createInsertSchema(lessonExercisesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLessonExercise = z.infer<typeof insertLessonExerciseSchema>;
export type LessonExercise = typeof lessonExercisesTable.$inferSelect;
