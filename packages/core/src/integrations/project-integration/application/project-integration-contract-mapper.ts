import { assertNever } from "@scarn/core/lib/assert-never";
import type { ProjectIntegrationEntity } from "../domain/project-integration-entity";
import type { ProjectIntegrationContract } from "../contracts/project-integration-contracts";

export const projectIntegrationEntityToContract = (
  integration: ProjectIntegrationEntity,
  now: Date,
): ProjectIntegrationContract => {
  const base = {
    id: integration.id,
    projectId: integration.projectId,
    status: integration.status,
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
