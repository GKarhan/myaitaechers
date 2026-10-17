import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { reviewC1MicroNodeIntegrity } from "./c1-micronode-integrity.js";

const node = (title: string, learningObjective: string, sourceBlockIndices: number[]) => ({ title, learningObjective, sourceBlockIndices });
describe("C1 MicroNode structural integrity", () => {
  it("accepts distinct sourced goals", () => {
    assert.deepEqual(reviewC1MicroNodeIntegrity([{microNodes:[node("Nature","Define nature",[0]),node("Events","Explain events",[1])]}],2),[]);
  });
  it("reports empty title, missing goal and missing source", () => {
    const codes=reviewC1MicroNodeIntegrity([{microNodes:[node("","",[])]}],2).map(f=>f.code);
    assert.deepEqual(codes,["EMPTY_TITLE","EMPTY_OBJECTIVE","MISSING_CORE_SOURCE"]);
  });
  it("reports invalid and repeated source references", () => {
    const codes=reviewC1MicroNodeIntegrity([{microNodes:[node("N","Define nature",[1,1,9])]}],2).map(f=>f.code);
    assert.ok(codes.includes("INVALID_SOURCE_REFERENCE"));
    assert.ok(codes.includes("DUPLICATE_CORE_REFERENCE"));
  });
  it("detects repeated identical objectives within a topic", () => {
    const codes=reviewC1MicroNodeIntegrity([{microNodes:[node("A","Define nature",[0]),node("B","  define   nature  ",[1])]}],2).map(f=>f.code);
    assert.ok(codes.includes("DUPLICATE_OBJECTIVE_IN_TOPIC"));
  });
  it("allows matching objectives in separate topics", () => {
    assert.deepEqual(reviewC1MicroNodeIntegrity([{microNodes:[node("A","Define nature",[0])]},{microNodes:[node("B","Define nature",[1])]}],2),[]);
  });
});