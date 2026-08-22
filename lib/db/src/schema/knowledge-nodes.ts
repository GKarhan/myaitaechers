import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subjectsTable } from "./subjects";
import { usersTable } from "./users";
import { lessonNodesTable } from "./lesson-nodes";
import { lessonNodeCognitiveLevelsTable } from "./lesson-node-cognitive-levels";

export const knowledgeNodesTable = pgTable(
  "knowledge_nodes",
  {
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

    // ── V2-R3 — Pedagogical Decision Engine (durable cross-session learner state) ──
    //
    // demonstratedCognitiveLevel: highest Bloom level for which this student has
    // accumulated sufficient INDEPENDENT evidence on this MicroNode.
    // Allowed: remember | understand | apply | analyze | evaluate | create | null
    // null = no level confirmed yet.
    // Evidence in evidence_events is authoritative; this is a write-through
    // materialized cache updated when a level is confirmed by the decision engine.
    demonstratedCognitiveLevel: text("demonstrated_cognitive_level"),

    // C4 canonical identity for the durable demonstrated ceiling. The Bloom
    // name above remains a readable compatibility snapshot, but C4 must use
    // the accepted lesson_node_cognitive_levels row ID as the source identity.
    demonstratedCognitiveLevelId: integer("demonstrated_cognitive_level_id")
      .references(() => lessonNodeCognitiveLevelsTable.id, { onDelete: "set null" }),
    demonstratedCognitiveLevelUpdatedAt: timestamp(
      "demonstrated_cognitive_level_updated_at",
      { withTimezone: true },
    ),
    demonstratedCognitiveEvidenceReference: text(
      "demonstrated_cognitive_evidence_reference",
    ),

    // revisitRequired: true when the remediation budget was exhausted before the
    // student reached the curriculum target ceiling. Must survive sessions — used
    // by Knowledge Tree and future review scheduler.
    // Cleared when demonstratedCognitiveLevel eventually reaches target ceiling.
    revisitRequired: boolean("revisit_required").notNull().default(false),

    // revisitReason: WHY this node needs revisiting. Typed enum at application
    // level. Allowed values (only valid when revisitRequired=true):
    //   REMEDIATION_EXHAUSTED  — student tried, remediationStep hit the ceiling
    //   LOCAL_BUDGET_EXHAUSTED — student tried, local node time budget ran out
    //   SESSION_TIME_LIMIT     — session ended before this level was attempted
    // null when revisitRequired=false.
    // Cleared together with revisitRequired when target level is confirmed.
    revisitReason: text("revisit_reason"),
  },
  (t) => [
    // One knowledge_node row per (student, lesson_node). NULLs are treated as
    // distinct by PostgreSQL unique indexes, so chat.ts rows with lessonNodeId=NULL
    // are unaffected — only non-null pairs are de-duplicated.
    uniqueIndex("knowledge_nodes_user_lesson_node_uidx").on(t.userId, t.lessonNodeId),
  ]
);

export const insertKnowledgeNodeSchema = createInsertSchema(knowledgeNodesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertKnowledgeNode = z.infer<typeof insertKnowledgeNodeSchema>;
export type KnowledgeNode = typeof knowledgeNodesTable.$inferSelect;
