import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  // AI-teacher fields (P4/P5 runtime use)
  childFriendlyExplanation: text("child_friendly_explanation"),
  basicExamples: jsonb("basic_examples").notNull().default(sql`'[]'::jsonb`),
  realLifeExamples: jsonb("real_life_examples").notNull().default(sql`'[]'::jsonb`),
  commonMisconception: text("common_misconception"),
  prerequisiteNodes: jsonb("prerequisite_nodes").notNull().default(sql`'[]'::jsonb`),
  // P0 node-level progress tracking (updated in real-time by chat.ts)
  masteryEvidenceCount: integer("mastery_evidence_count").notNull().default(0),
  lastEvidenceQuality: text("last_evidence_quality"), // nullable: "NONE"|"WEAK"|"MODERATE"|"STRONG"|"CONCLUSIVE"
  consecutiveCorrect: integer("consecutive_correct").notNull().default(0),
  consecutiveIncorrect: integer("consecutive_incorrect").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLessonNodeSchema = createInsertSchema(lessonNodesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLessonNode = z.infer<typeof insertLessonNodeSchema>;
export type LessonNode = typeof lessonNodesTable.$inferSelect;
