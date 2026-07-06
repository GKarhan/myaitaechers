import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subjectsTable } from "./subjects";
import { usersTable } from "./users";

export const knowledgeTopicsTable = pgTable("knowledge_topics", {
  id: serial("id").primaryKey(),
  subjectId: integer("subject_id")
    .notNull()
    .references(() => subjectsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  topicName: text("topic_name").notNull(),
  score: integer("score").notNull().default(0),
  status: text("status").notNull().default("not_started"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertKnowledgeTopicSchema = createInsertSchema(knowledgeTopicsTable).omit({ id: true, createdAt: true });
export type InsertKnowledgeTopic = z.infer<typeof insertKnowledgeTopicSchema>;
export type KnowledgeTopic = typeof knowledgeTopicsTable.$inferSelect;
