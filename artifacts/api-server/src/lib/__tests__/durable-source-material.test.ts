import assert from "node:assert/strict";
import { asc, eq } from "drizzle-orm";
import {
  lessonNodesTable,
  lessonSourceMaterialsTable,
  subjectsTable,
} from "@workspace/db";
import {
  buildDurableSourceMaterialRecords,
  type Pass1Block,
  type Pass2TopicResult,
} from "../../services/lesson-mapping.js";
import { validateInstructionalCoverage } from "../coverage-validator.js";
import { assertNoPollution, createFactory } from "./helpers/fixture-factory.js";
import { makeRunId } from "./helpers/run-id.js";
import { assertTestDb, closeTestDb, getTestDb } from "./helpers/test-db.js";

assertTestDb();

const db = getTestDb();
const runId = makeRunId();
const factory = createFactory(runId);

function block(
  blockType: Pass1Block["blockType"],
  sourceText: string,
  sourcePage: number,
  sourceParagraph: string | null = null,
): Pass1Block {
  return {
    blockType,
    sourceText,
    sourcePage,
    sourceParagraph,
    sourceBoundingBox: null,
  };
}

function sourceMap(
  blocks: Pass1Block[],
  topic: Pass2TopicResult,
) {
  return buildDurableSourceMaterialRecords({
    sourceDocumentId: 901,
    blocks,
    topics: [topic],
    instructionalCoverage: validateInstructionalCoverage(blocks, [topic]),
  });
}

async function replaceCurrentSourceMap(
  lessonId: number,
  materials: ReturnType<typeof buildDurableSourceMaterialRecords>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(lessonSourceMaterialsTable)
      .where(eq(lessonSourceMaterialsTable.lessonId, lessonId));
    await tx.insert(lessonSourceMaterialsTable).values(materials.map((material) => ({
      lessonId,
      sourceResourceId: null,
      stableSourceKey: material.stableSourceKey,
      sourceBlockIndex: material.sourceBlockIndex,
      blockType: material.blockType,
      sourceText: material.sourceText,
      physicalPage: material.physicalPage,
      sourceParagraph: material.sourceParagraph,
      sourceBoundingBox: material.sourceBoundingBox,
      verificationStatus: material.verificationStatus,
      primaryDisposition: material.primaryDisposition,
      dispositionReasonCodes: material.dispositionReasonCodes,
      provenanceMetadata: material.provenanceMetadata,
    })));
  });
}

async function main(): Promise<void> {
  try {
    const [subject] = await db.select({ id: subjectsTable.id }).from(subjectsTable).limit(1);
    assert.ok(subject, "isolated test database needs one seeded subject");
    const teacher = await factory.teacher();
    const lesson = await factory.lesson(teacher.userId, null, subject.id);

    const blocks = [
      block("RULE", "Կոտորակի նշանը որոշվում է համարիչի և հայտարարի նշաններով։", 10, "1"),
      block("NOTE", "Այս նշումը պարզաբանում է արդեն ներկայացված կանոնը։", 10, "1.1"),
      block("IMAGE", "?ա?ա?ա?ա?ա?ա", 10, "figure 1"),
      block("EXERCISE", "Որոշիր կոտորակի նշանը։", 10, "2"),
      block("OBJECTIVE", "Կոտորակների նշան", 10, null),
    ];
    const topic: Pass2TopicResult = {
      sequence: 1,
      title: "Կոտորակներ",
      topicType: "grammar",
      inputBlockIndices: [0, 1, 2, 3, 4],
      microNodes: [{
        title: "Կոտորակի նշանը",
        learningObjective: "Բացատրում է կոտորակի նշանի որոշումը։",
        microNodeType: "knowledge",
        sourceBlockIndices: [0],
        supportingMaterialIndices: [1],
        exercises: [{ blockIndex: 3, sourceParagraph: "2" }],
      }],
      additionalExercises: [],
      unmappedBlockIndices: [2, 4],
    };
    const firstMap = sourceMap(blocks, topic);
    assert.equal(firstMap.length, 5, "every verified block receives a durable record");
    assert.deepEqual(
      firstMap.map((material) => material.primaryDisposition),
      [
        "CORE_EVIDENCE",
        "SUPPORTING_MATERIAL",
        "UNRESOLVED_VISUAL_OR_FORMULA",
        "EXERCISE",
        "STRUCTURAL_MATERIAL",
      ],
    );
    assert.equal(firstMap[2].verificationStatus, "VERIFIED_UNREADABLE");
    assert.equal(firstMap[2].sourceText, blocks[2].sourceText, "garbled source is preserved verbatim");
    const directInstructionalNote = sourceMap(
      [block("NOTE", "Նշում. կանոնը սահմանում է կոտորակի նշանի որոշման եղանակը։", 10, "1.2")],
      {
        ...topic,
        inputBlockIndices: [0],
        microNodes: [{
          ...topic.microNodes[0],
          sourceBlockIndices: [0],
          supportingMaterialIndices: [],
          exercises: [],
        }],
        unmappedBlockIndices: [],
      },
    );
    assert.equal(directInstructionalNote[0].primaryDisposition, "CORE_EVIDENCE");

    await replaceCurrentSourceMap(lesson.id, firstMap);
    const storedFirst = await db.select()
      .from(lessonSourceMaterialsTable)
      .where(eq(lessonSourceMaterialsTable.lessonId, lesson.id))
      .orderBy(asc(lessonSourceMaterialsTable.sourceBlockIndex));
    assert.equal(storedFirst.length, 5, "the real table stores every verified block");
    assert.equal(storedFirst[1].primaryDisposition, "SUPPORTING_MATERIAL");
    assert.equal(storedFirst[2].primaryDisposition, "UNRESOLVED_VISUAL_OR_FORMULA");
    assert.equal(storedFirst[4].primaryDisposition, "STRUCTURAL_MATERIAL");
    assert.ok(storedFirst.every((row) => row.sourceText.length > 0));
    console.log("  ✓ A–G: readable, supporting, NOTE, unreadable, exercise, and structural blocks persist");

    const identicalTextDifferentLocations = sourceMap(
      [
        block("RULE", "Նույն կանոնը կրկնվում է տարբեր վայրերում։", 11, "1"),
        block("RULE", "Նույն կանոնը կրկնվում է տարբեր վայրերում։", 12, "1"),
      ],
      {
        ...topic,
        inputBlockIndices: [0, 1],
        microNodes: [{
          ...topic.microNodes[0],
          sourceBlockIndices: [0, 1],
          supportingMaterialIndices: [],
          exercises: [],
        }],
        unmappedBlockIndices: [],
      },
    );
    assert.notEqual(
      identicalTextDifferentLocations[0].stableSourceKey,
      identicalTextDifferentLocations[1].stableSourceKey,
      "identical text on distinct pages must not collide",
    );
    console.log("  ✓ H: identical text at different source locations has distinct stable identities");

    const node = await factory.node(lesson.id, {
      title: `${runId}-editable-node`,
      learningObjective: "Բացատրում է կանոնը։",
      theoryContent: "Teacher-authored structure may change.",
    });
    await db.update(lessonNodesTable)
      .set({ title: `${runId}-renamed-node` })
      .where(eq(lessonNodesTable.id, node.id));
    const afterTeacherEdit = await db.select({ sourceText: lessonSourceMaterialsTable.sourceText })
      .from(lessonSourceMaterialsTable)
      .where(eq(lessonSourceMaterialsTable.lessonId, lesson.id));
    assert.equal(afterTeacherEdit.length, 5);
    assert.equal(afterTeacherEdit[0].sourceText, blocks[0].sourceText);
    console.log("  ✓ K: teacher MicroNode edits leave durable source material unchanged");

    const secondMap = sourceMap(
      [block("RULE", "Վերաքարտեզագրված կանոնը պահվում է ամբողջությամբ։", 13, "1")],
      {
        ...topic,
        inputBlockIndices: [0],
        microNodes: [{
          ...topic.microNodes[0],
          sourceBlockIndices: [0],
          supportingMaterialIndices: [],
          exercises: [],
        }],
        unmappedBlockIndices: [],
      },
    );
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.delete(lessonSourceMaterialsTable)
          .where(eq(lessonSourceMaterialsTable.lessonId, lesson.id));
        await tx.insert(lessonSourceMaterialsTable).values([
          {
            lessonId: lesson.id,
            sourceResourceId: null,
            stableSourceKey: secondMap[0].stableSourceKey,
            sourceBlockIndex: 0,
            blockType: secondMap[0].blockType,
            sourceText: secondMap[0].sourceText,
            physicalPage: secondMap[0].physicalPage,
            verificationStatus: secondMap[0].verificationStatus,
            primaryDisposition: secondMap[0].primaryDisposition,
            dispositionReasonCodes: secondMap[0].dispositionReasonCodes,
            provenanceMetadata: secondMap[0].provenanceMetadata,
          },
          {
            lessonId: lesson.id,
            sourceResourceId: null,
            stableSourceKey: secondMap[0].stableSourceKey,
            sourceBlockIndex: 1,
            blockType: secondMap[0].blockType,
            sourceText: secondMap[0].sourceText,
            physicalPage: secondMap[0].physicalPage,
            verificationStatus: secondMap[0].verificationStatus,
            primaryDisposition: secondMap[0].primaryDisposition,
            dispositionReasonCodes: secondMap[0].dispositionReasonCodes,
            provenanceMetadata: secondMap[0].provenanceMetadata,
          },
        ]);
      }),
    );
    const afterFailedRemap = await db.select()
      .from(lessonSourceMaterialsTable)
      .where(eq(lessonSourceMaterialsTable.lessonId, lesson.id));
    assert.equal(afterFailedRemap.length, 5, "failed replacement rolls back to the valid source map");
    console.log("  ✓ J/L: failed replacement rolls back without partial source-map state");

    await replaceCurrentSourceMap(lesson.id, secondMap);
    const afterSuccessfulRemap = await db.select()
      .from(lessonSourceMaterialsTable)
      .where(eq(lessonSourceMaterialsTable.lessonId, lesson.id));
    assert.equal(afterSuccessfulRemap.length, 1, "remap replaces stale canonical source material");
    assert.equal(afterSuccessfulRemap[0].sourceText, secondMap[0].sourceText);
    console.log("  ✓ I/M/N: successful remap replaces stale state with one primary disposition per block");

    console.log("\nDurable source material persistence: 6/6 passed");
  } finally {
    try {
      await factory.cleanup();
      await assertNoPollution(runId);
    } finally {
      await closeTestDb();
    }
  }
}

await main();