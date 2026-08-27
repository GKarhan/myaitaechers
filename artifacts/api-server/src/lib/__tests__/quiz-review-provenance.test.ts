import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import {
  db,
  lessonNodeCognitiveLevelsTable,
  lessonNodesTable,
  lessonsTable,
  quizQuestionsTable,
  quizzesTable,
  subjectsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../../app.js";
import { assertTestDb } from "./helpers/test-db.js";

assertTestDb();

const runId = `quiz_review_provenance_${Date.now()}_${process.pid}`;
const secret = process.env.SESSION_SECRET ?? "myaiteacher-secret";
const server = app.listen(0);
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

const [subject] = await db.insert(subjectsTable).values({
  name: `${runId}_subject`,
  grade: "test",
}).returning({ id: subjectsTable.id });
const [teacher] = await db.insert(usersTable).values({
  username: `${runId}_teacher`,
  passwordHash: "test",
  fullName: "Quiz review teacher",
  role: "teacher",
}).returning({ id: usersTable.id });
const [lesson] = await db.insert(lessonsTable).values({
  subjectId: subject.id,
  teacherId: teacher.id,
  title: `${runId}_lesson`,
}).returning({ id: lessonsTable.id });

const nodes = await db.insert(lessonNodesTable).values([
  { lessonId: lesson.id, sequence: 1, title: `${runId}_node_apply`, createdBy: "teacher" },
  { lessonId: lesson.id, sequence: 2, title: `${runId}_node_understand`, createdBy: "teacher" },
]).returning({ id: lessonNodesTable.id, title: lessonNodesTable.title });
const levels = await db.insert(lessonNodeCognitiveLevelsTable).values([
  {
    lessonNodeId: nodes[0]!.id,
    cognitiveLevel: "apply",
    sequence: 1,
    isApplicable: true,
    isTargetCeiling: true,
    provenance: "teacher_authored",
  },
  {
    lessonNodeId: nodes[1]!.id,
    cognitiveLevel: "understand",
    sequence: 1,
    isApplicable: true,
    isTargetCeiling: true,
    provenance: "teacher_authored",
  },
]).returning({ id: lessonNodeCognitiveLevelsTable.id });

const [quiz] = await db.insert(quizzesTable).values({
  teacherId: teacher.id,
  subjectId: subject.id,
  nodeIds: nodes.map((node) => node.id),
  title: `${runId}_quiz`,
  questionCount: 5,
  difficultyMode: "HARD",
  status: "DRAFT",
}).returning({ id: quizzesTable.id });

await db.insert(quizQuestionsTable).values([
  {
    quizId: quiz.id,
    nodeId: nodes[0]!.id,
    questionText: "Ինչպե՞ս գնահատել և ստեղծել լուծումը։",
    options: ["Ա", "Բ", "Գ", "Դ"],
    correctOptionIndex: 0,
    difficultyLevel: "HIGH",
    sequence: 1,
    cognitiveLevelId: levels[0]!.id,
  },
  {
    quizId: quiz.id,
    nodeId: nodes[1]!.id,
    questionText: "Բացատրեք հասկացությունը։",
    options: ["Ա", "Բ", "Գ", "Դ"],
    correctOptionIndex: 1,
    difficultyLevel: "HIGH",
    sequence: 2,
    cognitiveLevelId: levels[1]!.id,
  },
  {
    quizId: quiz.id,
    nodeId: nodes[0]!.id,
    questionText: "Կիրառեք կանոնը նոր օրինակում։",
    options: ["Ա", "Բ", "Գ", "Դ"],
    correctOptionIndex: 2,
    difficultyLevel: "LOW",
    sequence: 3,
    cognitiveLevelId: levels[0]!.id,
  },
  {
    quizId: quiz.id,
    nodeId: null,
    questionText: "Հին հարց առանց հանգույցի։",
    options: ["Ա", "Բ", "Գ", "Դ"],
    correctOptionIndex: 0,
    difficultyLevel: "MEDIUM",
    sequence: 4,
    cognitiveLevelId: null,
  },
  {
    quizId: quiz.id,
    nodeId: nodes[1]!.id,
    questionText: "Հին հարց առանց ճանաչողական մակարդակի։",
    options: ["Ա", "Բ", "Գ", "Դ"],
    correctOptionIndex: 3,
    difficultyLevel: "MEDIUM",
    sequence: 5,
    cognitiveLevelId: null,
  },
]);

const token = jwt.sign(
  { userId: teacher.id, role: "teacher", username: `${runId}_teacher` },
  secret,
  { expiresIn: "5m" },
);

try {
  const response = await fetch(`${baseUrl}/quizzes/${quiz.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    questions: Array<{
      nodeId: number | null;
      nodeTitle: string | null;
      cognitiveLevelId: number | null;
      cognitiveLevel: string | null;
      cognitiveLevelLabel: string | null;
      questionText: string;
      difficultyLevel: string;
    }>;
  };
  assert.equal(body.questions.length, 5);

  const [apply, understand, multiNode, missingNode, missingLevel] = body.questions;
  assert.deepEqual(
    {
      nodeId: apply!.nodeId,
      nodeTitle: apply!.nodeTitle,
      cognitiveLevelId: apply!.cognitiveLevelId,
      cognitiveLevel: apply!.cognitiveLevel,
      cognitiveLevelLabel: apply!.cognitiveLevelLabel,
    },
    {
      nodeId: nodes[0]!.id,
      nodeTitle: nodes[0]!.title,
      cognitiveLevelId: levels[0]!.id,
      cognitiveLevel: "apply",
      cognitiveLevelLabel: "Կիրառել",
    },
  );
  assert.equal(apply!.difficultyLevel, "HIGH");
  assert.equal(apply!.cognitiveLevelLabel, "Կիրառել");
  assert.equal(understand!.cognitiveLevelLabel, "Հասկանալ");
  assert.equal(multiNode!.nodeTitle, nodes[0]!.title);
  assert.equal(multiNode!.cognitiveLevelLabel, "Կիրառել");
  assert.equal(missingNode!.nodeId, null);
  assert.equal(missingNode!.nodeTitle, null);
  assert.equal(missingNode!.cognitiveLevelLabel, null);
  assert.equal(missingLevel!.nodeTitle, nodes[1]!.title);
  assert.equal(missingLevel!.cognitiveLevelId, null);
  assert.equal(missingLevel!.cognitiveLevelLabel, null);
  assert.match(apply!.questionText, /գնահատել|ստեղծել/);
  console.log("Teacher quiz review provenance: 7/7 assertions passed");
} finally {
  await db.delete(quizzesTable).where(eq(quizzesTable.id, quiz.id));
  await db.delete(lessonsTable).where(eq(lessonsTable.id, lesson.id));
  await db.delete(subjectsTable).where(eq(subjectsTable.id, subject.id));
  await db.delete(usersTable).where(eq(usersTable.id, teacher.id));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}