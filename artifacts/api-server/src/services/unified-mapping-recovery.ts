import { db, lessonsTable, mappingJobsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const INTERRUPTED_JOB_RETIRED = "INTERRUPTED_JOB_RETIRED";
export const STALE_MAPPING_MS = 30 * 60_000;
export const activeMappingJob = (jobId: number) =>
  and(
    eq(mappingJobsTable.id, jobId),
    inArray(mappingJobsTable.status, ["pending", "running"]),
  );

/** Every canonical worker write must hold these locks until commit.
 * A retired job ID can never regain write authority, even if its provider
 * responds after a replacement worker has started.
 */
export async function assertActiveMappingWriter(
  tx: Transaction,
  lessonId: number,
  jobId: number,
) {
  await tx
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .for("update");
  const [job] = await tx
    .select({ id: mappingJobsTable.id })
    .from(mappingJobsTable)
    .where(
      and(activeMappingJob(jobId), eq(mappingJobsTable.lessonId, lessonId)),
    )
    .for("update");
  if (!job) throw new Error("MAPPING_WORKER_RETIRED");
}

/** Explicit teacher takeover, not proof of process death. No map data is removed.
 * Compare the observed timestamp under the lock so a fresh heartbeat wins.
 */
export async function retireInterruptedMapping(
  lessonId: number,
  jobId: number,
  observedUpdatedAt: string,
  confirmed: boolean,
  database = db,
) {
  if (confirmed !== true)
    return { error: "RECOVERY_CONFIRMATION_REQUIRED" } as const;
  return database.transaction(async (tx) => {
    await tx
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(eq(lessonsTable.id, lessonId))
      .for("update");
    const [job] = await tx
      .select()
      .from(mappingJobsTable)
      .where(
        and(
          eq(mappingJobsTable.id, jobId),
          eq(mappingJobsTable.lessonId, lessonId),
        ),
      )
      .for("update");
    if (
      !job ||
      ![
        "map",
        "generate_cognitive_paths",
        "generate_teaching_content",
      ].includes(job.jobType)
    )
      return { error: "MAPPING_JOB_NOT_FOUND" } as const;
    if (
      (job.result as { recoveryFenceVersion?: number } | null)
        ?.recoveryFenceVersion !== 1
    )
      return { error: "LEGACY_WORKER_REQUIRES_OPERATOR_REVIEW" } as const;
    if (!["pending", "running"].includes(job.status))
      return { error: "JOB_ALREADY_TERMINAL" } as const;
    if (
      job.updatedAt.toISOString() !== observedUpdatedAt ||
      Date.now() - job.updatedAt.getTime() <= STALE_MAPPING_MS
    )
      return { error: "JOB_UPDATED_OR_NOT_STALE" } as const;
    await tx
      .update(mappingJobsTable)
      .set({
        status: "failed",
        error: INTERRUPTED_JOB_RETIRED,
        updatedAt: new Date(),
      })
      .where(activeMappingJob(jobId));
    return { retiredJobId: jobId } as const;
  });
}
