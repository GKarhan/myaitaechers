---
name: Verified lesson source sets
description: Source-scope policy for curriculum mapping, including text PDFs, scanned PDFs, and approval gates.
---

Every mapping must establish a source-safe Source Set for the selected **physical**
PDF pages before any destructive replacement. Text-extractable PDFs use one
server-extracted physical page per Pass 1 request; the server assigns that page
identity and still requires source-text containment before Pass 2. Model page
labels, printed footer numbers, and repeated cross-page headings therefore never
become provenance. Scanned/garbled PDFs use one-image-per-physical-page
processing, server-assigned page identity, and a lesson-title anchor from the
extraction because parser text cannot verify OCR.

Table-of-contents pages are never acceptable mapping material, even when they
mention the lesson title. Persisted audits and job responses contain only
identifiers, page ranges, hashes, counts, enums, and block metadata — never
source text or free-form model review prose.

**Why:** Logical textbook page labels can differ from physical PDF pages, and
provider-produced text cannot safely become a durable textbook audit trail.
Without a verified scope, unrelated source material or unreviewed teaching
candidates could gain authority through otherwise valid mapping paths.

**How to apply:** Keep text and vision extraction page-scoped; do not restore
multi-page provider page inference. Validate Source Set scope before Pass
2/persistence, rerun ownership checks after any consolidation, and fail final
approval when Source Set metadata is absent/invalid, when there are no
MicroNodes, or when any MicroNode remains outside explicit approved status.