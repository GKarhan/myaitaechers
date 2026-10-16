import {
  db,
  lessonsTable,
  lessonNodesTable,
  lessonNodeCognitiveLevelsTable,
  mappingJobsTable,
} from "@workspace/db";
import { and, eq, inArray, desc } from "drizzle-orm";
import {
  hasCompleteTeachingContent,
  requiresExplicitTeacherReview,
} from "../lib/teaching-content-readiness.js";
import {
  decideUnifiedResume,
  type JobState,
} from "./unified-mapping-resume-policy.js";

export async function readUnifiedMappingResume(lessonId: number) {
  // One consistent read snapshot: never mix pre-C1 nodes with post-C1 job status.
  return db.transaction(
    async (tx) => {
      const [lesson] = await tx
        .select()
        .from(lessonsTable)
        .where(eq(lessonsTable.id, lessonId))
        .limit(1);
      if (!lesson) throw new Error("LESSON_NOT_FOUND");
      const nodes = await tx
        .select()
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.lessonId, lessonId));
      const jobs = await tx
        .select()
        .from(mappingJobsTable)
        .where(
          and(
            eq(mappingJobsTable.lessonId, lessonId),
            inArray(mappingJobsTable.jobType, [
              "map",
              "generate_cognitive_paths",
              "generate_teaching_content",
            ]),
          ),
        )
        .orderBy(desc(mappingJobsTable.id));
      const ids = nodes.map((n) => n.id);
      const levels = ids.length
        ? await tx
            .select()
            .from(lessonNodeCognitiveLevelsTable)
            .where(inArray(lessonNodeCognitiveLevelsTable.lessonNodeId, ids))
        : [];
      const latest = (kind: string) => jobs.find((j) => j.jobType === kind);
      const state = (kind: string): JobState => {
        const status = latest(kind)?.status ?? "none";
        return [
          "pending",
          "running",
          "completed",
          "failed",
          "coverage_failed",
          "none",
        ].includes(status)
          ? (status as JobState)
          : "failed";
      };
      const active = jobs.filter(
        (j) => j.status === "pending" || j.status === "running",
      );
      const metadata = lesson.mappingMetadata as Record<string, any> | null;
      const quality = metadata?.quality;
      const byNode = nodes.map((n) =>
        levels.filter((l) => l.lessonNodeId === n.id),
      );
      const snapshot = {
        activeC1: state("map"),
        activeC2: state("generate_cognitive_paths"),
        activeTeaching: state("generate_teaching_content"),
        // Diagnostic only. No timeout-based unlocking or automatic destructive retry.
        staleActiveJob: active.some(
          (j) => Date.now() - j.updatedAt.getTime() > 30 * 60_000,
        ),
        hasCanonicalNodes: nodes.length > 0,
        c1SourceVerified:
          quality?.sourceAudit?.sourceScope?.valid === true &&
          quality?.sourceAudit?.sourceSet?.titleMatch?.valid === true &&
          quality?.coverageValidation?.valid === true &&
          quality?.instructionalCoverage?.valid === true &&
          !nodes.some((n) => requiresExplicitTeacherReview(n.changeReason)),
        c2MissingCount: byNode.filter((path) => path.length === 0).length,
        invalidC2Count: byNode.filter(
          (path) =>
            path.length > 0 &&
            path.filter((l) => l.isTargetCeiling).length !== 1,
        ).length,
        teachingMissingCount: nodes.filter(
          (n) => !hasCompleteTeachingContent(n),
        ).length,
        hasTeacherEdits:
          nodes.some(
            (n) =>
              n.createdBy === "teacher" ||
              n.reviewedBy !== null ||
              n.version > 1,
          ) || levels.some((l) => l.provenance === "teacher_authored"),
      };
      const decision = decideUnifiedResume(snapshot);
      return {
        lessonId,
        ...decision,
        snapshot,
        activeJobs: active.map((j) => ({
          jobId: j.id,
          jobType: j.jobType,
          status: j.status,
          progress: j.progress,
          updatedAt: j.updatedAt,
        })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
