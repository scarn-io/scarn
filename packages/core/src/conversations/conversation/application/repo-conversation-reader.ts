import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";
import type { ConversationStatus } from "../domain/conversation-entity";
import type { RepoConversationRunFacts } from "../domain/repo-conversation-state";

/** The first run that pinned a commit: the chat's repo context. */
export type RepoConversationPin = {
  branch: string | null;
  commit: string;
  /** When that run started (else was claimed). */
  pinnedAt: Date;
};

/** A chat as its list row and detail read it. Statuses have liveness applied. */
export type RepoConversationRecord = {
  conversationId: UuidV7;
  projectId: UuidV7;
  conversationStatus: ConversationStatus;
  taskId: UuidV7;
  taskStatus: TaskStatus;
  startedByUserId: UuidV7 | null;
  firstMessageBody: string | null;
  latestRun: (RepoConversationRunFacts & { id: UuidV7 }) | null;
  pin: RepoConversationPin | null;
  createdAt: Date;
  /** The newest message's or run's time (a run's completion, else start, else queueing). */
  lastActivityAt: Date;
};

/** Read model of a project's chats: conversations whose Task has no work item. */
export type RepoConversationReader = {
  /** Newest first; `beforeConversationId` pages past that chat. */
  listByProject(
    projectId: UuidV7,
    filter: { beforeConversationId?: UuidV7 | undefined; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<RepoConversationRecord[]>;
  /** Null when the conversation isn't a chat. */
  loadByConversationId(
    conversationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<RepoConversationRecord | null>;
};
