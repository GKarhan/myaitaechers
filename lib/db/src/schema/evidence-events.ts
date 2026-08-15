import { pgTable, serial, integer, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { lessonSessionsTable } from "./lesson-sessions";
import { knowledgeNodesTable } from "./knowledge-nodes";

export const evidenceEventsTable = pgTable("evidence_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  lessonSessionId: integer("lesson_session_id")
    .references(() => lessonSessionsTable.id, { onDelete: "cascade" }),
  topicId: integer("topic_id")
    .references(() => knowledgeNodesTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  wasCorrect: boolean("was_correct"),
  responseTimeMs: integer("response_time_ms"),
  hintUsed: boolean("hint_used").notNull().default(false),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // ── Phase 2A — Confidence V2 Readiness Fields ────────────────────────────
  //
  // All three columns are NULLABLE and backward-compatible.
  // Every existing evidence row has NULL in these fields — that is correct.
  //
  // Old evidence remains valid for mastery scoring (wasCorrect / hintUsed /
  // responseTimeMs are still consumed by scoring.ts). However, old evidence
  // is NOT cognitive-depth evidence; it cannot be used to claim a learner
  // has demonstrated a specific Bloom level.
  //
  // STRICT RULE: DO NOT retroactively infer or backfill cognitive levels for
  // historical evidence rows. null = "recorded before Phase 2A or task has
  // no cognitive annotation" — not an error condition.
  //
  // Future evidence pipelines (quiz submit, chat.ts) will populate these
  // at insert time from the associated task's cognitive annotation.
  //
  // ── cognitiveLevel ───────────────────────────────────────────────────────
  // The Bloom level the task was DESIGNED to assess (not inferred afterward).
  // Allowed: remember | understand | apply | analyze | evaluate | create | null
  //
  // NOTE: cognitive level ≠ difficulty ≠ interaction format.
  // A HIGH-difficulty recall task has cognitiveLevel = 'remember'.
  // A LOW-difficulty apply task  has cognitiveLevel = 'apply'.
  // Never derive cognitiveLevel from difficulty_level or vice versa.
  //
  // ── taskDifficulty ───────────────────────────────────────────────────────
  // The difficulty of the specific task that produced this evidence event.
  // Allowed: LOW | MEDIUM | HIGH | null
  // Populated from quiz_questions.difficulty_level or lesson_exercises.difficulty_level
  // at evidence insert time (stored here so it remains stable even if the
  // question is later edited).
  //
  // ── assistanceLevel ──────────────────────────────────────────────────────
  // How much help the learner received during this evidence event.
  // Allowed: none | hint | scaffolded | ai_assisted | null
  // Used by future Confidence V2 to weight the independence of evidence.
  // 'none'        → learner answered without any assistance
  // 'hint'        → a hint was offered/used (maps to hintUsed = true)
  // 'scaffolded'  → partial worked example or step-by-step guidance provided
  // 'ai_assisted' → AI Teacher actively helped formulate or correct the answer
  //
  cognitiveLevel:  text("cognitive_level"),
  taskDifficulty:  text("task_difficulty"),
  assistanceLevel: text("assistance_level"),
});

export const insertEvidenceEventSchema = createInsertSchema(evidenceEventsTable).omit({ id: true, createdAt: true });
export type InsertEvidenceEvent = z.infer<typeof insertEvidenceEventSchema>;
export type EvidenceEvent = typeof evidenceEventsTable.$inferSelect;
