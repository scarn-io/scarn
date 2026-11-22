import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ProjectIntegrationRepo } from "./project-integration-repo";

export const deleteProjectIntegration = (
  id: UuidV7,
  projectId: UuidV7,
  repo: ProjectIntegrationRepo,
): Promise<number> => repo.delete(id, projectId);
