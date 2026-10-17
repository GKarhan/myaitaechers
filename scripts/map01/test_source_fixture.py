"""Offline regression tests, with a hash-pinned real-source check when provided."""
import copy
import json
import os
from pathlib import Path
import unittest
from source_fixture import build, clean, manifest, sha, verify

ROOT = Path(__file__).parent

class SourceFixtureTest(unittest.TestCase):
    def test_soft_wrap_across_page(self):
        self.assertEqual(clean('abc\u00ad\n\n    def'), 'abcdef')
        self.assertEqual(clean('abc\ndef'), 'abc def')

    def test_reject_wrong_pdf(self):
        with self.assertRaisesRegex(ValueError, 'Wrong source'):
            build(__file__)

    def test_manifest_inventory(self):
        expected = json.loads((ROOT/'manifest.json').read_text())
        ids = [b['id'].split('/')[-1] for b in expected['blocks']]
        self.assertEqual(len(ids),len(set(ids)))
        self.assertEqual([i for i in ids if i.startswith('question-') and i != 'question-heading'],[f'question-{i:02}' for i in range(1,14)])
        self.assertEqual([i for i in ids if i.startswith('practical-') and i != 'practical-heading'],['practical-01','practical-02'])
        self.assertEqual(expected['blocks'][-1]['physicalPages'],[9,10])

    @unittest.skipUnless(os.environ.get('MAP01_SOURCE_PDF'), 'Private source not supplied; not a real-source acceptance')
    def test_real_source_repeat_and_tamper(self):
        expected = json.loads((ROOT/'manifest.json').read_text())
        first = build(os.environ['MAP01_SOURCE_PDF'])
        second = build(os.environ['MAP01_SOURCE_PDF'])
        self.assertEqual(first,second)
        verify(first,expected)
        self.assertEqual([p['printedPage'] for p in first['pages']],[5,6,7,8,9])
        for mutate in ('delete-question','delete-continuation','alter-text','alter-page','alter-raw','duplicate-id','alter-table'):
            with self.subTest(mutate=mutate):
                f = copy.deepcopy(first)
                if mutate == 'delete-question': f['blocks'].pop(11)
                if mutate == 'delete-continuation': f['blocks'][-1]['fragments'].pop()
                if mutate == 'alter-text': f['blocks'][0]['text'] += 'x'
                if mutate == 'alter-page': f['blocks'][-1]['fragments'][0]['physicalPage'] = 8
                if mutate == 'alter-raw': f['pages'][0]['rawText'] += 'x'
                if mutate == 'duplicate-id': f['blocks'][-1]['id'] = f['blocks'][0]['id']
                if mutate == 'alter-table':
                    b = next(b for b in f['blocks'] if b['kind'] == 'question-10')
                    b['text'] = b['text'][:-20]
                with self.assertRaises(ValueError): verify(f,expected)

if __name__ == '__main__': unittest.main()
