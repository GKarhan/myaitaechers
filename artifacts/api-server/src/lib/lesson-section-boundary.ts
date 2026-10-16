/** Bound readable PDF text before provider extraction. Original physical page
 * identities and all retained characters survive unchanged. Never infer a
 * section from a fuzzy title match or from an inline section reference. */
export function boundLessonSection(
  pages: ReadonlyArray<{ pageNumber: number; text: string }>,
  lessonTitle: string,
) {
  const key = (text: string) => text.normalize('NFKC').toLowerCase()
    .replace(/§\s*\d+\.?/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  const wanted = key(lessonTitle);
  const headings = pages.flatMap((page, pageIndex) =>
    [...page.text.matchAll(/^[ \t]*§\s*(\d+)\s*\./gm)].map((match) => {
      const offset = match.index!;
      // PDF text layers sometimes duplicate headings into adjacent columns.
      const lines = page.text.slice(offset).split('\n').slice(0, 4);
      const parts = lines.flatMap(line => line.split('\t'))
        .map(part => part.replace(/§\s*\d+\.?/g, '').trim()).filter(Boolean);
      const unique = [...new Map(parts.map(part => [key(part), part])).values()];
      return { pageIndex, pageNumber: page.pageNumber, offset,
        section: Number(match[1]), headingKey: key(unique.join(' ')) };
    }));
  const matches = wanted.length >= 8
    ? headings.filter(heading => heading.headingKey.startsWith(wanted)) : [];
  if (matches.length !== 1) {
    // A document with explicit sections must not silently include neighbours
    // when the lesson anchor is absent or ambiguous. Unsectioned worksheets
    // retain the existing page-range path.
    return { pages: [...pages], audit: {
      state: headings.length ? 'REVIEW_REQUIRED' as const : 'NO_SECTION_MARKERS' as const,
      matchedSection: null, startPage: null, endPage: null, excludedCharacterCount: 0,
    } };
  }
  const start = matches[0];
  const end = headings.find(heading =>
    (heading.pageIndex > start.pageIndex ||
      (heading.pageIndex === start.pageIndex && heading.offset > start.offset)) &&
    heading.section !== start.section);
  const bounded = pages.flatMap((page, index) => {
    if (index < start.pageIndex || (end && index > end.pageIndex)) return [];
    const from = index === start.pageIndex ? start.offset : 0;
    const to = end && index === end.pageIndex ? end.offset : page.text.length;
    return to > from ? [{ pageNumber: page.pageNumber, text: page.text.slice(from, to) }] : [];
  });
  return { pages: bounded, audit: {
    state: 'BOUNDED' as const, matchedSection: start.section,
    startPage: start.pageNumber, endPage: bounded.at(-1)?.pageNumber ?? null,
    excludedCharacterCount: pages.reduce((sum, page) => sum + page.text.length, 0) -
      bounded.reduce((sum, page) => sum + page.text.length, 0),
  } };
}
