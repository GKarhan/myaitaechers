// ─────────────────────────────────────────────────────────────────────────────
// Frontend translation layer — Contract v1.2 mapping pipeline
//
// All 49 Armenian strings come verbatim from the Round 1.6 translation file.
// Dynamic params are extracted from:
//   issue.entityId  — primary entity ID ({id})
//   issue.description via regex — secondary params ({received}, {expected}, …)
// Safe fallback "?" on any regex failure — never undefined / null.
//
// Do NOT retype Armenian text — copy from the Round 1.x translation source.
// ─────────────────────────────────────────────────────────────────────────────

export interface TranslatableIssue {
  issueType: string;
  description: string;
  entityId?: string | null;
  line?: number | null;
  severity?: string;
}

// ── Regex helpers ─────────────────────────────────────────────────────────────

function rx(desc: string, pattern: RegExp, fallback = "?"): string {
  return desc.match(pattern)?.[1] ?? fallback;
}

function rx2(desc: string, pattern: RegExp, fb1 = "?", fb2 = "?"): [string, string] {
  const m = desc.match(pattern);
  return [m?.[1] ?? fb1, m?.[2] ?? fb2];
}

function rx3(desc: string, pattern: RegExp, fb = "?"): [string, string, string] {
  const m = desc.match(pattern);
  return [m?.[1] ?? fb, m?.[2] ?? fb, m?.[3] ?? fb];
}

function eid(issue: TranslatableIssue): string {
  return issue.entityId ?? "?";
}

// ── Translation lookup table ──────────────────────────────────────────────────

type IssueTranslationFn = (issue: TranslatableIssue) => string;

const ISSUE_TRANSLATIONS: Record<string, IssueTranslationFn> = {

  // ── Lesson structure errors ────────────────────────────────────────────────

  "lesson-missing": () =>
    "«ԴԱՍ» բաժինը բացակայում է։",

  "lesson-title-empty": () =>
    "ԴԱՍ. վերնագիրը դատարկ է։",

  "lesson-subject-empty": () =>
    "ԴԱՍ. առարկան դատարկ է։",

  // {grade} from: "LESSON: grade must be a positive integer (got {grade})."
  "lesson-grade-invalid": (issue) => {
    const grade = rx(issue.description, /\(got (.+?)\)\.$/);
    return `ԴԱՍ. դասարանը պետք է լինի դրական ամբողջ թիվ (ստացվեց՝ {grade})։`.replace("{grade}", grade);
  },

  "lesson-textbook-empty": () =>
    "ԴԱՍ. դասագիրքը դատարկ է։",

  // {from}, {to} from: "LESSON: pages must be valid range ... (got {from}–{to})."
  "lesson-pages-invalid": (issue) => {
    const [from, to] = rx2(issue.description, /\(got (.+?)–(.+?)\)\.$/);
    return `ԴԱՍ. էջերը պետք է կազմեն վավեր միջակայք՝ սկիզբը ≤ վերջը (ստացվեց՝ {from}–{to})։`.replace("{from}", from).replace("{to}", to);
  },

  // ── ID format errors ───────────────────────────────────────────────────────

  "node-id-invalid": (issue) =>
    `NODE-ի id-ն «{id}» պետք է համապատասխանի N\d+ ձևաչափին (օր.՝ N1, N2)։`.replace("{id}", eid(issue)),

  "micronode-id-invalid": (issue) =>
    `MICRONODE-ի id-ն «{id}» պետք է համապատասխանի MN-\d+.\d+ ձևաչափին (օր.՝ MN-1.1)։`.replace("{id}", eid(issue)),

  "sourceblock-id-invalid": (issue) =>
    `SOURCE BLOCK-ի id-ն «{id}» պետք է համապատասխանի B\d+ ձևաչափին։`.replace("{id}", eid(issue)),

  "exercise-id-invalid": (issue) =>
    `EXERCISE-ի id-ն «{id}» պետք է համապատասխանի EX-\d+ ձևաչափին։`.replace("{id}", eid(issue)),

  "dependency-id-invalid": (issue) =>
    `DEPENDENCY-ի id-ն «{id}» պետք է համապատասխանի D\d+ ձևաչափին։`.replace("{id}", eid(issue)),

  // ── Duplicate ID errors ────────────────────────────────────────────────────

  "duplicate-node-id": (issue) =>
    `Կրկնվող NODE id. {id}։`.replace("{id}", eid(issue)),

  "duplicate-micronode-id": (issue) =>
    `Կրկնվող MICRONODE id. {id}։`.replace("{id}", eid(issue)),

  "duplicate-sourceblock-id": (issue) =>
    `Կրկնվող SOURCE BLOCK id. {id}։`.replace("{id}", eid(issue)),

  "duplicate-exercise-id": (issue) =>
    `Կրկնվող EXERCISE id. {id}։`.replace("{id}", eid(issue)),

  "duplicate-dependency-id": (issue) =>
    `Կրկնվող DEPENDENCY id. {id}։`.replace("{id}", eid(issue)),

  // ── Orphan / parent reference ──────────────────────────────────────────────

  // {parentNodeId} from: "... parent NODE {parentNodeId} is not defined."
  "orphan-micronode": (issue) => {
    const parentNodeId = rx(issue.description, /parent NODE (\S+) is not defined/);
    return `MICRONODE {id}. ծնող NODE {parentNodeId}-ը սահմանված չէ։`
      .replace("{id}", eid(issue))
      .replace("{parentNodeId}", parentNodeId);
  },

  // ── MicroNode field errors ─────────────────────────────────────────────────

  "mn-title-empty": (issue) =>
    `MICRONODE {id}. վերնագիրը դատարկ է։`.replace("{id}", eid(issue)),

  // {received}, {expected} from: `microNodeType "{received}" is invalid. Expected: {expected}.`
  "mn-type-invalid": (issue) => {
    const [received, expected] = rx2(issue.description,
      /microNodeType "([^"]+)".*?Expected: (.+?)\.$/);
    return `MICRONODE {id}. microNodeType-ը «{received}» անվավեր է։ Ընդունելի են՝ {expected}։`
      .replace("{id}", eid(issue))
      .replace("{received}", received)
      .replace("{expected}", expected);
  },

  "mn-learning-objective-empty": (issue) =>
    `MICRONODE {id}. learningObjective-ը դատարկ է։`.replace("{id}", eid(issue)),

  "mn-confidence-missing": (issue) =>
    `MICRONODE {id}. confidenceScore-ը պարտադիր է։`.replace("{id}", eid(issue)),

  // {value} from: `confidenceScore {value} is out of range 0–100.`
  "mn-confidence-range": (issue) => {
    const value = rx(issue.description, /confidenceScore (\S+) is out of range/);
    return `MICRONODE {id}. confidenceScore-ը ({value}) դուրս է 0–100 միջակայքից։`
      .replace("{id}", eid(issue))
      .replace("{value}", value);
  },

  // {received}, {expected} from: `sourceCoverage "{received}" is invalid. Expected: {expected}.`
  "mn-coverage-invalid": (issue) => {
    const [received, expected] = rx2(issue.description,
      /sourceCoverage "([^"]+)".*?Expected: (.+?)\.$/);
    return `MICRONODE {id}. sourceCoverage-ը «{received}» անվավեր է։ Ընդունելի են՝ {expected}։`
      .replace("{id}", eid(issue))
      .replace("{received}", received)
      .replace("{expected}", expected);
  },

  // {received}, {expected} from: `status "{received}" is invalid. Expected: {expected}.`
  "mn-status-invalid": (issue) => {
    const [received, expected] = rx2(issue.description,
      /status "([^"]+)".*?Expected: (.+?)\.$/);
    return `MICRONODE {id}. status-ը «{received}» անվավեր է։ Ընդունելի են՝ {expected}։`
      .replace("{id}", eid(issue))
      .replace("{received}", received)
      .replace("{expected}", expected);
  },

  // ── Source block field errors ──────────────────────────────────────────────

  "sb-text-empty": (issue) =>
    `SOURCE BLOCK {id}. sourceText-ը դատարկ է։`.replace("{id}", eid(issue)),

  "sb-page-missing": (issue) =>
    `SOURCE BLOCK {id}. sourcePage-ը պարտադիր է։`.replace("{id}", eid(issue)),

  // {received}, {expected} from: `blockType "{received}" is invalid. Expected: {expected}.`
  "sb-blocktype-invalid": (issue) => {
    const [received, expected] = rx2(issue.description,
      /blockType "([^"]+)".*?Expected: (.+?)\.$/);
    return `SOURCE BLOCK {id}. blockType-ը «{received}» անվավեր է։ Ընդունելի են՝ {expected}։`
      .replace("{id}", eid(issue))
      .replace("{received}", received)
      .replace("{expected}", expected);
  },

  // {received}, {expected} from: `status "{received}" is invalid. Expected: {expected}.`
  "sb-status-invalid": (issue) => {
    const [received, expected] = rx2(issue.description,
      /status "([^"]+)".*?Expected: (.+?)\.$/);
    return `SOURCE BLOCK {id}. status-ը «{received}» անվավեր է։ Ընդունելի են՝ {expected}։`
      .replace("{id}", eid(issue))
      .replace("{received}", received)
      .replace("{expected}", expected);
  },

  // ── Reference errors ───────────────────────────────────────────────────────

  // {refId} — two description variants:
  //   A: `sourceBlockId "{refId}" not found.`
  //   B: `sourceRef references unknown SOURCE BLOCK {refId}.`
  "ref-sourceblock-unknown": (issue) => {
    const refId =
      rx(issue.description, /sourceBlockId "([^"]+)" not found/, "") ||
      rx(issue.description, /unknown SOURCE BLOCK (\S+)\./, "?");
    return `MICRONODE {id}. հղվում է գոյություն չունեցող SOURCE BLOCK-ին՝ «{refId}»։`
      .replace("{id}", eid(issue))
      .replace("{refId}", refId);
  },

  // {quote}, {sbId} from:
  //   `sourceRef quote "{quote}..." is not a substring of SOURCE BLOCK {sbId} sourceText.`
  "ref-sourcequote-mismatch": (issue) => {
    const [quote, sbId] = rx2(issue.description,
      /quote "([^"]+)\.\.\." is not a substring of SOURCE BLOCK (\S+) sourceText/);
    return `MICRONODE {id}. sourceRef-ի մեջբերումը՝ «{quote}...», չի հայտնաբերվել SOURCE BLOCK {sbId}-ի sourceText-ում։`
      .replace("{id}", eid(issue))
      .replace("{quote}", quote)
      .replace("{sbId}", sbId);
  },

  // {exId} from: `exerciseId "{exId}" not found.`
  "ref-exercise-unknown": (issue) => {
    const exId = rx(issue.description, /exerciseId "([^"]+)" not found/);
    return `MICRONODE {id}. հղվում է գոյություն չունեցող EXERCISE-ին՝ «{exId}»։`
      .replace("{id}", eid(issue))
      .replace("{exId}", exId);
  },

  // {prereqId} from: `prerequisite MN "{prereqId}" not found.`
  "ref-prerequisite-unknown": (issue) => {
    const prereqId = rx(issue.description, /prerequisite MN "([^"]+)" not found/);
    return `MICRONODE {id}. prerequisite MN «{prereqId}»-ը գոյություն չունի։`
      .replace("{id}", eid(issue))
      .replace("{prereqId}", prereqId);
  },

  // {relId} from: `relatedMicroNode "{relId}" not found.`
  // entityId may be MN or EX id
  "ref-related-mn-unknown": (issue) => {
    const relId = rx(issue.description, /relatedMicroNode "([^"]+)" not found/);
    return `{id}. relatedMicroNode «{relId}»-ը գոյություն չունի։`
      .replace("{id}", eid(issue))
      .replace("{relId}", relId);
  },

  // {from} from: `from "{from}" is not a known MICRONODE id.`
  "ref-dep-from-unknown": (issue) => {
    const from = rx(issue.description, /from "([^"]+)" is not a known/);
    return `DEPENDENCY {id}. from «{from}»-ը հայտնի MICRONODE id չէ։`
      .replace("{id}", eid(issue))
      .replace("{from}", from);
  },

  // {to} from: `to "{to}" is not a known MICRONODE id.`
  "ref-dep-to-unknown": (issue) => {
    const to = rx(issue.description, /to "([^"]+)" is not a known/);
    return `DEPENDENCY {id}. to «{to}»-ը հայտնի MICRONODE id չէ։`
      .replace("{id}", eid(issue))
      .replace("{to}", to);
  },

  // ── UNREADABLE block rule §8 ───────────────────────────────────────────────

  // {sbId} — two description variants, same regex captures both
  "unreadable-block-referenced": (issue) => {
    const sbId = rx(issue.description, /SOURCE BLOCK (\S+) with status UNREADABLE/);
    return `MICRONODE {id}. հղվում է SOURCE BLOCK {sbId}-ին, որի կարգավիճակը UNREADABLE է — արգելված է §8 կանոնով։`
      .replace("{id}", eid(issue))
      .replace("{sbId}", sbId);
  },

  // ── Exercise field errors ──────────────────────────────────────────────────

  "ex-text-empty": (issue) =>
    `EXERCISE {id}. տեքստը դատարկ է։`.replace("{id}", eid(issue)),

  // {received} from: `exerciseType "{received}" is invalid.`
  "ex-type-invalid": (issue) => {
    const received = rx(issue.description, /exerciseType "([^"]+)" is invalid/);
    return `EXERCISE {id}. exerciseType-ը «{received}» անվավեր է։`
      .replace("{id}", eid(issue))
      .replace("{received}", received);
  },

  // {received}, {expected} from: `difficulty "{received}" is invalid. Expected: {expected}.`
  "ex-difficulty-invalid": (issue) => {
    const [received, expected] = rx2(issue.description,
      /difficulty "([^"]+)".*?Expected: (.+?)\.$/);
    return `EXERCISE {id}. difficulty-ը «{received}» անվավեր է։ Ընդունելի են՝ {expected}։`
      .replace("{id}", eid(issue))
      .replace("{received}", received)
      .replace("{expected}", expected);
  },

  // ── Dependency field errors ────────────────────────────────────────────────

  // {received} from: `dependencyType "{received}" must be PREREQUISITE.`
  "dep-type-invalid": (issue) => {
    const received = rx(issue.description, /dependencyType "([^"]+)" must be/);
    return `DEPENDENCY {id}. dependencyType-ը «{received}» պետք է լինի PREREQUISITE։`
      .replace("{id}", eid(issue))
      .replace("{received}", received);
  },

  // ── Warnings ──────────────────────────────────────────────────────────────

  // {sbId} — two description variants
  "warn-sb-needs-review-referenced": (issue) => {
    const sbId = rx(issue.description, /SOURCE BLOCK (\S+) with status NEEDS_REVIEW/);
    return `MICRONODE {id}. հղվում է SOURCE BLOCK {sbId}-ին, որի կարգավիճակը NEEDS_REVIEW է — անհրաժեշտ է վերանայում մինչև հաստատումը։`
      .replace("{id}", eid(issue))
      .replace("{sbId}", sbId);
  },

  "warn-sb-orphan": (issue) =>
    `SOURCE BLOCK {id}-ը որևէ MICRONODE-ի կողմից հղված չէ — չի մասնակցի ոչ մի հանգույցի կազմությանը։`.replace("{id}", eid(issue)),

  "warn-ex-orphan": (issue) =>
    `EXERCISE {id}-ը որևէ MICRONODE-ի exerciseIds-ում նշված չէ — կարող է անկապ մնալ։`.replace("{id}", eid(issue)),

  "warn-mn-no-sources": (issue) =>
    `MICRONODE {id}. չկան sourceBlockIds կամ sourceRef տողեր — աղբյուրը չստուգված է։`.replace("{id}", eid(issue)),

  // {count}, {firstId} from:
  //   `MICRONODE {id}: {count} relatedMicroNodes — only the first ({firstId}) will be stored;...`
  "warn-related-mn-extra": (issue) => {
    const [count, firstId] = rx2(issue.description,
      /: (\d+) relatedMicroNodes — only the first \(([^)]+)\)/);
    return `MICRONODE {id}. {count} relatedMicroNode կա — միայն առաջինը ({firstId}) կպահպանվի, մնացածին անհրաժեշտ է join table (ապագա migration)։`
      .replace("{id}", eid(issue))
      .replace("{count}", count)
      .replace("{firstId}", firstId);
  },

  // {count}, {firstId} from:
  //   `EXERCISE {id}: {count} relatedMicroNodes — only first ({firstId}) will be stored as relatedNodeId.`
  "warn-ex-multi-related": (issue) => {
    const [count, firstId] = rx2(issue.description,
      /: (\d+) relatedMicroNodes — only first \(([^)]+)\)/);
    return `EXERCISE {id}. {count} relatedMicroNode կա — միայն առաջինը ({firstId}) կպահպանվի որպես relatedNodeId։`
      .replace("{id}", eid(issue))
      .replace("{count}", count)
      .replace("{firstId}", firstId);
  },

  // {page}, {pFrom}, {pTo} from:
  //   `SOURCE BLOCK {id}: sourcePage {page} is outside lesson page range {pFrom}–{pTo}.`
  "sb-page-out-of-range": (issue) => {
    const [page, pFrom, pTo] = rx3(issue.description,
      /sourcePage (\d+) is outside lesson page range (\d+)–(\d+)/);
    return `SOURCE BLOCK {id}. sourcePage-ը ({page}) դասի էջերի միջակայքից ({pFrom}–{pTo}) դուրս է։`
      .replace("{id}", eid(issue))
      .replace("{page}", page)
      .replace("{pFrom}", pFrom)
      .replace("{pTo}", pTo);
  },

  // ── Inserter-generated ─────────────────────────────────────────────────────

  // {mnId}, {relatedMnId} — entityId is DB integer; parse from description
  "related-mn-deferred": (issue) => {
    const [mnId, relatedMnId] = rx2(issue.description,
      /^MicroNode ([^:]+): relatedMicroNode "([^"]+)"/);
    return `MicroNode {mnId}. relatedMicroNode «{relatedMnId}»-ին անհրաժեշտ է join table — հետաձգված է ապագա migration-ի համար։`
      .replace("{mnId}", mnId)
      .replace("{relatedMnId}", relatedMnId);
  },

  // {exId}, {relatedMnId} — entityId is DB integer; parse from description
  "ex-multi-related-deferred": (issue) => {
    const [exId, relatedMnId] = rx2(issue.description,
      /^EXERCISE ([^:]+): additional relatedMicroNode "([^"]+)"/);
    return `EXERCISE {exId}. լրացուցիչ relatedMicroNode «{relatedMnId}»-ին անհրաժեշտ է join table — հետաձգված է ապագա migration-ի համար։`
      .replace("{exId}", exId)
      .replace("{relatedMnId}", relatedMnId);
  },

};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Translate a ValidationIssue into an Armenian user-facing string.
 * Unknown issueType: returns an unmissable marker so problems surface visibly.
 */
export function translateIssue(issue: TranslatableIssue): string {
  const fn = ISSUE_TRANSLATIONS[issue.issueType];
  if (!fn) {
    return `⚠️ [ԱՆHAYТ ТІПТЕС: ${issue.issueType}] ${issue.description}`;
  }
  return fn(issue);
}
