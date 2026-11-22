import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { SecretUseContract } from "../contracts/secret-contracts";

export type LoadSecretUsesDeps = {
  projectIntegrationRepo: Pick<ProjectIntegrationRepo, "listBySyncSecretIds">;
  projectRepo: Pick<ProjectRepo, "loadMany">;
};

/**
 * The project integrations each secret is lent to for auto-sync, keyed by
 * secret ID. Secrets lent nowhere map to an empty list. Two queries total,
 * however many secrets.
 */
export const loadSecretUses = async (
  secretIds: UuidV7[],
  deps: LoadSecretUsesDeps,
  dbExecutor?: DbExecutor,
): Promise<Map<UuidV7, SecretUseContract[]>> => {
  const uses = new Map<UuidV7, SecretUseContract[]>(
    secretIds.map((id) => [id, []]),
  );
  const integrations = await deps.projectIntegrationRepo.listBySyncSecretIds(
    secretIds,
    dbExecutor,
  );
  if (integrations.length === 0) {
    return uses;
  }
  const projects = await deps.projectRepo.loadMany(
    [...new Set(integrations.map((integration) => integration.projectId))],
    dbExecutor,
  );
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  for (const integration of integrations) {
    const secretId = integration.syncSecretId;
    const projectName = projectNames.get(integration.projectId);
    if (secretId === null || projectName === undefined) {
      continue;
    }
    uses.get(secretId)?.push({
      projectId: integration.projectId,
      projectName,
      integrationId: integration.id,
      platform: integration.platform,
    });
  }
  return uses;
};
