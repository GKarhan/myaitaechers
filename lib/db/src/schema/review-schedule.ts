import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { knowledgeNodesTable } from "./knowledge-nodes";

export const reviewScheduleTable = pgTable("review_schedule", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  topicId: integer("topic_id")
    .notNull()
    .references(() => knowledgeNodesTable.id, { onDelete: "cascade" }),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
  intervalDays: integer("interval_days").notNull().default(1),
  reviewCount: integer("review_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertReviewScheduleSchema = createInsertSchema(reviewScheduleTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertReviewSchedule = z.infer<typeof insertReviewScheduleSchema>;
export type ReviewSchedule = typeof reviewScheduleTable.$inferSelect;
