import {
  db,
  lessonsTable,
  lessonNodesTable,
  mappingJobsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

/** Serialize check + claim across API instances, without holding a connection
 * during AI work. The durable pending row owns the operation after commit.
 * Stale claims are never automatically released: age does not prove a worker died.
 */
export async function claimMappingStage(
  lessonId: number,
  jobType: "map" | "generate_teaching_content",
) {
  return db.transaction(async (tx) => {
    const [lesson] = await tx
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(eq(lessonsTable.id, lessonId))
      .for("update");
    if (!lesson) return { error: "LESSON_NOT_FOUND" } as const;
    const [active] = await tx
      .select({ id: mappingJobsTable.id })
      .from(mappingJobsTable)
      .where(
        and(
          eq(mappingJobsTable.lessonId, lessonId),
          inArray(mappingJobsTable.jobType, [
            "map",
            "generate_teaching_content",
            "generate_cognitive_paths",
          ]),
          inArray(mappingJobsTable.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    if (active)
      return {
        error: "MAPPING_ALREADY_IN_PROGRESS",
        jobId: active.id,
      } as const;
    if (jobType === "map") {
      const [node] = await tx
        .select({ id: lessonNodesTable.id })
        .from(lessonNodesTable)
        .where(eq(lessonNodesTable.lessonId, lessonId))
        .limit(1);
      if (node)
        return { error: "EXISTING_MAP_REQUIRES_EXPLICIT_REPLACEMENT" } as const;
    }
    const [job] = await tx
      .insert(mappingJobsTable)
      .values({ lessonId, jobType, status: "pending" })
      .onConflictDoNothing()
      .returning();
    if (!job) return { error: "MAPPING_ALREADY_IN_PROGRESS" } as const;
    return { job } as const;
  });
}
