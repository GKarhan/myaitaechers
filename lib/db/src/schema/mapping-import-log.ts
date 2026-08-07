import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { lessonsTable } from "./lessons";
import { usersTable } from "./users";

/**
 * One row per mapping import event.
 * Written by both the auto-map pipeline (source='auto') and the manual-map
 * route (source='manual') so the review dashboard has a full audit trail.
 */
export const mappingImportLogTable = pgTable("mapping_import_log", {
  id:                   serial("id").primaryKey(),
  lessonId:             integer("lesson_id")
    .notNull()
    .references(() => lessonsTable.id, { onDelete: "cascade" }),
  source:               text("source").notNull(),              // 'manual' | 'auto'
  mappingMode:          text("mapping_mode").notNull(),         // 'MANUAL_AI_JSON' | 'AUTO_VISION' | 'AUTO_TEXT'
  rawTextHash:          text("raw_text_hash").notNull(),        // SHA-256 hex of rawInput
  rawInput:             text("raw_input"),                      // teacher-pasted JSON (manual) or null
  mappingSchemaVersion: text("mapping_schema_version").notNull().default("1.0"),
  importedAt:           timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  importedBy:           integer("imported_by")
    .references(() => usersTable.id, { onDelete: "set null" }),
});

export const insertMappingImportLogSchema = createInsertSchema(mappingImportLogTable).omit({
  id: true,
  importedAt: true,
});
export type InsertMappingImportLog = z.infer<typeof insertMappingImportLogSchema>;
export type MappingImportLog = typeof mappingImportLogTable.$inferSelect;
