import { COGNITIVE_LEVELS, type CognitiveLevel } from "@workspace/db";

export const COGNITIVE_DEPTHS = COGNITIVE_LEVELS;
export type CognitiveDepth = CognitiveLevel;

export const COGNITIVE_DEPTH_RANK: Record<CognitiveDepth, number> = {
  remember: 1,
  understand: 2,
  apply: 3,
  analyze: 4,
  evaluate: 5,
  create: 6,
};

export function isCognitiveDepth(value: unknown): value is CognitiveDepth {
  return typeof value === "string" && (COGNITIVE_DEPTHS as readonly string[]).includes(value);
}

export function bloomIntToDepth(value: number | null | undefined): CognitiveDepth {
  const bounded = Math.max(1, Math.min(6, value ?? 1));
  return COGNITIVE_DEPTHS[bounded - 1];
}

export interface CognitivePathSnapshot {
  cognitiveLevel: string;
  isApplicable: boolean;
  isTargetCeiling: boolean;
}

export interface NodeCognitiveCapacityInput {
  targetBloomLevel: number | null | undefined;
  cogPathStatus: string | null | undefined;
  levels: CognitivePathSnapshot[];
}

export interface NodeCognitiveCapacity {
  depth: CognitiveDepth;
  source: "confirmed_path" | "unconfirmed_path" | "legacy_target";
  warnings: string[];
}

/**
 * Resolve the current curriculum capacity from the stable target ceiling.
 * A path is preferred whenever it supplies a valid ceiling; the old integer is
 * only a compatibility copy for legacy/unenriched nodes.
 */
export function deriveNodeCognitiveCapacity(
  input: NodeCognitiveCapacityInput,
): NodeCognitiveCapacity {
  const ceiling = input.levels.find(
    (level) => level.isApplicable && level.isTargetCeiling && isCognitiveDepth(level.cognitiveLevel),
  );
  if (ceiling && isCognitiveDepth(ceiling.cognitiveLevel)) {
    return {
      depth: ceiling.cognitiveLevel,
      source: input.cogPathStatus === "confirmed" ? "confirmed_path" : "unconfirmed_path",
      warnings: input.cogPathStatus === "confirmed" ? [] : ["COGNITIVE_PATH_NOT_CONFIRMED"],
    };
  }

  return {
    depth: bloomIntToDepth(input.targetBloomLevel),
    source: "legacy_target",
    warnings: ["COGNITIVE_PATH_MISSING"],
  };
}

export function isDepthWithinCapacity(
  requiredDepth: CognitiveDepth,
  capacity: NodeCognitiveCapacity,
): boolean {
  return COGNITIVE_DEPTH_RANK[requiredDepth] <= COGNITIVE_DEPTH_RANK[capacity.depth];
}

export function getAlignmentWarnings(
  role: "REQUIRED" | "SUPPORTING",
  requiredDepth: CognitiveDepth,
  capacity: NodeCognitiveCapacity,
): string[] {
  const warnings = [...capacity.warnings];
  if (role === "REQUIRED" && capacity.source !== "confirmed_path") {
    warnings.push("REQUIRED_DEPTH_NEEDS_CONFIRMED_PATH");
  }
  if (!isDepthWithinCapacity(requiredDepth, capacity)) {
    warnings.push("REQUIRED_DEPTH_EXCEEDS_NODE_CAPACITY");
  }
  return [...new Set(warnings)];
}

/**
 * Returns an out-of-band sequence for every item before a final normalized
 * reorder. Moving every row to these values first avoids transient collisions
 * with the immediate unique (lesson_id, sequence) index during swaps.
 */
export function buildTemporarySequencePlan(
  currentSequences: number[],
  orderedIds: number[],
): Array<{ id: number; temporarySequence: number; finalSequence: number }> {
  const temporaryBase = Math.max(0, ...currentSequences) + orderedIds.length + 1;
  return orderedIds.map((id, index) => ({
    id,
    temporarySequence: temporaryBase + index,
    finalSequence: index + 1,
  }));
}