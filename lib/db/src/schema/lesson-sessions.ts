import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { lessonsTable } from "./lessons";
import { lessonNodesTable } from "./lesson-nodes";

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
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertLessonSessionSchema = createInsertSchema(lessonSessionsTable).omit({ id: true, startedAt: true });
export type InsertLessonSession = z.infer<typeof insertLessonSessionSchema>;
export type LessonSession = typeof lessonSessionsTable.$inferSelect;
