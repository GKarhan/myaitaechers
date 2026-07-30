/**
 * One-time backfill: link existing courses to subjects by exact name match.
 * Run: pnpm --filter @workspace/scripts tsx backfill-courses-subjectid.ts
 */
import { db, coursesTable, subjectsTable } from "@workspace/db";
import { isNull, eq } from "drizzle-orm";

async function main() {
  const unlinked = await db
    .select({ id: coursesTable.id, name: coursesTable.name })
    .from(coursesTable)
    .where(isNull(coursesTable.subjectId));

  if (unlinked.length === 0) {
    console.log("No unlinked courses — nothing to do.");
    return;
  }

  const subjects = await db
    .select({ id: subjectsTable.id, name: subjectsTable.name })
    .from(subjectsTable);
  const subjectByName = new Map(subjects.map((s) => [s.name, s.id]));

  const matched: { courseId: number; courseName: string; subjectId: number }[] = [];
  const unmatched: { courseId: number; courseName: string }[] = [];

  for (const course of unlinked) {
    const subjectId = subjectByName.get(course.name);
    if (subjectId !== undefined) {
      matched.push({ courseId: course.id, courseName: course.name, subjectId });
    } else {
      unmatched.push({ courseId: course.id, courseName: course.name });
    }
  }

  for (const { courseId, courseName, subjectId } of matched) {
    await db.update(coursesTable).set({ subjectId }).where(eq(coursesTable.id, courseId));
    console.log(`✅  Linked course #${courseId} "${courseName}" → subject #${subjectId}`);
  }

  if (unmatched.length > 0) {
    console.log("\n⚠️  Unmatched courses (no subject with same name — fix manually via admin):");
    for (const { courseId, courseName } of unmatched) {
      console.log(`   course #${courseId}: "${courseName}"`);
    }
  } else {
    console.log("All courses linked.");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
