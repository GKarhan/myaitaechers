import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonsTable } from "./lessons";
import { lessonNodesTable } from "./lesson-nodes";
import { resourcesTable } from "./resources";

/**
 * Package 1B / C1 structured teaching content.
 *
 * These rows are pedagogical material, not textbook source extraction and not
 * exercises. Source fields on lesson_nodes and existing task tables remain the
 * respective authorities for fidelity and learner tasks.
 */
export const lessonNodeTeachingPackageItemsTable = pgTable(
  "lesson_node_teaching_package_items",
  {
    id: serial("id").primaryKey(),
    // Kept alongside the node FK for ownership-scoped authoring reads. Routes
    // verify that both IDs belong to the same lesson before every write.
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lessonsTable.id, { onDelete: "cascade" }),
    lessonNodeId: integer("lesson_node_id")
      .notNull()
      .references(() => lessonNodesTable.id, { onDelete: "cascade" }),
    itemType: text("item_type").notNull(),
    content: text("content").notNull(),
    // Stable semantic value; Cognitive Path rows themselves can be regenerated.
    cognitiveLevel: text("cognitive_level"),
    status: text("status").notNull().default("draft"),
    provenance: text("provenance").notNull().default("teacher_created"),
    // Only MAIN_EXPLANATION rows may be primary. A partial unique index below
    // permits at most one approved primary explanation per MicroNode.
    isPrimary: boolean("is_primary").notNull().default(false),
    // Optional link to existing course-owned material. No upload system is added.
    resourceId: integer("resource_id")
      .references(() => resourcesTable.id, { onDelete: "set null" }),
    // Internal deterministic legacy-field key used only for idempotent explicit
    // compatibility seeding. It preserves the original node fields unchanged.
    sourceItemKey: text("source_item_key"),
    sequence: integer("sequence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lntpi_node_type_sequence_uidx").on(t.lessonNodeId, t.itemType, t.sequence),
    uniqueIndex("lntpi_node_source_key_uidx")
      .on(t.lessonNodeId, t.sourceItemKey)
      .where(sql`${t.sourceItemKey} IS NOT NULL`),
    uniqueIndex("lntpi_primary_approved_explanation_uidx")
      .on(t.lessonNodeId)
      .where(sql`${t.itemType} = 'MAIN_EXPLANATION' AND ${t.status} = 'approved' AND ${t.isPrimary} = true`),
    foreignKey({
      name: "lntpi_node_lesson_fk",
      columns: [t.lessonNodeId, t.lessonId],
      foreignColumns: [lessonNodesTable.id, lessonNodesTable.lessonId],
    }),
    index("lntpi_lesson_idx").on(t.lessonId),
    index("lntpi_node_idx").on(t.lessonNodeId),
    check(
      "lntpi_type_chk",
      sql`${t.itemType} IN ('MAIN_EXPLANATION','KEY_FACT','RULE_OR_FORMULA','EXAMPLE','COUNTEREXAMPLE','MISCONCEPTION','ALTERNATIVE_EXPLANATION','GUIDING_QUESTION','HINT','RESOURCE')`,
    ),
    check("lntpi_status_chk", sql`${t.status} IN ('draft','reviewed','approved')`),
    check(
      "lntpi_provenance_chk",
      sql`${t.provenance} IN ('source_material','teacher_created','ai_generated','ai_generated_teacher_approved')`,
    ),
    check(
      "lntpi_cognitive_level_chk",
      sql`${t.cognitiveLevel} IS NULL OR ${t.cognitiveLevel} IN ('remember','understand','apply','analyze','evaluate','create')`,
    ),
    check(
      "lntpi_primary_type_chk",
      sql`${t.isPrimary} = false OR ${t.itemType} = 'MAIN_EXPLANATION'`,
    ),
    check("lntpi_sequence_chk", sql`${t.sequence} >= 1`),
  ],
);

export const TEACHING_PACKAGE_ITEM_TYPES = [
  "MAIN_EXPLANATION",
  "KEY_FACT",
  "RULE_OR_FORMULA",
  "EXAMPLE",
  "COUNTEREXAMPLE",
  "MISCONCEPTION",
  "ALTERNATIVE_EXPLANATION",
  "GUIDING_QUESTION",
  "HINT",
  "RESOURCE",
] as const;
export type TeachingPackageItemType = (typeof TEACHING_PACKAGE_ITEM_TYPES)[number];

export const TEACHING_PACKAGE_STATUSES = ["draft", "reviewed", "approved"] as const;
export type TeachingPackageStatus = (typeof TEACHING_PACKAGE_STATUSES)[number];

export const TEACHING_PACKAGE_PROVENANCE_VALUES = [
  "source_material",
  "teacher_created",
  "ai_generated",
  "ai_generated_teacher_approved",
] as const;
export type TeachingPackageProvenance = (typeof TEACHING_PACKAGE_PROVENANCE_VALUES)[number];

export const insertLessonNodeTeachingPackageItemSchema = createInsertSchema(
  lessonNodeTeachingPackageItemsTable,
  {
    itemType: z.enum(TEACHING_PACKAGE_ITEM_TYPES),
    content: z.string().trim().min(1),
    cognitiveLevel: z.enum(["remember", "understand", "apply", "analyze", "evaluate", "create"]).nullable().optional(),
    status: z.enum(TEACHING_PACKAGE_STATUSES).optional(),
    provenance: z.enum(TEACHING_PACKAGE_PROVENANCE_VALUES).optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLessonNodeTeachingPackageItem = z.infer<
  typeof insertLessonNodeTeachingPackageItemSchema
>;
export type LessonNodeTeachingPackageItem =
  typeof lessonNodeTeachingPackageItemsTable.$inferSelect;