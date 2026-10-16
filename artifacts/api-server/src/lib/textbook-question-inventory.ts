/** Conservative text-layer inventory for explicitly delimited question lists.
 * Never reconstruct from model text or infer numbering from prose. */
const compact = (value: string) => value.normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]/gu, '');
const QUESTION_HEADINGS = new Set(['Հարցեր և առաջադրանքներ', 'Questions and tasks'].map(compact));
const END_HEADINGS = new Set(['Գործնական աշխատանքներ', 'Practical work'].map(compact));
const STRUCTURAL_HEADINGS = new Set([...QUESTION_HEADINGS, ...END_HEADINGS, compact('Ամփոփում')]);

interface SourceBlock {
  blockType: string;
  sourceText: string;
  sourcePage: number;
  sourceParagraph: string | null;
  sourceBoundingBox: { x: number; y: number; w: number; h: number } | null;
}

export function reconcileTextbookQuestions<T extends SourceBlock>(
  page: { pageNumber: number; text: string }, blocks: readonly T[],
) {
  const lines = [...page.text.matchAll(/^.*(?:\n|$)/gm)]
    .filter(match => match[0].length > 0)
    .map(match => ({ text: match[0], offset: match.index! }));
  const starts = lines.filter(line => QUESTION_HEADINGS.has(compact(line.text)));
  const start = starts.length === 1 ? starts[0] : undefined;
  const end = start && lines.find(line => line.offset > start.offset && END_HEADINGS.has(compact(line.text)));
  const structuralCorrections: number[] = [];
  const classified = blocks.map((block, index) => {
    if (STRUCTURAL_HEADINGS.has(compact(block.sourceText)) &&
      ['EXERCISE', 'ACTIVITY', 'HOMEWORK'].includes(block.blockType)) {
      structuralCorrections.push(index);
      return { ...block, blockType: 'NOTE' as const };
    }
    return block;
  });
  const baseAudit = { physicalPage: page.pageNumber, structuralCorrections: structuralCorrections.length };
  if (!start || !end) return { blocks: classified, audit: { ...baseAudit, state: 'NO_BOUNDED_LIST' as const, questionNumbers: [] as number[] } };
  const listStart = start.offset + start.text.length;
  const text = page.text.slice(listStart, end.offset);
  // Numbered subparts inside question 10 must not become questions 1–4.
  const markers = [...text.matchAll(/^[ \t]*(\d+)\.[ \t]+/gm)];
  const topLevel: Array<{ number: number; offset: number }> = [];
  let expected = 1;
  for (const marker of markers) {
    if (Number(marker[1]) === expected) {
      topLevel.push({ number: expected++, offset: marker.index! });
    } else if (Number(marker[1]) > expected) {
      return { blocks: classified, audit: { ...baseAudit, state: 'AMBIGUOUS_NUMBERING' as const, questionNumbers: topLevel.map(item => item.number) } };
    }
  }
  if (topLevel.length < 2) return { blocks: classified, audit: { ...baseAudit, state: 'AMBIGUOUS_NUMBERING' as const, questionNumbers: [] as number[] } };
  const questions = topLevel.map((item, index) => ({
    blockType: 'EXERCISE' as const,
    sourceText: text.slice(item.offset, topLevel[index + 1]?.offset ?? text.length).trim(),
    sourcePage: page.pageNumber, sourceParagraph: String(item.number), sourceBoundingBox: null,
  }));
  const listKey = compact(text);
  // Replace provider fragments from this entire fenced list, including a table
  // belonging to one question. The exact PDF slice retains that table in place.
  const inside = (block: SourceBlock) => block.sourcePage === page.pageNumber &&
    compact(block.sourceText).length > 0 && listKey.includes(compact(block.sourceText));
  const before: T[] = [], after: T[] = [];
  for (const block of classified) {
    if (inside(block)) continue;
    const location = page.text.indexOf(block.sourceText);
    if (location >= 0 ? location < listStart :
      compact(page.text.slice(0, listStart)).includes(compact(block.sourceText))) before.push(block);
    else after.push(block);
  }
  return { blocks: [...before, ...questions, ...after], audit: {
    ...baseAudit, state: 'RECONCILED' as const,
    questionNumbers: questions.map(question => Number(question.sourceParagraph)),
  } };
}
