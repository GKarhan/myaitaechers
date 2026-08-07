import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonsTable } from "./lessons";

/**
 * Persisted review flags produced during manual-map (and eventually auto-map).
 * Allows the teacher-review dashboard to show a running "⚠ N unresolved issues" count.
 */
export const mappingReviewItemsTable = pgTable("mapping_review_items", {
  id:          serial("id").primaryKey(),
  lessonId:    integer("lesson_id")
    .notNull()
    .references(() => lessonsTable.id, { onDelete: "cascade" }),
  entityId:    integer("entity_id"),          // FK to lesson_nodes.id / lesson_exercises.id / lesson_topics.id (nullable — import-level issues have no entity)
  entityType:  text("entity_type"),           // 'node' | 'exercise' | 'topic' | 'import'
  issueType:   text("issue_type").notNull(),  // e.g. 'sourcePage-unverified' | 'duplicate-title' | 'validation-failed' | 'schema-error'
  severity:    text("severity").notNull(),    // 'warning' | 'error'
  description: text("description").notNull(),
  status:      text("status").notNull().default("open"),  // 'open' | 'resolved'
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMappingReviewItemSchema = createInsertSchema(mappingReviewItemsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMappingReviewItem = z.infer<typeof insertMappingReviewItemSchema>;
export type MappingReviewItem = typeof mappingReviewItemsTable.$inferSelect;
