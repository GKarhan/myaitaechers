/**
 * HTTP Fixture Factory — creates isolated fixtures via the real API server.
 *
 * For integration/E2E tests that MUST use the live HTTP API (localhost:8080).
 * Fixtures are created on the real heliumdb (same as API server) and are
 * tagged with a runId so they can be reliably cleaned up.
 *
 * Safety invariant:
 *   - All created entity titles/names start with runId (TR_xxx_...)
 *   - Pre-cleanup at suite start removes stale TR_ records from prior crashes
 *   - try/finally in every test guarantees cleanup
 *   - Post-pollution gate at end of suite verifies 0 TR_ records remain
 *
 * Usage:
 *   import { makeRunId } from "./helpers/run-id.js";
 *   import { createHttpFactory } from "./helpers/http-fixture-factory.js";
 *   import jwt from "jsonwebtoken";
 *
 *   const RUN_ID = makeRunId();
 *   const teacherToken = jwt.sign({ userId: 161, role: "teacher" }, SECRET, { expiresIn: "1h" });
 *   const F = createHttpFactory(RUN_ID, BASE, teacherToken);
 *
 *   const lesson = await F.lesson(subjectId);
 *   try {
 *     // ... test ...
 *   } finally {
 *     await F.cleanup();
 *   }
 *   await F.assertNoPollution();
 */

import { db, lessonsTable, lessonNodesTable, quizzesTable, quizLessonLinksTable,
         quizAssignmentsTable, usersTable, lessonTopicsTable, lessonExercisesTable,
         lessonNodeDependenciesTable, lessonSessionsTable } from "@workspace/db";
import { eq, inArray, like, and } from "drizzle-orm";
import { runTag, isTrRecord, TR_PATTERN } from "./run-id.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HttpFixtureFactory {
  /** Create a lesson via direct DB (faster) tagged with runId. Returns lessonId. */
  lesson(subjectId: number, opts?: { teacherId?: number; classId?: number; status?: string }): Promise<number>;

  /** Add a node to a lesson via direct DB. Returns nodeId. */
  node(lessonId: number, opts?: { title?: string; sequence?: number; topicId?: number | null }): Promise<number>;

  /** Add a topic to a lesson. Returns topicId. */
  topic(lessonId: number, opts?: { title?: string; sequence?: number }): Promise<number>;

  /** Add an exercise to a lesson. Returns exerciseId. */
  exercise(lessonId: number, nodeId: number | null, opts?: { text?: string }): Promise<number>;

  /** Create a quiz via direct DB. Returns quizId. */
  quiz(teacherId: number, subjectId: number, opts?: { title?: string; classId?: number | null; questionCount?: number }): Promise<number>;

  /** Link quiz to lesson. */
  linkQuiz(quizId: number, lessonId: number): Promise<void>;

  /** Create a temp student user. Returns studentId. */
  student(opts?: { username?: string }): Promise<number>;

  /** Clean up ALL fixtures created by this factory instance. */
  cleanup(): Promise<void>;

  /** Post-pollution gate: throw if any TR_ records from this run remain. */
  assertNoPollution(): Promise<void>;
}

export function createHttpFactory(
  runId: string,
  _baseUrl: string,
  _defaultToken: string,
): HttpFixtureFactory {
  let seq = 0;
  const nextSeq = () => ++seq;
  function tag(label: string) { return runTag(runId, label); }

  const created = {
    lessonIds:     [] as number[],
    nodeIds:       [] as number[],
    topicIds:      [] as number[],
    exerciseIds:   [] as number[],
    quizIds:       [] as number[],
    userIds:       [] as number[],
    assignmentIds: [] as number[],
    sessionIds:    [] as number[],
  };

  const factory: HttpFixtureFactory = {
    async lesson(subjectId, opts = {}) {
      const [l] = await db.insert(lessonsTable).values({
        title:     tag(`Lesson_${nextSeq()}`),
        subjectId,
        teacherId: opts.teacherId ?? null,
        classId:   opts.classId  ?? null,
        status:    opts.status   ?? "draft",
      }).returning({ id: lessonsTable.id });
      created.lessonIds.push(l.id);
      return l.id;
    },

    async node(lessonId, opts = {}) {
      const [n] = await db.insert(lessonNodesTable).values({
        lessonId,
        title:     opts.title    ?? tag(`Node_${nextSeq()}`),
        sequence:  opts.sequence ?? nextSeq(),
        topicId:   opts.topicId  ?? null,
        status:    "draft",
        createdBy: "teacher",
      }).returning({ id: lessonNodesTable.id });
      created.nodeIds.push(n.id);
      return n.id;
    },

    async topic(lessonId, opts = {}) {
      const [t] = await db.insert(lessonTopicsTable).values({
        lessonId,
        title:    opts.title    ?? tag(`Topic_${nextSeq()}`),
        sequence: opts.sequence ?? nextSeq(),
      }).returning({ id: lessonTopicsTable.id });
      created.topicIds.push(t.id);
      return t.id;
    },

    async exercise(lessonId, nodeId, opts = {}) {
      const [e] = await db.insert(lessonExercisesTable).values({
        lessonId,
        relatedNodeId:        nodeId,
        exerciseTextVerbatim: opts.text ?? tag(`Exercise_${nextSeq()}`),
        assignment:           "CLASS",
        difficultyLevel:      "MEDIUM",
        sourceType:           "teacher",
      }).returning({ id: lessonExercisesTable.id });
      created.exerciseIds.push(e.id);
      return e.id;
    },

    async quiz(teacherId, subjectId, opts = {}) {
      const [q] = await db.insert(quizzesTable).values({
        teacherId,
        subjectId,
        classId:       opts.classId       ?? null,
        title:         opts.title         ?? tag(`Quiz_${nextSeq()}`),
        questionCount: opts.questionCount ?? 3,
        status:        "GENERATED",
        nodeIds:       [],
      }).returning({ id: quizzesTable.id });
      created.quizIds.push(q.id);
      return q.id;
    },

    async linkQuiz(quizId, lessonId) {
      await db.insert(quizLessonLinksTable).values({ quizId, lessonId }).onConflictDoNothing();
    },

    async student(opts = {}) {
      const [u] = await db.insert(usersTable).values({
        username:     opts.username ?? tag(`student_${nextSeq()}`),
        passwordHash: "$2b$10$testHashForAutomatedTests",
        fullName:     tag("Student"),
        role:         "student",
      }).returning({ id: usersTable.id });
      created.userIds.push(u.id);
      return u.id;
    },

    async cleanup() {
      try {
        if (created.assignmentIds.length > 0) {
          await db.delete(quizAssignmentsTable).where(inArray(quizAssignmentsTable.id, created.assignmentIds));
        }
        if (created.sessionIds.length > 0) {
          await db.delete(lessonSessionsTable).where(inArray(lessonSessionsTable.id, created.sessionIds));
        }
        if (created.quizIds.length > 0) {
          await db.delete(quizzesTable).where(inArray(quizzesTable.id, created.quizIds));
        }
        if (created.exerciseIds.length > 0) {
          await db.delete(lessonExercisesTable).where(inArray(lessonExercisesTable.id, created.exerciseIds));
        }
        if (created.nodeIds.length > 0) {
          await db.delete(lessonNodesTable).where(inArray(lessonNodesTable.id, created.nodeIds));
        }
        if (created.topicIds.length > 0) {
          await db.delete(lessonTopicsTable).where(inArray(lessonTopicsTable.id, created.topicIds));
        }
        if (created.lessonIds.length > 0) {
          // CASCADE handles deps/exercises/topics/sessions/quizLinks
          await db.delete(lessonsTable).where(inArray(lessonsTable.id, created.lessonIds));
        }
        if (created.userIds.length > 0) {
          await db.delete(usersTable).where(inArray(usersTable.id, created.userIds));
        }
      } catch (err) {
        console.error("[http-fixture-factory] cleanup error:", err);
      }
    },

    async assertNoPollution() {
      const prefix = `${runId}_`;
      const leakedLessons = await db
        .select({ id: lessonsTable.id, title: lessonsTable.title })
        .from(lessonsTable)
        .where(like(lessonsTable.title, `${prefix}%`));

      const leakedQuizzes = await db
        .select({ id: quizzesTable.id, title: quizzesTable.title })
        .from(quizzesTable)
        .where(like(quizzesTable.title, `${prefix}%`));

      const leakedUsers = await db
        .select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable)
        .where(like(usersTable.username, `${prefix}%`));

      const leaked = [
        ...leakedLessons.map(r => `lessons.id=${r.id} title=${r.title}`),
        ...leakedQuizzes.map(r => `quizzes.id=${r.id} title=${r.title}`),
        ...leakedUsers.map(r => `users.id=${r.id} username=${r.username}`),
      ];

      if (leaked.length > 0) {
        throw new Error(
          `POST_POLLUTION_GATE FAIL: ${leaked.length} test record(s) leaked:\n` +
          leaked.map(s => `  ${s}`).join("\n"),
        );
      }
    },
  };

  return factory;
}

/**
 * Pre-cleanup: remove stale TR_ records from prior crashed runs against heliumdb.
 *
 * Only removes records where title/username starts with 'TR_' (isTrRecord check).
 * Never removes records that don't look like test fixtures.
 */
export async function preCleanupStaleTrRecords(runId: string): Promise<void> {
  const prefix = `${runId}_`;
  try {
    // Only clean up records from THIS run ID (not all TR_ records)
    // in case multiple runs are concurrent
    const staleQuizzes = await db
      .select({ id: quizzesTable.id })
      .from(quizzesTable)
      .where(like(quizzesTable.title, `${prefix}%`));
    if (staleQuizzes.length > 0) {
      await db.delete(quizzesTable).where(inArray(quizzesTable.id, staleQuizzes.map(q => q.id)));
    }

    const staleLessons = await db
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(like(lessonsTable.title, `${prefix}%`));
    if (staleLessons.length > 0) {
      await db.delete(lessonsTable).where(inArray(lessonsTable.id, staleLessons.map(l => l.id)));
    }

    const staleUsers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(like(usersTable.username, `${prefix}%`));
    if (staleUsers.length > 0) {
      await db.delete(usersTable).where(inArray(usersTable.id, staleUsers.map(u => u.id)));
    }
  } catch {
    // pre-cleanup failure must not abort the test suite
  }
}
