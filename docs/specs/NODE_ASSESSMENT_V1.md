Գ.19. Գիտելիքի յուրացման գնահատման համակարգ — վերջնական հստակեցում, 21.10.2026
Այս բաժինը հստակեցնում է Գ.6–Գ.8-ի տոկոսների և հավաստիության ներկայացումը։ Յուրաքանչյուր հանգույցի համար առանձին պահպանվում են ստուգված ճանաչողական պահանջը, ճիշտ պատասխանների քանակը, կատարված անկախ ստուգումների քանակը, արդյունքի տոկոսը, հավաստիության պիտակը և հաջորդ գործողությունը։ Տոկոսը հաշվվում է ճիշտ/կատարված հարաբերությամբ, ոչ նախատեսված բայց չտրված հարցերով։
1/1 ճիշտ՝ 100%, ցածր հավաստիություն։ 2/2 ճիշտ՝ 100%, միջին հավաստիություն։ 3/3 ճիշտ՝ 100%, բարձր հավաստիություն։ 1/3 ճիշտ՝ 33%, ցածր հավաստիություն։ 2/3 ճիշտ՝ 67%, միջին հավաստիություն։ Այս պիտակները կանոնային հաստատման աստիճան են, ոչ վիճակագրորեն չափված հավանականություն։ Երեք հարցի գեներացումն ինքնին բարձր հավաստիություն չի տալիս։ Չստուգված բարձր ճանաչողական մակարդակը չի համարվում յուրացված միայն ստորին մակարդակի հաջողությունից։
0/1 և 0/2 դեպքում ցուցադրվում է, որ տվյալ պահանջը դեռ չի հաստատվել։ 0/3 դեպքում կիրառվում է «Լրացուցիչ աջակցության կարիք» պիտակը. նույն աշխատանքային հատվածում անվերջ ստուգումները դադարեցվում են, խնդիրը պահվում է ուսուցչի վերանայման համար։ Թույլատրվում է այլ անկախ նյութի աշխատանք, բայց չհաստատված կարևոր նախապայմանից կախված նյութի ավտոմատ անցում չի թույլատրվում։ Ուսուցչի որոշման մանրամասն տեսակներն առանձին մշակման են։
Ստուգման հաշվարկում օգտագործվում են տարբեր առաջադրանքների առաջին ինքնուրույն պատասխանները։ Արդեն բացահայտված պատասխանի կրկնությունը մնում է վարժանք և չի բարձրացնում անկախ հավաստիությունը։ Ուսուցումից հետո նոր համարժեք առաջադրանքների առանձին շարքը կարող է հաստատել փոփոխությունը՝ պահպանելով նախկին պատմությունը։
Նոր թեստի համար N ընտրված հանգույցի դեպքում համակարգը պարտադիր ապահովում է ընտրված քանակի հավասարակշռված բաշխում՝ 1–3 տարբեր հարց յուրաքանչյուր հանգույցի համար։ N հարցը նշանակում է մեկ հարց յուրաքանչյուրին, 3N հարցը՝ երեք յուրաքանչյուրին, միջանկյալ քանակը՝ հնարավորինս հավասար բաշխում։ Ընդհանուր տեխնիկական առավելագույնը գերազանցելու դեպքում նյութը բաժանվում է, ոչ լուռ թողնվում անստուգված։ Ուսուցիչը տեսնում է իրական ծածկույթը։ Բովանդակության կրկնօրինակները չեն համարվում երեք անկախ հարց։
Թեստի նպատակը՝ ուսուցողական կամ գիտելիքի անկախ ստուգում, առանձին է կատարման համատեքստից՝ միայն դասարանում, միայն տանը, դասարանում սկսել և տանը շարունակել, ցանկացած վայրում։ Ուսուցողական թեստը կարող է անմիջապես բացատրել պատասխանը։ Անկախ ստուգման ընթացքում ճիշտ պատասխանը և բացատրությունը չեն բացահայտվում մինչև ավարտը։ Պահպանվում են անավարտ պատասխանները և շարունակության տեղը։ Առցանց համակարգը գրանցում է ուսուցչի նշանակած կատարման պայմանը, բայց չի հայտարարում, որ ինքնուրույն ապացուցել է սովորողի ֆիզիկական գտնվելու վայրը։
Իրականացումը սկսվում է հարցերի պարտադիր բաշխումից, տարբերակավորված գնահատման տվյալներից ու հաշվարկից, թեստի նպատակից և կատարման պայմաններից, ապա կապվում է ծառի, արդյունքների, կրկնության և ուսուցչի վերանայման հետ։ Հին թեստերը չեն վերանվանվում որպես նոր երեք անկախ ստուգում՝ առանց փաստացի համապատասխան ապացույցների։

## Implementation boundary

This versioned policy is an explicit update to quiz assessment, not a rewrite of P4/P5 AI teaching. `quizzes.assessment_config = null` preserves legacy behavior. New quizzes use `NODE_V1`.

### Existing components reused

- Approved lesson nodes and confirmed cognitive targets.
- Durable quiz generation jobs and per-node question quality gates.
- Attempt snapshots, immutable finalized answers and resume.
- Evidence events, cognitive ceiling projection, knowledge tree read model.
- Teacher/student result pages and review scheduling.

### Implementation sequence

1. Add nullable quiz policy configuration and a shared deterministic assessment policy.
2. Enforce balanced 1–3 distinct questions per node; reject missing coverage and duplicate tasks.
3. Save LEARNING/CHECK purpose separately from assignment context. Defer correctness for CHECK until completion.
4. Store each first independent response with policy version, cycle, family and exposure flags. Keep practice history separately.
5. Reuse the same latest independent assessment in results and the knowledge tree. Show percentage, certainty and next action together.
6. Generate fresh independent checks after practice. Enforce server-owned scope, learner authorization and job idempotency. Stop automatic checks at 0/3.
7. Schedule successful independent assessments for review; only advance intervals after the scheduled due date.
8. Verify HTTP behavior, resume, evidence, review timing and legacy regressions in CI before release.

### Deferred work

- Adaptive 2+1 orchestration and an independently validated semantic task-family model. Current duplicate protection uses normalized text; it does not prove semantic independence of paraphrases.
- A teacher intervention queue with resolution decisions, plus periodic class/group/individual summaries and notifications. Current release exposes the support flag and next action in teacher node results.
- Student-specific learned review intervals; the initial default remains the existing 1/3/7/14/30-day ladder.
- AI teacher teaching interactions and coordination with human teachers.

### Acceptance evidence

`node-assessment-policy.test.ts` exercises allocations, all requested ratios, exposure handling, target scope and legacy preservation. `node-assessment-http.test.ts` exercises CHECK secrecy, resume, LEARNING feedback, result/tree agreement, copied-task protection, support stopping and delayed review advancement against an isolated test database. Running the latter requires matching DATABASE_URL and TEST_DATABASE_URL.
