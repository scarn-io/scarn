import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  NOTIFICATION_SIGNAL_KEY,
  parseNotificationSignalItems,
} from "../contracts/notification-signal-contracts";
import { NotificationPolicyService } from "@scarn/core/notifications/notification-policy/application/notification-policy-service";
import type { NotificationRuleRepo } from "@scarn/core/notifications/notification-policy/application/notification-rule-repo";
import {
  dispatchNotificationDeliveries,
  type DispatchChannelDecision,
} from "@scarn/core/notifications/notification-delivery/application/notification-delivery-dispatcher";
import type { CommentArtifactReader } from "@scarn/core/notifications/comment-artifacts/application/comment-artifact-reader";
import {
  ARTIFACT_UNAVAILABLE_SUPPRESSION_REASON,
  prepareCommentDraftArtifacts,
} from "@scarn/core/notifications/comment-artifacts/application/prepare-comment-draft-artifacts";
import type { NotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-repo";
import type { NotificationChannelAdapterRegistry } from "@scarn/core/notifications/notification-delivery/application/notification-channel-adapter";
import {
  WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
  type NotificationChannel,
} from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";
import { UserNotificationEntity } from "../domain/user-notification-entity";
import type { UserNotificationRepo } from "./user-notification-repo";
import type { NotificationProvenanceReader } from "./notification-provenance-reader";

const VALID_CHANNELS: ReadonlySet<NotificationChannel> = new Set([
  "in_app",
  "work_item_platform_comment",
  "email",
  "slack",
]);

const sanitizeChannels = (
  channels: readonly string[] | undefined,
): NotificationChannel[] =>
  (channels ?? []).filter((c): c is NotificationChannel =>
    VALID_CHANNELS.has(c as NotificationChannel),
  );

export type CreateUserNotificationsDeps = {
  notificationRepo: UserNotificationRepo;
  deliveryRepo: NotificationDeliveryRepo;
  notificationRuleRepo: NotificationRuleRepo;
  adapterRegistry: NotificationChannelAdapterRegistry;
  provenanceReader: NotificationProvenanceReader;
  commentArtifactReader: CommentArtifactReader;
};

const readNotificationItems = (resultJson: AnyJsonValue | null) => {
  if (
    resultJson === null ||
    typeof resultJson !== "object" ||
    Array.isArray(resultJson)
  ) {
    return undefined;
  }
  const value = resultJson[NOTIFICATION_SIGNAL_KEY];
  return value === undefined ? undefined : parseNotificationSignalItems(value);
};

/**
 * Creates the user notifications a completed Task's result asks for under
 * `$scarn_notifications_v1`, and dispatches their deliveries. Called by
 * `completeClaimedTaskRun` in its transaction, for standalone and pipeline Tasks.
 */
export const createUserNotificationsFromTaskResult = async (
  task: { id: UuidV7; resultJson: AnyJsonValue | null },
  deps: CreateUserNotificationsDeps,
  tx: DbExecutor,
): Promise<void> => {
  const items = readNotificationItems(task.resultJson);
  if (!items || items.length === 0) return;

  const provenance = await deps.provenanceReader.resolveFromTaskRun(
    task.id,
    tx,
  );
  if (!provenance) return;

  const policyService = new NotificationPolicyService(
    deps.notificationRuleRepo,
  );

  const now = new Date();

  for (const item of items) {
    const sanitized = sanitizeChannels(item.suggestedChannels);
    const wantsPlatformComment = sanitized.includes(
      WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
    );

    const prepared = wantsPlatformComment
      ? await prepareCommentDraftArtifacts(
          item.body,
          { pipelineRunId: provenance.pipelineExecutionId },
          {
            commentArtifactReader: deps.commentArtifactReader,
            dbExecutor: tx,
          },
        )
      : null;
    const body = prepared?.status === "ready" ? prepared.body : item.body;
    const payloadJson =
      prepared?.status === "suppressed"
        ? {
            ...(item.payload ?? {}),
            commentSuppressed: prepared.commentSuppressed,
          }
        : (item.payload ?? null);

    const notification = await deps.notificationRepo.create(
      UserNotificationEntity.create({
        projectId: provenance.projectId,
        workItemId: provenance.workItemId,
        pipelineExecutionId: provenance.pipelineExecutionId,
        taskId: provenance.taskId,
        agentSessionId: null,
        recipientUserId: null,
        kind: item.kind,
        // Agent-sourced notifications default to assignee audience; richer
        // resolution is deferred until per-user fan-out is built.
        audience: "assignee",
        // TODO(Phase 6): `title` is still optional on `NotificationSignalItem`
        // until the SDK's title-less comment_draft schema is removed; until
        // then, fall back to `body` (equivalent to today's pre-Phase-3
        // behavior for kinds that omit a title).
        title: item.title ?? body,
        body,
        priority: item.priority,
        source: "agent",
        payloadJson,
        createdAt: now,
        updatedAt: now,
      }),
      tx,
    );

    const decisions: DispatchChannelDecision[] = await policyService.evaluate(
      {
        projectId: provenance.projectId,
        kind: item.kind,
        priority: item.priority,
        suggestedChannels: sanitized.filter(
          (c) => c !== WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
        ),
      },
      tx,
    );

    // `work_item_platform_comment` unconditionally bypasses policy
    // evaluation for every kind — there is still no automatic delivery
    // implementation for this channel, so it's diverted to a pending,
    // human-reviewed draft instead (see
    // `docs/plans/route-comment-drafts-by-channel.md`, Decisions 1/3/10).
    if (prepared?.status === "suppressed") {
      decisions.push({
        channel: WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
        allowed: false,
        suppressionReason: ARTIFACT_UNAVAILABLE_SUPPRESSION_REASON,
      });
    } else if (prepared) {
      decisions.push({
        channel: WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
        allowed: true,
        suppressionReason: null,
        artifactResolutionJson: prepared.artifactResolutionJson,
      });
    }

    await dispatchNotificationDeliveries(
      notification,
      decisions,
      {
        notificationRepo: deps.notificationRepo,
        deliveryRepo: deps.deliveryRepo,
        adapterRegistry: deps.adapterRegistry,
      },
      tx,
    );
  }
};
