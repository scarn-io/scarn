import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { Result } from "@scarn/core/lib/result";
import type {
  ResourceNotFoundError,
  UsageLimitExceededError,
} from "@scarn/core/lib/errors";
import type { Logger } from "@scarn/observability/logging";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UsageMeterRepo } from "@scarn/core/billing/usage-meter/application/usage-meter-repo";
import { ensureUsageAllowed } from "@scarn/core/billing/usage-meter/application/ensure-usage-allowed";
import { LogArchiveRetrievedDomainEvent } from "@scarn/core/tasks/task-log/domain/log-archive-retrieved.domain-event";
import type { ArtifactBundleRepo } from "@scarn/core/tasks/task-artifact/application/artifact-bundle-repo";
import { isArtifactBundleExpired } from "@scarn/core/tasks/task-artifact/domain/artifact-bundle";
import type { ArtifactPreviewContract } from "../contracts/artifact-share-contracts";
import {
  ArtifactBundleNotShareableError,
  ArtifactSharingDisabledError,
} from "../domain/artifact-share";
import type { ArtifactSharingConfig } from "../domain/artifact-sharing-config";
import { buildPreviewToken, previewTokenExpiry } from "../domain/preview-token";
import {
  artifactBundleNotFound,
  loadProjectBundle,
  requireShareManagementPermission,
} from "./artifact-share-view";

export type CreateArtifactPreviewError =
  | ResourceNotFoundError
  | ArtifactSharingDisabledError
  | ArtifactBundleNotShareableError
  | UsageLimitExceededError;

/** The preview URL for a token: `${contentUrl}/p/<token>/`. */
export const artifactPreviewUrl = (contentUrl: string, token: string): string =>
  `${contentUrl}/p/${token}/`;

/**
 * Mint a 15-minute preview URL for a bundle on the content origin, so a
 * project member can open it in the dashboard without sharing it.
 *
 * Only members with `executions:read` may preview; a public project's
 * non-members are refused, as for share links (plan decision 8). The bundle
 * must be `ready` and unexpired, and sharing must be configured (decision
 * 14). Opening a preview counts as one read against the org's read cap: the
 * cap is checked (402 when over) and the read recorded here, at mint time,
 * the way a download URL is metered. Serving the preview's files then only
 * re-checks the token and the bundle, so one page with many assets is one
 * read, not one per file.
 */
export const createArtifactPreview = async (
  projectIdInput: string,
  bundleIdInput: string,
  deps: {
    userAuthz: UserAuthorizationService;
    artifactBundleRepo: ArtifactBundleRepo;
    artifactSharingConfig: ArtifactSharingConfig;
    timeProvider: TimeProvider;
    orgRepo?: OrgRepo | undefined;
    usageMeterRepo?: UsageMeterRepo | undefined;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ArtifactPreviewContract, CreateArtifactPreviewError>> => {
  const projectId = uuidV7Schema.parse(projectIdInput);
  const bundleId = uuidV7Schema.parse(bundleIdInput);
  const { artifactSharingConfig: config, dbExecutor } = deps;

  await requireShareManagementPermission(
    deps.userAuthz,
    projectId,
    "executions:read",
    dbExecutor,
  );

  if (!config.enabled || !config.contentUrl || !config.shareSecret) {
    return Result.err(new ArtifactSharingDisabledError());
  }

  const bundle = await loadProjectBundle(
    projectId,
    bundleId,
    deps.artifactBundleRepo,
    dbExecutor,
  );
  if (!bundle || bundle.deletedAt !== null) {
    return Result.err(artifactBundleNotFound(bundleId));
  }
  const now = deps.timeProvider.now();
  if (isArtifactBundleExpired(bundle, now)) {
    return Result.err(
      new ArtifactBundleNotShareableError(bundle.id, "expired"),
    );
  }
  if (bundle.status !== "ready") {
    return Result.err(
      new ArtifactBundleNotShareableError(bundle.id, "not_ready", {
        status: bundle.status,
      }),
    );
  }

  const org =
    deps.orgRepo && deps.usageMeterRepo
      ? await deps.orgRepo.findByProjectId(projectId, dbExecutor)
      : null;
  if (org && deps.usageMeterRepo) {
    const allowed = await ensureUsageAllowed(
      org.id,
      "read",
      {},
      {
        usageMeterRepo: deps.usageMeterRepo,
        timeProvider: deps.timeProvider,
        dbExecutor,
      },
    );
    if (!allowed.ok) {
      return Result.err(allowed.error);
    }
  }

  const expiry = previewTokenExpiry(now);
  const expiresAt = new Date(expiry.getTime() - (expiry.getTime() % 1000));
  const token = buildPreviewToken(config.shareSecret, {
    bundleId: bundle.id,
    userId: deps.userAuthz.actorId,
    exp: expiresAt,
  });

  if (org && deps.domainEventDispatcher) {
    const dispatcher = deps.domainEventDispatcher;
    try {
      await (dbExecutor ?? getDb()).transaction(async (tx) => {
        await dispatcher.publish(
          [
            new LogArchiveRetrievedDomainEvent({
              orgId: org.id,
              projectId,
              taskRunId: bundle.taskRunId,
            }),
          ],
          tx,
        );
      });
    } catch (error) {
      deps.logger?.error(
        { bundleId: bundle.id, error },
        "Failed to emit artifact-preview usage event",
      );
    }
  }

  return Result.ok({
    url: artifactPreviewUrl(config.contentUrl, token),
    expiresAt: expiresAt.toISOString(),
  });
};
