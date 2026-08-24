import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonsTable } from "./lessons";
import { resourcesTable } from "./resources";

/**
 * Canonical, current source map for a lesson.
 *
 * This preserves verified textbook material independently of whether a block
 * becomes a MicroNode, an exercise, or a teacher-review item.
 */
export const lessonSourceMaterialsTable = pgTable(
  "lesson_source_materials",
  {
    id: serial("id").primaryKey(),
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lessonsTable.id, { onDelete: "cascade" }),
    sourceResourceId: integer("source_resource_id")
      .references(() => resourcesTable.id, { onDelete: "set null" }),
    stableSourceKey: text("stable_source_key").notNull(),
    // Compatibility/audit pointer only; durable identity is stableSourceKey.
    sourceBlockIndex: integer("source_block_index").notNull(),
    blockType: text("block_type").notNull(),
    sourceText: text("source_text").notNull(),
    physicalPage: integer("physical_page").notNull(),
    sourceParagraph: text("source_paragraph"),
    sourceBoundingBox: jsonb("source_bounding_box"),
    verificationStatus: text("verification_status").notNull(),
    primaryDisposition: text("primary_disposition").notNull(),
    dispositionReasonCodes: jsonb("disposition_reason_codes").notNull().default([]),
    provenanceMetadata: jsonb("provenance_metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lesson_source_materials_lesson_stable_key_uidx")
      .on(table.lessonId, table.stableSourceKey),
    index("lesson_source_materials_lesson_idx").on(table.lessonId),
  ],
);

export const insertLessonSourceMaterialSchema = createInsertSchema(
  lessonSourceMaterialsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertLessonSourceMaterial = z.infer<
  typeof insertLessonSourceMaterialSchema
>;
export type LessonSourceMaterial = typeof lessonSourceMaterialsTable.$inferSelect;