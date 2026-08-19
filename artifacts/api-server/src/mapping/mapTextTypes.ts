// ────────────────────────────────────────────────────────────────────────────
// Contract v1.2 — Canonical TEXT-import type definitions
// All interfaces and enums for the deterministic TEXT → DB pipeline.
// ────────────────────────────────────────────────────────────────────────────

// ── Enum sets (use .includes() for validation) ───────────────────────────────

export const BLOCK_TYPES = [
  "DEFINITION", "RULE", "EXPLANATION", "EXAMPLE", "NON_EXAMPLE",
  "CLASSIFICATION", "TABLE", "FACT", "TERM", "NOTE",
  "EXERCISE", "QUESTION", "ACTIVITY", "PROJECT", "HOMEWORK",
  "INSTRUCTION", "OTHER",
] as const;
export type BlockType = typeof BLOCK_TYPES[number];

export const SOURCE_BLOCK_STATUSES = ["EXTRACTED", "UNREADABLE", "NEEDS_REVIEW"] as const;
export type SourceBlockStatus = typeof SOURCE_BLOCK_STATUSES[number];

export const SOURCE_COVERAGES = ["FULL", "PARTIAL", "UNCERTAIN"] as const;
export type SourceCoverage = typeof SOURCE_COVERAGES[number];

export const MICRO_NODE_TYPES = ["KNOWLEDGE", "SKILL", "KNOWLEDGE_AND_SKILL"] as const;
export type MicroNodeType = typeof MICRO_NODE_TYPES[number];

export const MICRO_NODE_LIFECYCLES = ["draft", "reviewed", "approved"] as const;
export type MicroNodeLifecycle = typeof MICRO_NODE_LIFECYCLES[number];

export const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export type Difficulty = typeof DIFFICULTIES[number];

export const DEPENDENCY_TYPES = ["PREREQUISITE"] as const;
export type DependencyType = typeof DEPENDENCY_TYPES[number];

export const EXERCISE_TYPES = [
  "RECOGNITION", "RECALL", "CLASSIFICATION", "COMPARISON",
  "APPLICATION", "ERROR_DETECTION", "TRANSFORMATION",
  "WRITING", "SPEAKING", "READING", "PROJECT", "OTHER",
] as const;
export type ExerciseType = typeof EXERCISE_TYPES[number];

// ── Parsed entities ──────────────────────────────────────────────────────────

/** One `sourceRef: Bx | quote` line inside a MICRONODE section. */
export interface ParsedSourceRef {
  sourceBlockId: string;
  sourceQuote:   string;
}

/** Parsed LESSON section. */
export interface ParsedLesson {
  title:     string;
  subject:   string;
  grade:     number;        // 0 if parse failed
  textbook:  string;
  author:    string;
  section:   string;
  pagesFrom: number;        // 0 if parse failed
  pagesTo:   number;        // 0 if parse failed
  _line:     number;
}

/** Parsed MICRONODE section.
 *  Enum fields are kept as `string` so the validator can check them and
 *  report precise errors instead of silently coercing or discarding. */
export interface ParsedMicroNode {
  id:                string;
  parentNodeId:      string;   // derived: MN-2.3 → N2
  title:             string;
  microNodeType:     string;   // validator checks MicroNodeType enum
  learningObjective: string;
  sourceBlockIds:    string[];
  sourceRefs:        ParsedSourceRef[];
  exerciseIds:       string[];
  prerequisites:     string[];
  relatedMicroNodes: string[];
  confidenceScore:   number | null;
  sourceCoverage:    string;   // validator checks SourceCoverage enum
  status:            string;   // validator checks MicroNodeLifecycle enum
  _line:             number;
}

/** Parsed NODE section (holds its child MicroNodes). */
export interface ParsedNode {
  id:         string;
  title:      string;
  microNodes: ParsedMicroNode[];
  _line:      number;
}

/** Parsed SOURCE BLOCK section. */
export interface ParsedSourceBlock {
  id:              string;
  blockType:       string;     // validator checks BlockType enum
  sourceText:      string;
  sourcePage:      number | null;  // required — null → ERROR
  sourceParagraph: string;
  sourcePosition:  string;
  status:          string;     // validator checks SourceBlockStatus enum
  _line:           number;
}

/** Parsed EXERCISE section. */
export interface ParsedExercise {
  id:               string;
  sourcePage:       number | null;  // optional — null → OK
  sequence:         number;
  text:             string;
  exerciseType:     string;    // validator checks ExerciseType enum
  difficulty:       string;    // validator checks Difficulty enum
  interactionType:  string | null; // multiple_choice | true_false | constructed_response
  correctAnswer:    string | null; // validator normalizes objective answers
  cognitiveLoad:    number | null;
  confidenceScore:  number | null;
  relatedMicroNodes: string[];
  _line:            number;
}

/** Parsed DEPENDENCY section. */
export interface ParsedDependency {
  id:              string;
  from:            string;     // MN ID
  to:              string;     // MN ID
  dependencyType:  string;     // must equal "PREREQUISITE"
  reason:          string;
  confidenceScore: number | null;
  _line:           number;
}

/** Parsed FIDELITY AUDIT section (informational only). */
export interface ParsedFidelityAudit {
  issues: Array<{ entityId: string; description: string }>;
  _line:  number;
}

/** Coverage statistics, always computed by the validator — never from TEXT. */
export interface CoverageAudit {
  totalSourceBlocks:       number;
  mappedSourceBlocks:      number;
  unmappedSourceBlocks:    number;
  unmappedSourceBlockIds:  string[];
  totalExercises:          number;
  mappedExercises:         number;
  unmappedExercises:       number;
  unmappedExerciseIds:     string[];
  sourceCoveragePercent:   number;
  exerciseCoveragePercent: number;
}

/** Top-level output of `parseMappingText`. */
export interface ParsedMappingResult {
  lesson:            ParsedLesson | null;   // null if LESSON section missing
  nodes:             ParsedNode[];          // from NODE sections only
  sourceBlocks:      ParsedSourceBlock[];
  exercises:         ParsedExercise[];
  dependencies:      ParsedDependency[];
  fidelityAudit:     ParsedFidelityAudit | null;
  coverageAudit:     CoverageAudit;         // zeroed by parser; filled by validator
  /** MicroNodes whose parent NODE ID has no corresponding NODE section. */
  _orphanMicroNodes: ParsedMicroNode[];
}

// ── Validation types ─────────────────────────────────────────────────────────

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity:    ValidationSeverity;
  issueType:   string;
  entityId:    string | null;
  description: string;
  line:        number | null;
}

export interface ValidationResult {
  ok:            boolean;           // true when zero errors (warnings allowed)
  errors:        ValidationIssue[];
  warnings:      ValidationIssue[];
  all:           ValidationIssue[];
  coverageAudit: CoverageAudit;
}

// ── Preview (returned by dryRun=true) ────────────────────────────────────────

export interface MappingPreview {
  lessonTitle:   string;
  pagesFrom:     number;
  pagesTo:       number;
  counts: {
    nodes:        number;
    microNodes:   number;
    sourceBlocks: number;
    exercises:    number;
    dependencies: number;
  };
  coverageAudit: CoverageAudit;
  errors:        ValidationIssue[];
  warnings:      ValidationIssue[];
  hasErrors:     boolean;
}

// ── Insertion result ─────────────────────────────────────────────────────────

export interface InsertionResult {
  topicsCreated:       number;
  microNodesCreated:   number;
  exercisesCreated:    number;
  dependenciesCreated: number;
  reviewItemsCreated:  number;
}
