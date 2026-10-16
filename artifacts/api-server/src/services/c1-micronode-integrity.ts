/** Pure, non-destructive C1 MicroNode integrity review.
 * Pedagogical atomicity remains a separate semantic check and must not be
 * treated as proven by these structural rules.
 */
export interface C1NodeQualityInput {
  title: string;
  learningObjective: string;
  sourceBlockIndices: readonly number[];
  supportingMaterialIndices?: readonly number[];
}
export interface C1NodeQualityFinding {
  topicIndex: number;
  nodeIndex: number;
  code: "EMPTY_TITLE" | "EMPTY_OBJECTIVE" | "MISSING_CORE_SOURCE" | "INVALID_SOURCE_REFERENCE" | "DUPLICATE_CORE_REFERENCE" | "DUPLICATE_OBJECTIVE_IN_TOPIC";
}
export function reviewC1MicroNodeIntegrity(
  topics: readonly { microNodes: readonly C1NodeQualityInput[] }[],
  verifiedSourceCount: number,
): C1NodeQualityFinding[] {
  const findings: C1NodeQualityFinding[] = [];
  topics.forEach((topic, topicIndex) => {
    const objectives = new Set<string>();
    topic.microNodes.forEach((node, nodeIndex) => {
      const flag = (code: C1NodeQualityFinding["code"]) => findings.push({ topicIndex, nodeIndex, code });
      if (!node.title.trim()) flag("EMPTY_TITLE");
      const objective = node.learningObjective.trim();
      if (!objective) flag("EMPTY_OBJECTIVE");
      else {
        const key = objective.normalize("NFKC").toLocaleLowerCase("hy-AM").replace(/\s+/g, " ");
        if (objectives.has(key)) flag("DUPLICATE_OBJECTIVE_IN_TOPIC");
        objectives.add(key);
      }
      if (!node.sourceBlockIndices.length) flag("MISSING_CORE_SOURCE");
      const references = [...node.sourceBlockIndices, ...(node.supportingMaterialIndices ?? [])];
      if (references.some(x => !Number.isInteger(x) || x < 0 || x >= verifiedSourceCount)) flag("INVALID_SOURCE_REFERENCE");
      if (new Set(node.sourceBlockIndices).size !== node.sourceBlockIndices.length) flag("DUPLICATE_CORE_REFERENCE");
    });
  });
  return findings;
}
