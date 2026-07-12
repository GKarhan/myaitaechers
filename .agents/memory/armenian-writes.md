---
name: Armenian UTF-8 file writes
description: How to safely write Armenian Unicode into TypeScript/TSX source files
---

## Rule
Use Python with a template string + `.replace()` substitution pattern. Never use:
- Bash heredocs (multi-byte chars get corrupted)
- Python f-strings (JSX `{}` braces conflict with f-string interpolation)

## How to apply
1. Read exact Armenian strings from source files using Python: `spec_lines[n-1].strip()` and `line.split(' ', 1)[1]` to strip emoji prefix (emojis are 1 code point in Python 3)
2. Write a template string (regular `""" """`, NOT f-string) with `__PLACEHOLDER__` markers
3. Chain `.replace("__MARKER__", armenian_var)` calls
4. Write result with `open(path, 'w', encoding='utf-8').write(result)`

**Why:** bash heredocs corrupt Armenian multi-byte UTF-8. f-strings break on JSX `{user.fullName}` syntax.

## Confirmed source of truth
- `attached_assets/Pasted-Redesign...txt` — spec file with real Armenian Unicode sidebar labels and UI strings
- `artifacts/myaiteacher/src/pages/teacher-dashboard.tsx` — confirmed working Armenian status labels (Ավartvats, Wnthacqi мej, etc.)

## Key Armenian strings (from spec file, confirmed working)
Extract with: `spec_lines[n-1].strip()` then `after_emoji = line.split(' ', 1)[1]`
- Status completed: `spec(110)` stripped = Ավartvats
- Status active: `spec(108)` stripped = Wnthacqi мej
- Status waiting: `spec(106)` stripped = Сpassum е
- Start lesson button: `spec(96)` = ▶ СKSEL ДАСЫ (keep full with arrow)
- Empty homework: `spec(152)` = Тnayin аshkhatanikner chkan
