/**
 * C1 source-disposition completeness gate.
 *
 * Source blocks must be accounted for even when they do not become MicroNodes.
 * A textbook exercise/activity may be attached to a node, placed in the
 * supplementary pool, or explicitly flagged for teacher review; it must not
 * silently disappear. Pure function: no DB changes and no automatic approval.
 */
export interface C1SourceDisposition {
  sourceBlockId: string;
  kind: "KNOWLEDGE" | "EXERCISE" | "ACTIVITY" | "HOMEWORK" | "CONTEXT";
  disposition: "MICRONODE" | "ATTACHED_TASK" | "SUPPLEMENTARY_TASK" | "REVIEW_REQUIRED" | "EXCLUDED";
  reason?: string;
}
export interface C1CoverageIssue {
  code: "DUPLICATE_SOURCE_ID" | "MISSING_SOURCE_ID" | "TASK_NOT_PRESERVED" | "EXCLUSION_WITHOUT_REASON" | "EMPTY_SOURCE_ID";
  sourceBlockId: string;
}
export interface C1CoverageReport {
  ok: boolean;
  sourceCount: number;
  accountedCount: number;
  taskCount: number;
  preservedTaskCount: number;
  issues: C1CoverageIssue[];
}

const TASK_KINDS = new Set<C1SourceDisposition["kind"]>(["EXERCISE", "ACTIVITY", "HOMEWORK"]);
const PRESERVED_TASK_STATES = new Set<C1SourceDisposition["disposition"]>(["ATTACHED_TASK", "SUPPLEMENTARY_TASK", "REVIEW_REQUIRED"]);

export function auditC1SourceDispositions(
  expectedSourceIds: readonly string[],
  dispositions: readonly C1SourceDisposition[],
): C1CoverageReport {
  const issues: C1CoverageIssue[] = [];
  const expected = new Set(expectedSourceIds);
  const seen = new Set<string>();
  let taskCount = 0;
  let preservedTaskCount = 0;

  for (const item of dispositions) {
    const id = item.sourceBlockId.trim();
    if (!id) issues.push({ code: "EMPTY_SOURCE_ID", sourceBlockId: id });
    if (seen.has(id)) issues.push({ code: "DUPLICATE_SOURCE_ID", sourceBlockId: id });
    seen.add(id);
    if (!expected.has(id)) issues.push({ code: "MISSING_SOURCE_ID", sourceBlockId: id });
    if (TASK_KINDS.has(item.kind)) {
      taskCount++;
      if (PRESERVED_TASK_STATES.has(item.disposition)) preservedTaskCount++;
      else issues.push({ code: "TASK_NOT_PRESERVED", sourceBlockId: id });
    } else if (item.disposition === "EXCLUDED" && !item.reason?.trim()) {
      issues.push({ code: "EXCLUSION_WITHOUT_REASON", sourceBlockId: id });
    }
  }
  for (const id of expected) {
    if (!seen.has(id)) issues.push({ code: "MISSING_SOURCE_ID", sourceBlockId: id });
  }

  return {
    ok: issues.length === 0,
    sourceCount: expectedSourceIds.length,
    accountedCount: expectedSourceIds.filter(id => seen.has(id)).length,
    taskCount,
    preservedTaskCount,
    issues,
  };
}
