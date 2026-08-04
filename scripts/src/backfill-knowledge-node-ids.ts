/**
 * One-time backfill: for every knowledge_nodes row with lessonNodeId still null,
 * find a matching lesson_nodes row by:
 *   lesson_nodes.title      = knowledge_nodes.topicName
 *   lesson_nodes.lessonId → lessons.subjectId = knowledge_nodes.subjectId
 * and set lessonNodeId accordingly.
 *
 * Unmatched rows are logged but left as null — existing chat.ts behavior for them
 * is unaffected.
 *
 * Run with: pnpm --filter @workspace/scripts run backfill-knowledge-node-ids
 */
import { db, knowledgeNodesTable, lessonNodesTable, lessonsTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";

// 1. Load all knowledge_nodes rows with no lessonNodeId yet
const unlinked = await db
  .select()
  .from(knowledgeNodesTable)
  .where(isNull(knowledgeNodesTable.lessonNodeId));

console.log(`Found ${unlinked.length} knowledge_nodes rows with lessonNodeId = null`);

if (unlinked.length === 0) {
  console.log("Nothing to backfill.");
  process.exit(0);
}

// 2. Load all lesson_nodes with their resolved subjectId (via lessons JOIN)
const lessonNodeRows = await db
  .select({
    id:           lessonNodesTable.id,
    title:        lessonNodesTable.title,
    subjectId:    lessonsTable.subjectId,
  })
  .from(lessonNodesTable)
  .innerJoin(lessonsTable, eq(lessonsTable.id, lessonNodesTable.lessonId));

// Map "(subjectId):(title)" → lessonNodeId (first match wins if duplicates exist)
const nodeMap = new Map<string, number>();
for (const ln of lessonNodeRows) {
  const key = `${ln.subjectId}:${ln.title}`;
  if (!nodeMap.has(key)) {
    nodeMap.set(key, ln.id);
  }
}

// 3. Match and update
let matched = 0;
let unmatched = 0;

for (const kn of unlinked) {
  const key = `${kn.subjectId}:${kn.topicName}`;
  const lessonNodeId = nodeMap.get(key) ?? null;

  if (lessonNodeId !== null) {
    await db
      .update(knowledgeNodesTable)
      .set({ lessonNodeId })
      .where(eq(knowledgeNodesTable.id, kn.id));
    matched++;
  } else {
    console.warn(
      `UNMATCHED: id=${kn.id}  topicName="${kn.topicName}"  subjectId=${kn.subjectId}  userId=${kn.userId}`
    );
    unmatched++;
  }
}

console.log(`\nSummary: matched=${matched}  unmatched=${unmatched}  total=${unlinked.length}`);
process.exit(0);
