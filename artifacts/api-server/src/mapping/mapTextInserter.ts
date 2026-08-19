// ────────────────────────────────────────────────────────────────────────────
// Contract v1.2 — DB inserter for a validated ParsedMappingResult.
// Uses db.transaction() — caller must pass a validated result (ok=true).
// ────────────────────────────────────────────────────────────────────────────

import {
  db,
  lessonTopicsTable,
  lessonNodesTable,
  lessonExercisesTable,
  lessonNodeDependenciesTable,
  mappingImportLogTable,
  mappingReviewItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import type {
  ParsedMappingResult, ParsedMicroNode,
  ValidationIssue, InsertionResult,
} from "./mapTextTypes.js";
import { assertLearnerExerciseContent } from "../lib/exercise-content-boundary.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pick the primary source block id for a MicroNode (first referenced block). */
function primaryBlockId(mn: ParsedMicroNode): string | null {
  if (mn.sourceBlockIds.length > 0) return mn.sourceBlockIds[0];
  if (mn.sourceRefs.length > 0)     return mn.sourceRefs[0].sourceBlockId;
  return null;
}

// ── Main inserter ─────────────────────────────────────────────────────────────

/**
 * Inserts a VALIDATED ParsedMappingResult into the database inside a single
 * db.transaction(). All existing mapping data for the lesson is REPLACED.
 *
 * @param lessonId    - Target lesson.
 * @param parsed      - Output of parseMappingText(), validated (ok=true).
 * @param importedBy  - userId of the teacher (may be null).
 * @param rawTextHash - SHA-256 hex of the raw input text (for import log).
 * @param rawText     - Original raw TEXT (stored in import log).
 * @param warnings    - Validation warnings (stored as mapping_review_items).
 */
export async function insertParsedMapping(
  lessonId:    number,
  parsed:      ParsedMappingResult,
  importedBy:  number | null,
  rawTextHash: string,
  rawText:     string,
  warnings:    ValidationIssue[],
): Promise<InsertionResult> {

  let topicsCreated       = 0;
  let microNodesCreated   = 0;
  let exercisesCreated    = 0;
  let dependenciesCreated = 0;
  let reviewItemsCreated  = 0;

  // Build source-block lookup for MN field population
  const sbById = new Map(parsed.sourceBlocks.map(b => [b.id, b]));

  // Maps: parsed ID → inserted DB id
  const mnIdToDbId    = new Map<string, number>();  // MN-1.1 → lesson_nodes.id
  const topicIdToDbId = new Map<string, number>();  // N1     → lesson_topics.id

  // Extra review items generated during insertion (relatedMicroNodes, multi-MN exercises)
  const insertionReviewItems: {
    entityId:    number | null;
    entityType:  string;
    issueType:   string;
    severity:    string;
    description: string;
  }[] = [];

  await db.transaction(async (tx) => {

    // ── STEP 1: Clear existing mapping data for this lesson ─────────────────
    // Delete in dependency order (FK children first).

    await tx.delete(lessonNodeDependenciesTable)
      .where(eq(lessonNodeDependenciesTable.lessonId, lessonId));

    await tx.delete(lessonExercisesTable)
      .where(eq(lessonExercisesTable.lessonId, lessonId));

    await tx.delete(lessonNodesTable)
      .where(eq(lessonNodesTable.lessonId, lessonId));

    await tx.delete(lessonTopicsTable)
      .where(eq(lessonTopicsTable.lessonId, lessonId));

    // ── STEP 2: Insert NODE sections as lesson_topics ────────────────────────

    let topicSeq = 0;
    for (const node of parsed.nodes) {
      topicSeq += 1;
      const [topic] = await tx
        .insert(lessonTopicsTable)
        .values({
          lessonId,
          title:    node.title || node.id,   // fallback to id if title empty
          sequence: topicSeq,
        })
        .returning();
      topicIdToDbId.set(node.id, topic.id);
      topicsCreated += 1;
    }

    // ── STEP 3: Insert MICRONODE sections as lesson_nodes ───────────────────

    let nodeSeq = 0;
    for (const node of parsed.nodes) {
      const topicDbId = topicIdToDbId.get(node.id) ?? null;

      for (const mn of node.microNodes) {
        nodeSeq += 1;

        // Resolve primary source block for denormalised columns
        const primaryId    = primaryBlockId(mn);
        const primaryBlock = primaryId != null ? sbById.get(primaryId) : undefined;

        // microNodeType must be lowercase for DB ("knowledge" | "skill")
        const dbMicroNodeType = (() => {
          const t = mn.microNodeType.toLowerCase();
          if (t === "knowledge_and_skill") return "knowledge"; // fallback
          if (t === "skill") return "skill";
          return "knowledge";
        })();

        const [insertedNode] = await tx
          .insert(lessonNodesTable)
          .values({
            lessonId,
            topicId:              topicDbId,
            sequence:             nodeSeq,
            title:                mn.title,
            learningObjective:    mn.learningObjective || null,
            microNodeType:        dbMicroNodeType,
            sourceText:           primaryBlock?.sourceText || null,
            verbatimTheoryAnchor: primaryBlock?.sourceText || null,
            theoryContent:        primaryBlock?.sourceText || null,
            sourcePage:           primaryBlock?.sourcePage ?? null,
            sourceParagraph:      primaryBlock?.sourceParagraph || null,
            status:               (mn.status as "draft" | "reviewed" | "approved") || "draft",
            contentSourceType:    "manual",
            createdBy:            "teacher",
            confidenceScore:      mn.confidenceScore,
            targetBloomLevel:     1,
            estimatedMinutes:     5,
          })
          .returning();

        mnIdToDbId.set(mn.id, insertedNode.id);
        microNodesCreated += 1;

        // relatedMicroNodes — lesson_nodes has no relatedNodeId column.
        // All relatedMicroNode entries go to mapping_review_items so teacher can act on them.
        for (const relId of mn.relatedMicroNodes) {
          insertionReviewItems.push({
            entityId:    insertedNode.id,
            entityType:  "node",
            issueType:   "related-mn-deferred",
            severity:    "warning",
            description: `MicroNode ${mn.id}: relatedMicroNode "${relId}" needs a join table — deferred to future migration.`,
          });
        }
      }
    }

    // ── STEP 4: Insert EXERCISE sections as lesson_exercises ─────────────────

    let exSeq = 0;
    const sourceBlockIndexById = new Map(
      parsed.sourceBlocks.map((block, index) => [block.id, index]),
    );
    for (const ex of parsed.exercises) {
      exSeq += 1;

      // relatedMicroNodes[0] → relatedNodeId FK (lesson_exercises HAS this column)
      const firstMnId   = ex.relatedMicroNodes[0] ?? null;
      const relatedDbId = firstMnId != null ? (mnIdToDbId.get(firstMnId) ?? null) : null;
      const learnerContent = assertLearnerExerciseContent({
        exerciseTextVerbatim: ex.verbatimText,
        exerciseTextEdited: ex.learnerText,
        successCriteria: ex.successCriteria,
        correctAnswer: ex.correctAnswer,
      });

      const [insertedEx] = await tx
        .insert(lessonExercisesTable)
        .values({
          lessonId,
          exerciseId:           ex.id,
          exerciseTextVerbatim: ex.verbatimText,
          exerciseTextEdited:   learnerContent.learnerText,
          sourcePage:           ex.sourcePage != null ? String(ex.sourcePage) : null,
          sourceBlockIndex:     ex.sourceBlockId != null
            ? sourceBlockIndexById.get(ex.sourceBlockId) ?? null
            : null,
          relatedNodeId:        relatedDbId,
          sequence:             ex.sequence || exSeq,
          difficultyLevel:      ex.difficulty === "EASY"
            ? "LOW"
            : ex.difficulty === "HARD"
              ? "HIGH"
              : "MEDIUM",
          exercisePurpose:      ex.exerciseType,
          assignment:           "CLASS",
          interactionType:      ex.interactionType,
          correctAnswer:        ex.correctAnswer,
          successCriteria:      ex.successCriteria,
          sourceType:           "textbook" as const,
          status:               "draft",
          sourceText:           ex.sourceText ?? ex.verbatimText,
        })
        .returning();

      exercisesCreated += 1;

      // relatedMicroNodes[1:] → review items (no join table yet)
      for (const relId of ex.relatedMicroNodes.slice(1)) {
        insertionReviewItems.push({
          entityId:    insertedEx.id,
          entityType:  "exercise",
          issueType:   "ex-multi-related-deferred",
          severity:    "warning",
          description: `EXERCISE ${ex.id}: additional relatedMicroNode "${relId}" needs a join table — deferred to future migration.`,
        });
      }
    }

    // ── STEP 5: Insert DEPENDENCY sections ───────────────────────────────────

    for (const dep of parsed.dependencies) {
      const fromDbId = mnIdToDbId.get(dep.from);
      const toDbId   = mnIdToDbId.get(dep.to);
      if (!fromDbId || !toDbId) continue;   // validator already flagged these

      await tx
        .insert(lessonNodeDependenciesTable)
        .values({
          lessonId,
          fromNodeId:     fromDbId,
          toNodeId:       toDbId,
          dependencyType: dep.dependencyType,
          reason:         dep.reason || null,
        });

      dependenciesCreated += 1;
    }

    // ── STEP 6: Write mapping_review_items ───────────────────────────────────
    // Combines validation warnings + insertion-generated review items.

    const allReviewRows = [
      ...warnings.map(w => ({
        lessonId,
        entityId:    w.entityId != null ? (mnIdToDbId.get(w.entityId) ?? null) : null,
        entityType:  "import",
        issueType:   w.issueType,
        severity:    w.severity,
        description: w.description,
        status:      "open" as const,
      })),
      ...insertionReviewItems.map(r => ({
        lessonId,
        entityId:    r.entityId,
        entityType:  r.entityType,
        issueType:   r.issueType,
        severity:    r.severity,
        description: r.description,
        status:      "open" as const,
      })),
    ];

    if (allReviewRows.length > 0) {
      await tx.insert(mappingReviewItemsTable).values(allReviewRows);
      reviewItemsCreated = allReviewRows.length;
    }

  }); // end transaction

  // ── STEP 7: Write mapping_import_log (outside tx for observability) ───────

  await db
    .insert(mappingImportLogTable)
    .values({
      lessonId,
      source:               "manual",
      mappingMode:          "MANUAL_TEXT",
      rawTextHash,
      rawInput:             rawText,
      mappingSchemaVersion: "1.2",
      importedBy,
    });

  logger.info(
    { lessonId, topicsCreated, microNodesCreated, exercisesCreated, dependenciesCreated, reviewItemsCreated },
    "manual-map TEXT: import complete",
  );

  return { topicsCreated, microNodesCreated, exercisesCreated, dependenciesCreated, reviewItemsCreated };
}
