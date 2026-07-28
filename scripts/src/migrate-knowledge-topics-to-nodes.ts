/**
 * One-time data migration: copies all rows from knowledge_topics → knowledge_nodes.
 * The original knowledge_topics table is NOT modified or deleted.
 * Run with: pnpm --filter @workspace/scripts run migrate-knowledge-nodes
 */
import { db, knowledgeTopicsTable, knowledgeNodesTable } from "@workspace/db";

const rows = await db.select().from(knowledgeTopicsTable);

if (rows.length === 0) {
  console.log("No rows in knowledge_topics — nothing to migrate.");
  process.exit(0);
}

const toInsert = rows.map((row) => ({
  subjectId: row.subjectId,
  userId: row.userId,
  topicName: row.topicName,
  masteryScore: row.score,
  confidenceScore: null,
  retentionScore: null,
  bloomLevel: 1,
  isProvisional: true,
  status: row.status,
}));

const inserted = await db.insert(knowledgeNodesTable).values(toInsert).returning({ id: knowledgeNodesTable.id });

console.log(`Migrated ${inserted.length} rows from knowledge_topics → knowledge_nodes.`);
process.exit(0);
