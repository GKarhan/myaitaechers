import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonsTable } from "./lessons";

export const lessonNodesTable = pgTable("lesson_nodes", {
  id: serial("id").primaryKey(),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessonsTable.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  title: text("title").notNull(),
  theoryContent: text("theory_content"),
  targetBloomLevel: integer("target_bloom_level").notNull().default(1),
  estimatedMinutes: integer("estimated_minutes").notNull().default(5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLessonNodeSchema = createInsertSchema(lessonNodesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLessonNode = z.infer<typeof insertLessonNodeSchema>;
export type LessonNode = typeof lessonNodesTable.$inferSelect;
