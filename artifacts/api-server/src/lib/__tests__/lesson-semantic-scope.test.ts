import assert from "node:assert/strict";
import { deriveLessonSemanticScope } from "../lesson-semantic-scope.js";

const block = (blockType: string, sourceText: string, sourcePage = 29) => ({
  blockType,
  sourceText,
  sourcePage,
});

// A same-page next section stays physically verified but cannot enter Pass 2
// candidate generation for the selected lesson. Its matching exercise follows
// the section heading into the review-safe retention set.
{
  const result = deriveLessonSemanticScope({
    lessonTitle: "Ֆունկցիայի զրոներ",
    pagesTo: 29,
    blocks: [
      block("DEFINITION", "Ֆունկցիայի զրոները այն x արժեքներն են, որոնց համար f(x)=0։", 28),
      block("EXERCISE", "Գտնել ֆունկցիայի զրոները։", 28),
      block("OBJECTIVE", "2.2 ԿՈՈՐԴԻՆԱՏԱՅԻՆ ԱՌԱՆՑՔՆԵՐ"),
      block("DEFINITION", "Կոորդինատային առանցքները հարթությունը բաժանում են քառորդների։"),
      block("EXERCISE", "Նշել կետի կոորդինատները կոորդինատային հարթության վրա։"),
    ],
  });
  assert.deepEqual(result.inScopeBlockIndices, [0, 1]);
  assert.deepEqual(result.adjacentBlockIndices, [2, 3, 4]);
  assert.deepEqual(result.excludedCandidateBlockIndices, [2, 3, 4]);
}

// Numbered tasks are learner material, not section headings. They must remain
// eligible even when they occur at the terminal physical page.
{
  const result = deriveLessonSemanticScope({
    lessonTitle: "Ֆունկցիայի զրոները",
    pagesTo: 29,
    blocks: [
      block("DEFINITION", "Ֆունկցիայի զրոները այն x արժեքներն են, որոնց համար f(x)=0։", 28),
      block("EXERCISE", "2.2 Գտնել ֆունկցիայի զրոները։"),
      block("EXERCISE", "2.3 Ստուգել ստացված պատասխանները։"),
    ],
  });
  assert.deepEqual(result.inScopeBlockIndices, [0, 1, 2]);
  assert.deepEqual(result.excludedCandidateBlockIndices, []);
}

// Shared subject words cannot make a new terminal section look continuous:
// «function graph» remains outside a «function zeros» lesson.
{
  const result = deriveLessonSemanticScope({
    lessonTitle: "Ֆունկցիայի զրոները",
    pagesTo: 29,
    blocks: [
      block("DEFINITION", "Ֆունկցիայի զրոները այն x արժեքներն են, որոնց համար f(x)=0։", 28),
      block("OBJECTIVE", "ՖՈՒՆԿՑԻԱՅԻ ԳՐԱՖԻԿԸ"),
      block("DEFINITION", "Գրաֆիկը ցույց է տալիս ֆունկցիայի արժեքները։"),
      block("EXERCISE", "Կառուցել ֆունկցիայի գրաֆիկը։"),
    ],
  });
  assert.deepEqual(result.inScopeBlockIndices, [0]);
  assert.deepEqual(result.reviewRequiredBlockIndices, [1, 2, 3]);
}

// A title-like terminal block which is not clearly a new section is retained
// as review-required rather than silently treated as canonical content.
{
  const result = deriveLessonSemanticScope({
    lessonTitle: "Հոլովներ",
    pagesTo: 11,
    blocks: [
      block("DEFINITION", "Գոյականը կարող է փոխել իր ձևը նախադասության մեջ։", 10),
      block("OBJECTIVE", "ԱՆՀԱՍԿԱՆԱԼԻ ՆՈՐ ՎԵՐՆԱԳԻՐ", 11),
    ],
  });
  assert.deepEqual(result.reviewRequiredBlockIndices, [1]);
}

console.log("lesson semantic scope tests passed");