import type { UuidV7 } from "@/common/contracts/uuid-v7";
import type { DbExecutor } from "@/lib/db/db-executor";
import type { NotifyIntegrationAutoSyncPausedDeps } from "@/notifications/user-notification/application/notify-integration-auto-sync-paused";
import type { UserNotificationEntity } from "@/notifications/user-notification/domain/user-notification-entity";
import type { ProjectRepo } from "@/projects/project/application/project-repo";

/** A `DbExecutor` whose `transaction` runs the callback with a dummy tx. */
export const fakeDbExecutor = (): DbExecutor =>
  ({
    transaction: <T>(run: (tx: DbExecutor) => Promise<T>) =>
      run({} as DbExecutor),
  }) as unknown as DbExecutor;

/**
 * In-memory deps for `notifyIntegrationAutoSyncPaused`: no notification
 * rules (so in-app only), no channel adapters, and every created
 * notification kept in `created`.
 */
export const fakeAutoSyncPausedNotifications = (
  projectRepo: Pick<ProjectRepo, "load">,
  usernames: ReadonlyMap<UuidV7, string> = new Map(),
) => {
  const created: UserNotificationEntity[] = [];
  const deps = {
    notificationRepo: {
      create: (notification: UserNotificationEntity) => {
        created.push(notification);
        return Promise.resolve(notification);
      },
      updateStatus: () => Promise.resolve(),
    },
    notificationRuleRepo: { listByProjectId: () => Promise.resolve([]) },
    deliveryRepo: {
      create: <T>(delivery: T) => Promise.resolve(delivery),
      save: <T>(delivery: T) => Promise.resolve(delivery),
    },
    adapterRegistry: { get: () => undefined },
    projectRepo,
    usernameReader: {
      loadUsernamesByUserId: (ids: readonly UuidV7[]) =>
        Promise.resolve(
          new Map(
            ids.flatMap((id) => {
              const username = usernames.get(id);
              return username === undefined
                ? []
                : [[id, { username, image: null }] as const];
            }),
          ),
        ),
    },
  } as unknown as NotifyIntegrationAutoSyncPausedDeps;
  return { deps, created };
};
