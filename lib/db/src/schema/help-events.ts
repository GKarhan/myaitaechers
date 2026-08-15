/**
 * help_events — Phase 2B Round 2
 *
 * Records each individual help request during an active task.
 * The final evidence_event stores a summary (help_count, assistance_level, hint_used),
 * while this table preserves the full audit trail for future Confidence V2 analysis.
 *
 * Help levels:
 *   1 = light    — directional hint; no solution steps or final answer
 *   2 = moderate — conceptual/procedural guidance; still no final answer
 *   3 = guided   — step-by-step support; learner still produces the final response
 *   4 = reveal   — explicit answer/explanation reveal (is_answer_reveal = true)
 *
 * A help event must NEVER advance node_teaching_stage, increment evidence counters,
 * or count as a learner answer. It records what help occurred before a final answer.
 */
import {
  pgTable, serial, integer, text, boolean, timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { lessonSessionsTable } from "./lesson-sessions";
import { lessonNodesTable } from "./lesson-nodes";
import { lessonExercisesTable } from "./lesson-exercises";
import { quizQuestionsTable } from "./quizzes";
import { lessonNodeCognitiveLevelsTable } from "./lesson-node-cognitive-levels";

export const helpEventsTable = pgTable("help_events", {
  id: serial("id").primaryKey(),

  // Authenticated learner — never trust client-supplied userId; always derive from session.
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),

  // Session context
  lessonSessionId: integer("lesson_session_id")
    .references(() => lessonSessionsTable.id, { onDelete: "set null" }),

  // Task identity — what task the learner was on when they requested help
  lessonNodeId: integer("lesson_node_id")
    .notNull()
    .references(() => lessonNodesTable.id, { onDelete: "cascade" }),
  lessonExerciseId: integer("lesson_exercise_id")
    .references(() => lessonExercisesTable.id, { onDelete: "set null" }),
  quizQuestionId: integer("quiz_question_id")
    .references(() => quizQuestionsTable.id, { onDelete: "set null" }),
  cognitiveLevelId: integer("cognitive_level_id")
    .references(() => lessonNodeCognitiveLevelsTable.id, { onDelete: "set null" }),

  // Help level: 1=light, 2=moderate, 3=guided, 4=reveal
  helpLevel: integer("help_level").notNull(),

  // true only when help_level = 4 (explicit answer reveal).
  // Level 4 MUST be a separate deliberate action — it cannot happen automatically.
  isAnswerReveal: boolean("is_answer_reveal").notNull().default(false),

  // The actual hint text shown to the learner (optional; may be null for internal records)
  hintContent: text("hint_content"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type HelpEvent = typeof helpEventsTable.$inferSelect;
export type InsertHelpEvent = typeof helpEventsTable.$inferInsert;
