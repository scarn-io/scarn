import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { NotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-repo";
import type { UserNotificationContract } from "../../contracts/user-notification-contracts";
import type { UserNotificationRepo } from "../user-notification-repo";
import { userNotificationToContract } from "../user-notification-contract-mapper";
import { loadPendingCommentDraft } from "./load-pending-comment-draft";
import { recomputeAndPersistNotificationStatus } from "./recompute-and-persist-notification-status";

export type RejectCommentDraftInput = {
  notificationId: UuidV7;
};

export type RejectCommentDraftDeps = {
  userAuthz: UserAuthorizationService;
  userNotificationRepo: UserNotificationRepo;
  notificationDeliveryRepo: NotificationDeliveryRepo;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor;
};

/**
 * Discards a pending `work_item_platform_comment` draft without ever calling
 * out to GitHub. Marks the specific delivery row `"suppressed"` — the same
 * enum value used when a policy decision suppresses automatic delivery,
 * since a human "no, discard this" decision fits the same semantics — rather
 * than the whole notification, since one notification can have other,
 * unrelated channels (e.g. an already-`"sent"` `in_app` delivery) that must
 * not be clobbered (Decision 5). The notification's own `status` is then
 * recomputed from all of its deliveries via
 * `UserNotificationEntity.deriveStatus()`, the same way `approveCommentDraft`
 * does.
 */
export const rejectCommentDraft = async (
  input: RejectCommentDraftInput,
  deps: RejectCommentDraftDeps,
): Promise<UserNotificationContract> => {
  // Loaded before the permission check (no `:projectId` in this flat route's
  // URL) — the notification's own `projectId` is the authorization scope,
  // matching `approveCommentDraft`/`edit-work-item-comment.ts`'s "load first,
  // authorize against the loaded row" pattern.
  const { notification, delivery } = await loadPendingCommentDraft(
    input.notificationId,
    deps.userNotificationRepo,
    deps.notificationDeliveryRepo,
    deps.dbExecutor,
  );

  await deps.userAuthz.requireProjectPermission({
    projectId: notification.projectId,
    permission: "work-item-platform-comment:create",
    dbExecutor: deps.dbExecutor,
  });

  const suppressedDelivery = delivery.markSuppressed(null);
  await deps.notificationDeliveryRepo.save(suppressedDelivery, deps.dbExecutor);
  const derivedStatus = await recomputeAndPersistNotificationStatus(
    notification.id,
    deps.notificationDeliveryRepo,
    deps.userNotificationRepo,
    deps.dbExecutor,
  );

  // `recomputeAndPersistNotificationStatus` above already persisted the
  // notification's recomputed status via `updateStatus`; `withStatus` here is
  // purely a local, non-persisted shape used to return an up-to-date contract
  // without a second read-after-write round trip or a redundant `save`.
  const updated = notification.withStatus(
    derivedStatus,
    deps.timeProvider.now(),
  );

  return userNotificationToContract(updated);
};
