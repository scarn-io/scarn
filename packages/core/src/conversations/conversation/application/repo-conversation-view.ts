import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type {
  UserDisplay,
  UsernameReader,
} from "@scarn/core/organizations/organization/application/username-reader";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import type { ProjectEntity } from "@scarn/core/projects/project/domain/project-entity";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  DEFAULT_PROJECT_CONVERSATIONS_LIMIT,
  listProjectConversationsQuerySchema,
  type ConversationContract,
  type ConversationCreatorContract,
  type ListProjectConversationsQueryInput,
  type ProjectConversationsPageContract,
} from "../contracts/conversation-contracts";
import {
  conversationPreview,
  displayRepository,
  repoConversationError,
  repoConversationState,
  shortCommit,
} from "../domain/repo-conversation-state";
import { conversationCapabilities } from "./conversation-capabilities";
import type {
  RepoConversationReader,
  RepoConversationRecord,
} from "./repo-conversation-reader";

export type RepoConversationViewDeps = {
  projectRepo: Pick<ProjectRepo, "load">;
  repoConversationReader: RepoConversationReader;
  usernameReader: UsernameReader;
  dbExecutor?: DbExecutor | undefined;
};

type ChatFields = Pick<
  ConversationContract,
  | "taskId"
  | "creator"
  | "context"
  | "state"
  | "latestRun"
  | "error"
  | "capabilities"
>;

const creatorOf = (
  userId: UuidV7 | null,
  usernames: Map<UuidV7, UserDisplay>,
): ConversationCreatorContract | null =>
  userId === null
    ? null
    : {
        userId,
        username: usernames.get(userId)?.username ?? null,
        image: usernames.get(userId)?.image ?? null,
      };

const stateOf = (record: RepoConversationRecord) =>
  repoConversationState({
    conversationStatus: record.conversationStatus,
    taskStatus: record.taskStatus,
    latestRunReason: record.latestRun?.reason ?? null,
  });

const chatFields = (
  record: RepoConversationRecord,
  project: ProjectEntity,
  viewerId: UuidV7,
  usernames: Map<UuidV7, UserDisplay>,
): ChatFields => {
  const state = stateOf(record);
  return {
    taskId: record.taskId,
    creator: creatorOf(record.startedByUserId, usernames),
    context: {
      kind: "project_repo",
      repository: displayRepository(project.gitUrl),
      branch: record.pin?.branch ?? null,
      commit: record.pin?.commit ?? null,
      pinnedAt: record.pin?.pinnedAt.toISOString() ?? null,
    },
    state,
    latestRun: record.latestRun
      ? {
          id: record.latestRun.id,
          status: record.latestRun.status,
          reason: record.latestRun.reason,
        }
      : null,
    error: state === "failed" ? repoConversationError(record.latestRun) : null,
    capabilities: conversationCapabilities(
      project,
      record.startedByUserId,
      viewerId,
    ),
  };
};

/**
 * Adds a chat's fields (Task, creator, repo context, derived state, latest
 * run, safe error and the viewer's capabilities) to its conversation. Any
 * other conversation is returned unchanged. Checks no permissions.
 */
export const withRepoConversationView = async (
  conversation: ConversationContract,
  viewerId: UuidV7,
  deps: RepoConversationViewDeps,
): Promise<ConversationContract> => {
  if (conversation.workItemId !== null) {
    return conversation;
  }
  const record = await deps.repoConversationReader.loadByConversationId(
    parseUuidV7(conversation.id),
    deps.dbExecutor,
  );
  const project = record
    ? await deps.projectRepo.load(record.projectId, deps.dbExecutor)
    : null;
  if (!record || !project) {
    return conversation;
  }
  const usernames = await deps.usernameReader.loadUsernamesByUserId(
    record.startedByUserId ? [record.startedByUserId] : [],
    deps.dbExecutor,
  );
  return {
    ...conversation,
    ...chatFields(record, project, viewerId, usernames),
  };
};

/** A project's chats, newest first, cursor-paged. Needs `executions:read`. */
export const listProjectConversations = async (
  projectIdInput: string,
  queryInput: ListProjectConversationsQueryInput,
  deps: RepoConversationViewDeps & { userAuthz: UserAuthorizationService },
): Promise<Result<ProjectConversationsPageContract, ResourceNotFoundError>> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(projectIdInput));
  const query = listProjectConversationsQuerySchema.parse(queryInput);
  const project = await deps.projectRepo.load(projectId, deps.dbExecutor);
  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }
  await deps.userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
    dbExecutor: deps.dbExecutor,
  });
  const limit = query.limit ?? DEFAULT_PROJECT_CONVERSATIONS_LIMIT;
  const records = await deps.repoConversationReader.listByProject(
    projectId,
    {
      beforeConversationId: query.before
        ? parseUuidV7(query.before)
        : undefined,
      limit: limit + 1,
    },
    deps.dbExecutor,
  );
  const page = records.slice(0, limit);
  const usernames = await deps.usernameReader.loadUsernamesByUserId(
    [
      ...new Set(
        page.flatMap((record) =>
          record.startedByUserId ? [record.startedByUserId] : [],
        ),
      ),
    ],
    deps.dbExecutor,
  );
  return Result.ok({
    conversations: page.map((record) => ({
      id: record.conversationId,
      taskId: record.taskId,
      preview: conversationPreview(record.firstMessageBody),
      creator: creatorOf(record.startedByUserId, usernames),
      state: stateOf(record),
      lastActivityAt: record.lastActivityAt.toISOString(),
      shortCommit: shortCommit(record.pin?.commit ?? null),
      createdAt: record.createdAt.toISOString(),
    })),
    nextCursor:
      records.length > limit ? (page.at(-1)?.conversationId ?? null) : null,
  });
};
