# MAP-01: frozen Physics 7 §1 source

This is an offline source preparation/checking tool, not a new mapper or an
approval endpoint. It makes no network, AI or database calls. MAP-02 must load
the same verified private JSON for both experimental arms; do not extract or
regenerate independently for each model. Runtime mapping is unchanged.

## Pinned source and private artifact

- Original PDF: existing `artifacts/api-server/uploads/1786712221765-283472329.pdf`.
- PDF SHA-256: see `manifest.json`; a different edition/file is rejected.
- Physical PDF pages **6–10**, printed pages **5–9**.
- Private frozen fixture: `physics7-section1.json`, Library ID
  `libfile_a87e8b8d00748191b30f10a643b998ce` in the project folder.
  Download that item for experiments; it is not part of this repository.
- Poppler `pdftotext` **24.02.0**, `-layout`; Python 3.10+ standard library.
- Content SHA-256:
  `7afb9f9353b7820c5ad3a908e366d43adea44b9d5e99ac5e9233c8b309f05b9d`.

The content hash covers ordered stable IDs, normalized text and physical page
references. The fixture hash additionally covers all raw selected page text,
exact character offsets, extraction metadata and fragment provenance. It excludes
only its own hash field. SHA-256 serialization is UTF-8 JSON with sorted keys,
compact separators and `ensure_ascii=False`, without a final newline.

IDs are `physics7-section1-v1/{kind}`: introduction, theory-01..04, summary,
question-heading, question-01..13, practical-heading and practical-01..02.
These are source blocks, **not knowledge nodes**. P2 remains an activity and is
not assigned a mastery relationship by this tool.

## Reproduce and verify

From repository root, choose an output **outside** the repository:

```sh
python3 scripts/map01/source_fixture.py \
  artifacts/api-server/uploads/1786712221765-283472329.pdf \
  /absolute/private-directory/physics7-section1.json
MAP01_SOURCE_PDF=artifacts/api-server/uploads/1786712221765-283472329.pdf \
  python3 -m unittest discover -s scripts/map01 -v
python3 scripts/map01/source_fixture.py --verify-fixture \
  /absolute/private-directory/physics7-section1.json
```

Verification fails closed against the checked-in manifest. A new extraction
that differs must be reviewed; never automatically refresh expected hashes to
make a test pass. Frozen-JSON verification does not require PDF or Poppler.
Without `MAP01_SOURCE_PDF`, unit tests explicitly **skip** real-source validation;
that result is not an acceptance result.

## Coverage and normalization

The chapter introduction before §1, running footers, and §2 onward are excluded.
All remaining characters are partitioned, in order, into source blocks without
gaps or duplication. Every fragment retains its raw text, physical and printed
page and half-open Unicode character offsets into that raw page. Source PDF
bytes are independently pinned. Full raw page text includes excluded neighbors
only inside the private provenance record; **model input is exclusively the
ordered `blocks[].text`**, never `pages[].rawText`.

Discretionary soft hyphens are removed; a soft hyphen followed by a line/page
wrap joins the split word. Other whitespace collapses to one space. No Armenian
word, punctuation, fact or exercise is manually rewritten. Raw layout remains
available in fragments, including Q9's empty table and Q10's matching columns.
The two fragments of practical-02 are one activity, on physical pages 9 and 10
(printed 8 and 9). The preceding paragraph continuation also keeps both pages.

The snapshot freezes **text**, including figure captions, table headings and
matching options. It does not OCR embedded drawings or reproduce figure pixels.
Image interpretation or future changes to source reading require separate review.
A layout-text source may retain source spelling/typesetting oddities; these are
not silently corrected. No new model extraction has been used.

## Evidence and remaining acceptance

Local validation on 2026-10-17: four tests pass with the real hash-pinned PDF.
The real-source test extracts twice and compares complete fixtures, verifies
provenance and full character coverage, and rejects seven corruptions (missing
question, missing continuation, altered text/page/raw page, duplicate ID and
truncated Q10 options). Frozen JSON readback verification passes.

This establishes the reproducible source input only. It does not establish C1
quality, C2/Teaching Package readiness, teacher approval, database read-after-write
or downstream acceptance. No deploy, production/main write or paid AI run occurs.
Next action: MAP-02 controlled comparison using this exact verified model input.
