import { pgTable, serial, integer, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { lessonSessionsTable } from "./lesson-sessions";
import { knowledgeTopicsTable } from "./knowledge-topics";

export const evidenceEventsTable = pgTable("evidence_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  lessonSessionId: integer("lesson_session_id")
    .references(() => lessonSessionsTable.id, { onDelete: "cascade" }),
  topicId: integer("topic_id")
    .references(() => knowledgeTopicsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  wasCorrect: boolean("was_correct"),
  responseTimeMs: integer("response_time_ms"),
  hintUsed: boolean("hint_used").notNull().default(false),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEvidenceEventSchema = createInsertSchema(evidenceEventsTable).omit({ id: true, createdAt: true });
export type InsertEvidenceEvent = z.infer<typeof insertEvidenceEventSchema>;
export type EvidenceEvent = typeof evidenceEventsTable.$inferSelect;
