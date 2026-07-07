import { pgTable, integer, primaryKey } from "drizzle-orm/pg-core";
import { classesTable } from "./classes";
import { usersTable } from "./users";

export const classStudentsTable = pgTable(
  "class_students",
  {
    classId: integer("class_id")
      .notNull()
      .references(() => classesTable.id, { onDelete: "cascade" }),
    studentId: integer("student_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.classId, t.studentId] })]
);

export type ClassStudent = typeof classStudentsTable.$inferSelect;
