export type SourceSupportStatus = "SUFFICIENT" | "PARTIAL" | "INSUFFICIENT" | "UNREADABLE";

export type SourceAlignmentAudit = {
  status: SourceSupportStatus;
  reasonCode: "DIRECT_SUPPORT" | "PARTIAL_CONCEPT_OVERLAP" | "NO_CONCEPT_OVERLAP" | "HEADING_ONLY" | "UNREADABLE_SOURCE";
  matchedConceptCount: number;
};

type SourceBlock = { sourceText: string; blockType?: string | null };

const ARMENIAN_SUFFIXES = ["ությունների", "ության", "ություն", "ներից", "ների", "ներով", "մանը", "ումը", "ման", "ների", "ները", "երի", "ներ", "ում", "ի", "ը"];
const GENERIC = new Set(["աշակերտ", "կարող", "պետք", "լինի", "մասին", "դասի", "շենք", "տրված"]);

function tokens(value: string): Set<string> {
  return new Set(value.normalize("NFKC").toLocaleLowerCase("hy-AM")
    .split(/[^\p{L}\p{N}]+/u).map((raw) => {
      let token = raw.trim();
      for (const suffix of ARMENIAN_SUFFIXES) {
        if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
          token = token.slice(0, -suffix.length);
          break;
        }
      }
      return token;
    }).filter((token) => token.length >= 3 && !GENERIC.has(token)));
}

export function isUnreadableSource(value: string): boolean {
  const text = value.trim();
  if (text.length < 20) return true;
  if (/(?:\?[^\s]){2,}|�|□{2,}/u.test(text)) return true;
  const readable = [...text].filter((char) => /\p{L}|\p{N}/u.test(char)).length;
  return readable / Math.max(text.length, 1) < 0.42;
}

/** A deterministic safety classification, not a claim of full linguistic entailment. */
export function classifyMicroNodeSourceAlignment(
  learningObjective: string | null | undefined,
  sourceBlocks: readonly SourceBlock[],
): SourceAlignmentAudit {
  const sourceText = sourceBlocks.map((block) => block.sourceText ?? "").join("\n").trim();
  if (isUnreadableSource(sourceText)) {
    return { status: "UNREADABLE", reasonCode: "UNREADABLE_SOURCE", matchedConceptCount: 0 };
  }
  const onlyHeadings = sourceBlocks.length > 0 &&
    sourceBlocks.every((block) => block.blockType === "OBJECTIVE" && (block.sourceText ?? "").trim().length < 80);
  if (onlyHeadings) {
    return { status: "INSUFFICIENT", reasonCode: "HEADING_ONLY", matchedConceptCount: 0 };
  }
  const objective = tokens(learningObjective ?? "");
  const source = tokens(sourceText);
  const matched = [...objective].filter((token) => source.has(token)).length;
  if (matched >= 2 || (objective.size <= 2 && matched === objective.size && objective.size > 0)) {
    return { status: "SUFFICIENT", reasonCode: "DIRECT_SUPPORT", matchedConceptCount: matched };
  }
  if (matched === 1) {
    return { status: "PARTIAL", reasonCode: "PARTIAL_CONCEPT_OVERLAP", matchedConceptCount: matched };
  }
  return { status: "INSUFFICIENT", reasonCode: "NO_CONCEPT_OVERLAP", matchedConceptCount: 0 };
}

export function pedagogicalNearDuplicate(
  a: { title: string; learningObjective: string },
  b: { title: string; learningObjective: string },
): boolean {
  const left = tokens(`${a.title} ${a.learningObjective}`);
  const right = tokens(`${b.title} ${b.learningObjective}`);
  const shared = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return shared >= 2 && shared / Math.max(union, 1) >= 0.4;
}