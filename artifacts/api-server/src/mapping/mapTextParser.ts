// ────────────────────────────────────────────────────────────────────────────
// Contract v1.2 — Deterministic TEXT → ParsedMappingResult parser
// Pure function; no DB access; no AI involvement.
// ────────────────────────────────────────────────────────────────────────────

import type {
  ParsedMappingResult, ParsedLesson, ParsedNode, ParsedMicroNode,
  ParsedSourceBlock, ParsedExercise, ParsedDependency,
  ParsedFidelityAudit, ParsedSourceRef, CoverageAudit,
} from "./mapTextTypes.js";

// ── Section types ─────────────────────────────────────────────────────────────

type SectionType =
  | "LESSON"
  | "NODE"
  | "MICRONODE"
  | "SOURCE_BLOCK"
  | "EXERCISE"
  | "DEPENDENCY"
  | "FIDELITY_AUDIT";

interface RawSection {
  type:       SectionType;
  id:         string | null;
  fields:     Record<string, string>;  // key → accumulated value (may be multi-line)
  sourceRefs: string[];                // each "Bx | quote" string from repeated sourceRef: lines
  line:       number;
}

// ── Section marker matching ───────────────────────────────────────────────────

function matchSectionMarker(line: string): { type: SectionType; id: string | null } | null {
  if (line === "LESSON")        return { type: "LESSON",        id: null };
  if (line === "FIDELITY AUDIT") return { type: "FIDELITY_AUDIT", id: null };

  let m: RegExpMatchArray | null;

  if ((m = line.match(/^NODE (N\d+)$/)))             return { type: "NODE",         id: m[1] };
  if ((m = line.match(/^MICRONODE (MN-\d+\.\d+)$/))) return { type: "MICRONODE",    id: m[1] };
  if ((m = line.match(/^SOURCE BLOCK (B\d+)$/)))     return { type: "SOURCE_BLOCK", id: m[1] };
  if ((m = line.match(/^EXERCISE (EX-\d+)$/)))       return { type: "EXERCISE",     id: m[1] };
  if ((m = line.match(/^DEPENDENCY (D\d+)$/)))       return { type: "DEPENDENCY",   id: m[1] };

  return null;
}

// ── Primitive helpers ─────────────────────────────────────────────────────────

function parseIntOrNull(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return isNaN(n) ? null : n;
}

/** Parses "22-24", "22–24" (en-dash), "22—24" (em-dash), or "22" (single page). */
function parsePageRange(s: string): { pagesFrom: number | null; pagesTo: number | null } {
  const normalized = s.replace(/[–—]/g, "-").trim();
  if (!normalized) return { pagesFrom: null, pagesTo: null };
  const parts = normalized.split("-").map(p => p.trim());
  if (parts.length === 1) {
    const n = parseIntOrNull(parts[0]);
    return { pagesFrom: n, pagesTo: n };
  }
  if (parts.length === 2) {
    return { pagesFrom: parseIntOrNull(parts[0]), pagesTo: parseIntOrNull(parts[1]) };
  }
  return { pagesFrom: null, pagesTo: null };
}

/** Splits "B1, B2, B3" into ["B1","B2","B3"]. Empty → []. */
function parseCSV(s: string): string[] {
  if (!s.trim()) return [];
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

/** Derives parent NODE id from MICRONODE id: "MN-2.3" → "N2". */
function deriveParentNodeId(mnId: string): string {
  const m = mnId.match(/^MN-(\d+)\.\d+$/);
  return m ? `N${m[1]}` : "";
}

// ── Entity builders ───────────────────────────────────────────────────────────

function buildLesson(raw: RawSection): ParsedLesson {
  const f = raw.fields;
  const { pagesFrom, pagesTo } = parsePageRange(f["pages"] ?? "");
  return {
    title:     (f["title"]    ?? "").trim(),
    subject:   (f["subject"]  ?? "").trim(),
    grade:     parseIntOrNull(f["grade"] ?? "") ?? 0,
    textbook:  (f["textbook"] ?? "").trim(),
    author:    (f["author"]   ?? "").trim(),
    section:   (f["section"]  ?? "").trim(),
    pagesFrom: pagesFrom ?? 0,
    pagesTo:   pagesTo   ?? 0,
    _line: raw.line,
  };
}

function buildNode(raw: RawSection): ParsedNode {
  return {
    id:         raw.id ?? "",
    title:      (raw.fields["title"] ?? "").trim(),
    microNodes: [],
    _line: raw.line,
  };
}

function buildMicroNode(raw: RawSection): ParsedMicroNode {
  const f = raw.fields;
  const id = raw.id ?? "";

  const sourceRefs: ParsedSourceRef[] = [];
  for (const sr of raw.sourceRefs) {
    const pipeIdx = sr.indexOf("|");
    if (pipeIdx === -1) {
      // No pipe: treat whole string as blockId, quote is empty
      const blockId = sr.trim();
      if (blockId) sourceRefs.push({ sourceBlockId: blockId, sourceQuote: "" });
    } else {
      const blockId = sr.slice(0, pipeIdx).trim();
      const quote   = sr.slice(pipeIdx + 1).trim();
      if (blockId) sourceRefs.push({ sourceBlockId: blockId, sourceQuote: quote });
    }
  }

  return {
    id,
    parentNodeId:      deriveParentNodeId(id),
    title:             (f["title"]             ?? "").trim(),
    microNodeType:     (f["microNodeType"]      ?? "").trim(),
    learningObjective: (f["learningObjective"]  ?? "").trim(),
    sourceBlockIds:    parseCSV(f["sourceBlockIds"] ?? ""),
    sourceRefs,
    exerciseIds:       parseCSV(f["exerciseIds"]    ?? ""),
    prerequisites:     parseCSV(f["prerequisites"]  ?? ""),
    relatedMicroNodes: parseCSV(f["relatedMicroNodes"] ?? ""),
    confidenceScore:   parseIntOrNull(f["confidenceScore"] ?? ""),
    sourceCoverage:    (f["sourceCoverage"] ?? "").trim(),
    status:            (f["status"]         ?? "").trim() || "draft",
    _line: raw.line,
  };
}

function buildSourceBlock(raw: RawSection): ParsedSourceBlock {
  const f = raw.fields;
  return {
    id:              raw.id ?? "",
    blockType:       (f["blockType"]       ?? "").trim(),
    sourceText:      (f["sourceText"]      ?? "").trim(),
    sourcePage:      parseIntOrNull(f["sourcePage"] ?? ""),
    sourceParagraph: (f["sourceParagraph"] ?? "").trim(),
    sourcePosition:  (f["sourcePosition"]  ?? "").trim(),
    status:          (f["status"]          ?? "").trim(),
    _line: raw.line,
  };
}

function buildExercise(raw: RawSection): ParsedExercise {
  const f = raw.fields;
  return {
    id:               raw.id ?? "",
    sourcePage:       parseIntOrNull(f["sourcePage"] ?? ""),
    sequence:         parseIntOrNull(f["sequence"]   ?? "") ?? 0,
    text:             (f["text"]          ?? "").trim(),
    exerciseType:     (f["exerciseType"]  ?? "").trim(),
    difficulty:       (f["difficulty"]    ?? "").trim(),
    cognitiveLoad:    f["cognitiveLoad"]  != null ? parseIntOrNull(f["cognitiveLoad"])  : null,
    confidenceScore:  f["confidenceScore"] != null ? parseIntOrNull(f["confidenceScore"]) : null,
    relatedMicroNodes: parseCSV(f["relatedMicroNodes"] ?? ""),
    _line: raw.line,
  };
}

function buildDependency(raw: RawSection): ParsedDependency {
  const f = raw.fields;
  return {
    id:              raw.id ?? "",
    from:            (f["from"]           ?? "").trim(),
    to:              (f["to"]             ?? "").trim(),
    dependencyType:  (f["dependencyType"] ?? "").trim(),
    reason:          (f["reason"]         ?? "").trim(),
    confidenceScore: f["confidenceScore"] != null ? parseIntOrNull(f["confidenceScore"]) : null,
    _line: raw.line,
  };
}

function buildFidelityAudit(raw: RawSection): ParsedFidelityAudit {
  // The FIDELITY AUDIT section is informational. We store it as a marker.
  // Individual issue lines inside it are not structured fields in this version.
  return { issues: [], _line: raw.line };
}

// ── Zeroed CoverageAudit (filled later by validator) ─────────────────────────

function zeroCoverageAudit(): CoverageAudit {
  return {
    totalSourceBlocks:       0,
    mappedSourceBlocks:      0,
    unmappedSourceBlocks:    0,
    unmappedSourceBlockIds:  [],
    totalExercises:          0,
    mappedExercises:         0,
    unmappedExercises:       0,
    unmappedExerciseIds:     [],
    sourceCoveragePercent:   100,
    exerciseCoveragePercent: 100,
  };
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parses a canonical TEXT mapping document into a structured result.
 *
 * Rules:
 *  - Lines starting with `#` are comments and ignored.
 *  - Blank lines reset continuation; they do NOT end a section.
 *  - Lines with 4-leading-space indent continue the previous field value.
 *  - Section markers start a new entity (e.g. `NODE N1`, `SOURCE BLOCK B3`).
 *  - Field lines are `key: value`; `sourceRef:` accumulates into an array.
 *  - Unrecognised lines are silently skipped (validator catches structural gaps).
 */
export function parseMappingText(text: string): ParsedMappingResult {
  const lines = text.split("\n");
  const rawSections: RawSection[] = [];
  let current: RawSection | null = null;
  let lastFieldKey: string | null = null;   // for multi-line continuation

  for (let i = 0; i < lines.length; i++) {
    const lineNo  = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trimEnd();   // preserve leading spaces for 4-space detection

    // 1. Comments
    if (trimmed.trimStart().startsWith("#")) continue;

    // 2. Blank line → ends continuation, ignored otherwise
    if (trimmed.trim() === "") {
      lastFieldKey = null;
      continue;
    }

    // 3. 4-space continuation (multi-line sourceText)
    if (rawLine.startsWith("    ") && lastFieldKey !== null && current !== null) {
      const lineContent = rawLine.slice(4).trimEnd();  // strip exactly 4 spaces
      current.fields[lastFieldKey] =
        (current.fields[lastFieldKey] ?? "") + "\n" + lineContent;
      continue;
    }

    const lineContent = trimmed.trim();

    // 4. Section marker
    const sectionMatch = matchSectionMarker(lineContent);
    if (sectionMatch) {
      if (current) rawSections.push(current);
      current = {
        type:       sectionMatch.type,
        id:         sectionMatch.id,
        fields:     {},
        sourceRefs: [],
        line:       lineNo,
      };
      lastFieldKey = null;
      continue;
    }

    // 5. Field line: key: value
    const fieldMatch = lineContent.match(/^([a-zA-Z][a-zA-Z0-9]*)\s*:\s?(.*)$/);
    if (fieldMatch && current) {
      const key   = fieldMatch[1];
      const value = fieldMatch[2] ?? "";

      if (key === "sourceRef") {
        // Repeated field — accumulate into array; no multi-line continuation
        current.sourceRefs.push(value);
        lastFieldKey = null;
      } else {
        current.fields[key] = value;
        lastFieldKey = key;   // enable continuation for this field
      }
      continue;
    }

    // 6. Unrecognised line — silently skip
    // (Structural gaps will be reported by the validator)
  }

  // Push final section
  if (current) rawSections.push(current);

  // ── Build typed entities ──────────────────────────────────────────────────

  let lesson: ParsedLesson | null = null;
  const nodesMap    = new Map<string, ParsedNode>();
  const allMicroNodes: ParsedMicroNode[] = [];   // collected before placement
  const sourceBlocks: ParsedSourceBlock[] = [];
  const exercises:    ParsedExercise[]    = [];
  const dependencies: ParsedDependency[]  = [];
  let fidelityAudit:  ParsedFidelityAudit | null = null;

  for (const raw of rawSections) {
    switch (raw.type) {
      case "LESSON":
        lesson = buildLesson(raw);
        break;
      case "NODE": {
        const node = buildNode(raw);
        nodesMap.set(node.id, node);
        break;
      }
      case "MICRONODE":
        allMicroNodes.push(buildMicroNode(raw));
        break;
      case "SOURCE_BLOCK":
        sourceBlocks.push(buildSourceBlock(raw));
        break;
      case "EXERCISE":
        exercises.push(buildExercise(raw));
        break;
      case "DEPENDENCY":
        dependencies.push(buildDependency(raw));
        break;
      case "FIDELITY_AUDIT":
        fidelityAudit = buildFidelityAudit(raw);
        break;
    }
  }

  // ── Place MicroNodes into parent Nodes ────────────────────────────────────

  const orphanMicroNodes: ParsedMicroNode[] = [];

  for (const mn of allMicroNodes) {
    const parent = nodesMap.get(mn.parentNodeId);
    if (parent) {
      parent.microNodes.push(mn);
    } else {
      orphanMicroNodes.push(mn);
    }
  }

  const nodes = Array.from(nodesMap.values());

  return {
    lesson,
    nodes,
    sourceBlocks,
    exercises,
    dependencies,
    fidelityAudit,
    coverageAudit:      zeroCoverageAudit(),
    _orphanMicroNodes:  orphanMicroNodes,
  };
}
