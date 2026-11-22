import { assertNever } from "@scarn/core/lib/assert-never";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  supportsAutoSync,
  type ProjectIntegrationEntity,
} from "../domain/project-integration-entity";
import type {
  AutoSyncSyncsAsContract,
  ProjectIntegrationAutoSyncContract,
  ProjectIntegrationContract,
} from "../contracts/project-integration-contracts";

/** Who each lent key (by secret id) syncs as. See `loadAutoSyncDisplay`. */
export type AutoSyncDisplayBySecretId = ReadonlyMap<
  UuidV7,
  AutoSyncSyncsAsContract
>;

const EMPTY_AUTO_SYNC_DISPLAY: AutoSyncDisplayBySecretId = new Map();

const toAutoSyncContract = (
  integration: ProjectIntegrationEntity,
  display: AutoSyncDisplayBySecretId,
): ProjectIntegrationAutoSyncContract => {
  const state = integration.syncSecretId
    ? "on"
    : integration.autoSyncPausedReason
      ? "paused"
      : "off";
  const syncsAs = integration.syncSecretId
    ? (display.get(integration.syncSecretId) ?? null)
    : null;
  return {
    supported: supportsAutoSync(integration),
    state,
    syncsAs: syncsAs
      ? {
          userId: syncsAs.userId,
          displayName: syncsAs.displayName,
          secretName: syncsAs.secretName,
        }
      : null,
    pausedReason: integration.autoSyncPausedReason,
    pausedDetail: integration.autoSyncPausedDetail,
    pausedAt: integration.autoSyncPausedAt?.toISOString() ?? null,
  };
};

export const projectIntegrationEntityToContract = (
  integration: ProjectIntegrationEntity,
  now: Date,
  autoSyncDisplay: AutoSyncDisplayBySecretId = EMPTY_AUTO_SYNC_DISPLAY,
): ProjectIntegrationContract => {
  const base = {
    id: integration.id,
    projectId: integration.projectId,
    status: integration.status,
    autoSync: toAutoSyncContract(integration, autoSyncDisplay),
    lastSyncedAt: integration.lastSyncedAt
      ? integration.lastSyncedAt.toISOString()
      : null,
    lastError: integration.lastError,
    firstSyncHorizonDays: integration.firstSyncHorizonDays,
    createdAt: (integration.createdAt ?? now).toISOString(),
    updatedAt: (integration.updatedAt ?? now).toISOString(),
  };
  switch (integration.kind) {
    case "github_app":
      return {
        ...base,
        kind: integration.kind,
        platform: integration.platform,
        authMode: integration.authMode,
        installationId: integration.installationId,
        externalScope: { repos: integration.scope.repos },
      };
    case "github_token":
      return {
        ...base,
        kind: integration.kind,
        platform: integration.platform,
        authMode: integration.authMode,
        externalScope: { repos: integration.scope.repos },
      };
    case "bitbucket":
      return {
        ...base,
        kind: integration.kind,
        platform: integration.platform,
        authMode: integration.authMode,
        externalScope: { repos: integration.scope.repos },
      };
    case "jira":
      return {
        ...base,
        kind: integration.kind,
        platform: integration.platform,
        authMode: integration.authMode,
        externalScope: integration.scope,
      };
    default:
      return assertNever(integration);
  }
};
