import { pgTable, serial, integer, text, timestamp, jsonb, boolean, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { subjectsTable } from "./subjects";
import { classesTable } from "./classes";
import { booksTable } from "./books";
import { lessonNodesTable } from "./lesson-nodes";
import { lessonsTable } from "./lessons";
import { lessonExercisesTable } from "./lesson-exercises";
import { lessonNodeCognitiveLevelsTable } from "./lesson-node-cognitive-levels";

// ── quizzesTable ──────────────────────────────────────────────────────────────
export const quizzesTable = pgTable("quizzes", {
  id: serial("id").primaryKey(),
  teacherId: integer("teacher_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  subjectId: integer("subject_id")
    .notNull()
    .references(() => subjectsTable.id, { onDelete: "cascade" }),
  classId: integer("class_id")
    .references(() => classesTable.id, { onDelete: "set null" }),
  sourceBookId: integer("source_book_id")
    .references(() => booksTable.id, { onDelete: "set null" }),
  nodeIds: jsonb("node_ids").notNull().default(sql`'[]'::jsonb`),
  title: text("title").notNull(),
  questionCount: integer("question_count").notNull().default(10),
  // SIMPLE | MEDIUM | HARD | MIXED
  difficultyMode: text("difficulty_mode").notNull().default("MIXED"),
  // DRAFT | GENERATED | PUBLISHED | ASSIGNED | CLOSED
  status: text("status").notNull().default("DRAFT"),
  // Phase 1.9: explicit quiz scope — 'lesson' (1 linked lesson) | 'summary' (≥1 lessons) | null (legacy/unclassified)
  quizType: text("quiz_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Quiz = typeof quizzesTable.$inferSelect;

// ── quizQuestionsTable ────────────────────────────────────────────────────────
export const quizQuestionsTable = pgTable("quiz_questions", {
  id: serial("id").primaryKey(),
  quizId: integer("quiz_id")
    .notNull()
    .references(() => quizzesTable.id, { onDelete: "cascade" }),
  nodeId: integer("node_id")
    .references(() => lessonNodesTable.id, { onDelete: "set null" }),
  questionText: text("question_text").notNull(),
  // jsonb array of exactly 4 strings
  options: jsonb("options").notNull().default(sql`'[]'::jsonb`),
  correctOptionIndex: integer("correct_option_index").notNull().default(0), // 0-3
  // LOW | MEDIUM | HIGH
  difficultyLevel: text("difficulty_level").notNull().default("MEDIUM"),
  sequence: integer("sequence").notNull(),
  // Nullable TEXT[] — one explanation per option, index-aligned with options[].
  // null = no explanations available for this question (existing questions, or
  // generation produced insufficient source material).
  // Individual slots may also be null (partial — that slot has no reliable explanation).
  optionExplanations: text("option_explanations").array(),

  // ── Phase 2B Round 2 — Cognitive Identity ────────────────────────────────
  // All nullable. Existing questions remain valid with null in these fields.
  //
  // If the question was genuinely derived from a known lesson exercise, store
  // source_exercise_id. If it was generated only from node theory/context with
  // no specific exercise, leave null. NEVER fabricate a link.
  sourceExerciseId: integer("source_exercise_id")
    .references(() => lessonExercisesTable.id, { onDelete: "set null" }),

  // If the question was generated to assess a known cognitive level, store the FK.
  // This enables evidence_events.cognitive_level to be populated at quiz submit time.
  cognitiveLevelId: integer("cognitive_level_id")
    .references(() => lessonNodeCognitiveLevelsTable.id, { onDelete: "set null" }),

  // The ACTUAL learner interaction format for this question.
  // Examples: multiple_choice | true_false | classification | short_answer | numeric_answer
  // Reflects what the student UI renders — not a future target.
  interactionType: text("interaction_type"),
});

export type QuizQuestion = typeof quizQuestionsTable.$inferSelect;

// ── quizAssignmentsTable ──────────────────────────────────────────────────────
export const quizAssignmentsTable = pgTable("quiz_assignments", {
  id: serial("id").primaryKey(),
  quizId: integer("quiz_id")
    .notNull()
    .references(() => quizzesTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  // ASSIGNED | IN_PROGRESS | COMPLETED
  status: text("status").notNull().default("ASSIGNED"),
});

export type QuizAssignment = typeof quizAssignmentsTable.$inferSelect;

// ── quizAttemptsTable ─────────────────────────────────────────────────────────
// One attempt per assignment (enforced by unique constraint on quizAssignmentId).
export const quizAttemptsTable = pgTable("quiz_attempts", {
  id: serial("id").primaryKey(),
  quizAssignmentId: integer("quiz_assignment_id")
    .notNull()
    .unique()
    .references(() => quizAssignmentsTable.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  totalCorrect: integer("total_correct").notNull().default(0),
  totalQuestions: integer("total_questions").notNull().default(0),
  scorePercent: integer("score_percent"), // null until completed
});

export type QuizAttempt = typeof quizAttemptsTable.$inferSelect;

// ── quizAnswersTable ──────────────────────────────────────────────────────────
export const quizAnswersTable = pgTable("quiz_answers", {
  id: serial("id").primaryKey(),
  attemptId: integer("attempt_id")
    .notNull()
    .references(() => quizAttemptsTable.id, { onDelete: "cascade" }),
  questionId: integer("question_id")
    .notNull()
    .references(() => quizQuestionsTable.id, { onDelete: "cascade" }),
  // Denormalized copy of the question's nodeId — kept for future scoring-engine
  // integration; not enforced as FK to avoid complex cascade concerns.
  nodeId: integer("node_id"),
  selectedOptionIndex: integer("selected_option_index").notNull(),
  isCorrect: boolean("is_correct").notNull(),
});

export type QuizAnswer = typeof quizAnswersTable.$inferSelect;

// ── quizLessonLinksTable ──────────────────────────────────────────────────────
// Authoritative Lesson ↔ Quiz relationship (Phase 1.9).
// One quiz may link to one lesson (type='lesson') or many lessons (type='summary').
// Deleting a quiz cascades to remove its links.
// Deleting a lesson removes only that link row — never the quiz itself.
export const quizLessonLinksTable = pgTable(
  "quiz_lesson_links",
  {
    id:       serial("id").primaryKey(),
    quizId:   integer("quiz_id").notNull().references(() => quizzesTable.id,  { onDelete: "cascade" }),
    lessonId: integer("lesson_id").notNull().references(() => lessonsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.quizId, t.lessonId)],
);

export type QuizLessonLink = typeof quizLessonLinksTable.$inferSelect;
