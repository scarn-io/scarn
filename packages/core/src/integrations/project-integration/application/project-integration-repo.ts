import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  GitHubAppProjectIntegration,
  ProjectIntegrationEntity,
} from "../domain/project-integration-entity";

export type ProjectIntegrationRepo = {
  create(
    integration: ProjectIntegrationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity>;
  save(
    integration: ProjectIntegrationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity>;
  findById(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity | null>;
  listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity[]>;
  findByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<GitHubAppProjectIntegration[]>;
  listActive(
    dbExecutor?: DbExecutor,
    options?: { pageSize?: number },
  ): Promise<ProjectIntegrationEntity[]>;
  delete(
    id: UuidV7,
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
  deleteByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
};
