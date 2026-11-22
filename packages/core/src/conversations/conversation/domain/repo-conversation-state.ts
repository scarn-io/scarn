/**
 * How a repo conversation (chat) reads to people, derived from its
 * conversation, its Task and the Task's latest run; and the details shown
 * with it (a preview of the question, a short pin, a safe error).
 */
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type {
  TaskRunReason,
  TaskRunStatus,
} from "@scarn/core/tasks/task-run/domain/task-run-entity";
import {
  namedRunError,
  TASK_ERROR_NAMES,
} from "@scarn/core/tasks/task/domain/run-error";
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";
import type { ConversationStatus } from "./conversation-entity";

export const repoConversationStateValues = [
  "queued",
  "running",
  "retry_queued",
  "waiting",
  "failed",
  "ended",
] as const;

export type RepoConversationState =
  (typeof repoConversationStateValues)[number];

/** What the chat's state and safe error need from its latest run. */
export type RepoConversationRunFacts = {
  status: TaskRunStatus;
  reason: TaskRunReason;
  errorJson: AnyJsonValue | null;
};

/**
 * `ended` once the conversation is closed (End, or a cancelled Task);
 * `failed` while the Task is failed (resumable through Retry); `waiting` while
 * the agent waits for a reply; `running` while a turn runs; otherwise a turn
 * is queued, `retry_queued` when it's a retry. `taskStatus` must be the
 * effective status (a lapsed run reads as failed).
 */
export const repoConversationState = (chat: {
  conversationStatus: ConversationStatus;
  taskStatus: TaskStatus;
  latestRunReason: TaskRunReason | null;
}): RepoConversationState => {
  if (chat.conversationStatus === "closed") {
    return "ended";
  }
  switch (chat.taskStatus) {
    case "failed":
      return "failed";
    case "succeeded":
    case "cancelled":
      return "ended";
    case "waiting_for_person":
      return "waiting";
    case "running":
      return "running";
    case "queued":
    case "waiting_for_concurrency_slot":
    case "waiting_for_work":
      return chat.latestRunReason === "retry" ? "retry_queued" : "queued";
  }
};

export const REPO_CONVERSATION_PREVIEW_LENGTH = 140;

/** The question, on one line, cut to `REPO_CONVERSATION_PREVIEW_LENGTH` characters. */
export const conversationPreview = (body: string | null): string => {
  const line = (body ?? "").replace(/\s+/gu, " ").trim();
  return line.length <= REPO_CONVERSATION_PREVIEW_LENGTH
    ? line
    : `${line.slice(0, REPO_CONVERSATION_PREVIEW_LENGTH - 1).trimEnd()}…`;
};

export const SHORT_COMMIT_LENGTH = 12;

export const shortCommit = (commit: string | null): string | null =>
  commit === null ? null : commit.slice(0, SHORT_COMMIT_LENGTH);

/** The project's repo URL without any userinfo (credentials) in it. */
export const displayRepository = (gitUrl: string): string => {
  try {
    const url = new URL(gitUrl);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return gitUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/iu, "$1");
  }
};

const REPO_CONTEXT_COMMIT_UNAVAILABLE = "REPO_CONTEXT_COMMIT_UNAVAILABLE";

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  [REPO_CONTEXT_COMMIT_UNAVAILABLE]: "The pinned commit is no longer available",
  [TASK_ERROR_NAMES.timeout]: "The turn timed out",
  [TASK_ERROR_NAMES.heartbeatTimeout]: "The worker stopped responding",
  [TASK_ERROR_NAMES.maxTurnsExceeded]:
    "The conversation reached its turn limit",
  [TASK_ERROR_NAMES.logArchiveFailed]: "The turn's logs could not be saved",
};

const GENERIC_ERROR_MESSAGE = "The turn failed";

const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/u;

const errorCodeOf = (errorJson: AnyJsonValue | null): string | null => {
  if (
    typeof errorJson !== "object" ||
    errorJson === null ||
    Array.isArray(errorJson)
  ) {
    return null;
  }
  const code = errorJson["code"];
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code)
    ? code
    : null;
};

export type RepoConversationSafeError = { code: string; message: string };

/**
 * A failed run's error as people may see it: its code (or error name) and a
 * fixed message for that code. Never the run's own message, logs or stack.
 */
export const repoConversationError = (
  run: Pick<RepoConversationRunFacts, "status" | "errorJson"> | null,
): RepoConversationSafeError => {
  if (run === null) {
    return {
      code: TASK_ERROR_NAMES.stepFailed,
      message: GENERIC_ERROR_MESSAGE,
    };
  }
  const name = namedRunError(run).name;
  const code =
    errorCodeOf(run.errorJson) ??
    (ERROR_CODE_PATTERN.test(name) ? name : TASK_ERROR_NAMES.stepFailed);
  return { code, message: SAFE_ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGE };
};
