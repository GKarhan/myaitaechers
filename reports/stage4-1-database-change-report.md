# Stage 4.1 — Database Change Report

## Result

- Rows examined for authorized remediation: 2
- Rows changed: 2
- Rows unchanged by this write operation: 32
- Rows still requiring one or more human reviews: 34 (see stage4-1-review-required.md)
- Transaction result: COMMITTED
- Schema migration: NONE

## Exact mutations

### EX-579-2 (DB 941)

- Changed field: `exerciseTextEdited` only
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
- Validation: PASS — learner text resolves safely; hidden successCriteria/correctAnswer, source-fidelity text, provenance, identity, lesson, and MicroNode relationship were re-read and preserved in the transaction.

### EX-579-3 (DB 942)

- Changed field: `exerciseTextEdited` only
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
- Validation: PASS — learner text resolves safely; hidden successCriteria/correctAnswer, source-fidelity text, provenance, identity, lesson, and MicroNode relationship were re-read and preserved in the transaction.
