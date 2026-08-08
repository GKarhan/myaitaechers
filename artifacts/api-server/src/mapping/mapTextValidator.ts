// ────────────────────────────────────────────────────────────────────────────
// Contract v1.2 — Deterministic validator for ParsedMappingResult
// Pure function; no DB access; no AI involvement.
// ────────────────────────────────────────────────────────────────────────────

import {
  BLOCK_TYPES, SOURCE_BLOCK_STATUSES, SOURCE_COVERAGES,
  MICRO_NODE_TYPES, MICRO_NODE_LIFECYCLES, DIFFICULTIES,
  DEPENDENCY_TYPES, EXERCISE_TYPES,
  type ParsedMappingResult, type ParsedMicroNode,
  type ValidationIssue, type ValidationResult, type CoverageAudit,
} from "./mapTextTypes.js";
import {
  makeError, makeWarning,
  E_LESSON_MISSING, E_LESSON_TITLE_EMPTY, E_LESSON_SUBJECT_EMPTY,
  E_LESSON_GRADE_INVALID, E_LESSON_TEXTBOOK_EMPTY, E_LESSON_PAGES_INVALID,
  E_NODE_ID_INVALID, E_MICRONODE_ID_INVALID,
  E_SOURCEBLOCK_ID_INVALID, E_EXERCISE_ID_INVALID, E_DEPENDENCY_ID_INVALID,
  E_DUPLICATE_NODE_ID, E_DUPLICATE_MICRONODE_ID,
  E_DUPLICATE_SOURCEBLOCK_ID, E_DUPLICATE_EXERCISE_ID, E_DUPLICATE_DEPENDENCY_ID,
  E_ORPHAN_MICRONODE,
  E_MN_TITLE_EMPTY, E_MN_TYPE_INVALID, E_MN_LEARNING_OBJ_EMPTY,
  E_MN_CONFIDENCE_MISSING, E_MN_CONFIDENCE_RANGE,
  E_MN_COVERAGE_INVALID, E_MN_STATUS_INVALID,
  E_SB_PAGE_MISSING, E_SB_BLOCKTYPE_INVALID, E_SB_STATUS_INVALID, E_SB_TEXT_EMPTY,
  E_REF_SOURCEBLOCK_UNKNOWN, E_REF_SOURCEQUOTE_MISMATCH,
  E_REF_EXERCISE_UNKNOWN, E_REF_PREREQ_UNKNOWN, E_REF_RELATED_UNKNOWN,
  E_REF_DEP_FROM_UNKNOWN, E_REF_DEP_TO_UNKNOWN,
  E_UNREADABLE_BLOCK_REF,
  E_EX_TEXT_EMPTY, E_EX_TYPE_INVALID, E_EX_DIFFICULTY_INVALID,
  E_DEP_TYPE_INVALID,
  W_SB_NEEDS_REVIEW_REF, W_SB_ORPHAN, W_EX_ORPHAN,
  W_MN_NO_SOURCES, W_RELATED_MN_EXTRA, W_EX_MULTI_RELATED,
} from "./mapTextErrors.js";

// ── Coverage computation ──────────────────────────────────────────────────────

function computeCoverageAudit(parsed: ParsedMappingResult): CoverageAudit {
  const referencedBlockIds  = new Set<string>();
  const referencedExerciseIds = new Set<string>();

  for (const node of parsed.nodes) {
    for (const mn of node.microNodes) {
      for (const id of mn.sourceBlockIds)       referencedBlockIds.add(id);
      for (const ref of mn.sourceRefs)          referencedBlockIds.add(ref.sourceBlockId);
      for (const id of mn.exerciseIds)          referencedExerciseIds.add(id);
    }
  }

  const totalSB = parsed.sourceBlocks.length;
  const totalEx = parsed.exercises.length;

  const unmappedSBIds = parsed.sourceBlocks
    .filter(b => !referencedBlockIds.has(b.id))
    .map(b => b.id);
  const unmappedExIds = parsed.exercises
    .filter(e => !referencedExerciseIds.has(e.id))
    .map(e => e.id);

  const mappedSB = totalSB - unmappedSBIds.length;
  const mappedEx = totalEx - unmappedExIds.length;

  return {
    totalSourceBlocks:       totalSB,
    mappedSourceBlocks:      mappedSB,
    unmappedSourceBlocks:    unmappedSBIds.length,
    unmappedSourceBlockIds:  unmappedSBIds,
    totalExercises:          totalEx,
    mappedExercises:         mappedEx,
    unmappedExercises:       unmappedExIds.length,
    unmappedExerciseIds:     unmappedExIds,
    sourceCoveragePercent:   totalSB > 0 ? Math.round(mappedSB / totalSB * 100) : 100,
    exerciseCoveragePercent: totalEx > 0 ? Math.round(mappedEx / totalEx * 100) : 100,
  };
}

// ── Main validator ────────────────────────────────────────────────────────────

/**
 * Validates a ParsedMappingResult.
 *
 * @param parsed       - Output of parseMappingText().
 * @param lessonPagesFrom - Lesson's pagesFrom from DB (null if unknown).
 * @param lessonPagesTo   - Lesson's pagesTo from DB (null if unknown).
 * @returns ValidationResult with errors, warnings, and computed coverageAudit.
 */
export function validateParsedMapping(
  parsed: ParsedMappingResult,
  lessonPagesFrom: number | null = null,
  lessonPagesTo:   number | null = null,
): ValidationResult {
  const errors:   ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // ── 1. Lesson section ──────────────────────────────────────────────────────

  if (!parsed.lesson) {
    errors.push(makeError(E_LESSON_MISSING, null, "LESSON section is missing."));
  } else {
    const L = parsed.lesson;
    if (!L.title)    errors.push(makeError(E_LESSON_TITLE_EMPTY,    null, "LESSON: title is empty.",    L._line));
    if (!L.subject)  errors.push(makeError(E_LESSON_SUBJECT_EMPTY,  null, "LESSON: subject is empty.",  L._line));
    if (!L.textbook) errors.push(makeError(E_LESSON_TEXTBOOK_EMPTY, null, "LESSON: textbook is empty.", L._line));
    if (L.grade <= 0)
      errors.push(makeError(E_LESSON_GRADE_INVALID, null, `LESSON: grade must be a positive integer (got ${L.grade}).`, L._line));
    if (L.pagesFrom <= 0 || L.pagesTo <= 0 || L.pagesFrom > L.pagesTo)
      errors.push(makeError(E_LESSON_PAGES_INVALID, null,
        `LESSON: pages must be valid range pagesFrom≤pagesTo (got ${L.pagesFrom}–${L.pagesTo}).`, L._line));
  }

  // ── 2. Build lookup tables ─────────────────────────────────────────────────

  const allMnById = new Map<string, ParsedMicroNode>();
  for (const node of parsed.nodes) {
    for (const mn of node.microNodes) allMnById.set(mn.id, mn);
  }
  for (const mn of parsed._orphanMicroNodes) allMnById.set(mn.id, mn);

  const sbById = new Map(parsed.sourceBlocks.map(b => [b.id, b]));
  const exById = new Map(parsed.exercises.map(e    => [e.id, e]));

  // ── 3. Duplicate ID checks ─────────────────────────────────────────────────

  {
    const nodeIds = parsed.nodes.map(n => n.id);
    const seen = new Set<string>();
    for (const id of nodeIds) {
      if (seen.has(id)) errors.push(makeError(E_DUPLICATE_NODE_ID, id, `Duplicate NODE id: ${id}.`));
      seen.add(id);
    }
  }
  {
    const seen = new Set<string>();
    for (const [id] of allMnById) {
      if (seen.has(id)) errors.push(makeError(E_DUPLICATE_MICRONODE_ID, id, `Duplicate MICRONODE id: ${id}.`));
      seen.add(id);
    }
    // Also check within the allMicroNodes flat list (including orphans)
    const all: string[] = [];
    for (const n of parsed.nodes) all.push(...n.microNodes.map(m => m.id));
    all.push(...parsed._orphanMicroNodes.map(m => m.id));
    const dupCheck = new Set<string>();
    for (const id of all) {
      if (dupCheck.has(id)) {
        if (!errors.some(e => e.issueType === E_DUPLICATE_MICRONODE_ID && e.entityId === id))
          errors.push(makeError(E_DUPLICATE_MICRONODE_ID, id, `Duplicate MICRONODE id: ${id}.`));
      }
      dupCheck.add(id);
    }
  }
  {
    const seen = new Set<string>();
    for (const sb of parsed.sourceBlocks) {
      if (seen.has(sb.id)) errors.push(makeError(E_DUPLICATE_SOURCEBLOCK_ID, sb.id, `Duplicate SOURCE BLOCK id: ${sb.id}.`, sb._line));
      seen.add(sb.id);
    }
  }
  {
    const seen = new Set<string>();
    for (const ex of parsed.exercises) {
      if (seen.has(ex.id)) errors.push(makeError(E_DUPLICATE_EXERCISE_ID, ex.id, `Duplicate EXERCISE id: ${ex.id}.`, ex._line));
      seen.add(ex.id);
    }
  }
  {
    const seen = new Set<string>();
    for (const dep of parsed.dependencies) {
      if (seen.has(dep.id)) errors.push(makeError(E_DUPLICATE_DEPENDENCY_ID, dep.id, `Duplicate DEPENDENCY id: ${dep.id}.`, dep._line));
      seen.add(dep.id);
    }
  }

  // ── 4. ID format checks ────────────────────────────────────────────────────

  for (const node of parsed.nodes) {
    if (!/^N\d+$/.test(node.id))
      errors.push(makeError(E_NODE_ID_INVALID, node.id, `NODE id "${node.id}" must match N\\d+ (e.g. N1, N2).`, node._line));
  }
  for (const [, mn] of allMnById) {
    if (!/^MN-\d+\.\d+$/.test(mn.id))
      errors.push(makeError(E_MICRONODE_ID_INVALID, mn.id, `MICRONODE id "${mn.id}" must match MN-\\d+.\\d+ (e.g. MN-1.1).`, mn._line));
  }
  for (const sb of parsed.sourceBlocks) {
    if (!/^B\d+$/.test(sb.id))
      errors.push(makeError(E_SOURCEBLOCK_ID_INVALID, sb.id, `SOURCE BLOCK id "${sb.id}" must match B\\d+.`, sb._line));
  }
  for (const ex of parsed.exercises) {
    if (!/^EX-\d+$/.test(ex.id))
      errors.push(makeError(E_EXERCISE_ID_INVALID, ex.id, `EXERCISE id "${ex.id}" must match EX-\\d+.`, ex._line));
  }
  for (const dep of parsed.dependencies) {
    if (!/^D\d+$/.test(dep.id))
      errors.push(makeError(E_DEPENDENCY_ID_INVALID, dep.id, `DEPENDENCY id "${dep.id}" must match D\\d+.`, dep._line));
  }

  // ── 5. Orphan MicroNodes ───────────────────────────────────────────────────

  for (const mn of parsed._orphanMicroNodes) {
    errors.push(makeError(E_ORPHAN_MICRONODE, mn.id,
      `MICRONODE ${mn.id}: parent NODE ${mn.parentNodeId} is not defined.`, mn._line));
  }

  // ── 6. NODE fields ─────────────────────────────────────────────────────────

  // (Node title is not required per contract — only NODE id and child MNs matter.)

  // ── 7. MICRONODE fields ────────────────────────────────────────────────────

  for (const node of parsed.nodes) {
    for (const mn of node.microNodes) {

      if (!mn.title)
        errors.push(makeError(E_MN_TITLE_EMPTY, mn.id, `MICRONODE ${mn.id}: title is empty.`, mn._line));

      if (!(MICRO_NODE_TYPES as readonly string[]).includes(mn.microNodeType))
        errors.push(makeError(E_MN_TYPE_INVALID, mn.id,
          `MICRONODE ${mn.id}: microNodeType "${mn.microNodeType}" is invalid. Expected: ${MICRO_NODE_TYPES.join(" | ")}.`, mn._line));

      if (!mn.learningObjective)
        errors.push(makeError(E_MN_LEARNING_OBJ_EMPTY, mn.id, `MICRONODE ${mn.id}: learningObjective is empty.`, mn._line));

      if (mn.confidenceScore === null)
        errors.push(makeError(E_MN_CONFIDENCE_MISSING, mn.id, `MICRONODE ${mn.id}: confidenceScore is required.`, mn._line));
      else if (mn.confidenceScore < 0 || mn.confidenceScore > 100)
        errors.push(makeError(E_MN_CONFIDENCE_RANGE, mn.id,
          `MICRONODE ${mn.id}: confidenceScore ${mn.confidenceScore} is out of range 0–100.`, mn._line));

      if (mn.sourceCoverage && !(SOURCE_COVERAGES as readonly string[]).includes(mn.sourceCoverage))
        errors.push(makeError(E_MN_COVERAGE_INVALID, mn.id,
          `MICRONODE ${mn.id}: sourceCoverage "${mn.sourceCoverage}" is invalid. Expected: ${SOURCE_COVERAGES.join(" | ")}.`, mn._line));

      if (mn.status && !(MICRO_NODE_LIFECYCLES as readonly string[]).includes(mn.status))
        errors.push(makeError(E_MN_STATUS_INVALID, mn.id,
          `MICRONODE ${mn.id}: status "${mn.status}" is invalid. Expected: ${MICRO_NODE_LIFECYCLES.join(" | ")}.`, mn._line));

      // No source refs at all → warning (not error, theory nodes are valid)
      if (mn.sourceBlockIds.length === 0 && mn.sourceRefs.length === 0)
        warnings.push(makeWarning(W_MN_NO_SOURCES, mn.id,
          `MICRONODE ${mn.id}: no sourceBlockIds or sourceRef lines — source is unverified.`, mn._line));

      // relatedMicroNodes[1:] — only first stored in DB
      if (mn.relatedMicroNodes.length > 1)
        warnings.push(makeWarning(W_RELATED_MN_EXTRA, mn.id,
          `MICRONODE ${mn.id}: ${mn.relatedMicroNodes.length} relatedMicroNodes — only the first (${mn.relatedMicroNodes[0]}) will be stored; the rest need a join table (future migration).`, mn._line));

      // ── Source block references ──────────────────────────────────────────

      for (const refId of mn.sourceBlockIds) {
        const block = sbById.get(refId);
        if (!block) {
          errors.push(makeError(E_REF_SOURCEBLOCK_UNKNOWN, mn.id,
            `MICRONODE ${mn.id}: sourceBlockId "${refId}" not found.`, mn._line));
          continue;
        }
        // UNREADABLE rule: absolute error
        if (block.status === "UNREADABLE")
          errors.push(makeError(E_UNREADABLE_BLOCK_REF, mn.id,
            `MICRONODE ${mn.id}: references SOURCE BLOCK ${refId} with status UNREADABLE — forbidden by contract §8.`, mn._line));
        // NEEDS_REVIEW: warning
        else if (block.status === "NEEDS_REVIEW")
          warnings.push(makeWarning(W_SB_NEEDS_REVIEW_REF, mn.id,
            `MICRONODE ${mn.id}: references SOURCE BLOCK ${refId} with status NEEDS_REVIEW — review required before finalising.`, mn._line));
      }

      for (const ref of mn.sourceRefs) {
        const block = sbById.get(ref.sourceBlockId);
        if (!block) {
          errors.push(makeError(E_REF_SOURCEBLOCK_UNKNOWN, mn.id,
            `MICRONODE ${mn.id}: sourceRef references unknown SOURCE BLOCK ${ref.sourceBlockId}.`, mn._line));
          continue;
        }
        // UNREADABLE rule
        if (block.status === "UNREADABLE")
          errors.push(makeError(E_UNREADABLE_BLOCK_REF, mn.id,
            `MICRONODE ${mn.id}: sourceRef references SOURCE BLOCK ${ref.sourceBlockId} with status UNREADABLE — forbidden by contract §8.`, mn._line));
        else if (block.status === "NEEDS_REVIEW")
          warnings.push(makeWarning(W_SB_NEEDS_REVIEW_REF, mn.id,
            `MICRONODE ${mn.id}: sourceRef references SOURCE BLOCK ${ref.sourceBlockId} with status NEEDS_REVIEW.`, mn._line));

        // Quote must be exact substring of block sourceText (if block is EXTRACTED and quote is non-empty)
        if (ref.sourceQuote && block.status === "EXTRACTED") {
          if (!block.sourceText.includes(ref.sourceQuote))
            errors.push(makeError(E_REF_SOURCEQUOTE_MISMATCH, mn.id,
              `MICRONODE ${mn.id}: sourceRef quote "${ref.sourceQuote.slice(0, 40)}..." is not a substring of SOURCE BLOCK ${ref.sourceBlockId} sourceText.`, mn._line));
        }
      }

      // ── Exercise references ──────────────────────────────────────────────

      for (const exId of mn.exerciseIds) {
        if (!exById.has(exId))
          errors.push(makeError(E_REF_EXERCISE_UNKNOWN, mn.id,
            `MICRONODE ${mn.id}: exerciseId "${exId}" not found.`, mn._line));
      }

      // ── Prerequisite MN references ───────────────────────────────────────

      for (const prereqId of mn.prerequisites) {
        if (!allMnById.has(prereqId))
          errors.push(makeError(E_REF_PREREQ_UNKNOWN, mn.id,
            `MICRONODE ${mn.id}: prerequisite MN "${prereqId}" not found.`, mn._line));
      }

      // ── Related MN references ────────────────────────────────────────────

      for (const relId of mn.relatedMicroNodes) {
        if (!allMnById.has(relId))
          errors.push(makeError(E_REF_RELATED_UNKNOWN, mn.id,
            `MICRONODE ${mn.id}: relatedMicroNode "${relId}" not found.`, mn._line));
      }
    }
  }

  // ── 8. SOURCE BLOCK fields ─────────────────────────────────────────────────

  for (const sb of parsed.sourceBlocks) {
    if (!sb.sourceText)
      errors.push(makeError(E_SB_TEXT_EMPTY, sb.id, `SOURCE BLOCK ${sb.id}: sourceText is empty.`, sb._line));

    if (sb.sourcePage === null)
      errors.push(makeError(E_SB_PAGE_MISSING, sb.id, `SOURCE BLOCK ${sb.id}: sourcePage is required (null → ERROR).`, sb._line));

    if (!(BLOCK_TYPES as readonly string[]).includes(sb.blockType))
      errors.push(makeError(E_SB_BLOCKTYPE_INVALID, sb.id,
        `SOURCE BLOCK ${sb.id}: blockType "${sb.blockType}" is invalid. Expected: ${BLOCK_TYPES.join(" | ")}.`, sb._line));

    if (!(SOURCE_BLOCK_STATUSES as readonly string[]).includes(sb.status))
      errors.push(makeError(E_SB_STATUS_INVALID, sb.id,
        `SOURCE BLOCK ${sb.id}: status "${sb.status}" is invalid. Expected: ${SOURCE_BLOCK_STATUSES.join(" | ")}.`, sb._line));
  }

  // ── 9. EXERCISE fields ─────────────────────────────────────────────────────

  for (const ex of parsed.exercises) {
    if (!ex.text)
      errors.push(makeError(E_EX_TEXT_EMPTY, ex.id, `EXERCISE ${ex.id}: text is empty.`, ex._line));

    if (!(EXERCISE_TYPES as readonly string[]).includes(ex.exerciseType))
      errors.push(makeError(E_EX_TYPE_INVALID, ex.id,
        `EXERCISE ${ex.id}: exerciseType "${ex.exerciseType}" is invalid.`, ex._line));

    if (!(DIFFICULTIES as readonly string[]).includes(ex.difficulty))
      errors.push(makeError(E_EX_DIFFICULTY_INVALID, ex.id,
        `EXERCISE ${ex.id}: difficulty "${ex.difficulty}" is invalid. Expected: ${DIFFICULTIES.join(" | ")}.`, ex._line));

    // relatedMicroNodes on exercise
    for (const relId of ex.relatedMicroNodes) {
      if (!allMnById.has(relId))
        errors.push(makeError(E_REF_RELATED_UNKNOWN, ex.id,
          `EXERCISE ${ex.id}: relatedMicroNode "${relId}" not found.`, ex._line));
    }
    if (ex.relatedMicroNodes.length > 1)
      warnings.push(makeWarning(W_EX_MULTI_RELATED, ex.id,
        `EXERCISE ${ex.id}: ${ex.relatedMicroNodes.length} relatedMicroNodes — only first (${ex.relatedMicroNodes[0]}) will be stored as relatedNodeId.`, ex._line));
  }

  // ── 10. DEPENDENCY fields ──────────────────────────────────────────────────

  for (const dep of parsed.dependencies) {
    if (!(DEPENDENCY_TYPES as readonly string[]).includes(dep.dependencyType))
      errors.push(makeError(E_DEP_TYPE_INVALID, dep.id,
        `DEPENDENCY ${dep.id}: dependencyType "${dep.dependencyType}" must be PREREQUISITE.`, dep._line));

    if (!allMnById.has(dep.from))
      errors.push(makeError(E_REF_DEP_FROM_UNKNOWN, dep.id,
        `DEPENDENCY ${dep.id}: from "${dep.from}" is not a known MICRONODE id.`, dep._line));

    if (!allMnById.has(dep.to))
      errors.push(makeError(E_REF_DEP_TO_UNKNOWN, dep.id,
        `DEPENDENCY ${dep.id}: to "${dep.to}" is not a known MICRONODE id.`, dep._line));
  }

  // ── 11. Orphan source blocks and exercises (warnings) ─────────────────────

  const coverageAudit = computeCoverageAudit(parsed);
  parsed.coverageAudit = coverageAudit;   // mutate in place so caller sees it

  for (const id of coverageAudit.unmappedSourceBlockIds)
    warnings.push(makeWarning(W_SB_ORPHAN, id,
      `SOURCE BLOCK ${id} is not referenced by any MICRONODE — it will not contribute to any node.`));

  for (const id of coverageAudit.unmappedExerciseIds)
    warnings.push(makeWarning(W_EX_ORPHAN, id,
      `EXERCISE ${id} is not referenced by any MICRONODE exerciseIds — it may be unlinked.`));

  // ── 12. Page-range checks (lesson pages as hint, not hard error) ───────────

  const pFrom = lessonPagesFrom ?? parsed.lesson?.pagesFrom ?? null;
  const pTo   = lessonPagesTo   ?? parsed.lesson?.pagesTo   ?? null;

  if (pFrom != null && pTo != null) {
    for (const sb of parsed.sourceBlocks) {
      if (sb.sourcePage !== null && (sb.sourcePage < pFrom || sb.sourcePage > pTo))
        warnings.push(makeWarning("sb-page-out-of-range", sb.id,
          `SOURCE BLOCK ${sb.id}: sourcePage ${sb.sourcePage} is outside lesson page range ${pFrom}–${pTo}.`, sb._line));
    }
  }

  // ── Assemble result ────────────────────────────────────────────────────────

  const all = [...errors, ...warnings];
  return {
    ok:            errors.length === 0,
    errors,
    warnings,
    all,
    coverageAudit,
  };
}
