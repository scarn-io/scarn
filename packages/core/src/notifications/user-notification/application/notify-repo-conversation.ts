import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { NotificationPolicyService } from "@scarn/core/notifications/notification-policy/application/notification-policy-service";
import { dispatchNotificationDeliveries } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-dispatcher";
import { WORK_ITEM_PLATFORM_COMMENT_CHANNEL } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";
import { UserNotificationEntity } from "../domain/user-notification-entity";
import type { CreateUserNotificationsDeps } from "./create-user-notifications-from-task-result";

export type NotifyRepoConversationDeps = Pick<
  CreateUserNotificationsDeps,
  | "notificationRepo"
  | "deliveryRepo"
  | "notificationRuleRepo"
  | "adapterRegistry"
>;

/** A chat has no work item to comment on. */
export const NOT_APPLICABLE_WITHOUT_WORK_ITEM =
  "not_applicable_without_work_item";

/** What happened to the chat's turn: an answer is ready, or it failed for good. */
export type RepoConversationEvent = "answer_ready" | "failed";

const MESSAGES = {
  answer_ready: {
    kind: "result_ready",
    title: "Repo conversation answer ready",
    body: "Open the conversation to read the answer.",
  },
  failed: {
    kind: "warning",
    title: "Repo conversation failed",
    body: "The agent couldn't answer. Open the conversation to retry.",
  },
} as const;

export type NotifyRepoConversationInput = {
  event: RepoConversationEvent;
  projectId: UuidV7;
  taskId: UuidV7;
  conversationId: UuidV7;
  /** The chat's creator; nobody is notified when unknown. */
  recipientUserId: UuidV7 | null;
  now: Date;
};

/**
 * Tells a repo conversation's (chat's) creator, and nobody else, that its
 * answer is ready (`result_ready`) or that its turn failed after its retries
 * (`warning`). Title and body never carry the chat's content; the payload
 * names the conversation. Dispatched under the project's notification rules,
 * except that `work_item_platform_comment` is never applicable. Runs in the
 * caller's transaction.
 */
export const notifyRepoConversation = async (
  input: NotifyRepoConversationInput,
  deps: NotifyRepoConversationDeps,
  tx: DbExecutor,
): Promise<void> => {
  if (input.recipientUserId === null) {
    return;
  }
  const { kind, title, body } = MESSAGES[input.event];
  const decisions = (
    await new NotificationPolicyService(deps.notificationRuleRepo).evaluate(
      {
        projectId: input.projectId,
        kind,
        priority: "normal",
        suggestedChannels: [],
      },
      tx,
    )
  ).map((decision) =>
    decision.channel === WORK_ITEM_PLATFORM_COMMENT_CHANNEL
      ? {
          ...decision,
          allowed: false,
          suppressionReason: NOT_APPLICABLE_WITHOUT_WORK_ITEM,
        }
      : decision,
  );
  const notification = await deps.notificationRepo.create(
    UserNotificationEntity.create({
      projectId: input.projectId,
      workItemId: null,
      pipelineExecutionId: null,
      taskId: input.taskId,
      agentSessionId: null,
      recipientUserId: input.recipientUserId,
      kind,
      audience: "specific_users",
      title,
      body,
      priority: "normal",
      source: "system",
      payloadJson: { conversationId: input.conversationId },
      createdAt: input.now,
      updatedAt: input.now,
    }),
    tx,
  );
  await dispatchNotificationDeliveries(notification, decisions, deps, tx);
};
