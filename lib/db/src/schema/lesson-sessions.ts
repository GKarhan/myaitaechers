import { pgTable, text, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { lessonsTable } from "./lessons";
import { lessonNodesTable } from "./lesson-nodes";

export const lessonSessionsTable = pgTable("lesson_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessonsTable.id, { onDelete: "cascade" }),
  currentPhase: integer("current_phase").notNull().default(1),
  status: text("status").notNull().default("active"),
  masteryScore: integer("mastery_score"),
  currentNodeId: integer("current_node_id")
    .references(() => lessonNodesTable.id, { onDelete: "set null" }),
  nodeStartedAt: timestamp("node_started_at", { withTimezone: true }),
  // P0: how many AI turns have been spent on the current node/phase (safety cap)
  nodeAttemptCount: integer("node_attempt_count").notNull().default(0),
  // P7 Node Lock: last question asked in this session (for redirect canned reply)
  lastQuestionAsked: text("last_question_asked"),
  // P7 Question dedup: list of question-template abstracts used in current node
  askedQuestionTemplates: jsonb("asked_question_templates")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  // P8 Phase 1: how many review questions have been asked (separate from nodeAttemptCount)
  reviewQuestionCount: integer("review_question_count").notNull().default(0),
  // P8 Phase 3: index of next exercise to present in deep-dive phase
  deepDiveExerciseIndex: integer("deep_dive_exercise_index").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertLessonSessionSchema = createInsertSchema(lessonSessionsTable).omit({ id: true, startedAt: true });
export type InsertLessonSession = z.infer<typeof insertLessonSessionSchema>;
export type LessonSession = typeof lessonSessionsTable.$inferSelect;
