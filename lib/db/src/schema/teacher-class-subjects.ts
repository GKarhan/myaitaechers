import { pgTable, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { classesTable } from "./classes";
import { subjectsTable } from "./subjects";
import { teachersTable } from "./teachers";

export const teacherClassSubjectsTable = pgTable("teacher_class_subjects", {
  id: serial("id").primaryKey(),
  classId: integer("class_id").notNull().references(() => classesTable.id, { onDelete: "cascade" }),
  teacherId: integer("teacher_id").notNull().references(() => teachersTable.id, { onDelete: "cascade" }),
  subjectId: integer("subject_id").notNull().references(() => subjectsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueAssignment: unique().on(t.classId, t.teacherId, t.subjectId),
}));

export type TeacherClassSubject = typeof teacherClassSubjectsTable.$inferSelect;
