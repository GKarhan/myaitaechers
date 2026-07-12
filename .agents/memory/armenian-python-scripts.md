---
name: Armenian Python scripts
description: How to safely write Armenian Unicode to files via Python template strings
---

## Rule
When writing Armenian (or any non-ASCII Unicode) via Python template strings, do NOT use:
- `\u{1F916}` — JavaScript syntax, invalid in Python
- `\u576` — 3-digit, invalid in Python (needs exactly 4 hex digits)

## Use instead
1. Embed actual Unicode characters directly in the Python source (UTF-8 source file with `# -*- coding: utf-8 -*-` header)
2. `\uXXXX` — 4-digit hex (e.g., `\u0531` = Ա)
3. `\UXXXXXXXX` — 8-digit hex for emoji (e.g., `\U0001F916` = 🤖)
4. For JSX/TSX output that contains emoji, embed actual emoji characters in the Python template string rather than using JS-style `\u{...}` escapes.

**Why:** Python interprets `\u{...}` differently from JavaScript; `\uXXX` with fewer than 4 digits fails silently or raises SyntaxError.

**How to apply:** Every time a Python script writes a .tsx or .ts file with Armenian/emoji content.
