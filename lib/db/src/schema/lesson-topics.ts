import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonsTable } from "./lessons";

/**
 * Groups MicroNodes (lessonNodesTable rows) under a shared topic heading.
 *
 * Example hierarchy for one lesson:
 *   Topic: "Հատուկ և հասարակ գոյականներ"  (sequence 1)
 *     MicroNode: "Հասարակ գոյականի սահմանում"  (topicId → this topic)
 *     MicroNode: "Հատուկ գոյականի սահմանում"   (topicId → this topic)
 *   Topic: "Գոյականի հոլովումը"               (sequence 2)
 *     MicroNode: ...
 *
 * A MicroNode with topicId = NULL belongs to no topic (standalone).
 */
export const lessonTopicsTable = pgTable("lesson_topics", {
  id: serial("id").primaryKey(),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessonsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sequence: integer("sequence").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLessonTopicSchema = createInsertSchema(lessonTopicsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLessonTopic = z.infer<typeof insertLessonTopicSchema>;
export type LessonTopic = typeof lessonTopicsTable.$inferSelect;
