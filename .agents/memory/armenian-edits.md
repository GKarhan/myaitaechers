---
name: Armenian text file edits
description: How to reliably edit files containing Armenian Unicode text
---

The `edit` tool fails when the `old_string` contains Armenian (or other non-ASCII) characters — the match silently fails or throws a unicode error.

**Rule:** Never use `edit` with an `old_string` that contains Armenian characters. Use line-range splicing via Python instead.

**How to apply:**
1. Read the file with `read` to find the exact 0-based line boundaries.
2. Write the new content block to `/tmp/block.tsx` using a bash heredoc (avoids Python string escaping issues with Unicode).
3. Run a Python script: read file lines, slice `lines[:start]` + new_block_lines + `lines[end:]`, write back.

**Why:** The edit tool does byte-exact string matching. Armenian codepoints in the match string get corrupted in the tool's string handling layer.
