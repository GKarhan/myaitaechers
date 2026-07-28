import { Router } from "express";
import { db, subjectsTable, knowledgeNodesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

function getMasteryLevel(score: number, status: string): "mastered" | "weak" | "not_started" {
  if (status === "not_started" || score === 0) return "not_started";
  if (score >= 80) return "mastered";
  if (score >= 50) return "weak";
  return "not_started";
}

const router = Router();

router.get(
  "/knowledge-tree/:subjectId",
  requireAuth,
  async (req: AuthRequest, res) => {
    const subjectId = parseInt(String(req.params.subjectId), 10);
    if (isNaN(subjectId)) {
      res.status(400).json({ error: "Invalid subject id" });
      return;
    }

    const [subject] = await db
      .select()
      .from(subjectsTable)
      .where(eq(subjectsTable.id, subjectId))
      .limit(1);

    if (!subject) {
      res.status(404).json({ error: "Subject not found" });
      return;
    }

    const topics = await db
      .select()
      .from(knowledgeNodesTable)
      .where(
        and(
          eq(knowledgeNodesTable.subjectId, subjectId),
          eq(knowledgeNodesTable.userId, req.userId!)
        )
      )
      .orderBy(knowledgeNodesTable.id);

    const mappedTopics = topics.map((t) => ({
      id: t.id,
      topicName: t.topicName,
      score: t.masteryScore ?? 0,
      status: t.status,
      masteryLevel: getMasteryLevel(t.masteryScore ?? 0, t.status),
    }));

    // Build AI recommendations
    const recommendations: Array<{
      type: "start" | "review" | "repeat";
      message: string;
      topicName: string;
    }> = [];

    const notStarted = mappedTopics.filter((t) => t.masteryLevel === "not_started");
    const weak = mappedTopics.filter((t) => t.masteryLevel === "weak");
    const mastered = mappedTopics.filter((t) => t.masteryLevel === "mastered");

    if (notStarted.length > 0) {
      recommendations.push({
        type: "start",
        message: `Սկսեք «${notStarted[0].topicName}» թեմայից`,
        topicName: notStarted[0].topicName,
      });
    }
    if (weak.length > 0) {
      const weakest = weak.reduce((a, b) => (a.score < b.score ? a : b));
      recommendations.push({
        type: "review",
        message: `Կրկնեք «${weakest.topicName}» թեման — գնահատականը ${weakest.score}%`,
        topicName: weakest.topicName,
      });
    }
    if (mastered.length > 0) {
      const oldest = mastered[0];
      recommendations.push({
        type: "repeat",
        message: `Կրկնեք «${oldest.topicName}» — ամրապնդեք գիտելիքը`,
        topicName: oldest.topicName,
      });
    }

    res.json({
      subjectId: subject.id,
      subjectName: subject.name,
      topics: mappedTopics,
      recommendations,
    });
  }
);

export default router;
