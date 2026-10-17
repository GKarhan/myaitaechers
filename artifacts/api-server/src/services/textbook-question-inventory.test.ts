import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTextbookQuestions } from '../lib/textbook-question-inventory.js';
import { bindTextBlocksToPhysicalPages, filterVerifiedTextBlocks } from '../lib/lesson-source-set.js';
const block = (sourceText: string, blockType: 'EXERCISE' | 'HOMEWORK' = 'EXERCISE') => ({
  blockType, sourceText, sourcePage: 9, sourceParagraph: null, sourceBoundingBox: null,
});

test('recovers omitted questions from literal source, retaining nested numbered choices', () => {
  const page = { pageNumber: 9, text: 'Questions and tasks\n1. First question\n2. Match the following:\n1. Choice A\n2. Choice B\n3. Last question\nPractical work\nDo an experiment' };
  const result = reconcileTextbookQuestions(page, [block('1. First question'), block('Practical work', 'HOMEWORK')]);
  assert.equal(result.audit.state, 'RECONCILED');
  assert.deepEqual(result.audit.questionNumbers, [1, 2, 3]);
  assert.equal(result.blocks[1].sourceText, '2. Match the following:\n1. Choice A\n2. Choice B');
  assert.equal(result.blocks[3].blockType, 'NOTE');
  assert.equal(result.audit.structuralCorrections, 1);
  assert.equal(filterVerifiedTextBlocks(bindTextBlocksToPhysicalPages([page], result.blocks).blocks).length, 4);
});
test('does not invent a missing source number', () => {
  const result = reconcileTextbookQuestions({pageNumber: 9, text: 'Questions and tasks\n1. First\n3. Third\nPractical work'}, []);
  assert.equal(result.audit.state, 'AMBIGUOUS_NUMBERING');
  assert.deepEqual(result.blocks, []);
});
test('does not infer a task list from a summary or an unbounded page', () => {
  for (const text of ['Summary\n1. Fact\n2. Fact', 'Questions and tasks\n1. First\n2. Second']) {
    assert.equal(reconcileTextbookQuestions({ pageNumber: 9, text }, []).audit.state, 'NO_BOUNDED_LIST');
  }
});
test('real Physics PDF restores question 5 and preserves all 13 questions verbatim', async () => {
  const { PDFParse } = await import('pdf-parse');
  const { readFileSync } = await import('node:fs');
  const parser = new PDFParse({data: readFileSync(new URL('../../uploads/1786712221765-283472329.pdf', import.meta.url))});
  let text: string;
  try { text = (await parser.getText({partial: [9]})).text; } finally { await parser.destroy(); }
  const page = { pageNumber: 9, text };
  // Reproduce an extraction where the model supplied no usable question 5.
  const result = reconcileTextbookQuestions(page, []);
  assert.equal(result.audit.state, 'RECONCILED');
  assert.deepEqual(result.audit.questionNumbers, Array.from({length: 13}, (_, i) => i + 1));
  assert.equal(result.blocks.length, 13);
  assert(result.blocks[4].sourceText.startsWith('5.'));
  assert(result.blocks[4].sourceText.length > 100);
  assert(result.blocks[9].sourceText.includes('1.'));
  assert.equal(result.blocks[12].sourceParagraph, '13');
  for (const item of result.blocks) assert(text.includes(item.sourceText));
  const bound = bindTextBlocksToPhysicalPages([page], result.blocks);
  assert.equal(bound.audit.quarantinedBlockCount, 0);
  assert.equal(filterVerifiedTextBlocks(bound.blocks).length, 13);
});
