import { pgTable, text, serial, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subjectsTable } from "./subjects";
import { usersTable } from "./users";
import { classesTable } from "./classes";
import { resourcesTable } from "./resources";

export const lessonsTable = pgTable("lessons", {
  id: serial("id").primaryKey(),
  subjectId: integer("subject_id")
    .notNull()
    .references(() => subjectsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  bloomLevel: integer("bloom_level").notNull().default(1),
  phases: jsonb("phases").notNull().default([]),
  teacherId: integer("teacher_id")
    .references(() => usersTable.id, { onDelete: "set null" }),
  classId: integer("class_id")
    .references(() => classesTable.id, { onDelete: "set null" }),
  content: text("content").notNull().default(""),
  lessonNumber: integer("lesson_number"),
  pagesFrom: integer("pages_from"),
  pagesTo: integer("pages_to"),
  month: integer("month"),
  day: integer("day"),
  courseId: integer("course_id"),
  // New structured fields
  textbookAuthor: text("textbook_author"),
  textbookTitle: text("textbook_title"),
  chapterTitle: text("chapter_title"),
  paragraphNumber: text("paragraph_number"),
  textbookResourceId: integer("textbook_resource_id")
    .references(() => resourcesTable.id, { onDelete: "set null" }),
  // AI-generated lesson mapping fields
  lessonGoal: text("lesson_goal"),
  lessonOutcomes: jsonb("lesson_outcomes").notNull().default([]),
  // Package 1C authoring gate. Existing lessons default to "legacy" so their
  // established mapping and learner delivery remain usable until a teacher
  // explicitly begins canonical Goal/Outcome review.
  goalOutcomeReviewStatus: text("goal_outcome_review_status").notNull().default("legacy"),
  // A source-aware AI proposal is deliberately separate from the confirmed
  // lesson goal and canonical outcome rows. It is never learner-facing and is
  // only applied by an explicit teacher action.
  goalOutcomeProposal: jsonb("goal_outcome_proposal"),
  goalOutcomeConfirmedAt: timestamp("goal_outcome_confirmed_at", { withTimezone: true }),
  goalOutcomeConfirmedBy: integer("goal_outcome_confirmed_by")
    .references(() => usersTable.id, { onDelete: "set null" }),
  coreIdea: text("core_idea"),
  coreProblem: text("core_problem"),
  essentialQuestion: text("essential_question"),
  practicalTasks: jsonb("practical_tasks").notNull().default([]),
  knowledgeBoundaries: jsonb("knowledge_boundaries").notNull().default(sql`'[]'::jsonb`),
  mappingMetadata: jsonb("mapping_metadata"),
  status: text("status").notNull().default("draft"),
  // P1.13-pre: set to true on first successful final-approval; once true, ordinary
  // teacher edits do NOT revert the lesson to needs_review.
  everApproved: boolean("ever_approved").notNull().default(false),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // ── V2-R4A — Learning Budget ───────────────────────────────────────────────
  //
  // requiredSessionMinutes: how many ACTIVE LEARNING minutes the student must
  // accumulate before the required portion of this lesson session is complete.
  // null = no required-session budget configured (unlimited — pre-R4 behavior).
  // This is a DEFAULT for new sessions; each session snapshots its own copy at
  // creation time so mid-lesson teacher edits don't affect running sessions.
  // DISTINCT from lesson_nodes.estimatedMinutes (per-node pedagogical estimate).
  requiredSessionMinutes: integer("required_session_minutes"),
});

export const insertLessonSchema = createInsertSchema(lessonsTable).omit({ id: true, createdAt: true });
export type InsertLesson = z.infer<typeof insertLessonSchema>;
export type Lesson = typeof lessonsTable.$inferSelect;
