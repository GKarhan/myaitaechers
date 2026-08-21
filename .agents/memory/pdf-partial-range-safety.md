---
name: PDF partial-range safety
description: The PDF parser interprets an empty selected-page list as a request for the entire document.
---

When extracting a lesson page range, validate that both endpoints are positive
integers and that the start does not exceed the end before calling the PDF
library. Never pass an empty partial-page selection downstream.

**Why:** This parser's empty partial selection means “all pages,” not “no pages.”
A reversed lesson range can therefore turn a small source request into a
whole-textbook provider prompt.

**How to apply:** Keep ordered-range validation at authoring save, mapping-route,
and extraction boundaries. Treat malformed stored ranges as a teacher-correctable
error before any AI request or destructive mapping write.