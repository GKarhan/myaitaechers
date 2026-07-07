---
name: Armenian text encoding
description: How to get correct Armenian Unicode into source files without manual transcription errors
---

The project uses correct Armenian Unicode (codepoints U+0531–U+058F) for all UI text. When reading Armenian chars in tool outputs, the rendered glyphs can look identical to Latin or Cyrillic characters, making manual transcription unreliable.

**Rule:** Always extract Armenian strings from known-good source files using Python regex with `[\u0531-\u058F]` codepoint ranges, then inject the exact bytes via Python string operations. Never manually type or copy-paste Armenian text from tool output.

**Why:** Armenian Ա (U+0531) looks like Latin A; Armenian ե (U+0565) looks like e; Armenian ք (U+0584) looks like k/q, etc. The visual similarity causes transcription errors that produce Latin/Cyrillic "mojibake" that renders correctly in some contexts but breaks proper Armenian text.

**How to apply:**
1. Extract correct strings from `artifacts/myaiteacher/src/pages/admin-dashboard.tsx` using `re.search(r'(Ու[\u0531-\u058F]+ներ)', admin)` etc.
2. Extract spec-confirmed correct terms from `attached_assets/Pasted-myaiteacher--*.txt` using `re.findall(r'«([^»]+)»', spec)` — pairs are (correct, wrong, correct, wrong…)
3. Use Python `.replace()` or `re.sub()` to inject into target files — never write Armenian chars as string literals in Python scripts.

**Key confirmed-correct terms (from admin-dashboard + spec):**
- Teachers (pl): `Ուsutsichner` extracted via `"(Ու[\u0531-\u058F]+ներ)"`
- Students (pl): spec_terms[2] from «» pairs  
- Courses (pl): spec_terms[4] — "Դasyntatsner"
- My Schedule: spec_terms[6] — "Im Dasatsutsaky"
- My Classes: spec_terms[8] — "Im Dasarannery"
- Logout: `>(Ե[\u0531-\u058F]+)</button>`
- Save: `>(Պ[\u0531-\u058F]+)</button>`
- Cancel: `>(Չ[\u0531-\u058F]+)</button>`
- Delete: `"(Ջ[\u0531-\u058F]+)"`
