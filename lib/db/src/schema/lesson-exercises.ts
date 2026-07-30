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
});

export const insertLessonExerciseSchema = createInsertSchema(lessonExercisesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLessonExercise = z.infer<typeof insertLessonExerciseSchema>;
export type LessonExercise = typeof lessonExercisesTable.$inferSelect;
