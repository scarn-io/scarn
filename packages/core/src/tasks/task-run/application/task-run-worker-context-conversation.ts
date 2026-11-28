import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { ConversationRepo } from "@scarn/core/conversations/conversation/application/conversation-repo";
import { deliverPendingMessages } from "@scarn/core/conversations/conversation/application/send-conversation-message";
import type {
  ConversationMessageAuthorKind,
  ConversationMessageEntity,
} from "@scarn/core/conversations/conversation/domain/conversation-message-entity";
import type { TaskRunEntity } from "../domain/task-run-entity";
import type { StepSteering } from "./task-run-worker-context-steering";

/** Total body characters of the newest messages kept in the fallback prompt. */
export const CONVERSATION_PROMPT_BUDGET = 40_000;

export const CONVERSATION_AGENT_AUTHOR_NAME = "Scarn (you)";

/** What a continuation is told when the person continued without a reply. */
export const NO_ANSWER_TEXT =
  "No answer is coming. Make the call yourself and record your assumption in your result.";

const CHAT_NOTHING_NEW_TEXT =
  "Nothing new has come in since your previous answer; carry on from it.";

export type ConversationPromptEntry = {
  authorKind: ConversationMessageAuthorKind;
  /** The username for a person, the agent's name for an agent message. */
  author: string | null;
  body: string;
  /** Set on the `system` message that records a grant request's decision. */
  grantRequestId?: UuidV7 | null;
};

/**
 * What a continuation sees of its conversation: the messages delivered to it,
 * oldest first, and the agent and person messages that fit the prompt budget,
 * with how many were left out and where in `thread` they were (`omittedAt`).
 * For a chat, `delivered` is the current turn's input instead.
 */
export type ConversationContinuation = {
  delivered: ConversationPromptEntry[];
  thread: ConversationPromptEntry[];
  omitted: number;
  omittedAt: number;
};

export type ConversationContinuationDeps = {
  conversationRepo: ConversationRepo;
  usernameReader: UsernameReader;
  timeProvider: TimeProvider;
};

/** The newest messages whose bodies fit the budget, and how many older ones were dropped. */
export const keepNewestWithinBudget = (
  messages: ConversationMessageEntity[],
) => {
  let used = 0;
  let firstKept = messages.length;
  while (firstKept > 0) {
    const size = messages[firstKept - 1]?.body.length ?? 0;
    if (used + size > CONVERSATION_PROMPT_BUDGET) {
      break;
    }
    used += size;
    firstKept -= 1;
  }
  return { kept: messages.slice(firstKept), omitted: firstKept };
};

/**
 * A chat transcript cut to the budget: always the first question and every
 * message from `currentTurnStart` on, then the newest of the messages in
 * between that still fit. The omitted ones sit right after the first question.
 */
export const keepChatTranscriptWithinBudget = (
  messages: ConversationMessageEntity[],
  currentTurnStart: number,
) => {
  const turnStart = Math.max(1, currentTurnStart);
  const required = [...messages.slice(0, 1), ...messages.slice(turnStart)];
  let used = required.reduce((sum, message) => sum + message.body.length, 0);
  let firstKept = turnStart;
  while (firstKept > 1) {
    const size = messages[firstKept - 1]?.body.length ?? 0;
    if (used + size > CONVERSATION_PROMPT_BUDGET) {
      break;
    }
    used += size;
    firstKept -= 1;
  }
  return {
    kept: [...messages.slice(0, 1), ...messages.slice(firstKept)],
    omitted: firstKept - 1,
  };
};

/** Where the current turn starts: just after the latest agent message. */
export const currentTurnStart = (
  messages: readonly ConversationMessageEntity[],
): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.authorKind === "agent") {
      return index + 1;
    }
  }
  return 0;
};

/**
 * For a chat run, whatever its reason: delivers the conversation's pending
 * messages to this run and reads the transcript back. The current turn's
 * input is the person messages after the latest agent message, whether they
 * were delivered now, to an earlier failed run, or on an earlier fetch of
 * this context (decision 6), so a retry replays exactly that turn.
 */
export const loadChatTurn = async (
  { task, conversationId }: { task: TaskRunEntity; conversationId: UuidV7 },
  deps: ConversationContinuationDeps,
): Promise<ConversationContinuation> =>
  await getDb().transaction(async (tx) => {
    await deliverPendingMessages(conversationId, task.id, deps, tx);
    const transcript = (
      await deps.conversationRepo.listMessages(conversationId, tx)
    ).filter((message) => message.authorKind !== "system");
    const turnStart = currentTurnStart(transcript);
    const currentTurn = transcript.slice(turnStart);
    const { kept, omitted } = keepChatTranscriptWithinBudget(
      transcript,
      turnStart,
    );
    const toEntry = await entryMapper(kept, deps, tx);
    return {
      delivered: currentTurn.map(toEntry),
      thread: kept.map(toEntry),
      omitted,
      omittedAt: Math.min(1, kept.length),
    };
  });

const entryMapper = async (
  messages: ConversationMessageEntity[],
  deps: Pick<ConversationContinuationDeps, "usernameReader">,
  tx: DbExecutor,
) => {
  const usernames = await deps.usernameReader.loadUsernamesByUserId(
    messages.flatMap((message) =>
      message.authorUserId ? [message.authorUserId] : [],
    ),
    tx,
  );
  return (message: ConversationMessageEntity): ConversationPromptEntry => ({
    authorKind: message.authorKind,
    author:
      message.authorKind === "agent"
        ? CONVERSATION_AGENT_AUTHOR_NAME
        : authorName(usernames, message.authorUserId),
    body: message.body,
    grantRequestId: message.grantRequestId,
  });
};

/**
 * For a `continuation` run (not a steer): finds the conversation
 * through the previous Task's agent message, delivers its pending person and
 * system messages to this Task, and reads it back. Delivery locks the
 * conversation, so a reply sent meanwhile either makes it in or is refused.
 * When the worker fetches the context again, delivery finds nothing pending
 * and the messages already delivered to this Task are used. Null when the
 * run isn't a continuation or no conversation is found.
 */
export const loadConversationContinuation = async (
  { task, steering }: { task: TaskRunEntity; steering: StepSteering },
  deps: ConversationContinuationDeps,
): Promise<ConversationContinuation | null> => {
  const previousRun = steering.previousRun;
  if (
    task.reason !== "continuation" ||
    !previousRun ||
    steering.hasOwnMessage
  ) {
    return null;
  }
  const conversationId = await deps.conversationRepo.findIdByAgentTaskRunId(
    previousRun.taskRunId,
  );
  if (!conversationId) {
    return null;
  }
  return await getDb().transaction(async (tx) => {
    const justDelivered = await deliverPendingMessages(
      conversationId,
      task.id,
      deps,
      tx,
    );
    const messages = await deps.conversationRepo.listMessages(
      conversationId,
      tx,
    );
    const delivered =
      justDelivered.length > 0
        ? justDelivered
        : messages.filter(
            (message) => message.deliveredToTaskRunId === task.id,
          );
    const { kept, omitted } = keepNewestWithinBudget(
      messages.filter((message) => message.authorKind !== "system"),
    );
    const toEntry = await entryMapper([...delivered, ...kept], deps, tx);
    return {
      delivered: delivered.map(toEntry),
      thread: kept.map(toEntry),
      omitted,
      omittedAt: 0,
    };
  });
};

const authorName = (
  usernames: Map<UuidV7, { username: string | null }>,
  userId: UuidV7 | null,
): string | null => (userId ? (usernames.get(userId)?.username ?? null) : null);

/** A `system` message that isn't a grant request's decision: a continue without a reply. */
const isContinueWithoutReply = (entry: ConversationPromptEntry) =>
  entry.authorKind === "system" && !entry.grantRequestId;

/**
 * The next user message for a restored session: the decision on the access
 * request the previous run made, if any, then one "Reply from <name>: …" per
 * delivered person message, oldest first, and the no-answer text for a
 * continue without a reply. A decision's own `system` message is skipped,
 * since `grantDecision` already says it.
 */
export const buildRestoredSessionMessage = (
  delivered: ConversationPromptEntry[],
  grantDecision: string | null = null,
): string => {
  const parts = delivered.flatMap((entry) => {
    if (isContinueWithoutReply(entry)) {
      return [NO_ANSWER_TEXT];
    }
    if (entry.authorKind === "person") {
      return [`Reply from ${entry.author ?? "a person"}: ${entry.body}`];
    }
    return [];
  });
  if (grantDecision !== null) {
    return [grantDecision, ...parts].join("\n\n");
  }
  return parts.length > 0 ? parts.join("\n\n") : NO_ANSWER_TEXT;
};

const indent = (text: string) => text.split("\n").map((line) => `    ${line}`);

/**
 * The fallback prompt's conversation block, ending with a blank line: the
 * kept agent and person messages, oldest first, and the no-answer text when
 * this Task was continued without a reply. Empty for a Task that isn't a
 * continuation.
 */
export const buildConversationPromptLines = (
  continuation: ConversationContinuation | null,
): string[] => {
  if (!continuation) {
    return [];
  }
  const continuedWithoutReply = continuation.delivered.some(
    isContinueWithoutReply,
  );
  return [
    "The conversation so far, oldest first:",
    ...buildThreadLines(continuation),
    ...(continuedWithoutReply ? [NO_ANSWER_TEXT] : []),
    "",
  ];
};

const buildThreadLines = (continuation: ConversationContinuation) => {
  const omittedLine =
    continuation.omitted > 0
      ? [
          `(${String(continuation.omitted)} earlier ${continuation.omitted === 1 ? "message" : "messages"} omitted)`,
        ]
      : [];
  const entryLines = (entries: ConversationPromptEntry[]) =>
    entries.flatMap((entry) => [
      `${entry.author ?? "A person"}:`,
      ...indent(entry.body),
    ]);
  return [
    ...entryLines(continuation.thread.slice(0, continuation.omittedAt)),
    ...omittedLine,
    ...entryLines(continuation.thread.slice(continuation.omittedAt)),
  ];
};

/**
 * A chat's conversation block for a fresh session, ending with a blank line:
 * the transcript (first question and current turn always kept) and which
 * messages to answer now.
 */
export const buildChatPromptLines = (
  turn: ConversationContinuation,
): string[] => [
  "The conversation so far, oldest first:",
  ...buildThreadLines(turn),
  "",
  turn.delivered.length === 0
    ? CHAT_NOTHING_NEW_TEXT
    : turn.delivered.length === 1
      ? "Answer the last message now."
      : `Answer the last ${String(turn.delivered.length)} messages now; they came in since your previous answer.`,
  "",
];

/**
 * The current turn's input for a restored chat session: one "Reply from
 * <name>: …" per person message since the agent's latest answer.
 */
export const buildChatRestoredMessage = (
  turn: ConversationContinuation,
): string =>
  turn.delivered.length > 0
    ? buildRestoredSessionMessage(turn.delivered)
    : CHAT_NOTHING_NEW_TEXT;
