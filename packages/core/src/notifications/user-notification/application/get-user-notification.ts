import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { NotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-repo";
import type { UserNotificationWithDeliveriesContract } from "../contracts/user-notification-contracts";
import type { UserNotificationRepo } from "./user-notification-repo";
import { userNotificationWithDeliveriesToContract } from "./user-notification-contract-mapper";

type GetUserNotificationInput = {
  projectId: UuidV7;
  notificationId: UuidV7;
};

type GetUserNotificationDeps = {
  userAuthz: UserAuthorizationService;
  userNotificationRepo: UserNotificationRepo;
  notificationDeliveryRepo: NotificationDeliveryRepo;
};

export const getUserNotification = async (
  input: GetUserNotificationInput,
  deps: GetUserNotificationDeps,
): Promise<UserNotificationWithDeliveriesContract> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "executions:read",
  });

  const notification = await deps.userNotificationRepo.load(
    input.notificationId,
  );

  if (
    !notification ||
    notification.projectId !== input.projectId ||
    !notification.isVisibleTo(deps.userAuthz.actorId)
  ) {
    throw new ResourceNotFoundError("User notification", input.notificationId);
  }

  const deliveries = await deps.notificationDeliveryRepo.listByNotificationId(
    notification.id,
  );

  return userNotificationWithDeliveriesToContract(notification, deliveries);
};
