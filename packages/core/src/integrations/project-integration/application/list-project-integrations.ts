import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ProjectIntegrationEntity } from "../domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "./project-integration-repo";

export const listProjectIntegrations = (
  projectId: UuidV7,
  repo: ProjectIntegrationRepo,
): Promise<ProjectIntegrationEntity[]> => repo.listByProjectId(projectId);
