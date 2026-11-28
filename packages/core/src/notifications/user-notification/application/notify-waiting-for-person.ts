import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { NotificationPolicyService } from "@scarn/core/notifications/notification-policy/application/notification-policy-service";
import { dispatchNotificationDeliveries } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-dispatcher";
import { UserNotificationEntity } from "../domain/user-notification-entity";
import type { CreateUserNotificationsDeps } from "./create-user-notifications-from-task-result";

export type NotifyWaitingForPersonDeps = Pick<
  CreateUserNotificationsDeps,
  | "notificationRepo"
  | "deliveryRepo"
  | "notificationRuleRepo"
  | "adapterRegistry"
>;

/** What Scarn is waiting on: an agent's message in a conversation, or a question comment. */
export type WaitingSubject =
  | { conversationId: UuidV7; source: "agent" }
  | { questionId: UuidV7; source: "system" };

export type NotifyWaitingForPersonInput = {
  projectId: UuidV7;
  workItemId: UuidV7 | null;
  workItemTitle: string | null;
  pipelineExecutionId: UuidV7 | null;
  /** The attempt that wrote the message; null for a question, which no Task wrote. */
  taskId: UuidV7 | null;
  body: string;
  subject: WaitingSubject;
  /** The agent's pending grant request, when it asks for more access. */
  grantRequestId?: UuidV7 | null | undefined;
  /**
   * Deduplicated; one notification each. Empty when nobody is known, which
   * files one notification for the whole project instead.
   */
  recipientUserIds: readonly UuidV7[];
  now: Date;
};

/**
 * Creates the `feedback_request` notifications telling people Scarn waits
 * on them, one per recipient, and dispatches each under the project's
 * notification rules. Runs in the caller's transaction, like
 * `createUserNotificationsFromTaskResult`.
 */
export const notifyWaitingForPerson = async (
  input: NotifyWaitingForPersonInput,
  deps: NotifyWaitingForPersonDeps,
  tx: DbExecutor,
): Promise<void> => {
  const uniqueRecipients = [...new Set(input.recipientUserIds)];
  const recipients: (UuidV7 | null)[] =
    uniqueRecipients.length > 0 ? uniqueRecipients : [null];
  const { source, ...subjectIds } = input.subject;
  const decisions = await new NotificationPolicyService(
    deps.notificationRuleRepo,
  ).evaluate(
    {
      projectId: input.projectId,
      kind: "feedback_request",
      priority: "normal",
      suggestedChannels: [],
    },
    tx,
  );

  for (const recipientUserId of recipients) {
    const notification = await deps.notificationRepo.create(
      UserNotificationEntity.create({
        projectId: input.projectId,
        workItemId: input.workItemId,
        pipelineExecutionId: input.pipelineExecutionId,
        taskId: input.taskId,
        agentSessionId: null,
        recipientUserId,
        kind: "feedback_request",
        audience: "specific_users",
        title: input.workItemTitle
          ? `Scarn is waiting on you in ${input.workItemTitle}`
          : "Scarn is waiting on you",
        body: input.body,
        priority: "normal",
        source,
        payloadJson: input.grantRequestId
          ? { ...subjectIds, grantRequestId: input.grantRequestId }
          : subjectIds,
        createdAt: input.now,
        updatedAt: input.now,
      }),
      tx,
    );
    await dispatchNotificationDeliveries(notification, decisions, deps, tx);
  }
};
