import { openrouter } from "@workspace/integrations-openrouter-ai";
import { z } from "zod/v4";
import {
  answerEvaluationSchema,
  type ChatMessage,
} from "../ai.js";
import { containsHiddenExerciseContent } from "../../lib/exercise-content-boundary.js";

const MODEL = "deepseek/deepseek-chat-v3-0324";

export const phase2TheoryResultSchema = z.object({
  student_message: z.string().min(1),
});

const phase2TaskInteractionTypeSchema = z.enum([
  "multiple_choice",
  "true_false",
  "constructed_response",
]);

export const phase2TaskCandidateSchema = z.object({
  student_message: z.string().min(1),
  interaction_type: phase2TaskInteractionTypeSchema,
  options: z.array(z.object({
    key: z.string().regex(/^[A-Z]$/u),
    text: z.string().min(1),
  })).nullable(),
  correct_option: z.string().nullable(),
  question_template: z.string().nullable(),
}).superRefine((candidate, ctx) => {
  if (!hasVisibleTaskStem(candidate.student_message)) {
    ctx.addIssue({
      code: "custom",
      path: ["student_message"],
      message: "task candidate must contain an explicit visible, answerable task stem",
    });
  }
  if (candidate.interaction_type === "multiple_choice") {
    if (!candidate.options || candidate.options.length < 2) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "multiple_choice tasks require at least two options",
      });
    } else if (
      candidate.correct_option === null ||
      !candidate.options.some((option) => option.key === candidate.correct_option)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["correct_option"],
        message: "correct_option must match a visible option key",
      });
    }
  } else if (candidate.interaction_type === "true_false") {
    if (candidate.correct_option !== "TRUE" && candidate.correct_option !== "FALSE") {
      ctx.addIssue({
        code: "custom",
        path: ["correct_option"],
        message: "true_false tasks require TRUE or FALSE",
      });
    }
  } else if (candidate.correct_option !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["correct_option"],
      message: "constructed_response tasks cannot include a deterministic answer key",
    });
  }
});

export const phase2EvaluationResultSchema = answerEvaluationSchema;

export const phase2FeedbackResultSchema = z.object({
  student_message: z.string().min(1),
});

export type Phase2TheoryResult = z.infer<typeof phase2TheoryResultSchema>;
export type Phase2TaskCandidate = z.infer<typeof phase2TaskCandidateSchema>;
export type Phase2EvaluationResult = z.infer<typeof phase2EvaluationResultSchema>;
export type Phase2FeedbackResult = z.infer<typeof phase2FeedbackResultSchema>;

export type FeedbackAuthorityStatus = "CORRECT" | "INCORRECT" | "PARTIALLY_CORRECT";

const VISIBLE_OPTION_MARKER = /(?:^|\n)\s*[A-ZԱ-Ֆ]\s*[.)]/u;
const TASK_DIRECTIVE =
  /(?:^|[.!։]\s+)(?:խնդրում եմ\s+)?(?:ընտր(?:իր|եք)|լրաց(?:րու|րեք)|հաշվ(?:իր|եք)|գր(?:իր|եք)|գտ(?:իր|եք)|լուծ(?:իր|եք)|պատասխանի(?:ր|րեք)|նշ(?:իր|եք)|համադր(?:իր|եք)|ապացուց(?:իր|եք)|կատար(?:իր|եք)|նկարագր(?:իր|եք)|բացատր(?:իր|եք))/imu;
const LEARNER_WORK_DIRECTIVE =
  /(?:փորձ(?:իր|եք)|նկարագր(?:իր|եք)|բացատր(?:իր|եք)|պատասխանի(?:ր|րեք)|նշ(?:իր|եք)|գր(?:իր|եք)|լուծ(?:իր|եք)|ներկայացր(?:ու|եք)|բեր(?:իր|եք)?\s+օրինակ|աս(?:ա|եք)|ցույց\s+տուր)/iu;

const FEEDBACK_ACTIONS_WITHOUT_LEARNER_INPUT = new Set([
  "DELIVER_THEORY",
  "DELIVER_SOURCE_EXERCISE",
  "GENERATE_TASK",
  "ADVANCE_COGNITIVE_LEVEL",
  "COMPLETE_MICRONODE",
]);

function hasVisibleTaskStem(text: string): boolean {
  return /[?՞]/u.test(text) || TASK_DIRECTIVE.test(text);
}

// Conservative, high-confidence learner-facing outcome claims. These do not
// match neutral encouragement such as «ճիշտ ուղղությամբ ես մտածում».
const EXPLICIT_CORRECTNESS_CLAIM =
  /(?:ճիշտ\s+(?:է|պատասխան(?:ն)?(?:\s+է)?|ես\s+պատասխանել)|դու\s+(?:ճիշտ\s+)?(?:ընտրեցիր|պատասխանեցիր)|դու\s+(?:ճիշտ\s+)?ընտրել\s+ես\s+ճիշտ\s+պատասխանը)/iu;
const EXPLICIT_INCORRECTNESS_CLAIM =
  /(?:սխալ\s+(?:է|պատասխան(?:ն)?(?:\s+է)?|ես\s+պատասխանել)|դու\s+(?:սխալ\s+)?(?:ընտրեցիր|պատասխանեցիր)|դու\s+(?:սխալ\s+)?ընտրել\s+ես\s+սխալ\s+պատասխանը)/iu;

export function assertTheoryOnly(result: Phase2TheoryResult): void {
  if (
    /[?՞]/u.test(result.student_message) ||
    VISIBLE_OPTION_MARKER.test(result.student_message) ||
    TASK_DIRECTIVE.test(result.student_message)
  ) {
    throw new Error("phase2_theory_result attempted to include a visible task");
  }
}

export function assertFeedbackOnly(result: Phase2FeedbackResult): void {
  if (
    /[?՞]/u.test(result.student_message) ||
    VISIBLE_OPTION_MARKER.test(result.student_message) ||
    TASK_DIRECTIVE.test(result.student_message)
  ) {
    throw new Error("phase2_feedback_result attempted to include a visible task");
  }
}

export function assertFeedbackDoesNotRevealHiddenContent(
  result: Phase2FeedbackResult,
  hiddenContents: readonly (string | null | undefined)[],
): void {
  if (containsHiddenExerciseContent(result.student_message, hiddenContents)) {
    throw new Error("phase2_feedback_result attempted to reveal evaluator-only exercise content");
  }
}

/**
 * Sentinel error thrown when both bounded THEORY attempts produce a response
 * that includes a visible answerable task. Callers must catch this specific
 * type to activate the safe node-content fallback path; all other errors remain
 * fail-closed and must not trigger the fallback.
 */
export class Phase2TheoryExhaustionError extends Error {
  constructor(public readonly originalMessage: string) {
    super("phase2_theory_exhausted: both bounded THEORY attempts included a visible task");
    this.name = "Phase2TheoryExhaustionError";
  }
}

/**
 * Node content available to buildNodeTheoryFallback. Only fields that are
 * already approved and learner-safe may appear here — evaluator-only content
 * (answer keys, rubrics, success criteria) must never be passed in.
 */
export type NodeTheoryFallbackContent = {
  title: string;
  learningObjective?: string | null;
  theoryContent?: string | null;
  childFriendlyExplanation?: string | null;
  basicExamples?: readonly string[] | null;
};

/**
 * Composes a short, safe Armenian theory message from approved server-owned
 * node content. The result is validated with assertTheoryOnly before it is
 * returned; if the composed text somehow violates the contract, this throws
 * normally so the call site remains fail-closed for that case.
 *
 * This function must ONLY be called after Phase2TheoryExhaustionError — it is
 * not a general-purpose theory generator. No AI, no provider call.
 */
export function buildNodeTheoryFallback(
  node: NodeTheoryFallbackContent,
): Phase2TheoryResult {
  const parts: string[] = [];

  // Preferred: child-friendly explanation — already written for learners.
  if (node.childFriendlyExplanation && node.childFriendlyExplanation.trim()) {
    parts.push(node.childFriendlyExplanation.trim());
  } else if (node.theoryContent && node.theoryContent.trim()) {
    // Fallback to raw theory content (approved by the teacher).
    parts.push(node.theoryContent.trim());
  } else {
    // Minimal safe intro anchored to the node title.
    parts.push(`«${node.title}» թեման։`);
    if (node.learningObjective && node.learningObjective.trim()) {
      parts.push(node.learningObjective.trim());
    }
  }

  // Append basic examples if available and not already embedded.
  if (
    Array.isArray(node.basicExamples) &&
    node.basicExamples.length > 0 &&
    parts.length < 2
  ) {
    const examplesText = node.basicExamples
      .filter((example) => typeof example === "string" && example.trim())
      .slice(0, 2)
      .join("\n");
    if (examplesText) {
      parts.push(examplesText);
    }
  }

  const student_message = parts.join("\n\n");
  const result: Phase2TheoryResult = { student_message };

  // Validate the fallback with the same strict guard used for AI-generated
  // THEORY. If somehow the approved node content contains a task marker, throw
  // normally — the caller must not persist or continue.
  assertTheoryOnly(result);

  return result;
}

/**
 * Final learner-delivery guard: FEEDBACK may explain or encourage, but cannot
 * reverse the authoritative evaluation polarity. The server adds the visible
 * correctness acknowledgement separately.
 */
export function assertFeedbackMatchesAuthority(
  result: Phase2FeedbackResult,
  status: FeedbackAuthorityStatus,
): void {
  if (
    status === "INCORRECT" &&
    EXPLICIT_CORRECTNESS_CLAIM.test(result.student_message)
  ) {
    throw new Error("phase2_feedback_result contradicts authoritative INCORRECT status");
  }
  if (
    status === "CORRECT" &&
    EXPLICIT_INCORRECTNESS_CLAIM.test(result.student_message)
  ) {
    throw new Error("phase2_feedback_result contradicts authoritative CORRECT status");
  }
  if (
    status === "PARTIALLY_CORRECT" &&
    (
      EXPLICIT_CORRECTNESS_CLAIM.test(result.student_message) ||
      EXPLICIT_INCORRECTNESS_CLAIM.test(result.student_message)
    )
  ) {
    throw new Error("phase2_feedback_result contradicts authoritative PARTIALLY_CORRECT status");
  }
}

/**
 * FEEDBACK describes an action chosen by the server; it cannot manufacture
 * learner work when no real answerable task exists. Remediation that preserves
 * an active task remains intentionally allowed.
 */
export function assertFeedbackConsistentWithServerAction(
  result: Phase2FeedbackResult,
  input: { serverAction: string; hasActiveTask: boolean },
): void {
  // Completion is authoritative even while the request-local mirror has not
  // yet observed the session's cleared task state.
  const completionEndsLearnerWork = input.serverAction === "COMPLETE_MICRONODE";
  if (
    (completionEndsLearnerWork ||
      (!input.hasActiveTask &&
        FEEDBACK_ACTIONS_WITHOUT_LEARNER_INPUT.has(input.serverAction))) &&
    LEARNER_WORK_DIRECTIVE.test(result.student_message)
  ) {
    throw new Error(
      "phase2_feedback_result attempted learner work without an active task",
    );
  }
}

export function serverOwnedFeedbackAcknowledgement(
  status: string,
): string | null {
  switch (status) {
    case "CORRECT":
      return "Ճիշտ պատասխան է։";
    case "INCORRECT":
      return "Պատասխանը ճիշտ չէ։";
    case "PARTIALLY_CORRECT":
      return "Պատասխանը մասամբ ճիշտ է։";
    default:
      return null;
  }
}

type BoundedJobSpec<T> = {
  name: string;
  schema: z.ZodType<T>;
  systemPrompt: string;
  messages: ChatMessage[];
  maxTokens: number;
  validateResult?: (result: T) => void;
};

function formatForSchema<T>(name: string, schema: z.ZodType<T>) {
  return {
    type: "json_schema" as const,
    json_schema: {
      name,
      strict: true,
      schema: z.toJSONSchema(schema),
    },
  };
}

async function runBoundedJob<T>(spec: BoundedJobSpec<T>): Promise<T> {
  const request = async (systemPrompt: string): Promise<T> => {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: spec.maxTokens,
      temperature: 0.4,
      frequency_penalty: 0.2,
      response_format: formatForSchema(spec.name, spec.schema),
      messages: [
        { role: "system", content: systemPrompt },
        ...spec.messages,
      ],
    });

    const raw = response.choices?.[0]?.message?.content;
    if (!raw || !raw.trim()) {
      throw new Error(`${spec.name} returned empty content`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch (error) {
      throw new Error(`${spec.name} returned invalid JSON: ${String(error)}`);
    }

    const result = spec.schema.parse(parsed);
    spec.validateResult?.(result);
    return result;
  };

  try {
    return await request(spec.systemPrompt);
  } catch (firstError) {
    const correction = [
      spec.systemPrompt,
      "",
      "The previous response failed bounded schema validation.",
      "Return only one valid JSON object matching the requested contract.",
      `Validation error: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
    ].join("\n");
    return request(correction);
  }
}

const ARMENIAN_ONLY =
  "Պատասխանիր միայն հայերենով։ Մի՛ գրիր JSON-ից դուրս ոչինչ։";

/**
 * Returns true when the error is specifically an assertTheoryOnly visible-task
 * rejection. Used to distinguish bounded THEORY exhaustion (both attempts
 * included a task) from unrelated provider, schema, or safety failures.
 */
function isTheoryVisibleTaskError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "phase2_theory_result attempted to include a visible task"
  );
}

/**
 * Calls the bounded THEORY job. On both attempts the AI must return pure
 * explanation text with no answerable task stem. If both attempts violate that
 * contract specifically, throws Phase2TheoryExhaustionError so the caller can
 * activate the safe node-content fallback. All other failures (provider errors,
 * schema errors, JSON parse errors) propagate as-is so the call site stays
 * fail-closed for unrelated problems.
 */
export async function callPhase2TheoryJob(
  messages: ChatMessage[],
  lessonContext: string,
): Promise<Phase2TheoryResult> {
  const systemPrompt = [
    "Դու myaiteacher-ի THEORY job-ն ես։",
    "Բացատրիր միայն ընթացիկ MicroNode-ի և cognitive target-ի նյութը։",
    "Տուր կարճ, հասկանալի բացատրություն՝ առանց հարցի, ընտրանքների կամ պատասխանի բանալու։",
    "Մի որոշիր workflow, հաջորդ քայլ, առաջընթաց, գնահատում կամ ավարտ։",
    "Արտածիր միայն {student_message} դաշտը։",
    ARMENIAN_ONLY,
    "AUTHORITATIVE EDUCATIONAL CONTEXT:",
    lessonContext,
  ].join("\n");

  // Attempt 1 — use runBoundedJob without a validateResult hook so that we can
  // inspect the first error ourselves. We validate manually after parsing.
  const runAttempt = async (prompt: string): Promise<Phase2TheoryResult> => {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 900,
      temperature: 0.4,
      frequency_penalty: 0.2,
      response_format: formatForSchema("phase2_theory_result", phase2TheoryResultSchema),
      messages: [
        { role: "system", content: prompt },
        ...messages,
      ],
    });
    const raw = response.choices?.[0]?.message?.content;
    if (!raw || !raw.trim()) {
      throw new Error("phase2_theory_result returned empty content");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch (err) {
      throw new Error(`phase2_theory_result returned invalid JSON: ${String(err)}`);
    }
    const result = phase2TheoryResultSchema.parse(parsed);
    // assertTheoryOnly throws "phase2_theory_result attempted to include a visible task"
    assertTheoryOnly(result);
    return result;
  };

  let firstError: unknown;
  try {
    return await runAttempt(systemPrompt);
  } catch (err) {
    firstError = err;
    // Non-visible-task errors (provider, schema, JSON) are fail-closed: rethrow.
    if (!isTheoryVisibleTaskError(err)) {
      throw err;
    }
  }

  // Attempt 2 — corrective retry with the specific constraint re-stated.
  const correctionPrompt = [
    systemPrompt,
    "",
    "The previous response failed bounded schema validation.",
    "Return only one valid JSON object matching the requested contract.",
    `Validation error: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
    "CRITICAL: Do NOT include any question mark, answerable task, or option list in student_message.",
  ].join("\n");

  try {
    return await runAttempt(correctionPrompt);
  } catch (secondError) {
    // If the second attempt also produced a visible task, signal exhaustion.
    // All other second-attempt failures are still fail-closed.
    if (isTheoryVisibleTaskError(secondError)) {
      throw new Phase2TheoryExhaustionError(
        secondError instanceof Error ? secondError.message : String(secondError),
      );
    }
    throw secondError;
  }
}

export function callPhase2TaskJob(
  messages: ChatMessage[],
  lessonContext: string,
): Promise<Phase2TaskCandidate> {
  return runBoundedJob({
    name: "phase2_task_candidate",
    schema: phase2TaskCandidateSchema,
    maxTokens: 1100,
    messages,
    systemPrompt: [
      "Դու myaiteacher-ի TASK job-ն ես։",
      "Ստեղծիր ճիշտ մեկ տեսանելի MICRO_CHECK ընթացիկ MicroNode-ի համար։",
      "Մի՛ բացատրիր տեսություն, մի՛ գնահատիր սովորողի պատասխան, մի՛ տուր feedback և մի՛ որոշիր progression։",
      "multiple_choice-ի դեպքում տուր առնվազն երկու ընտրանք և correct_option-ը պետք է համապատասխանի ընտրանքի key-ին։",
      "true_false-ի դեպքում correct_option-ը պետք է լինի TRUE կամ FALSE։",
      "constructed_response-ի դեպքում correct_option-ը պետք է լինի null։",
      "student_message-ում գրիր միայն առաջադրանքի հարցի տեքստը, երբեք մի՛ կրկնիր ընտրանքները։",
      "Մի՛ նշիր source exercise identity կամ textbook provenance։",
      ARMENIAN_ONLY,
      "AUTHORITATIVE EDUCATIONAL CONTEXT:",
      lessonContext,
    ].join("\n"),
  });
}

export function callPhase2EvaluationJob(
  messages: ChatMessage[],
  evaluationContext: string,
): Promise<Phase2EvaluationResult> {
  return runBoundedJob({
    name: "phase2_evaluation_result",
    schema: phase2EvaluationResultSchema,
    maxTokens: 700,
    messages,
    systemPrompt: [
      "Դու myaiteacher-ի EVALUATION job-ն ես։",
      "Գնահատիր միայն սովորողի վերջին պատասխանը տրված առաջադրանքի և չափանիշների հիման վրա։",
      "Մի՛ գրիր feedback կամ learner-facing wording։",
      "Մի՛ որոշիր հաջորդ task-ը, teaching stage-ը, cognitive level-ը, progression-ը կամ node completion-ը։",
      "Օգտագործիր միայն գործող canonical status, evidence_quality, error_family և error_stability արժեքները։",
      ARMENIAN_ONLY,
      "EVALUATION CONTEXT:",
      evaluationContext,
    ].join("\n"),
  });
}

export function callPhase2FeedbackJob(
  messages: ChatMessage[],
  feedbackContext: string,
  hiddenContents: readonly (string | null | undefined)[] = [],
): Promise<Phase2FeedbackResult> {
  return runBoundedJob({
    name: "phase2_feedback_result",
    schema: phase2FeedbackResultSchema,
    maxTokens: 900,
    messages,
    validateResult: (result) => {
      assertFeedbackOnly(result);
      assertFeedbackDoesNotRevealHiddenContent(result, hiddenContents);
    },
    systemPrompt: [
      "Դու myaiteacher-ի FEEDBACK job-ն ես։",
      "Գրիր միայն learner-facing կարճ feedback՝ տրված authoritative evaluation-ի և Decision Engine action-ի հիման վրա։",
      "Մի՛ փոխիր correctness-ը, evidence quality-ն, progression-ը, completion-ը, teaching stage-ը կամ հաջորդ task-ը։",
      "Մի՛ ասա, որ պատասխանը ճիշտ է, սխալ է, կամ մասամբ ճիշտ է. այդ acknowledgement-ը server-ն է ավելացնում։",
      "Մի՛ բացահայտիր կամ վերարտադրիր evaluator-only success criteria, rubric կամ answer key։",
      "Մի՛ ավելացրու նոր հարց, ընտրանքներ կամ առաջադրանք։",
      "Արտածիր միայն {student_message} դաշտը։",
      ARMENIAN_ONLY,
      "FEEDBACK CONTEXT:",
      feedbackContext,
    ].join("\n"),
  });
}