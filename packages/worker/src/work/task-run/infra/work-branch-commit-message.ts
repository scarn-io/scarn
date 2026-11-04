import { renderPromptTemplate } from "@scarn/sdk/definitions/steps";
import type { AnyJsonValue } from "../../../common/contracts/json";

/** The longest commit subject the worker will hand to git. */
export const MAX_COMMIT_SUBJECT_LENGTH = 200;

export function defaultCommitMessage(taskRunId: string): string {
  return `scarn: task ${taskRunId}`;
}

/** The work item values a commit message's `{{workItem.…}}` tokens may use. */
export type CommitMessageWorkItem = { title: string; platformKey: string };

/**
 * Render a `readWrite` step's commit message. The template (`{{input.…}}`,
 * `{{result.…}}` and `{{workItem.title}}` / `{{workItem.platformKey}}` tokens)
 * is rendered against the step's additional input, the findings the agent
 * submitted and the work item read live at commit time (absent tokens render
 * empty when the read was skipped or failed). The rendered text carries agent output, so
 * it is reduced to a safe single-line subject: whitespace runs collapse to one
 * space, remaining control characters (NUL included, which Node rejects in an
 * argv entry) are stripped, and the subject is cut to
 * {@link MAX_COMMIT_SUBJECT_LENGTH} characters. A `null` template, or one that
 * renders to nothing, yields {@link defaultCommitMessage}, since git aborts on
 * an empty message.
 */
export function renderCommitMessage(input: {
  template: string | null;
  taskRunId: string;
  inputJson: unknown;
  result: AnyJsonValue;
  workItem?: CommitMessageWorkItem | null | undefined;
}): string {
  const fallback = defaultCommitMessage(input.taskRunId);
  if (input.template === null) return fallback;

  const rendered = renderPromptTemplate(input.template, {
    input: input.inputJson,
    result: input.result,
    workItem: input.workItem
      ? { title: input.workItem.title, platformKey: input.workItem.platformKey }
      : null,
  });
  const singleLine = rendered
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\u2028\u2029]/gu, "")
    .trim();
  const subject = Array.from(singleLine)
    .slice(0, MAX_COMMIT_SUBJECT_LENGTH)
    .join("")
    .trim();
  return subject === "" ? fallback : subject;
}
