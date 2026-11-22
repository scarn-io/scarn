/**
 * What a chat (repo conversation) run is told on top of its stored prompt:
 * the repo-ask instruction that replaces the owning-work-item line, and the
 * current-turn preamble sent into a restored session every turn (decision 8
 * in `docs/plans/repo-conversations.md`). Instructions only; nothing here
 * changes which tools the agent has.
 */

export type ChatRepoContext = {
  taskRunId: string;
  gitUrl: string;
  baseBranch: string | null;
  baseCommit: string | null;
};

const describeCheckout = (context: ChatRepoContext): string => {
  const branch = context.baseBranch ?? "the repository's default branch";
  return context.baseCommit
    ? `${context.gitUrl}, branch ${branch}, commit ${context.baseCommit}`
    : `${context.gitUrl}, branch ${branch}, at the commit pinned when this conversation first ran`;
};

/** The repo-ask instruction: advisory, grounded in the pinned commit. */
export const buildRepoAskPromptLines = (context: ChatRepoContext): string[] => [
  `You are answering questions about this repository: ${describeCheckout(context)}.`,
  "This conversation is advisory. Explain and propose; do not edit files, commit, push, or create, change or close work items.",
  "Give any proposed change as a patch or snippet in your answer.",
  "Cite files by their path at the pinned commit, with line numbers where they help.",
  "When you have answered, end your turn: your final message is sent to the person, and you continue here when they reply. Don't call `scarn-end-conversation` to finish an ordinary answer.",
];

const FRESH_CHECKOUT_TEXT =
  "Your workspace is a fresh checkout at the same commit; files you changed in earlier turns and any runtime state are not preserved.";

/**
 * The current-turn preamble for a restored chat session: the run, the pinned
 * repo, branch and commit, the advisory rules, and that the checkout is
 * fresh. Ends with a blank line, so the turn's input follows it.
 */
export const buildChatTurnPreamble = (context: ChatRepoContext): string =>
  [
    `This is a new turn (task run ${context.taskRunId}).`,
    ...buildRepoAskPromptLines(context),
    FRESH_CHECKOUT_TEXT,
    "",
    "",
  ].join("\n");
