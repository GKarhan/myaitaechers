"""Offline MAP-01 source freeze. No database, network or model calls."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

PDF_SHA256 = 'd8404d572f145d4afe924d0b8af900b3d9ed085a37893594667ab07a2ec12904'
SOURCE_ID = 'physics7-section1-v1'

def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def clean(value):
    # Remove discretionary hyphens; join only explicitly discretionary line wraps.
    value = re.sub(r'\u00ad[ \t]*\n\s*', '', value)
    value = value.replace('\u00ad', '')
    return re.sub(r'\s+', ' ', value).strip()

def build(pdf):
    if sha(Path(pdf).read_bytes()) != PDF_SHA256:
        raise ValueError('Wrong source PDF SHA-256')
    raw = subprocess.check_output(['pdftotext', '-f', '6', '-l', '10', '-layout', str(pdf), '-'], text=True)
    pages = raw.split('\f')
    if len(pages) != 6 or pages[-1].strip():
        raise ValueError('Expected exactly five physical pages')
    pages = pages[:-1]
    # Match boundaries without changing raw offsets or retyping Armenian source.
    ranges = []
    for index, page in enumerate(pages):
        start, end = 0, len(page)
        if index == 0:
            start = page.index('§1.')
        if index == 4:
            end = page.index('§2.')
        else:
            # Last nonempty line is the printed running footer, never lesson text.
            lines = list(re.finditer(r'[^\n]+', page))
            footer = next(m for m in reversed(lines) if m.group().strip())
            if not re.search(rf'\b{index + 5}\b', footer.group()):
                raise ValueError('Unexpected page footer')
            end = footer.start()
        ranges.append((start, end))
    # A combined raw view with explicit offsets retains every selected character.
    selected = ''.join(p[a:b] for p, (a, b) in zip(pages, ranges))
    starts = [(0, 'introduction')]
    for i, marker in enumerate('❶❷❸❹', 1):
        starts.append((selected.index(marker), f'theory-{i:02}'))
    # Locate summary and exercise headings structurally on physical page 9.
    qpage = pages[3]
    qstarts = list(re.finditer(r'^ {4}(\d+)\.[ \t]+', qpage, re.M))
    ones = [m for m in qstarts if m.group(1) == '1']
    if len(ones) != 2:
        raise ValueError('Ambiguous summary/question inventory')
    question_start = ones[1].start()
    base = sum(b-a for a,b in ranges[:3])
    starts.append((base, 'summary'))
    actual = [m for m in qstarts if m.start() >= question_start and len(m.group()) - len(m.group().lstrip()) < 8]
    # Nested matching options have deeper indentation and must remain inside Q10.
    actual = [m for m in actual if int(m.group(1)) <= 13]
    if [int(m.group(1)) for m in actual] != list(range(1,14)):
        raise ValueError('Question inventory differs from 1..13')
    heading_start = qpage.rfind('\n', 0, question_start - 1) + 1
    starts.append((base+heading_start, 'question-heading'))
    starts.extend((base+m.start(), f'question-{int(m.group(1)):02}') for m in actual)
    bullets = list(re.finditer(r'^[ \t]*\x84', qpage, re.M))
    if len(bullets) != 2:
        raise ValueError('Expected two practical activities')
    heading_start = qpage.rfind('\n', 0, bullets[0].start() - 1) + 1
    starts.append((base+heading_start, 'practical-heading'))
    starts.extend((base+m.start(), f'practical-{i:02}') for i,m in enumerate(bullets,1))
    starts.sort()
    blocks = []
    for i,(a, kind) in enumerate(starts):
        b = starts[i+1][0] if i+1 < len(starts) else len(selected)
        fragments, cursor = [], 0
        for j,(page,(lo,hi)) in enumerate(zip(pages,ranges)):
            length = hi-lo
            left,right = max(a,cursor), min(b,cursor+length)
            if left < right:
                x,y = lo+left-cursor,lo+right-cursor
                fragments.append({'physicalPage':j+6,'printedPage':j+5,'start':x,'end':y,'rawText':page[x:y]})
            cursor += length
        text = clean(''.join(f['rawText'] for f in fragments))
        blocks.append({'id':SOURCE_ID+'/'+kind,'kind':kind,'fragments':fragments,'text':text,'sha256':sha(text)})
    result = {'schemaVersion':1,'sourceId':SOURCE_ID,'pdfSha256':PDF_SHA256,
              'extraction':{'command':'pdftotext -f 6 -l 10 -layout SOURCE.pdf -','version':subprocess.check_output(['pdftotext','-v'],stderr=subprocess.STDOUT,text=True).splitlines()[0]},
              'pages':[{'physicalPage':i+6,'printedPage':i+5,'rawText':p,'includedRange':list(ranges[i])} for i,p in enumerate(pages)],'blocks':blocks}
    result['contentSha256'] = sha(canonical([{'id':b['id'],'text':b['text'],'pages':[f['physicalPage'] for f in b['fragments']]} for b in blocks]))
    result['fixtureSha256'] = sha(canonical(result))
    return result

def manifest(fixture):
    return {k:fixture[k] for k in ('schemaVersion','sourceId','pdfSha256','contentSha256','fixtureSha256')} | {'blocks':[{'id':b['id'],'sha256':b['sha256'],'physicalPages':[f['physicalPage'] for f in b['fragments']]} for b in fixture['blocks']]}

def verify(fixture, expected):
    if manifest(fixture) != expected:
        raise ValueError('Fixture differs from pinned manifest')
    unhashed = {k:v for k,v in fixture.items() if k != 'fixtureSha256'}
    if sha(canonical(unhashed)) != fixture['fixtureSha256']:
        raise ValueError('Fixture integrity failure')
    rebuilt = []
    for b in fixture['blocks']:
        for f in b['fragments']:
            p = fixture['pages'][f['physicalPage']-6]
            if p['rawText'][f['start']:f['end']] != f['rawText']:
                raise ValueError('Fragment provenance mismatch')
            rebuilt.append(f['rawText'])
        if clean(''.join(f['rawText'] for f in b['fragments'])) != b['text'] or sha(b['text']) != b['sha256']:
            raise ValueError('Block content mismatch')
    selected = ''.join(p['rawText'][slice(*p['includedRange'])] for p in fixture['pages'])
    if ''.join(rebuilt) != selected or '§2.' in ''.join(b['text'] for b in fixture['blocks']):
        raise ValueError('Source coverage/boundary failure')
    if [f['physicalPage'] for f in fixture['blocks'][-1]['fragments']] != [9,10]:
        raise ValueError('Practical continuation lost')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-fixture', action='store_true', help='Verify frozen private JSON instead of extracting PDF')
    parser.add_argument('pdf', type=Path)
    parser.add_argument('output', nargs='?', type=Path, help='Private path outside the repository')
    args = parser.parse_args()
    if args.verify_fixture:
        verify(json.loads(args.pdf.read_text()), json.loads(Path(__file__).with_name('manifest.json').read_text()))
        print('Frozen fixture verified')
        raise SystemExit(0)
    if args.output is None:
        parser.error('Private output path required for extraction')
    if Path(__file__).resolve().parents[2] in args.output.resolve().parents:
        parser.error('Full source fixture must be stored outside the repository')
    f = build(args.pdf)
    expected = json.loads(Path(__file__).with_name('manifest.json').read_text())
    verify(f, expected)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(f,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':'verified','contentSha256':f['contentSha256'],'blocks':len(f['blocks'])}))
