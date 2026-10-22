import assert from "node:assert/strict";
import { composePreparedTheory, selectPreparedTeachingItems, PreparedTeachingUnavailableError, type PreparedTeachingItem } from "../prepared-teaching.js";
const target = { lessonId: 7, microNodeId: 11, cognitiveLevel: "understand" };
const row = (id: number, change: Partial<PreparedTeachingItem> = {}): PreparedTeachingItem => ({
  id, lessonId: 7, lessonNodeId: 11, cognitiveLevel: null,
  itemType: "MAIN_EXPLANATION", content: `content-${id}`, status: "approved", isPrimary: false, sequence: id,
  ...change,
});
const invalid = [row(1, { status: "draft" }), row(2, { status: "reviewed" }),
  row(3, { lessonId: 8 }), row(4, { lessonNodeId: 12 }),
  row(5, { cognitiveLevel: "create" }), row(6, { content: " " })];
assert.deepEqual(selectPreparedTeachingItems(invalid, target, "MAIN_EXPLANATION"), []);
assert.throws(() => composePreparedTheory(invalid, target, "Node"), PreparedTeachingUnavailableError);
const items = [...invalid, row(9), row(10, { isPrimary: true }),
  row(14, { itemType: "EXAMPLE", sequence: 2 }), row(13, { itemType: "EXAMPLE", sequence: 1 }),
  row(15, { itemType: "EXAMPLE", sequence: 3 }), row(16, { itemType: "HINT" })];
const result = composePreparedTheory(items, target, "Node");
assert.deepEqual(result.itemIds, [10, 13, 14]);
assert.equal(result.student_message, "Node\n\ncontent-10\n\ncontent-13\n\ncontent-14");
assert.equal(selectPreparedTeachingItems(items, target, "HINT")[0].id, 16);
assert.equal(selectPreparedTeachingItems([row(18), row(19, { cognitiveLevel: "understand" })], target, "MAIN_EXPLANATION")[0].id, 19);
assert.deepEqual(composePreparedTheory([row(1)], target, "Node").itemIds, [1]);
console.log("Prepared teaching: scope, approval, cognitive level, primary selection, ordering, no legacy fallback and help selection passed.");
