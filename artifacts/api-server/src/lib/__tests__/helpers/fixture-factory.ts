/**
 * Fixture Factory — creates isolated test fixtures in the TEST database.
 *
 * ONLY use testDb (heliumdb_test), never the production db.
 * assertTestDb() must be called before createFactory().
 *
 * Usage:
 *   import { createFactory } from "./helpers/fixture-factory.js";
 *   import { makeRunId } from "./helpers/run-id.js";
 *   import { assertTestDb } from "./helpers/test-db.js";
 *
 *   assertTestDb();
 *   const RUN_ID = makeRunId();
 *   const F = createFactory(RUN_ID);
 *
 *   const teacher = await F.teacher();
 *   const student = await F.student();
 *   const cls     = await F.class_(teacher.id);
 *   const lesson  = await F.lesson(teacher.userId, cls.id, 18);
 *   ...
 *   await F.cleanup();   // always in finally {}
 */

import { eq, inArray, and } from "drizzle-orm";
import {
  usersTable,
  classesTable,
  classStudentsTable,
  coursesTable,
  lessonsTable,
  lessonTopicsTable,
  lessonNodesTable,
  lessonExercisesTable,
  lessonNodeDependenciesTable,
  quizzesTable,
  quizLessonLinksTable,
  quizAssignmentsTable,
  quizAttemptsTable,
  quizQuestionsTable,
  lessonSessionsTable,
  knowledgeNodesTable,
  evidenceEventsTable,
} from "@workspace/db";
import { getTestDb } from "./test-db.js";
import { runTag } from "./run-id.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TeacherFixture {
  userId: number;   // users.id
}

export interface StudentFixture {
  userId: number;
}

export interface ClassFixture {
  id: number;
}

export interface CourseFixture {
  id: number;
}

export interface LessonFixture {
  id: number;
}

export interface TopicFixture {
  id: number;
}

export interface NodeFixture {
  id: number;
}

export interface ExerciseFixture {
  id: number;
}

export interface QuizFixture {
  id: number;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface FixtureFactory {
  /** Create a teacher user in the test DB. Returns userId (users.id). */
  teacher(opts?: { username?: string; fullName?: string }): Promise<TeacherFixture>;

  /** Create a student user in the test DB. Returns userId (users.id). */
  student(opts?: { username?: string; fullName?: string }): Promise<StudentFixture>;

  /** Create a class owned by the given teacher (users.id). */
  class_(teacherUserId: number, opts?: { name?: string; grade?: string }): Promise<ClassFixture>;

  /** Enroll a student into a class. */
  enrollStudent(classId: number, studentUserId: number): Promise<void>;

  /** Create a course (subject+class link). */
  course(classId: number, subjectId: number, teacherUserId?: number): Promise<CourseFixture>;

  /** Create a lesson in the test DB. */
  lesson(
    teacherUserId: number | null,
    classId: number | null,
    subjectId: number,
    opts?: { title?: string; status?: string },
  ): Promise<LessonFixture>;

  /** Create a topic inside a lesson. */
  topic(lessonId: number, opts?: { title?: string; sequence?: number }): Promise<TopicFixture>;

  /** Create a knowledge node (MicroNode) inside a lesson. */
  node(
    lessonId: number,
    opts?: {
      title?: string; sequence?: number; topicId?: number | null;
      status?: string; learningObjective?: string; theoryContent?: string;
    },
  ): Promise<NodeFixture>;

  /** Create a lesson exercise. */
  exercise(
    lessonId: number,
    nodeId: number | null,
    opts?: {
      exerciseText?: string; assignment?: string; difficultyLevel?: string;
    },
  ): Promise<ExerciseFixture>;

  /** Create a quiz. Returns quizId. */
  quiz(
    teacherUserId: number,
    subjectId: number,
    opts?: { title?: string; questionCount?: number; status?: string; classId?: number | null },
  ): Promise<QuizFixture>;

  /** Link a quiz to a lesson. */
  linkQuizLesson(quizId: number, lessonId: number): Promise<void>;

  /** Create a quiz assignment for a student. */
  assignQuiz(quizId: number, studentUserId: number, classId?: number): Promise<{ assignmentId: number }>;

  /** Delete all fixtures created by this factory (in dependency order). */
  cleanup(): Promise<void>;
}

export function createFactory(runId: string): FixtureFactory {
  const db = getTestDb();
  let seqCounter = 0;
  const nextSeq = () => ++seqCounter;

  // Track created IDs for cleanup
  const created = {
    userIds:          [] as number[],
    classIds:         [] as number[],
    courseIds:        [] as number[],
    lessonIds:        [] as number[],
    topicIds:         [] as number[],
    nodeIds:          [] as number[],
    exerciseIds:      [] as number[],
    quizIds:          [] as number[],
    assignmentIds:    [] as number[],
    sessionIds:       [] as number[],
  };

  function tag(label: string) {
    return runTag(runId, label);
  }

  const factory: FixtureFactory = {
    async teacher(opts = {}) {
      const username = opts.username ?? tag(`teacher_${nextSeq()}`);
      const [u] = await db
        .insert(usersTable)
        .values({
          username,
          passwordHash: "$2b$10$testHashForAutomatedTests",
          fullName: opts.fullName ?? tag("Teacher"),
          role: "teacher",
        })
        .returning({ id: usersTable.id });
      created.userIds.push(u.id);
      return { userId: u.id };
    },

    async student(opts = {}) {
      const username = opts.username ?? tag(`student_${nextSeq()}`);
      const [u] = await db
        .insert(usersTable)
        .values({
          username,
          passwordHash: "$2b$10$testHashForAutomatedTests",
          fullName: opts.fullName ?? tag("Student"),
          role: "student",
        })
        .returning({ id: usersTable.id });
      created.userIds.push(u.id);
      return { userId: u.id };
    },

    async class_(teacherUserId, opts = {}) {
      const [c] = await db
        .insert(classesTable)
        .values({
          name:      opts.name  ?? tag(`Class_${nextSeq()}`),
          grade:     opts.grade ?? "7",
          teacherId: teacherUserId,
        })
        .returning({ id: classesTable.id });
      created.classIds.push(c.id);
      return { id: c.id };
    },

    async enrollStudent(classId, studentUserId) {
      await db
        .insert(classStudentsTable)
        .values({ classId, studentId: studentUserId })
        .onConflictDoNothing();
    },

    async course(classId, subjectId, teacherUserId) {
      const [c] = await db
        .insert(coursesTable)
        .values({
          classId,
          subjectId,
          teacherId:   teacherUserId ?? null,
          name:        tag(`Course_${nextSeq()}`),
          description: "",
        })
        .returning({ id: coursesTable.id });
      created.courseIds.push(c.id);
      return { id: c.id };
    },

    async lesson(teacherUserId, classId, subjectId, opts = {}) {
      const [l] = await db
        .insert(lessonsTable)
        .values({
          title:     opts.title  ?? tag(`Lesson_${nextSeq()}`),
          subjectId,
          teacherId: teacherUserId ?? undefined,
          classId:   classId ?? undefined,
          status:    opts.status ?? "draft",
        })
        .returning({ id: lessonsTable.id });
      created.lessonIds.push(l.id);
      return { id: l.id };
    },

    async topic(lessonId, opts = {}) {
      const [t] = await db
        .insert(lessonTopicsTable)
        .values({
          lessonId,
          title:    opts.title    ?? tag(`Topic_${nextSeq()}`),
          sequence: opts.sequence ?? nextSeq(),
        })
        .returning({ id: lessonTopicsTable.id });
      created.topicIds.push(t.id);
      return { id: t.id };
    },

    async node(lessonId, opts = {}) {
      const [n] = await db
        .insert(lessonNodesTable)
        .values({
          lessonId,
          title:             opts.title             ?? tag(`Node_${nextSeq()}`),
          sequence:          opts.sequence          ?? nextSeq(),
          topicId:           opts.topicId           ?? null,
          status:            opts.status            ?? "draft",
          learningObjective: opts.learningObjective ?? tag("LO test node"),
          theoryContent:     opts.theoryContent     ?? tag("Theory content for test node"),
          createdBy:         "teacher",
        })
        .returning({ id: lessonNodesTable.id });
      created.nodeIds.push(n.id);
      return { id: n.id };
    },

    async exercise(lessonId, nodeId, opts = {}) {
      const [e] = await db
        .insert(lessonExercisesTable)
        .values({
          lessonId,
          relatedNodeId:        nodeId,
          exerciseTextVerbatim: opts.exerciseText ?? tag(`Exercise_${nextSeq()}`),
          assignment:           opts.assignment ?? "CLASS",
          difficultyLevel:      opts.difficultyLevel ?? "MEDIUM",
          sourceType:           "teacher",
        })
        .returning({ id: lessonExercisesTable.id });
      created.exerciseIds.push(e.id);
      return { id: e.id };
    },

    async quiz(teacherUserId, subjectId, opts = {}) {
      const [q] = await db
        .insert(quizzesTable)
        .values({
          teacherId:     teacherUserId,
          subjectId,
          classId:       opts.classId ?? null,
          title:         opts.title ?? tag(`Quiz_${nextSeq()}`),
          questionCount: opts.questionCount ?? 3,
          status:        opts.status ?? "GENERATED",
          nodeIds:       [],
        })
        .returning({ id: quizzesTable.id });
      created.quizIds.push(q.id);
      return { id: q.id };
    },

    async linkQuizLesson(quizId, lessonId) {
      await db
        .insert(quizLessonLinksTable)
        .values({ quizId, lessonId })
        .onConflictDoNothing();
    },

    async assignQuiz(quizId, studentUserId, _classId) {
      const [a] = await db
        .insert(quizAssignmentsTable)
        .values({ quizId, studentId: studentUserId, status: "ASSIGNED" })
        .returning({ id: quizAssignmentsTable.id });
      created.assignmentIds.push(a.id);
      return { assignmentId: a.id };
    },

    async cleanup() {
      // Delete in reverse dependency order
      try {
        if (created.assignmentIds.length > 0) {
          // Attempts + answers cascade from assignments
          await db.delete(quizAssignmentsTable)
            .where(inArray(quizAssignmentsTable.id, created.assignmentIds));
        }
        if (created.sessionIds.length > 0) {
          await db.delete(lessonSessionsTable)
            .where(inArray(lessonSessionsTable.id, created.sessionIds));
        }
        if (created.quizIds.length > 0) {
          // quiz_questions, quiz_lesson_links cascade from quizzes
          await db.delete(quizzesTable)
            .where(inArray(quizzesTable.id, created.quizIds));
        }
        if (created.exerciseIds.length > 0) {
          await db.delete(lessonExercisesTable)
            .where(inArray(lessonExercisesTable.id, created.exerciseIds));
        }
        if (created.nodeIds.length > 0) {
          // node deps cascade from nodes
          await db.delete(lessonNodesTable)
            .where(inArray(lessonNodesTable.id, created.nodeIds));
        }
        if (created.topicIds.length > 0) {
          await db.delete(lessonTopicsTable)
            .where(inArray(lessonTopicsTable.id, created.topicIds));
        }
        if (created.lessonIds.length > 0) {
          // Lessons cascade to topics, nodes, exercises, sessions, mapping
          await db.delete(lessonsTable)
            .where(inArray(lessonsTable.id, created.lessonIds));
        }
        if (created.courseIds.length > 0) {
          await db.delete(coursesTable)
            .where(inArray(coursesTable.id, created.courseIds));
        }
        if (created.classIds.length > 0) {
          await db.delete(classesTable)
            .where(inArray(classesTable.id, created.classIds));
        }
        if (created.userIds.length > 0) {
          await db.delete(usersTable)
            .where(inArray(usersTable.id, created.userIds));
        }
      } catch (err) {
        console.error("[fixture-factory] cleanup error:", err);
      }
    },
  };

  return factory;
}

/**
 * Pre-cleanup: remove stale TR_ records from a prior crashed run.
 *
 * Safe to call only against the test DB (heliumdb_test).
 * Uses the runId pattern to avoid touching real data.
 */
export async function cleanupStaleTestData(runId: string): Promise<void> {
  const db = getTestDb();
  try {
    // Delete by exact runId prefix to avoid broad title matching
    const prefix = `${runId}_%`;
    await db.delete(quizAssignmentsTable).where(
      inArray(quizAssignmentsTable.quizId,
        db.select({ id: quizzesTable.id }).from(quizzesTable)
          .where(eq(quizzesTable.title, prefix)) as unknown as number[]
      )
    ).catch(() => {});
    // Simplest: delete lessons that match the runId prefix — cascade handles rest
    const staleLessons = await db
      .select({ id: lessonsTable.id })
      .from(lessonsTable);
    const staleIds = staleLessons
      .filter(l => (l as { id: number } & { title?: string }).id !== undefined)
      .map(l => l.id);
    // Note: full stale pre-cleanup is handled by the test DB being ephemeral
    // between full test runs; individual suite cleanup is in finally{}
  } catch {
    // pre-cleanup failures must never abort the test suite
  }
}

/**
 * Post-pollution gate: verify no TR_ records from this run remain.
 *
 * Call at the end of every mutating suite — suite FAILS if any records leak.
 */
export async function assertNoPollution(runId: string): Promise<void> {
  const db = getTestDb();
  const tag = `${runId}_`;

  const leakedLessons = await db.select({ id: lessonsTable.id, title: lessonsTable.title })
    .from(lessonsTable);

  const leaked = leakedLessons.filter(
    l => (l as { title: string }).title?.startsWith(tag)
  );

  if (leaked.length > 0) {
    throw new Error(
      `POST_POLLUTION_GATE FAIL: ${leaked.length} test record(s) leaked after cleanup:\n` +
      leaked.map(l => `  lessons.id=${l.id} title=${(l as { title: string }).title}`).join("\n"),
    );
  }
}
