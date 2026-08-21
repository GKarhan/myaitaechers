import {
  COGNITIVE_LEVELS,
  TEACHING_PACKAGE_ITEM_TYPES,
  TEACHING_PACKAGE_PROVENANCE_VALUES,
  TEACHING_PACKAGE_STATUSES,
  type TeachingPackageItemType,
  type TeachingPackageProvenance,
  type TeachingPackageStatus,
} from "@workspace/db";

export { TEACHING_PACKAGE_ITEM_TYPES, TEACHING_PACKAGE_PROVENANCE_VALUES, TEACHING_PACKAGE_STATUSES };
export type { TeachingPackageItemType, TeachingPackageProvenance, TeachingPackageStatus };

export function isTeachingPackageItemType(value: unknown): value is TeachingPackageItemType {
  return typeof value === "string" && (TEACHING_PACKAGE_ITEM_TYPES as readonly string[]).includes(value);
}

export function isTeachingPackageStatus(value: unknown): value is TeachingPackageStatus {
  return typeof value === "string" && (TEACHING_PACKAGE_STATUSES as readonly string[]).includes(value);
}

export function isTeachingPackageProvenance(value: unknown): value is TeachingPackageProvenance {
  return typeof value === "string"
    && (TEACHING_PACKAGE_PROVENANCE_VALUES as readonly string[]).includes(value);
}

/**
 * This value is an audit result, not a client-selectable input. It is assigned
 * only by the explicit approve action after loading an existing AI draft.
 */
export function isServerControlledTeachingPackageProvenance(
  provenance: TeachingPackageProvenance,
): boolean {
  return provenance === "ai_generated_teacher_approved";
}

export function requiresExplicitTeachingPackageApproval(
  provenance: TeachingPackageProvenance,
  status: TeachingPackageStatus,
): boolean {
  return provenance === "ai_generated" && status === "approved";
}

export function provenanceAfterExplicitTeachingPackageApproval(
  provenance: TeachingPackageProvenance,
): TeachingPackageProvenance {
  return provenance === "ai_generated" ? "ai_generated_teacher_approved" : provenance;
}

export function isStableCognitiveLevel(value: unknown): value is (typeof COGNITIVE_LEVELS)[number] {
  return typeof value === "string" && (COGNITIVE_LEVELS as readonly string[]).includes(value);
}

export interface TeachingPackageSeedNode {
  id: number;
  theoryContent: string | null;
  childFriendlyExplanation: string | null;
  basicExamples: unknown;
  realLifeExamples: unknown;
  commonMisconception: string | null;
  nonExamples: unknown;
  contentSourceType: string | null;
  createdBy: string | null;
}

export interface TeachingPackageSeedCandidate {
  itemType: TeachingPackageItemType;
  content: string;
  sourceItemKey: string;
  provenance: TeachingPackageProvenance;
}

function asNonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function provenanceForExistingNode(node: TeachingPackageSeedNode): TeachingPackageProvenance {
  if (node.contentSourceType === "textbook") return "source_material";
  if (node.createdBy === "teacher") return "teacher_created";
  return "ai_generated";
}

/**
 * Only fields whose semantics already exactly match a canonical item type are
 * eligible for explicit compatibility seeding. This never edits original node
 * fields and all candidates remain draft for teacher review.
 */
export function getDeterministicTeachingPackageSeedCandidates(
  node: TeachingPackageSeedNode,
): TeachingPackageSeedCandidate[] {
  const provenance = provenanceForExistingNode(node);
  const candidates: TeachingPackageSeedCandidate[] = [];
  const addText = (
    itemType: TeachingPackageItemType,
    content: string | null,
    sourceItemKey: string,
  ) => {
    const trimmed = content?.trim();
    if (trimmed) candidates.push({ itemType, content: trimmed, sourceItemKey, provenance });
  };
  const addList = (
    itemType: TeachingPackageItemType,
    values: unknown,
    sourceKeyPrefix: string,
  ) => {
    asNonEmptyStrings(values).forEach((content, index) => {
      candidates.push({
        itemType,
        content,
        sourceItemKey: `${sourceKeyPrefix}:${index}`,
        provenance,
      });
    });
  };

  addText("MAIN_EXPLANATION", node.theoryContent, "legacy:theory_content");
  addText("ALTERNATIVE_EXPLANATION", node.childFriendlyExplanation, "legacy:child_friendly_explanation");
  addList("EXAMPLE", node.basicExamples, "legacy:basic_examples");
  addList("EXAMPLE", node.realLifeExamples, "legacy:real_life_examples");
  addText("MISCONCEPTION", node.commonMisconception, "legacy:common_misconception");
  addList("COUNTEREXAMPLE", node.nonExamples, "legacy:non_examples");
  return candidates;
}