import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { lessonsTable } from "./lessons";
import { lessonNodesTable } from "./lesson-nodes";

/**
 * Authoring-time dependency graph between nodes within a single lesson.
 * This is NOT the student mastery graph (knowledge_nodes / knowledge_edges).
 * Populated by lesson-mapping.ts during AI-assisted lesson authoring.
 */
export const lessonNodeDependenciesTable = pgTable("lesson_node_dependencies", {
  id: serial("id").primaryKey(),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessonsTable.id, { onDelete: "cascade" }),
  fromNodeId: integer("from_node_id")
    .notNull()
    .references(() => lessonNodesTable.id, { onDelete: "cascade" }), // prerequisite
  toNodeId: integer("to_node_id")
    .notNull()
    .references(() => lessonNodesTable.id, { onDelete: "cascade" }), // depends on fromNodeId
  dependencyType: text("dependency_type").notNull().default("SEQUENTIAL"), // REQUIRED | SEQUENTIAL | CONCEPTUAL
  requiredLevel: text("required_level").notNull().default("SUPPORTING"),   // CRITICAL | SUPPORTING
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LessonNodeDependency = typeof lessonNodeDependenciesTable.$inferSelect;
