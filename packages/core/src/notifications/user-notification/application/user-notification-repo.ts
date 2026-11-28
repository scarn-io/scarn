import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserNotificationEntity } from "../domain/user-notification-entity";
import type { UserNotificationStatus } from "../contracts/user-notification-contracts";

export type ListUserNotificationsFilter = {
  projectId: UuidV7;
  /** Only notifications addressed to this person or to the whole project. */
  viewerUserId: UuidV7;
  workItemId?: UuidV7;
  status?: UserNotificationStatus;
};

export interface UserNotificationRepo {
  create(
    entity: UserNotificationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<UserNotificationEntity>;
  load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<UserNotificationEntity | null>;
  list(
    filter: ListUserNotificationsFilter,
    dbExecutor?: DbExecutor,
  ): Promise<UserNotificationEntity[]>;
  updateStatus(
    id: UuidV7,
    status: UserNotificationStatus,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  save(entity: UserNotificationEntity, dbExecutor?: DbExecutor): Promise<void>;
  /**
   * Deletes the notifications about a Task or its conversation (`task_id`,
   * or `payload_json.conversationId`) and, by cascade, their deliveries.
   * Returns the number deleted.
   */
  deleteByTaskOrConversation(
    target: { projectId: UuidV7; taskId: UuidV7; conversationId: UuidV7 },
    dbExecutor?: DbExecutor,
  ): Promise<number>;
  /**
   * Deletes the project's notifications about the given Tasks (`task_id`)
   * and, by cascade, their deliveries. Returns the number deleted.
   */
  deleteByTaskIds(
    target: { projectId: UuidV7; taskIds: UuidV7[] },
    dbExecutor?: DbExecutor,
  ): Promise<number>;
  /** Deletes the project's notifications and, by cascade, their deliveries. */
  deleteByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
}
