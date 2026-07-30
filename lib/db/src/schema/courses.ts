import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { classesTable } from "./classes";
import { usersTable } from "./users";
import { subjectsTable } from "./subjects";

export const coursesTable = pgTable("courses", {
  id: serial("id").primaryKey(),
  classId: integer("class_id")
    .notNull()
    .references(() => classesTable.id, { onDelete: "cascade" }),
  teacherId: integer("teacher_id")
    .references(() => usersTable.id, { onDelete: "set null" }),
  subjectId: integer("subject_id")
    .references(() => subjectsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCourseSchema = createInsertSchema(coursesTable).omit({ id: true, createdAt: true });
export type InsertCourse = z.infer<typeof insertCourseSchema>;
export type Course = typeof coursesTable.$inferSelect;
