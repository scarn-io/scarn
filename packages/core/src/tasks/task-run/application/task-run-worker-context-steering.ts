import type { TaskRunWorkerContextContract } from "../contracts/task-run-contracts";
import type { TaskRunReason } from "../domain/task-run-entity";
import type { TaskRunHistoryEntry } from "./task-run-history-reader";
import type { TaskRunRepo } from "./task-run-repo";

export const PREVIOUS_RUN_TRANSCRIPT_RELATIVE_PATH =
  ".scarn/previous-run/transcript.txt";
export const PREVIOUS_RUN_FINDINGS_RELATIVE_PATH =
  ".scarn/previous-run/findings.json";

/** One message a person sent to the step, in the previous-run chain. */
export type StepMessagePromptEntry = {
  attemptNumber: number | null;
  body: string;
  quoteText: string | null;
};

export type ContinuedBranch = {
  from: "previous_run" | "earlier_run";
  workBranch: string;
};

/**
 * What a Task's previous-run chain contributes to its worker context (see
 * rule 4 in `docs/plans/step-steering-v1.md`): every message in the chain, and,
 * when the Task has a message of its own or continues a yielded run, the
 * previous run and the branch to continue from: a yielded previous run's work
 * branch, else the nearest succeeded run's.
 */
export type StepSteering = {
  messages: StepMessagePromptEntry[];
  hasOwnMessage: boolean;
  previousRun: TaskRunWorkerContextContract["previousRun"];
  continuedBranch: ContinuedBranch | null;
};

const findContinuedBranch = async (
  earlierRuns: TaskRunHistoryEntry[],
  taskRunRepo: TaskRunRepo,
): Promise<ContinuedBranch | null> => {
  const previous = earlierRuns.at(-1);
  if (previous?.status === "yielded") {
    const workBranch = (await taskRunRepo.load(previous.taskRunId))?.workBranch;
    if (workBranch) {
      return { from: "previous_run", workBranch };
    }
  }
  const nearestSucceeded = earlierRuns
    .filter((run) => run.status === "succeeded")
    .at(-1);
  if (!nearestSucceeded) {
    return null;
  }
  const workBranch = (await taskRunRepo.load(nearestSucceeded.taskRunId))
    ?.workBranch;
  if (!workBranch) {
    return null;
  }
  return {
    from: nearestSucceeded === previous ? "previous_run" : "earlier_run",
    workBranch,
  };
};

/**
 * The messages sent to the run's step and, for a `continuation` run or one
 * with its own message, the previous run it carries on from. A `retry` or a
 * rerun with no message of its own starts fresh.
 */
export const loadStepSteering = async ({
  history,
  reason,
  taskRunRepo,
}: {
  history: TaskRunHistoryEntry[];
  reason: TaskRunReason;
  taskRunRepo: TaskRunRepo;
}): Promise<StepSteering> => {
  const messages = history.flatMap((run, index) =>
    run.messages.map((message) => ({
      attemptNumber: index + 1,
      body: message.body,
      quoteText: message.quoteText,
    })),
  );
  const current = history.at(-1);
  const earlierRuns = history.slice(0, -1);
  const previous = earlierRuns.at(-1);
  const hasOwnMessage = (current?.messages.length ?? 0) > 0;
  if (!previous || (!hasOwnMessage && reason !== "continuation")) {
    return {
      messages,
      hasOwnMessage,
      previousRun: null,
      continuedBranch: null,
    };
  }

  const [previousTask, continuedBranch] = await Promise.all([
    taskRunRepo.load(previous.taskRunId),
    findContinuedBranch(earlierRuns, taskRunRepo),
  ]);
  return {
    messages,
    hasOwnMessage,
    previousRun: {
      taskRunId: previous.taskRunId,
      status: previous.status,
      transcriptRelativePath: PREVIOUS_RUN_TRANSCRIPT_RELATIVE_PATH,
      findingsRelativePath: PREVIOUS_RUN_FINDINGS_RELATIVE_PATH,
      findingsJson: previousTask?.resultJson ?? null,
    },
    continuedBranch,
  };
};

const indent = (text: string, prefix: string) =>
  text.split("\n").map((line) => `${prefix}${line}`);

const buildMessageLines = (
  messages: StepMessagePromptEntry[],
  hasOwnMessage: boolean,
): string[] => {
  if (messages.length === 0) {
    return [];
  }
  const entries = messages.flatMap((message, index) => {
    const sent =
      message.attemptNumber === null
        ? "Sent earlier"
        : `Sent before attempt ${String(message.attemptNumber)}`;
    const actNow =
      hasOwnMessage && index === messages.length - 1
        ? " (the latest; act on this one now)"
        : "";
    return [
      `[${String(index + 1)}] ${sent}${actNow}:`,
      ...(message.quoteText ? indent(message.quoteText, "    > ") : []),
      ...indent(message.body, "    "),
    ];
  });
  const header = hasOwnMessage
    ? "Messages from the user to this step, oldest first:"
    : "Earlier instructions from the user to this step, oldest first:";
  return hasOwnMessage
    ? [header, ...entries, ""]
    : [
        header,
        ...entries,
        "This run starts from the upstream work, not from the earlier runs' work, so carry these instructions out again.",
        "",
      ];
};

const buildBranchLine = (
  continuedBranch: ContinuedBranch | null,
  baseWorkBranch: string | null,
  stepBaseBranch: string | null,
): string => {
  if (continuedBranch?.from === "previous_run") {
    return `Your work branch starts from that run's branch, ${continuedBranch.workBranch}.`;
  }
  if (continuedBranch?.from === "earlier_run") {
    return `Your work branch starts from ${continuedBranch.workBranch}, the branch of the last run of this step that succeeded.`;
  }
  if (stepBaseBranch !== null) {
    return "No earlier run of this step left a work branch to build on, so your work branch starts from the step's base branch.";
  }
  return baseWorkBranch
    ? `No earlier run of this step left a work branch to build on, so your work branch starts from the upstream branch, ${baseWorkBranch}.`
    : "No earlier run of this step left a work branch to build on, so your work branch starts from the repository's base branch.";
};

/**
 * The prompt lines added after the step instructions: the messages block and,
 * for a run with its own message, the previous-run block. Each block ends with
 * a blank line; empty when the chain has no messages.
 */
export const buildSteeringPromptLines = ({
  steering,
  baseWorkBranch,
  stepBaseBranch,
}: {
  steering: StepSteering;
  baseWorkBranch: string | null;
  /** The step's `baseBranch` template; set, it beats the upstream branch. */
  stepBaseBranch: string | null;
}): string[] => {
  const messageLines = buildMessageLines(
    steering.messages,
    steering.hasOwnMessage,
  );
  if (!steering.previousRun) {
    return messageLines;
  }
  return [
    ...messageLines,
    `This run continues the previous run of this step (status: ${steering.previousRun.status}).`,
    steering.previousRun.status === "yielded"
      ? "It handed the conversation to a person, so it has no findings."
      : `Its findings: ${PREVIOUS_RUN_FINDINGS_RELATIVE_PATH}`,
    `Its full transcript: ${PREVIOUS_RUN_TRANSCRIPT_RELATIVE_PATH}. Its final message is at the end. If the file is missing, the transcript was unavailable.`,
    "Search it for what you need; don't read it whole.",
    buildBranchLine(steering.continuedBranch, baseWorkBranch, stepBaseBranch),
    "Start your final message with one line saying what changed since the previous run.",
    "",
  ];
};
