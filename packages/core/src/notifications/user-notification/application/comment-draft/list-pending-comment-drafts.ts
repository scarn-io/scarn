import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { NotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-repo";
import {
  commentDraftArtifactResolutionSchema,
  type CommentDraftArtifactResolutionContract,
  type UserNotificationContract,
} from "../../contracts/user-notification-contracts";
import { userNotificationToContract } from "../user-notification-contract-mapper";

export type ListPendingCommentDraftsInput = {
  workItemId: UuidV7;
};

export type ListPendingCommentDraftsDeps = {
  userAuthz: UserAuthorizationService;
  notificationDeliveryRepo: NotificationDeliveryRepo;
  workItemRepo: WorkItemRepo;
  dbExecutor?: DbExecutor;
};

export type PendingCommentDraft = {
  notification: UserNotificationContract;
  lastError: string | null;
  artifactResolution: CommentDraftArtifactResolutionContract | null;
};

const toArtifactResolution = (
  json: AnyJsonObject | null,
): CommentDraftArtifactResolutionContract | null => {
  if (json === null) {
    return null;
  }
  const parsed = commentDraftArtifactResolutionSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
};

/**
 * Pending `work_item_platform_comment` drafts for a work item, each paired
 * with its last delivery error (if the most recent approve attempt failed)
 * so the UI can surface it inline next to the still-actionable draft, and
 * the draft-time artifact marker resolution so the UI can preview markers
 * and list what was left out.
 *
 * Starts from `notification_deliveries` (Decision 12) via a single join, not
 * from `user_notifications` filtered by kind — the delivery row, not the
 * notification's kind, is what makes something a "draft," and this avoids an
 * N+1 per-notification delivery lookup.
 *
 * Visibility is gated by `comments:read` (the same permission as the rest of
 * the comment thread), not `work-item-platform-comment:create` — reading the
 * list of pending drafts is a read concern; the UI separately gates the
 * Approve/Reject action buttons behind the create permission.
 */
export const listPendingCommentDrafts = async (
  input: ListPendingCommentDraftsInput,
  deps: ListPendingCommentDraftsDeps,
): Promise<PendingCommentDraft[]> => {
  const workItemId = parseWorkItemId(input.workItemId);

  const workItem = await deps.workItemRepo.load(workItemId, deps.dbExecutor);
  if (!workItem) {
    throw new ResourceNotFoundError("Work item", workItemId);
  }

  await deps.userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "comments:read",
    dbExecutor: deps.dbExecutor,
  });

  const drafts =
    await deps.notificationDeliveryRepo.listPendingWorkItemPlatformCommentDrafts(
      parseUuidV7(workItemId),
      deps.dbExecutor,
    );

  return drafts.map(({ delivery, notification }) => ({
    notification: userNotificationToContract(notification),
    lastError: delivery.status === "failed" ? delivery.suppressionReason : null,
    artifactResolution: toArtifactResolution(delivery.artifactResolutionJson),
  }));
};
