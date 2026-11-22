import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { UserNotificationContract } from "../contracts/user-notification-contracts";
import type { UserNotificationRepo } from "./user-notification-repo";
import { userNotificationToContract } from "./user-notification-contract-mapper";

type RespondToFeedbackRequestInput = {
  projectId: UuidV7;
  notificationId: UuidV7;
  answer: string;
};

type RespondToFeedbackRequestDeps = {
  userAuthz: UserAuthorizationService;
  userNotificationRepo: UserNotificationRepo;
};

/**
 * Records a human answer to a `feedback_request` notification. The answer is
 * stored in the notification payload under `response`, and the notification is
 * marked delivered (its lifecycle is complete from the user's perspective).
 */
export const respondToFeedbackRequest = async (
  input: RespondToFeedbackRequestInput,
  deps: RespondToFeedbackRequestDeps,
): Promise<UserNotificationContract> => {
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

  if (notification.kind !== "feedback_request") {
    throw new CoreValidationError(
      "Only feedback_request notifications can be responded to",
      "NOTIFICATION_KIND_NOT_RESPONDABLE",
    );
  }

  const now = new Date();
  const payload: AnyJsonObject = {
    ...(notification.payloadJson ?? {}),
    response: {
      answer: input.answer,
      respondedAt: now.toISOString(),
      respondedBy: deps.userAuthz.actorId,
    },
  };

  const updated = notification.withPayload(payload, now);
  await deps.userNotificationRepo.save(updated);

  return userNotificationToContract(updated);
};
