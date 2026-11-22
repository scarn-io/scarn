import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  notifyIntegrationAutoSyncPaused,
  type NotifyIntegrationAutoSyncPausedDeps,
} from "@scarn/core/notifications/user-notification/application/notify-integration-auto-sync-paused";
import type { SecretRepo } from "@scarn/core/secrets/secret/application/secret-repo";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type {
  AutoSyncPausedReason,
  ProjectIntegrationEntity,
} from "../domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "./project-integration-repo";

export type PauseIntegrationAutoSyncInput = {
  integrationId: UuidV7;
  /** The lent key that couldn't be used. */
  lentSecretId: UuidV7;
  reason: AutoSyncPausedReason;
  /** Shown to people; may name the key or a repo, never a key value or email. */
  detail?: string | null;
};

export type PauseIntegrationAutoSyncDeps = {
  projectIntegrationRepo: Pick<ProjectIntegrationRepo, "findById" | "save">;
  secretRepo: Pick<SecretRepo, "listSummariesByIds">;
  notifications: NotifyIntegrationAutoSyncPausedDeps;
  timeProvider: TimeProvider;
  logger?: Logger;
  /** The caller's transaction, if any; the pause and its notifications run in it. */
  dbExecutor?: DbExecutor;
};

/**
 * The one place Scarn pauses an integration's auto-sync because its lent key
 * can't be used: sets status `paused`, clears the key, saves the reason and
 * notifies the people who can fix it (see `notifyIntegrationAutoSyncPaused`),
 * all in one transaction. Does nothing when the integration is gone or no
 * longer lent `lentSecretId` (someone turned auto-sync off or lent another
 * key while the failing sync ran). Returns the paused integration, or null
 * when skipped.
 */
export const pauseIntegrationAutoSync = async (
  input: PauseIntegrationAutoSyncInput,
  deps: PauseIntegrationAutoSyncDeps,
): Promise<ProjectIntegrationEntity | null> => {
  const paused = await (deps.dbExecutor ?? getDb()).transaction(async (tx) => {
    const integration = await deps.projectIntegrationRepo.findById(
      input.integrationId,
      tx,
    );
    if (!integration || integration.syncSecretId !== input.lentSecretId) {
      return null;
    }

    const now = deps.timeProvider.now();
    const detail = input.detail ?? null;
    const saved = await deps.projectIntegrationRepo.save(
      integration.withAutoSyncPaused(input.reason, now, detail),
      tx,
    );
    const [keySummary] = await deps.secretRepo.listSummariesByIds(
      [input.lentSecretId],
      tx,
    );
    await notifyIntegrationAutoSyncPaused(
      {
        integration: saved,
        reason: input.reason,
        detail,
        keyOwnerUserId: keySummary?.ownerUserId ?? null,
        now,
      },
      deps.notifications,
      tx,
    );
    return saved;
  });

  if (paused) {
    (deps.logger ?? noopLogger).warn(
      {
        integrationId: paused.id,
        projectId: paused.projectId,
        kind: paused.kind,
        reason: input.reason,
      },
      "Paused project integration auto-sync",
    );
  }
  return paused;
};
