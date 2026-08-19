# Stage 4.1 — Existing Exercise Remediation Dry Run

Generated read-only from the current development database. **No database rows were modified.**

## Summary

- TOTAL: 34
- SAFE_NO_CHANGE: 3
- SAFE_REMEDIATION_PROVABLE: 2
- REVIEW_REQUIRED_CONTENT: 29
- REVIEW_REQUIRED_EVALUATION: 32
- REVIEW_REQUIRED_PROVENANCE: 34

Review classifications overlap: a row can have a provable learner-text repair while still requiring evaluation or provenance review. Only the two rows in SAFE_REMEDIATION_PROVABLE are authorized for a field-level write.

## Row index

| DB id | Exercise ID | Lesson | MicroNode | Current learner-safety state | Classification | Write authorized |
|---:|---|---:|---:|---|---|---|
| 7 | EX-51-1 | 51 | 46 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 8 | EX-51-2 | 51 | 47 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 9 | EX-51-3 | 51 | 48 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 36 | EX-61-1 | 61 | 78 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 37 | EX-61-2 | 61 | 77 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 159 | EX-60-1 | 60 | 961 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 160 | EX-60-2 | 60 | 961 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 161 | EX-60-3 | 60 | 965 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 162 | EX-60-4 | 60 | 965 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 844 | EX-69-1 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 845 | EX-69-2 | 69 | 1291 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 846 | EX-69-3 | 69 | 1291 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 847 | EX-69-4 | 69 | 1291 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 848 | EX-69-5 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 849 | EX-69-6 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 850 | EX-69-7 | 69 | 1293 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 851 | EX-69-8 | 69 | 1293 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 852 | EX-69-9 | 69 | 1293 | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 853 | EX-69-10 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 854 | EX-69-11 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 855 | EX-69-12 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 856 | EX-69-13 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 857 | EX-69-14 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 858 | EX-69-15 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 859 | EX-69-16 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 860 | EX-69-17 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 861 | EX-69-18 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 862 | EX-69-19 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 863 | EX-69-20 | 69 | — | validated_verbatim_fallback | REVIEW_REQUIRED_CONTENT<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 940 | EX-579-1 | 579 | 2107 | edited | SAFE_NO_CHANGE<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 941 | EX-579-2 | 579 | 2107 | blocked: explicit-answer-key | SAFE_REMEDIATION_PROVABLE<br>REVIEW_REQUIRED_PROVENANCE | YES — edited text only |
| 942 | EX-579-3 | 579 | 2107 | blocked: expected-answer-guidance, success-criteria-exposed | SAFE_REMEDIATION_PROVABLE<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | YES — edited text only |
| 943 | EX-579-4 | 579 | 2107 | edited | SAFE_NO_CHANGE<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |
| 944 | EX-579-5 | 579 | 2107 | edited | SAFE_NO_CHANGE<br>REVIEW_REQUIRED_EVALUATION<br>REVIEW_REQUIRED_PROVENANCE | NO |

## Per-row evidence and proposal

### EX-51-1 (DB 7)

- Lesson: 51; related MicroNode: 46
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
76284345
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: ```text
Ճիշտ տրոհումը և մեկնաբանությունը՝ 76284-345 (հազարների և միավորների դասեր):
```
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 8
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-51-2 (DB 8)

- Lesson: 51; related MicroNode: 47
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Որքա՞ն է 3 458 թվի միավորների (մեկերի) քանակը: Որքա՞ն է 3 458 թվի միավորների քանակը միավորների դասում: Որքա՞ն է 3 423 458 թվի հազարների քանակը: Որքա՞ն է 3 423 458 թվի հազարների քանակը հազարների դասում: Որքա՞ն է 32 324 458 թվի միլիոնների քանակը: Որքա՞ն է 32 324 458 թվի միլիոնների քանակը միլիոնների դասում:
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: ```text
Ճիշտ պատասխանները՝ 8, 8, 423, 423, 32, 32:
```
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 8
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-51-3 (DB 9)

- Lesson: 51; related MicroNode: 48
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Ի՞նչ է ցույց տալիս 6 թվանշանը տրված թվի գրության մեջ: Ի՞նչ ցույց կտա 6–ը, եթե տրված թվի առաջին թվանշանը ջնջենք: Ի՞նչ ցույց կտա 6–ը, եթե տրված թվի վերջին թվանշանը ջնջենք:
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: ```text
Ճիշտ պատասխանները՝ 6-ը ցույց է տալիս հազարավորների կարգը, 6-ը կդառնա հարյուրավորների կարգ, 6-ը կմնա հազարավորների կարգ:
```
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 10
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-61-1 (DB 36)

- Lesson: 61; related MicroNode: 78
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Գծեք ձեր երևակայությամբ Մեսրոպ Մաշտոցի այբուբեն ստեղծելու պահը
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: ```text
Նկարը արտահայտում է այբուբենի ստեղծման գաղափարը
```
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: —
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-61-2 (DB 37)

- Lesson: 61; related MicroNode: 77
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Գրեք կարճ պատում, թե ինչ կլիներ, եթե հայերենի այբուբեն չստեղծվեր
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: ```text
Պատումն արտահայտում է այբուբենի կարևորությունը
```
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: —
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-60-1 (DB 159)

- Lesson: 60; related MicroNode: 961
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Լուծե՛ք տրված խաչբառը՝ բաժանելով երեք խմբի։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 16
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-60-2 (DB 160)

- Lesson: 60; related MicroNode: 961
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
42. 1. Սկարագրգրի Հայաստանի դրոշը, զինանշանը։
2. Լսեք Հայաստանի Հանրապետության հիմնը։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 16
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-60-3 (DB 161)

- Lesson: 60; related MicroNode: 965
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
1. Որոշի՛ր առարկա, հատկանիշ, գործողություն ցույց տվող բառերը և գրի՛ր
առանձին սյունակներով։
աղբյուր, սև, դժգույն, բարձր, գիրք, գնալ, փայլել, տասնհինգ, գործել, փորել,
չորրորդ, կանխել, ազնիվ, բուրդ, գրատախտակ, փոքր, լայն, շքեղ, կորցնել,
ամուր, ապակի, կարծր, համարել, պայուսակ, բողոք, արտասանել, վերց-
նել, ակնթարթ, մակույկ, մրուր, բարձրացնել, հուշարձան, արևորդի, հեռ-
նային, վայրենանալ, այժմկյան, տխրություն, բորբոքել, տասներորդ,
կցկտուր, կծկել, քամահրել, տարրալուծել, վարդագույն, արփի։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 19
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-60-4 (DB 162)

- Lesson: 60; related MicroNode: 965
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
2. Տրված սխալից դուրս գրի՛ր առարկա, հատկանիշ, գործողություն ցույց
տվող սերգական բառ։
Մարտատը ճաշկալում տեղաշարժի անհնարարժի լեռն է՝ կազմված
երկու կրճակա զարգաթերից, որոնցից մանր կոչվում է Մասիս, փոքրը Սիս։
Արարատի գագաթը ծածկված է հավերժական ձյունով։ Լեռան անունը
Աստվածաշնչում հիշատակվում է իբրև Համաշխարհային ջրհեղեղից
փրկված Նոյ նահապետի առաջին հանգրվան։ Ըստ ավանդության՝ Արա-
րատի վրա են գտնվել հայ թագավորների շիրիմները։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 19
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-1 (DB 844)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
21  	Ըստ նմու շի՝ հե քի ա թից դո՛ւրս գրիր հե րոս նե րի հատ կա նիշ ե րը հիմ
նա վո րող մտ քերը:
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 30
- sourceText: _empty_
- sourceBlockIndex: 0
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-2 (DB 845)

- Lesson: 69; related MicroNode: 1291
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Նայի՛ր օ րի նակ նե րը: Ի՞նչ օ րի նա չա փու թյուն ես նկա տում:
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 31
- sourceText: _empty_
- sourceBlockIndex: 5
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-3 (DB 846)

- Lesson: 69; related MicroNode: 1291
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
1 	Ար տագ րի՛ր՝ լրացնելով –եր(ը) կամ –ներ(ը):
Հայաս տանում հայտնի է ա ղավնի___ պահե լու սո վո րու թյունը: Ա սում ե ն՝ ա ղավ
նի____ մի լավ սո վո րու թյուն ունեն: Նրանք ամբողջ օ րը գնում են այգի___ ,
պար տեզ___ , դաշտ__ 	u ան տառ___ : Ե րե կոյան, որ տեղ էլ որ լինեն,
վե րադառ նում են ի րենց բն___ :
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 32
- sourceText: _empty_
- sourceBlockIndex: 8
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-4 (DB 847)

- Lesson: 69; related MicroNode: 1291
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
2 	Ունկնդրի՛ր: Գծի՛ր ա ղյու սակ և ա ռան ձին սյու նակ նե րում
gրի՛ր ե զա կի և հոգ նա կի գո յա կան նե րը:
Եզակի 	Հոգնակի
շա ռաչ 	— այս տեղ՝ ջրի ձայ նը
հորձանք տալ 	— վա րա րել
զմ րուխտ 	— 1) վառ կանաչ թանկարժեք քար
2) վառ կանաչ
3) զմրուխտանման
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 32
- sourceText: _empty_
- sourceBlockIndex: 9
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-5 (DB 848)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
3 	Ա մա ռային պայ ծառ ար ևի շո ղե րից Սևա նը զմ րուխ տի պես փայ լում էր
նա խա դա սու թյան մեջ ո՞ր ի մաս տով է գոր ծած վել զմ րուխտ բա ռը։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 32
- sourceText: _empty_
- sourceBlockIndex: 10
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-6 (DB 849)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
4 	« Գե տը» բա նաս տեղծու թյան հե ղի նա կը պատմում է, թե ի նչ օ գուտ
ներ է տա լիս գե տը: Ի՞նչ օգուտներ կարող են լինել դրանք։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 32
- sourceText: _empty_
- sourceBlockIndex: 11
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-7 (DB 850)

- Lesson: 69; related MicroNode: 1293
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
6 	Բա նաս տեղծու թյու նից դո՛ւրս գրիր հոգ նա կի և ե զա կի 4–ա կան
gո յա կան:
Դուրս գրած հոգ նա կի գո յա կան նե րը դարձ րո՛ւ ե զա կի, ե զա կի գո յա
կան նե րը՝ հոգ նա կի:
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 33
- sourceText: _empty_
- sourceBlockIndex: 15
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-8 (DB 851)

- Lesson: 69; related MicroNode: 1293
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
7 	Հարցերի պատասխաններով ամ բող ջաց րո՛ւ ա ղյու սա կը։
Ին չե՞ր 	Ին չե՞ րը 	Ին չե րի՞ 	Ին չե րի՞ն 	Ին չե րի՞ց 	Ին չե րո՞վ 	Ինչերո՞ւմ
gե տեր
Փո փոխ ված ձևե րից եր կու սը գոր ծա ծի՛ր նա խա դա սու թյուն նե րի մեջ։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 34
- sourceText: _empty_
- sourceBlockIndex: 17
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-9 (DB 852)

- Lesson: 69; related MicroNode: 1293
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
10 	Ա ղյու սա կը լրաց րո՛ւ 2–ա կան գո յա կան նե րով։
Կեն դա նի բնու թյուն 	Ան կեն դան բնու թյուն
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 34
- sourceText: _empty_
- sourceBlockIndex: 20
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-10 (DB 853)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
8 	Բա ցատ րի՛ր զմ րուխտ բա ռի ի մաս տը բա նաս տեղծու թյան մեջ։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 34
- sourceText: _empty_
- sourceBlockIndex: 18
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-11 (DB 854)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
9 	Բա նաս տեղծու թյու նից դո՛ւրս գրիր տր ված բա ռե րի ի մաստն
ար տա հայ տող բա ռերն ու կապակցու թյուն նե րը։
կեն դանաց նել — կյան քի կո չել 	սառը — …
զար դա րել — … 	anց նել — …
ար ժանանալ — … 	i զուր — …
էլեկտ րա կայան — …
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 34
- sourceText: _empty_
- sourceBlockIndex: 19
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-12 (DB 855)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
11 	Գ րի՛ր բա նաս տեղծու թյան բա նա լի բա ռե րը։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 34
- sourceText: _empty_
- sourceBlockIndex: 21
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-13 (DB 856)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
12 	Պա տաս խա նի՛ր հար ցե րին:
ա) Ի՞նչ է նշա նա կում բա նաս տեղծու թյան ը նդգծ ված տո ղը։
բ) Ինչո՞ւ է գե տը կար ևոր բնության հա մար:
գ) Ին չո՞ւ է հե ղի նա կը կար ևո րում, որ գետն իր ճա նա պար հին կա թիլն ան գամ
զուր չի կորցնում։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 34
- sourceText: _empty_
- sourceBlockIndex: 22
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-14 (DB 857)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
13 	Բա նաս տեղծու թյու նը վերաշարադրի՛ր որ պես՝
ծնող, որ զրուցում է երեխայի հետ,
ըն կեր, ո րը հան դի պել է ուրիշ ե րկ րում ապ րող ըն կե րո ջը,
թոռ նիկ, որը կար դում է պապիկի համար։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 34
- sourceText: _empty_
- sourceBlockIndex: 23
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-15 (DB 858)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
15 	Բա ցատ րի՛ր՝ ինչու է կար ևոր ունենալ նպա տակ ներ և ի րա գոր ծել
dրանք այնպես, ինչպես գետն է իրագործում իր կյանքի ճանապարհին:
Ա ռանց օգտա կար գոր ծի կամ ա ռանց նոր բան սո վո րե լու՝ օ րը կո րած է:
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 35
- sourceText: _empty_
- sourceBlockIndex: 25
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-16 (DB 859)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
16 	Ո՞ր հատկանիշերի համար է հեղինակը հորդորում մարդուն
լինել գետի նման։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 35
- sourceText: _empty_
- sourceBlockIndex: 26
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-17 (DB 860)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
18 	Ո՞ր տողից են երևում բանաստեղծության հերոսին բնորոշ հատկանիշերը՝
1) աշ խա տա սի րու թյու նը, 	3) օգտա կար լի նե լը,
2) նվիր վա ծու թյու նը, 	4) նպա տա կաս լա ցու թյու նը։
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 35
- sourceText: _empty_
- sourceBlockIndex: 28
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-18 (DB 861)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
19 	Խմ բով լրաց րե՛ք ա ղյու սա կը՝ նկա րագ րե լով գե տի ճա նա պար հի
հիմ նա կան փու լե րը և գործողությունները։
Փու լե րը 	Նկա րագ րու թյուն
Ս կիզբ
Ըն թացք
Ա վարտ
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 35
- sourceText: _empty_
- sourceBlockIndex: 29
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-19 (DB 862)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
14 	Ինք նա թե լադ րու թյուն:
ա) Ը նտ րի՛ր բա նաս տեղծու թյան քեզ դուր ե կած քա ռա տո ղը:
բ) Բաժանվե՛ք զույգերի: Օգնե՛ք իրար անգիր սովորելու ձեր ընտրած քառատողերը:
գ) Հի շո ղու թյամբ գրի՛ր քա ռա տո ղը տետ րում:
դ) Գր քից օ գտ վելով՝ ստուգի՛ր գրածդ և ուղղումներն արա՛ այլ գույնի գրիչով:
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 35
- sourceText: _empty_
- sourceBlockIndex: 24
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-69-20 (DB 863)

- Lesson: 69; related MicroNode: missing
- Current Stage-4 safety: validated_verbatim_fallback (learner-text-not-persisted)
- Classification: REVIEW_REQUIRED_CONTENT, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
17 	Ունկնդ րի՛ր « Թա գա վորն ու հո ղա գոր ծը» հե քի ա թը և
հա մե մա տի՛ր «Գետը» բանաստեղծության հետ. ի՞նչ
ընդհանրություններ նկատեցիր:
```

**Current learner text (`exerciseTextEdited`)**
_empty_

**Current hidden evaluator metadata**
- successCriteria: _empty_
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: 35
- sourceText: _empty_
- sourceBlockIndex: 27
- sourceType/status: textbook / draft

**Unresolved issues**
- A teacher/content editor must approve an independently stored learner-facing representation; no learner rewrite is inferred from source text.
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-579-1 (DB 940)

- Lesson: 579; related MicroNode: 2107
- Current Stage-4 safety: edited
- Classification: SAFE_NO_CHANGE, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Վարժություն 1 — Բազմակի ընտրություն

Հարց․ Ո՞ր պնդումն է ճիշտ մոլեկուլների շարժման մասին։

Ա) Մոլեկուլները շարժվում են միայն նյութը տաքացնելիս։
Բ) Մոլեկուլները նյութերում անընդհատ շարժվում են։
Գ) Մոլեկուլները շարժվում են միայն գազերում։
Դ) Մոլեկուլները հանգիստ վիճակում ընդհանրապես չեն շարժվում։
```

**Current learner text (`exerciseTextEdited`)**
```text
Վարժություն 1 — Բազմակի ընտրություն

Հարց․ Ո՞ր պնդումն է ճիշտ մոլեկուլների շարժման մասին։

Ա) Մոլեկուլները շարժվում են միայն նյութը տաքացնելիս։
Բ) Մոլեկուլները նյութերում անընդհատ շարժվում են։
Գ) Մոլեկուլները շարժվում են միայն գազերում։
Դ) Մոլեկուլները հանգիստ վիճակում ընդհանրապես չեն շարժվում։
```

**Current hidden evaluator metadata**
- successCriteria: ```text
Ճիշտ պատասխան՝ Բ
```
- correctAnswer: ```text
B
```
- interactionType: multiple_choice

**Current provenance**
- sourcePage: —
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: manual / approved

**Unresolved issues**
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-579-2 (DB 941)

- Lesson: 579; related MicroNode: 2107
- Current Stage-4 safety: BLOCKED (explicit-answer-key)
- Classification: SAFE_REMEDIATION_PROVABLE, REVIEW_REQUIRED_PROVENANCE
- Write authorized: YES

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Վարժություն 2 — Ճիշտ / Սխալ

Պնդում․ Օծանելիքի բույրի տարածումը սենյակում ցույց է տալիս, որ մոլեկուլները շարժվում են և տարածվում տարբեր ուղղություններով։

Ճիշտ պատասխան՝ Ճիշտ

Հասկանալ — 3 վարժություն

Վարժություն 3 — Բազմակի ընտրություն

Հարց․ Ինչո՞ւ է բացված օծանելիքի սրվակի բույրը որոշ ժամանակ անց տարածվում ամբողջ սենյակում։

Ա) Օդը վերացնում է օծանելիքի մոլեկուլները։
Բ) Օծանելիքի մոլեկուլները անընդհատ և անկանոն շարժվում են ու տարածվում օդում։
Գ) Օծանելիքի մոլեկուլները մնում են միայն սրվակի մոտ։
Դ) Սենյակի օդը դադարում է շարժվել։
```

**Current learner text (`exerciseTextEdited`)**
```text
Վարժություն 2 — Ճիշտ / Սխալ

Պնդում․ Օծանելիքի բույրի տարածումը սենյակում ցույց է տալիս, որ մոլեկուլները շարժվում են և տարածվում տարբեր ուղղություններով։

Ճիշտ պատասխան՝ Ճիշտ
```

**Current hidden evaluator metadata**
- successCriteria: ```text
Ճիշտ պատասխան՝ Ճիշտ
```
- correctAnswer: ```text
TRUE
```
- interactionType: true_false

**Current provenance**
- sourcePage: —
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: manual / approved

**Proposed deterministic change**
- Field: `exerciseTextEdited` only
- BEFORE:
```text
Վարժություն 2 — Ճիշտ / Սխալ

Պնդում․ Օծանելիքի բույրի տարածումը սենյակում ցույց է տալիս, որ մոլեկուլները շարժվում են և տարածվում տարբեր ուղղություններով։

Ճիշտ պատասխան՝ Ճիշտ
```
- AFTER:
```text
Վարժություն 2 — Ճիշտ / Սխալ

Պնդում․ Օծանելիքի բույրի տարածումը սենյակում ցույց է տալիս, որ մոլեկուլները շարժվում են և տարածվում տարբեր ուղղություններով։
```
- Authority: The exact terminal labeled answer is independently persisted in successCriteria and correctAnswer=TRUE; removing only that identical terminal segment preserves the original learner statement verbatim.
- Validator result: PASS (edited)
- Unchanged: source-fidelity text, successCriteria, correctAnswer, interactionType, identity, lesson, and MicroNode relation.

### EX-579-3 (DB 942)

- Lesson: 579; related MicroNode: 2107
- Current Stage-4 safety: BLOCKED (expected-answer-guidance, success-criteria-exposed)
- Classification: SAFE_REMEDIATION_PROVABLE, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: YES

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Վարժություն 4 — Ընդարձակ պատասխան

Հարց․ Պղնձարջասպի լուծույթի և ջրի փորձը ինչպե՞ս է ցույց տալիս, որ մոլեկուլներն անընդհատ շարժվում են։

Սպասվող պատասխանի հիմնական միտքը․ Ժամանակի ընթացքում ջրի և պղնձարջասպի միջև սկզբնական սահմանը վերանում է, որովհետև դրանց մոլեկուլները անկանոն շարժվում և ներթափանցում են միմյանց զբաղեցրած տարածք։
```

**Current learner text (`exerciseTextEdited`)**
```text
Վարժություն 4 — Ընդարձակ պատասխան

Հարց․ Պղնձարջասպի լուծույթի և ջրի փորձը ինչպե՞ս է ցույց տալիս, որ մոլեկուլներն անընդհատ շարժվում են։

Սպասվող պատասխանի հիմնական միտքը․ Ժամանակի ընթացքում ջրի և պղնձարջասպի միջև սկզբնական սահմանը վերանում է, որովհետև դրանց մոլեկուլները անկանոն շարժվում և ներթափանցում են միմյանց զբաղեցրած տարածք։
```

**Current hidden evaluator metadata**
- successCriteria: ```text
Սպասվող պատասխանի հիմնական միտքը․ Ժամանակի ընթացքում ջրի և պղնձարջասպի միջև սկզբնական սահմանը վերանում է, որովհետև դրանց մոլեկուլները անկանոն շարժվում և ներթափանցում են միմյանց զբաղեցրած տարածք։
```
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: —
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: manual / approved

**Proposed deterministic change**
- Field: `exerciseTextEdited` only
- BEFORE:
```text
Վարժություն 4 — Ընդարձակ պատասխան

Հարց․ Պղնձարջասպի լուծույթի և ջրի փորձը ինչպե՞ս է ցույց տալիս, որ մոլեկուլներն անընդհատ շարժվում են։

Սպասվող պատասխանի հիմնական միտքը․ Ժամանակի ընթացքում ջրի և պղնձարջասպի միջև սկզբնական սահմանը վերանում է, որովհետև դրանց մոլեկուլները անկանոն շարժվում և ներթափանցում են միմյանց զբաղեցրած տարածք։
```
- AFTER:
```text
Վարժություն 4 — Ընդարձակ պատասխան

Հարց․ Պղնձարջասպի լուծույթի և ջրի փորձը ինչպե՞ս է ցույց տալիս, որ մոլեկուլներն անընդհատ շարժվում են։
```
- Authority: The exact terminal expected-answer section is independently persisted as successCriteria; removing only that identical terminal segment preserves the original learner question verbatim.
- Validator result: PASS (edited)
- Unchanged: source-fidelity text, successCriteria, correctAnswer, interactionType, identity, lesson, and MicroNode relation.

### EX-579-4 (DB 943)

- Lesson: 579; related MicroNode: 2107
- Current Stage-4 safety: edited
- Classification: SAFE_NO_CHANGE, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Վարժություն 5 — Ընդարձակ պատասխան

Հարց․ Ընտրիր օծանելիքի կամ պղնձարջասպի փորձերից մեկը և բացատրիր՝ այդ փորձի ո՞ր դիտարկումն է ապացույց, որ մոլեկուլների շարժումը շարունակական և անկանոն է։

Հաջող պատասխանը պետք է ներառի՝

ճիշտ ընտրված փորձ,
փորձում դիտվող փոփոխությունը,
կապը մոլեկուլների շարժման հետ,
բացատրություն, որ մոլեկուլները շարժվում են տարբեր ուղղություններով և ժամանակի ընթացքում տարածվում/խառնվում են։
```

**Current learner text (`exerciseTextEdited`)**
```text
Վարժություն 5 — Ընդարձակ պատասխան

Հարց․ Ընտրիր օծանելիքի կամ պղնձարջասպի փորձերից մեկը և բացատրիր՝ այդ փորձի ո՞ր դիտարկումն է ապացույց, որ մոլեկուլների շարժումը շարունակական և անկանոն է։
```

**Current hidden evaluator metadata**
- successCriteria: ```text
Հաջող պատասխանը պետք է ներառի՝  ճիշտ ընտրված փորձ, փորձում դիտվող փոփոխությունը, կապը մոլեկուլների շարժման հետ, բացատրություն, որ մոլեկուլները շարժվում են տարբեր ուղղություններով և ժամանակի ընթացքում տարածվում/խառնվում են։
```
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: —
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: manual / approved

**Unresolved issues**
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.

### EX-579-5 (DB 944)

- Lesson: 579; related MicroNode: 2107
- Current Stage-4 safety: edited
- Classification: SAFE_NO_CHANGE, REVIEW_REQUIRED_EVALUATION, REVIEW_REQUIRED_PROVENANCE
- Write authorized: NO

**Current source-fidelity text (`exerciseTextVerbatim`)**
```text
Վարժություն 3 — Բազմակի ընտրություն

Հարց․ Ինչո՞ւ է բացված օծանելիքի սրվակի բույրը որոշ ժամանակ անց տարածվում ամբողջ սենյակում։

Ա) Օդը վերացնում է օծանելիքի մոլեկուլները։
Բ) Օծանելիքի մոլեկուլները անընդհատ և անկանոն շարժվում են ու տարածվում օդում։
Գ) Օծանելիքի մոլեկուլները մնում են միայն սրվակի մոտ։
Դ) Սենյակի օդը դադարում է շարժվել։
```

**Current learner text (`exerciseTextEdited`)**
```text
Վարժություն 3 — Բազմակի ընտրություն

Հարց․ Ինչո՞ւ է բացված օծանելիքի սրվակի բույրը որոշ ժամանակ անց տարածվում ամբողջ սենյակում։

Ա) Օդը վերացնում է օծանելիքի մոլեկուլները։
Բ) Օծանելիքի մոլեկուլները անընդհատ և անկանոն շարժվում են ու տարածվում օդում։
Գ) Օծանելիքի մոլեկուլները մնում են միայն սրվակի մոտ։
Դ) Սենյակի օդը դադարում է շարժվել։
```

**Current hidden evaluator metadata**
- successCriteria: ```text
Ճիշտ պատասխան՝ Բ
```
- correctAnswer: _empty_
- interactionType: —

**Current provenance**
- sourcePage: —
- sourceText: _empty_
- sourceBlockIndex: —
- sourceType/status: manual / approved

**Unresolved issues**
- Interaction/evaluation metadata is absent or ambiguous and must be decided from authoritative editorial evidence.
- No exact persisted sourcePage/sourceText/sourceBlockIndex reconstruction is currently proven; leave provenance unchanged.