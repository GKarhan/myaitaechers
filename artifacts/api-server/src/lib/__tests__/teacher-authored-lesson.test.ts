import assert from "node:assert/strict";
import { lessonsTable, lessonOutcomesTable } from "@workspace/db";
import { createTeacherAuthoredLesson, parseAuthoredOutcomes } from "../teacher-authored-lesson.js";

assert.deepEqual(parseAuthoredOutcomes([" first ", "", "first", "second"]), {valid:true,outcomes:["first","second"]});
assert.equal(parseAuthoredOutcomes("first").valid, false);
assert.equal(parseAuthoredOutcomes([null]).valid, false);
assert.deepEqual(parseAuthoredOutcomes(undefined), {valid:true,outcomes:[]});

let committed: Array<{table: unknown; value: any}> = [];
let failOutcomes = false;
let transactions = 0;
const database = {
  transaction: async (fn: (tx: any) => Promise<unknown>) => {
    transactions++;
    const pending: typeof committed = [];
    const result = await fn({insert: (table: unknown) => ({values: (value: any) => {
      if (table === lessonOutcomesTable && failOutcomes) throw new Error("outcome write failed");
      pending.push({table,value});
      return table === lessonsTable ? {returning: async () => [{...value,id:901}]} : Promise.resolve();
    }})});
    committed.push(...pending);
    return result;
  },
} as unknown as Parameters<typeof createTeacherAuthoredLesson>[1];
const lesson = await createTeacherAuthoredLesson({title:"Test",subjectId:18,lessonGoal:"Goal",lessonOutcomes:[" first ","second"]}, database);
assert.equal(lesson.id, 901);
assert.equal(transactions, 1);
assert.equal(committed.length, 2);
assert.equal(committed[0].value.goalOutcomeReviewStatus, "draft");
assert.deepEqual(committed[1].value, [
  {lessonId:901,outcomeText:"first",sequence:1,status:"draft",provenance:"teacher_authored"},
  {lessonId:901,outcomeText:"second",sequence:2,status:"draft",provenance:"teacher_authored"},
]);
committed = [];
failOutcomes = true;
await assert.rejects(createTeacherAuthoredLesson({title:"Failure",subjectId:18,lessonOutcomes:["first"]}, database), /outcome write failed/);
assert.equal(committed.length, 0);
failOutcomes = false;
await createTeacherAuthoredLesson({title:"No draft",subjectId:18}, database);
assert.equal(committed.length, 1);
assert.equal(committed[0].value.goalOutcomeReviewStatus, undefined);
console.log("PASS authored lesson: canonical drafts on first save, one transaction, rollback on outcome failure, optional outcomes preserved");
