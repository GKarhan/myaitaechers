import { pgTable, text, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subjectsTable } from "./subjects";
import { usersTable } from "./users";
import { classesTable } from "./classes";

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLessonSchema = createInsertSchema(lessonsTable).omit({ id: true, createdAt: true });
export type InsertLesson = z.infer<typeof insertLessonSchema>;
export type Lesson = typeof lessonsTable.$inferSelect;
