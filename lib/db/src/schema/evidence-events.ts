import { pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { lessonSessionsTable } from "./lesson-sessions";
import { knowledgeNodesTable } from "./knowledge-nodes";
import { lessonExercisesTable } from "./lesson-exercises";
import { lessonNodeCognitiveLevelsTable } from "./lesson-node-cognitive-levels";
import { lessonNodesTable } from "./lesson-nodes";
import { quizAttemptsTable, quizQuestionsTable } from "./quizzes";

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

  // ── assistanceLevel ──────────────────────────────────────────────────────
  // Phase 2B semantics (supersedes old comment):
  // none     → no help used
  // light    → level-1 hint used
  // moderate → level-2 hint used
  // guided   → level-3 step-by-step used
  // revealed → level-4 answer reveal used
  assistanceLevel: text("assistance_level"),

  // ── Phase 2B Round 2 additions ───────────────────────────────────────────
  // All nullable and backward-compatible. Old rows have null — that is correct.

  // Stable identity of the source exercise that produced this evidence.
  // null = AI MICRO_CHECK (no source exercise) or quiz question with no source link.
  lessonExerciseId: integer("lesson_exercise_id")
    .references(() => lessonExercisesTable.id, { onDelete: "set null" }),

  // The ACTUAL interaction format the learner used (not merely the preferred format).
  // Examples: multiple_choice | true_false | classification | short_answer | numeric_answer
  interactionType: text("interaction_type"),

  // Which attempt number on this same task (1-based). Allows distinguishing repeated
  // attempts on the identical task for independence-of-evidence evaluation.
  attemptSequence: integer("attempt_sequence"),

  // Number of help events (help_events rows) that occurred before this answer.
  // 0 = no help used. Combined with assistance_level for Confidence V2.
  helpCount: integer("help_count").notNull().default(0),

  // ── C3 — Trustworthy qualifying-evidence identity ─────────────────────────
  // Nullable for historical compatibility. New evidence that is allowed to
  // count toward a Cognitive Level must populate the normalized IDs and the
  // qualification state; legacy rows deliberately remain null/legacy.
  lessonNodeId: integer("lesson_node_id")
    .references(() => lessonNodesTable.id, { onDelete: "set null" }),
  cognitiveLevelId: integer("cognitive_level_id")
    .references(() => lessonNodeCognitiveLevelsTable.id, { onDelete: "set null" }),
  quizQuestionId: integer("quiz_question_id")
    .references(() => quizQuestionsTable.id, { onDelete: "set null" }),
  quizAttemptId: integer("quiz_attempt_id")
    .references(() => quizAttemptsTable.id, { onDelete: "cascade" }),

  // Typed source of the answerable task, e.g. micro_check, source_exercise,
  // quiz_question. This is intentionally distinct from interactionType.
  taskSource: text("task_source"),
  // Immutable opaque reference created when a task is activated. It survives
  // later lesson-session state changes and is never inferred after an answer.
  taskReference: text("task_reference"),
  // qualified | unqualified | legacy. Null is also legacy for pre-C3 rows.
  qualificationStatus: text("qualification_status"),
  // Snapshot of the evidence-strength decision at the moment of the answer.
  evidenceQuality: text("evidence_quality"),
}, (table) => [
  uniqueIndex("evidence_events_task_attempt_identity_uq")
    .on(table.lessonSessionId, table.taskReference, table.attemptSequence)
    .where(sql`${table.taskReference} is not null and ${table.attemptSequence} is not null`),
]);

export const insertEvidenceEventSchema = createInsertSchema(evidenceEventsTable).omit({ id: true, createdAt: true });
export type InsertEvidenceEvent = z.infer<typeof insertEvidenceEventSchema>;
export type EvidenceEvent = typeof evidenceEventsTable.$inferSelect;
