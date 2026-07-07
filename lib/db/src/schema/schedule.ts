import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { classesTable } from "./classes";

export const scheduleTable = pgTable("schedule", {
  id: serial("id").primaryKey(),
  classId: integer("class_id")
    .notNull()
    .references(() => classesTable.id, { onDelete: "cascade" }),
  day: text("day").notNull(),
  time: text("time").notNull(),
  subject: text("subject").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Schedule = typeof scheduleTable.$inferSelect;
