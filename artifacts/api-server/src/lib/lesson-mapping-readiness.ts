import {
  resolveLessonAssignmentReadiness,
  type LessonAssignmentReadiness,
} from "./lesson-assignment-readiness.js";

export type { LessonAssignmentReadiness } from "./lesson-assignment-readiness.js";

export function classifyMappingAssignmentReadiness(input: {
  sourceScopeVerified: boolean;
  sourceSetVerified: boolean;
  structuralCoverageValid: boolean;
  microNodeCount: number;
  reviewFindingCount: number;
}): LessonAssignmentReadiness {
  const errors = [];
  if (!input.sourceScopeVerified || !input.sourceSetVerified) {
    errors.push({
      code: "UNVERIFIED_LESSON_SOURCE_SCOPE",
      messageArm: "Դասի աղբյուրային շրջանակը պահանջում է վերանայում։",
    });
  }
  if (!input.structuralCoverageValid) {
    errors.push({
      code: "UNRESOLVED_INSTRUCTIONAL_SOURCE",
      messageArm: "Ընթեռնելի ուսումնական աղբյուրի մի մասը MicroNode-ի պատասխանատու չունի։",
    });
  }
  if (input.microNodeCount === 0) {
    errors.push({
      code: "NO_MICRONODES",
      messageArm: "Դասը պետք է ունենա առնվազն մեկ MicroNode։",
    });
  }
  const warnings = input.reviewFindingCount > 0
    ? [{
      code: "MAPPING_REVIEW_REQUIRED",
      messageArm: "Քարտեզագրման արդյունքները պահանջում են ուսուցչի վերանայում։",
      count: input.reviewFindingCount,
    }]
    : [];

  return resolveLessonAssignmentReadiness({
    readiness: "READY",
    errors,
    overrideable: [],
    warnings,
    summary: {
      totalNodes: input.microNodeCount,
      approvedNodes: input.microNodeCount,
      totalTopics: 0,
      sourceExercises: 0,
      approvedSourceExercises: 0,
      draftSourceExercises: 0,
      phase2CompleteNodes: 0,
      missingLONodes: 0,
      emptyNodes: 0,
      usableNodes: input.microNodeCount,
    },
  }).readiness;
}