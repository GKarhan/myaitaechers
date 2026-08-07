import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { lessonsTable } from "./lessons";

// ── Background mapping jobs ────────────────────────────────────────────────────
// Tracks async execution of the two long-running lesson-intelligence operations:
//   jobType 'map'                      → POST /lessons/:id/map
//   jobType 'generate_teaching_content' → POST /lessons/:id/generate-teaching-content
//
// Lifecycle: pending → running → completed | failed
// The route creates the record, responds with { jobId }, then processes inside
// setImmediate so the HTTP connection is released immediately.
export const mappingJobsTable = pgTable("mapping_jobs", {
  id:        serial("id").primaryKey(),
  lessonId:  integer("lesson_id").notNull().references(() => lessonsTable.id, { onDelete: "cascade" }),
  jobType:   text("job_type").notNull(), // 'map' | 'generate_teaching_content'
  status:    text("status").notNull().default("pending"), // 'pending' | 'running' | 'completed' | 'failed'
  result:    jsonb("result"),
  error:     text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type MappingJob = typeof mappingJobsTable.$inferSelect;
export type NewMappingJob = typeof mappingJobsTable.$inferInsert;
