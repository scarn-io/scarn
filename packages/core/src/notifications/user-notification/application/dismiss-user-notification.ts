import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { UserNotificationRepo } from "./user-notification-repo";

type DismissUserNotificationInput = {
  projectId: UuidV7;
  notificationId: UuidV7;
};

type DismissUserNotificationDeps = {
  userAuthz: UserAuthorizationService;
  userNotificationRepo: UserNotificationRepo;
};

export const dismissUserNotification = async (
  input: DismissUserNotificationInput,
  deps: DismissUserNotificationDeps,
): Promise<null> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "executions:write",
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

  await deps.userNotificationRepo.updateStatus(notification.id, "suppressed");
  return null;
};
