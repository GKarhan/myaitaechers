import { pgTable, serial, integer, jsonb, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const studentProfileTable = pgTable("student_profile", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" })
    .unique(),
  avgMastery: integer("avg_mastery"),
  masteredTopicsCount: integer("mastered_topics_count").notNull().default(0),
  weakTopicsCount: integer("weak_topics_count").notNull().default(0),
  notStartedTopicsCount: integer("not_started_topics_count").notNull().default(0),
  totalLessonsCompleted: integer("total_lessons_completed").notNull().default(0),
  overallK: integer("overall_k"),
  reviewQueueSummary: jsonb("review_queue_summary").notNull().default([]),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertStudentProfileSchema = createInsertSchema(studentProfileTable).omit({
  id: true,
  createdAt: true,
});
export type InsertStudentProfile = z.infer<typeof insertStudentProfileSchema>;
export type StudentProfile = typeof studentProfileTable.$inferSelect;
