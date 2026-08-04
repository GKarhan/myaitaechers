import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subjectsTable } from "./subjects";
import { usersTable } from "./users";
import { lessonNodesTable } from "./lesson-nodes";

export const knowledgeNodesTable = pgTable("knowledge_nodes", {
  id: serial("id").primaryKey(),
  subjectId: integer("subject_id")
    .notNull()
    .references(() => subjectsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  topicName: text("topic_name").notNull(),
  lessonNodeId: integer("lesson_node_id")
    .references(() => lessonNodesTable.id, { onDelete: "cascade" }),
  masteryScore: integer("mastery_score"),
  confidenceScore: integer("confidence_score"),
  retentionScore: integer("retention_score"),
  bloomLevel: integer("bloom_level").notNull().default(1),
  isProvisional: boolean("is_provisional").notNull().default(true),
  status: text("status").notNull().default("not_started"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertKnowledgeNodeSchema = createInsertSchema(knowledgeNodesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertKnowledgeNode = z.infer<typeof insertKnowledgeNodeSchema>;
export type KnowledgeNode = typeof knowledgeNodesTable.$inferSelect;
