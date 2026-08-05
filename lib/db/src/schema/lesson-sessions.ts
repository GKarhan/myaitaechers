import { pgTable, text, serial, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
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
  // Per-session node-progress counters (moved from lessonNodesTable so each student
  // has their own progress state instead of a shared row on the curriculum node).
  nodeMasteryEvidenceCount: integer("node_mastery_evidence_count").notNull().default(0),
  nodeConsecutiveCorrect: integer("node_consecutive_correct").notNull().default(0),
  nodeConsecutiveIncorrect: integer("node_consecutive_incorrect").notNull().default(0),
  nodeLastEvidenceQuality: text("node_last_evidence_quality"),
  nodeTeachingStage: text("node_teaching_stage").notNull().default("THEORY"),
  // Phase 1 early-exit: consecutive correct review answers in the current Phase 1 run
  phase1ConsecutiveCorrect: integer("phase1_consecutive_correct").notNull().default(0),
  // Deterministic lesson intro gate: false = intro not yet confirmed by student
  introConfirmed: boolean("intro_confirmed").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertLessonSessionSchema = createInsertSchema(lessonSessionsTable).omit({ id: true, startedAt: true });
export type InsertLessonSession = z.infer<typeof insertLessonSessionSchema>;
export type LessonSession = typeof lessonSessionsTable.$inferSelect;
