import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { PipelineGraphVersionRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-version-repo";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { ConversationRepo } from "@scarn/core/conversations/conversation/application/conversation-repo";
import {
  conversationIdParamsSchema,
  type ConversationContract,
  type ConversationMessageContract,
  type WorkItemConversationContract,
} from "@scarn/core/conversations/conversation/contracts/conversation-contracts";
import type { ConversationMessageEntity } from "@scarn/core/conversations/conversation/domain/conversation-message-entity";
import {
  withRepoConversationView,
  type RepoConversationViewDeps,
} from "@scarn/core/conversations/conversation/application/repo-conversation-view";
import type { PipelineRunRepo } from "./pipeline-run-repo";
import { stepDefinitionForNode } from "./step-definition-for-node";

export type ConversationReadDeps = {
  conversationRepo: ConversationRepo;
  pipelineRunRepo: PipelineRunRepo;
  pipelineGraphVersionRepo: PipelineGraphVersionRepo;
  stepDefinitionRepo: StepDefinitionRepo;
  usernameReader: UsernameReader;
  dbExecutor?: DbExecutor | undefined;
};

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

const messageContract = (
  message: ConversationMessageEntity,
  usernames: Awaited<ReturnType<UsernameReader["loadUsernamesByUserId"]>>,
): ConversationMessageContract => ({
  id: message.id,
  authorKind: message.authorKind,
  authorName: message.authorUserId
    ? (usernames.get(message.authorUserId)?.username ?? null)
    : null,
  taskRunId: message.taskRunId,
  grantRequestId: message.grantRequestId,
  body: message.body,
  createdAt: (message.createdAt ?? new Date(0)).toISOString(),
});

/**
 * A conversation as the API shows it, with the step visit it belongs to.
 * Checks no permissions: the callers do.
 */
export const loadConversation = async (
  conversationId: UuidV7,
  deps: ConversationReadDeps,
): Promise<Result<ConversationContract, ResourceNotFoundError>> => {
  const conversation = await deps.conversationRepo.load(
    conversationId,
    deps.dbExecutor,
  );
  if (!conversation) {
    return Result.err(
      new ResourceNotFoundError("Conversation", conversationId),
    );
  }
  const [messages, visit] = await Promise.all([
    deps.conversationRepo.listMessages(conversationId, deps.dbExecutor),
    deps.pipelineRunRepo.findVisitByConversationId(
      conversationId,
      deps.dbExecutor,
    ),
  ]);
  const [usernames, stepDefinition] = await Promise.all([
    deps.usernameReader.loadUsernamesByUserId(
      messages.flatMap((message) =>
        message.authorUserId ? [message.authorUserId] : [],
      ),
      deps.dbExecutor,
    ),
    visit ? stepDefinitionForNode(visit, deps, deps.dbExecutor) : null,
  ]);
  return Result.ok({
    id: conversation.id,
    projectId: conversation.projectId,
    workItemId: conversation.workItemId,
    status: conversation.status,
    messages: messages.map((message) => messageContract(message, usernames)),
    visit: visit
      ? {
          pipelineExecutionId: visit.pipelineRunId,
          visitId: visit.visitId,
          nodeId: visit.nodeId,
        }
      : null,
    endsWith: stepDefinition
      ? stepDefinition.resultSchemaJson === null
        ? "conversation"
        : "findings"
      : null,
    createdAt: (conversation.createdAt ?? new Date(0)).toISOString(),
    closedAt: iso(conversation.closedAt),
  });
};

/**
 * `loadConversation` with a chat's fields as `viewerId` sees them (see
 * `withRepoConversationView`). Checks no permissions.
 */
export const loadConversationFor = async (
  conversationId: UuidV7,
  viewerId: UuidV7,
  deps: ConversationReadDeps & RepoConversationViewDeps,
): Promise<Result<ConversationContract, ResourceNotFoundError>> => {
  const loaded = await loadConversation(conversationId, deps);
  return loaded.ok
    ? Result.ok(await withRepoConversationView(loaded.value, viewerId, deps))
    : loaded;
};

/**
 * One conversation, with its messages oldest first, and a chat's fields.
 * Needs `executions:read`.
 */
export const getConversation = async (
  input: { conversationId: string },
  deps: ConversationReadDeps &
    RepoConversationViewDeps & { userAuthz: UserAuthorizationService },
): Promise<Result<ConversationContract, ResourceNotFoundError>> => {
  const conversationId = parseUuidV7(
    conversationIdParamsSchema.parse(input).conversationId,
  );
  const conversation = await deps.conversationRepo.load(
    conversationId,
    deps.dbExecutor,
  );
  if (!conversation) {
    return Result.err(
      new ResourceNotFoundError("Conversation", conversationId),
    );
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: conversation.projectId,
    permission: "executions:read",
    dbExecutor: deps.dbExecutor,
  });
  return await loadConversationFor(
    conversationId,
    deps.userAuthz.actorId,
    deps,
  );
};

/**
 * A work item's conversations, newest first, with the step visit each
 * belongs to and its messages oldest first. Needs `executions:read`.
 */
export const listWorkItemConversations = async (
  workItemIdInput: string,
  deps: ConversationReadDeps & {
    userAuthz: UserAuthorizationService;
    workItemRepo: WorkItemRepo;
  },
): Promise<Result<WorkItemConversationContract[], ResourceNotFoundError>> => {
  const workItemId = parseWorkItemId(workItemIdInput);
  const workItem = await deps.workItemRepo.load(workItemId, deps.dbExecutor);
  if (!workItem) {
    return Result.err(new ResourceNotFoundError("Work item", workItemId));
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "executions:read",
    dbExecutor: deps.dbExecutor,
  });
  const summaries = await deps.conversationRepo.listByWorkItemId(
    parseUuidV7(workItemId),
    deps.dbExecutor,
  );
  const [visits, messages] = await Promise.all([
    Promise.all(
      summaries.map(({ conversation }) =>
        deps.pipelineRunRepo.findVisitByConversationId(
          conversation.id,
          deps.dbExecutor,
        ),
      ),
    ),
    deps.conversationRepo.listMessagesByConversationIds(
      summaries.map(({ conversation }) => conversation.id),
      deps.dbExecutor,
    ),
  ]);
  const usernames = await deps.usernameReader.loadUsernamesByUserId(
    [
      ...new Set(
        messages.flatMap((message) =>
          message.authorUserId ? [message.authorUserId] : [],
        ),
      ),
    ],
    deps.dbExecutor,
  );
  const messagesByConversation = new Map<UuidV7, ConversationMessageEntity[]>();
  for (const message of messages) {
    const list = messagesByConversation.get(message.conversationId) ?? [];
    list.push(message);
    messagesByConversation.set(message.conversationId, list);
  }
  return Result.ok(
    summaries.map(({ conversation, lastMessageAt }, index) => {
      const visit = visits[index] ?? null;
      return {
        id: conversation.id,
        status: conversation.status,
        nodeId: visit?.nodeId ?? null,
        pipelineExecutionId: visit?.pipelineRunId ?? null,
        visitId: visit?.visitId ?? null,
        lastMessageAt: iso(lastMessageAt),
        messages: (messagesByConversation.get(conversation.id) ?? []).map(
          (message) => messageContract(message, usernames),
        ),
        createdAt: (conversation.createdAt ?? new Date(0)).toISOString(),
      };
    }),
  );
};
