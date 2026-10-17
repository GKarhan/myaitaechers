import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundLessonSection } from '../lib/lesson-section-boundary.js';

test('keeps a cross-page task continuation but excludes the next section', () => {
  const result = boundLessonSection([
    { pageNumber: 6, text: 'Chapter introduction\n§1. First concept\nTask begins' },
    { pageNumber: 7, text: 'Task continues\n§2. Next concept\nOther material' },
    { pageNumber: 8, text: 'Other section continues' },
  ], 'First concept');
  assert.deepEqual(result.pages, [
    { pageNumber: 6, text: '§1. First concept\nTask begins' },
    { pageNumber: 7, text: 'Task continues\n' },
  ]);
  assert.equal(result.audit.state, 'BOUNDED');
});
test('supports duplicated, wrapped PDF headings without rewriting retained text', () => {
  const source = 'Intro\n§1.\t§1. First concept\tFirst concept\nSecond concept\tSecond concept\n❶ body';
  const result = boundLessonSection([{ pageNumber: 6, text: source }], 'First concept: Second concept');
  assert.equal(result.audit.state, 'BOUNDED');
  assert.equal(result.pages[0].text, source.slice(source.indexOf('§1.')));
});
test('inline references do not terminate a lesson', () => {
  const source = '§1. First concept\nRefer to §2. for more details.\nTask';
  assert.equal(boundLessonSection([{ pageNumber: 1, text: source }], 'First concept').pages[0].text, source);
});
test('explicit mismatched or ambiguous sections require review', () => {
  assert.equal(boundLessonSection([{ pageNumber: 1, text: '§2. Other concept' }], 'First concept').audit.state, 'REVIEW_REQUIRED');
  assert.equal(boundLessonSection([{ pageNumber: 1, text: '§1. First concept\n§2. First concept' }], 'First concept').audit.state, 'REVIEW_REQUIRED');
});
test('unsectioned worksheets keep their selected page range', () => {
  const pages = [{ pageNumber: 3, text: 'Worksheet with five tasks' }];
  assert.deepEqual(boundLessonSection(pages, 'Worksheet').pages, pages);
});

test('Physics 7 PDF keeps the exact last-page continuation before section 2', async () => {
  const { PDFParse } = await import('pdf-parse');
  const { readFileSync } = await import('node:fs');
  const parser = new PDFParse({ data: readFileSync(new URL('../../uploads/1786712221765-283472329.pdf', import.meta.url)) });
  const pages: Array<{ pageNumber: number; text: string }> = [];
  try {
    for (let pageNumber = 6; pageNumber <= 10; pageNumber++) {
      pages.push({ pageNumber, text: (await parser.getText({ partial: [pageNumber] })).text.trim() });
    }
  } finally { await parser.destroy(); }
  const title = pages[0].text.slice(pages[0].text.indexOf('§1.')).split('\n').slice(0, 2)
    .map(line => line.split('\t').map(part => part.replace(/§\s*\d+\.?/g, '').trim()).find(Boolean)).join(' ');
  const result = boundLessonSection(pages, title);
  assert.equal(result.audit.state, 'BOUNDED');
  assert.equal(result.audit.matchedSection, 1);
  assert.deepEqual(result.pages.map(page => page.pageNumber), [6, 7, 8, 9, 10]);
  assert.equal(result.pages.at(-1)!.text, pages.at(-1)!.text.split('§2.')[0]);
  assert(result.pages.at(-1)!.text.length > 200);
  assert(!result.pages.some(page => page.text.includes('§2.')));
});
