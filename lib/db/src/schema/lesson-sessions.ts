import { pgTable, text, serial, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { lessonsTable } from "./lessons";
import { lessonNodesTable } from "./lesson-nodes";
import { lessonExercisesTable } from "./lesson-exercises";
import { lessonNodeCognitiveLevelsTable } from "./lesson-node-cognitive-levels";

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

  // ── Phase 2B Round 2 — Active Task Identity ──────────────────────────────
  // Tracks the currently active task so help requests and evidence events
  // can be linked to the same stable task without trusting client input.
  // All nullable — null = no active task (e.g. THEORY phase).

  // lesson_exercises.id of the textbook exercise currently being presented.
  // null = MICRO_CHECK (AI-generated) or THEORY phase.
  activeLessonExerciseId: integer("active_lesson_exercise_id")
    .references(() => lessonExercisesTable.id, { onDelete: "set null" }),

  // lesson_node_cognitive_levels.id of the cognitive level being targeted.
  // null = cognitive path not confirmed or not applicable.
  activeCognitiveLevelId: integer("active_cognitive_level_id")
    .references(() => lessonNodeCognitiveLevelsTable.id, { onDelete: "set null" }),

  // Provenance of the active task: 'micro_check' | 'source_exercise' | null
  activeTaskProvenance: text("active_task_provenance"),

  // C3: immutable opaque identity created when an answerable task is activated.
  // It is copied into evidence_events before this mutable active-task state can
  // be reset by continuation/progression.
  activeTaskReference: text("active_task_reference"),

  // Backend-only answer data for an active AI-generated objective MICRO_CHECK.
  // null = no active objective micro-check; source exercises never use this payload.
  activeObjectiveTaskPayload: jsonb("active_objective_task_payload")
    .$type<{
      interactionType: "multiple_choice" | "true_false";
      options: Array<{ key: string; text: string }> | null;
      correctOption: string;
    } | null>(),

  // Which attempt number this is on the current active task (1-based).
  // Reset to 1 when a new task starts; incremented on each answer attempt.
  activeAttemptSequence: integer("active_attempt_sequence").notNull().default(0),

  // How many help events have been requested during the current active task.
  // Reset to 0 when a new task starts.
  activeHelpCount: integer("active_help_count").notNull().default(0),

  // Maximum help level reached during the current active task.
  // 'none' | 'light' | 'moderate' | 'guided' | 'revealed'
  activeAssistanceLevel: text("active_assistance_level").notNull().default("none"),

  // ── V2-R3 — Pedagogical Decision Engine ──────────────────────────────────
  //
  // remediationStep: which escalation step the system is at for the CURRENT
  // cognitive level.  0 = initial teach/check; 1–5 = escalation steps.
  // Increments only on a failed ANSWER evaluation (not HELP/CONFUSED/etc.).
  // Resets to 0 when: a new cognitive level activates, node advances, or an
  // independent verification succeeds.
  // MAX_REMEDIATION_STEPS (policy constant in decision engine) = 5.
  remediationStep: integer("remediation_step").notNull().default(0),

  // ── V2-R4A — Learning Budget ───────────────────────────────────────────────
  //
  // requiredSessionMinutes: SNAPSHOT of lessons.requiredSessionMinutes at the
  // moment this session was created.  Isolates the student's session contract
  // from future teacher edits.  null = no budget (pre-R4 behavior preserved).
  requiredSessionMinutes: integer("required_session_minutes"),

  // activeLearningSeconds: running accumulation of CREDITED active learning
  // time using the turn-based capped-interval model.  Only POST /api/chat
  // calls increment this (GET/refresh/polling never do).  Atomic SQL increment
  // ensures concurrency safety.  Never decrements.
  activeLearningSeconds: integer("active_learning_seconds").notNull().default(0),

  // lastActivityAt: timestamp of the most recent qualifying learner interaction
  // (i.e. when the last /api/chat response was dispatched).  Used to compute
  // the inter-turn interval on the NEXT qualifying event.
  // null = no qualifying event yet (first-activity anchor not yet established).
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  //
  // ── V2-R4A.3 — Required-session completion + optional continuation ───────────

  // requiredSessionCompletedAt: timestamp of the first time activeLearningSeconds
  // crossed the required budget (i.e., the FIRST time END_REQUIRED_SESSION fired).
  // null = required session has not yet completed (either no budget or not reached).
  // Once set, it is NEVER overwritten — idempotent completion mark.
  requiredSessionCompletedAt: timestamp("required_session_completed_at", { withTimezone: true }),

  // optionalContinuation: true when the learner explicitly chose «Շարունակել կամավոր»
  // after the required portion ended.  false (default) = required portion only.
  // When true, effectiveSessionBudgetExhausted = false, so teaching resumes normally.
  // Evidence earned during optional continuation is real and stored normally.
  optionalContinuation: boolean("optional_continuation").notNull().default(false),
});

export const insertLessonSessionSchema = createInsertSchema(lessonSessionsTable).omit({ id: true, startedAt: true });
export type InsertLessonSession = z.infer<typeof insertLessonSessionSchema>;
export type LessonSession = typeof lessonSessionsTable.$inferSelect;
