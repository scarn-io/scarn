import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type {
  AutoSyncPausedReason,
  ProjectIntegrationEntity,
} from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import { NotificationPolicyService } from "@scarn/core/notifications/notification-policy/application/notification-policy-service";
import { dispatchNotificationDeliveries } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-dispatcher";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { hasProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import { UserNotificationEntity } from "../domain/user-notification-entity";
import {
  autoSyncPausedMessage,
  integrationDisplayName,
} from "./auto-sync-paused-message";
import type { CreateUserNotificationsDeps } from "./create-user-notifications-from-task-result";

export type NotifyIntegrationAutoSyncPausedDeps = Pick<
  CreateUserNotificationsDeps,
  | "notificationRepo"
  | "deliveryRepo"
  | "notificationRuleRepo"
  | "adapterRegistry"
> & {
  projectRepo: Pick<ProjectRepo, "load">;
  usernameReader: UsernameReader;
};

export type NotifyIntegrationAutoSyncPausedInput = {
  integration: ProjectIntegrationEntity;
  reason: AutoSyncPausedReason;
  detail: string | null;
  /** Owner of the key that couldn't be used; null when the key is gone. */
  keyOwnerUserId: UuidV7 | null;
  now: Date;
};

const KIND = "integration_auto_sync_paused";
const PRIORITY = "high";

/**
 * Tells the project's members with `work-items:write`, plus the key's owner
 * (even after they left the project), that Scarn paused an integration's
 * auto-sync, one `integration_auto_sync_paused` notification each,
 * dispatched under the project's notification rules. Runs in the caller's
 * transaction.
 */
export const notifyIntegrationAutoSyncPaused = async (
  input: NotifyIntegrationAutoSyncPausedInput,
  deps: NotifyIntegrationAutoSyncPausedDeps,
  tx: DbExecutor,
): Promise<void> => {
  const { integration } = input;
  const project = await deps.projectRepo.load(integration.projectId, tx);
  const writers = (project?.memberships ?? [])
    .filter((membership) =>
      hasProjectPermission(membership.permissions, "work-items:write"),
    )
    .map((membership) => membership.userId);
  const recipients = [
    ...new Set(
      input.keyOwnerUserId === null
        ? writers
        : [...writers, input.keyOwnerUserId],
    ),
  ];
  if (recipients.length === 0) return;

  const ownerName =
    input.keyOwnerUserId === null
      ? null
      : ((
          await deps.usernameReader.loadUsernamesByUserId(
            [input.keyOwnerUserId],
            tx,
          )
        ).get(input.keyOwnerUserId)?.username ?? null);
  const { title, body } = autoSyncPausedMessage({
    integrationName: integrationDisplayName(integration),
    ownerName,
    reason: input.reason,
    detail: input.detail,
  });
  const decisions = await new NotificationPolicyService(
    deps.notificationRuleRepo,
  ).evaluate(
    {
      projectId: integration.projectId,
      kind: KIND,
      priority: PRIORITY,
      suggestedChannels: [],
    },
    tx,
  );

  for (const recipientUserId of recipients) {
    const notification = await deps.notificationRepo.create(
      UserNotificationEntity.create({
        projectId: integration.projectId,
        workItemId: null,
        pipelineExecutionId: null,
        taskId: null,
        agentSessionId: null,
        recipientUserId,
        kind: KIND,
        audience: "specific_users",
        title,
        body,
        priority: PRIORITY,
        source: "system",
        payloadJson: {
          integrationId: integration.id,
          reason: input.reason,
          detail: input.detail,
        },
        createdAt: input.now,
        updatedAt: input.now,
      }),
      tx,
    );
    await dispatchNotificationDeliveries(notification, decisions, deps, tx);
  }
};
