import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  sendConversationMessageInputSchema,
  type SendConversationMessageInput,
} from "../contracts/conversation-contracts";
import type {
  ConversationEntity,
  ConversationStatus,
} from "../domain/conversation-entity";
import { ConversationMessageEntity } from "../domain/conversation-message-entity";
import type { ConversationRepo } from "./conversation-repo";

export type ConversationWriteDeps = {
  userAuthz: UserAuthorizationService;
  conversationRepo: ConversationRepo;
  timeProvider: TimeProvider;
};

export type SentConversationMessage = {
  conversation: ConversationEntity;
  message: ConversationMessageEntity;
  /** The status before this message; `waiting_for_person` means it queues the agent's next turn. */
  previousStatus: ConversationStatus;
};

/**
 * A person's message, accepted while the conversation waits for a person or
 * its reply is still pending (`CONVERSATION_NOT_WAITING` otherwise). Locks the
 * row, so it must run in a transaction. Needs `comments:write`.
 */
export const sendConversationMessage = async (
  input: SendConversationMessageInput,
  deps: ConversationWriteDeps,
  tx: DbExecutor,
): Promise<Result<SentConversationMessage, ResourceNotFoundError>> => {
  const parsed = sendConversationMessageInputSchema.parse(input);
  const conversation = await deps.conversationRepo.lock(
    parsed.conversationId,
    tx,
  );
  if (!conversation) {
    return Result.err(
      new ResourceNotFoundError("Conversation", parsed.conversationId),
    );
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: conversation.projectId,
    permission: "comments:write",
    dbExecutor: tx,
  });
  const now = deps.timeProvider.now();
  const accepted = conversation.acceptPersonMessage(now);
  const saved = await deps.conversationRepo.save(accepted, tx);
  const message = await deps.conversationRepo.insertMessage(
    ConversationMessageEntity.person({
      conversationId: conversation.id,
      authorUserId: deps.userAuthz.actorId,
      body: parsed.body,
      createdAt: now,
    }),
    tx,
  );
  return Result.ok({
    conversation: saved,
    message,
    previousStatus: conversation.status,
  });
};

/**
 * Records an action a person took without writing, while the conversation
 * waits for them: a `system` message, with the conversation's next status.
 * Locks the row, so it must run in a transaction. The caller checks
 * permissions.
 */
export const postConversationSystemMessage = async (
  conversation: ConversationEntity,
  body: string,
  next: (conversation: ConversationEntity, now: Date) => ConversationEntity,
  deps: Omit<ConversationWriteDeps, "userAuthz"> & { actorId: UuidV7 },
  tx: DbExecutor,
): Promise<ConversationEntity> => {
  conversation.assertWaitingForPerson();
  const now = deps.timeProvider.now();
  const saved = await deps.conversationRepo.save(next(conversation, now), tx);
  await deps.conversationRepo.insertMessage(
    ConversationMessageEntity.system({
      conversationId: conversation.id,
      authorUserId: deps.actorId,
      body,
      createdAt: now,
    }),
    tx,
  );
  return saved;
};

/**
 * Hands every undelivered person and system message to `taskRunId` and gives
 * the agent the floor (`agent_turn`). Locks the row, so a message sent while
 * this runs either makes it in or is refused afterwards. Returns the
 * delivered messages, oldest first; none when the conversation is missing or
 * not `reply_pending`.
 */
export const deliverPendingMessages = async (
  conversationId: UuidV7,
  taskRunId: UuidV7,
  deps: Pick<ConversationWriteDeps, "conversationRepo" | "timeProvider">,
  tx: DbExecutor,
): Promise<ConversationMessageEntity[]> => {
  const conversation = await deps.conversationRepo.lock(conversationId, tx);
  if (!conversation || conversation.status !== "reply_pending") {
    return [];
  }
  const pending = await deps.conversationRepo.listUndeliveredInbound(
    conversationId,
    tx,
  );
  await deps.conversationRepo.markDelivered(
    pending.map((message) => message.id),
    taskRunId,
    tx,
  );
  await deps.conversationRepo.save(
    conversation.deliver(deps.timeProvider.now()),
    tx,
  );
  return pending.map((message) =>
    ConversationMessageEntity.rehydrate({
      ...message.toJSON(),
      deliveredToTaskRunId: taskRunId,
    }),
  );
};
