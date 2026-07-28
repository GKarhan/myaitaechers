import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { knowledgeNodesTable } from "./knowledge-nodes";

export const knowledgeEdgesTable = pgTable("knowledge_edges", {
  id: serial("id").primaryKey(),
  fromNodeId: integer("from_node_id")
    .notNull()
    .references(() => knowledgeNodesTable.id, { onDelete: "cascade" }),
  toNodeId: integer("to_node_id")
    .notNull()
    .references(() => knowledgeNodesTable.id, { onDelete: "cascade" }),
  relationType: text("relation_type").notNull().default("prerequisite"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertKnowledgeEdgeSchema = createInsertSchema(knowledgeEdgesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertKnowledgeEdge = z.infer<typeof insertKnowledgeEdgeSchema>;
export type KnowledgeEdge = typeof knowledgeEdgesTable.$inferSelect;
