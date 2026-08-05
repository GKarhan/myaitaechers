import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonsTable } from "./lessons";
import { usersTable } from "./users";
import { lessonTopicsTable } from "./lesson-topics";

export const lessonNodesTable = pgTable("lesson_nodes", {
  id: serial("id").primaryKey(),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessonsTable.id, { onDelete: "cascade" }),
  // Nullable FK to lessonTopicsTable — groups this MicroNode under a parent topic.
  // NULL means standalone (not yet grouped, or intentionally topic-free).
  topicId: integer("topic_id")
    .references(() => lessonTopicsTable.id, { onDelete: "set null" }),
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
  // Node-level teaching stage machine (THEORY → MICRO_CHECK → EXERCISE → VERIFIED)
  // Spec-5 fields
  verbatimTheoryAnchor: text("verbatim_theory_anchor"),
  nonExamples: jsonb("non_examples").notNull().default(sql`'[]'::jsonb`),
  teachingStage: text("teaching_stage").notNull().default("THEORY"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // ── Authoring provenance & review fields ────────────────────────────────
  // What the student should be able to do after mastering this node.
  learningObjective: text("learning_objective"),
  // Broad category: "knowledge" (declarative) | "skill" (procedural)
  microNodeType: text("micro_node_type"),
  // Verbatim passage from the textbook this node was extracted from.
  sourceText: text("source_text"),
  // Page number in the textbook PDF.
  sourcePage: integer("source_page"),
  // Paragraph number or brief label within the page (nullable).
  sourceParagraph: text("source_paragraph"),
  // Bounding box on the rasterized page image: {x, y, w, h} in pixels
  // (preferred over text offsets since we use the vision path).
  sourceBoundingBox: jsonb("source_bounding_box"),
  // Structural role of this block in the textbook layout.
  // One of: DEFINITION | RULE | EXAMPLE | EXERCISE | OBJECTIVE | WARNING |
  //         EXCEPTION | TABLE | IMAGE | CAPTION | NOTE | ACTIVITY | HOMEWORK
  blockType: text("block_type"),
  // AI confidence 0–100 in the extraction/classification (nullable).
  confidenceScore: integer("confidence_score"),
  // Who created this node: "ai" (mapping pipeline) | "teacher" (manual).
  createdBy: text("created_by").default("ai"),
  // Teacher/user who reviewed this node (FK to users.id, nullable).
  reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "set null" }),
  // Authoring lifecycle: "draft" → "reviewed" → "approved"
  status: text("status").notNull().default("draft"),
  // Optimistic-lock version counter; bump on every teacher edit.
  version: integer("version").notNull().default(1),
  // Optional validity window (e.g. curriculum year).
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  // Free-text reason for the last edit (audit trail).
  changeReason: text("change_reason"),
});

export const insertLessonNodeSchema = createInsertSchema(lessonNodesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLessonNode = z.infer<typeof insertLessonNodeSchema>;
export type LessonNode = typeof lessonNodesTable.$inferSelect;
