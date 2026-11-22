import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type {
  UserNotificationContract,
  UserNotificationStatus,
} from "../contracts/user-notification-contracts";
import type { UserNotificationRepo } from "./user-notification-repo";
import { userNotificationToContract } from "./user-notification-contract-mapper";

type ListUserNotificationsInput = {
  projectId: UuidV7;
  workItemId?: UuidV7;
  status?: UserNotificationStatus;
};

type ListUserNotificationsDeps = {
  userAuthz: UserAuthorizationService;
  userNotificationRepo: UserNotificationRepo;
};

/** The project's notifications the caller sees: their own and the project-wide ones, newest first. */
export const listUserNotifications = async (
  input: ListUserNotificationsInput,
  deps: ListUserNotificationsDeps,
): Promise<UserNotificationContract[]> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "executions:read",
  });

  const entities = await deps.userNotificationRepo.list({
    projectId: input.projectId,
    viewerUserId: deps.userAuthz.actorId,
    workItemId: input.workItemId,
    status: input.status,
  });

  return entities.map(userNotificationToContract);
};
