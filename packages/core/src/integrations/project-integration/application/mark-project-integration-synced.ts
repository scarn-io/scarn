import { CoreValidationError } from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ProjectIntegrationEntity } from "../domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "./project-integration-repo";

export const markProjectIntegrationSynced = async (
  id: UuidV7,
  syncedAt: Date,
  repo: ProjectIntegrationRepo,
): Promise<ProjectIntegrationEntity> => {
  const existing = await repo.findById(id);
  if (!existing) {
    throw new CoreValidationError(
      "Project integration not found",
      "PROJECT_INTEGRATION_NOT_FOUND",
    );
  }
  return repo.save(existing.withSyncSuccess(syncedAt));
};

export const markProjectIntegrationError = async (
  id: UuidV7,
  message: string,
  occurredAt: Date,
  repo: ProjectIntegrationRepo,
): Promise<ProjectIntegrationEntity> => {
  const existing = await repo.findById(id);
  if (!existing) {
    throw new CoreValidationError(
      "Project integration not found",
      "PROJECT_INTEGRATION_NOT_FOUND",
    );
  }
  return repo.save(existing.withSyncError(message, occurredAt));
};
