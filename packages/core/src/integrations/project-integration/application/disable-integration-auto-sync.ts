import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ProjectIntegrationEntity } from "../domain/project-integration-entity";
import { requireProjectIntegration } from "./enable-integration-auto-sync";
import type { ProjectIntegrationRepo } from "./project-integration-repo";

/**
 * Turns auto-sync off: clears the lent key and any pause. Anyone with
 * `work-items:write` can do this, whoever lent the key.
 */
export const disableIntegrationAutoSync = async (
  input: { projectId: UuidV7; integrationId: UuidV7 },
  deps: {
    userAuthz: UserAuthorizationService;
    projectIntegrationRepo: ProjectIntegrationRepo;
  },
): Promise<ProjectIntegrationEntity> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "integrations:write",
  });
  const integration = await requireProjectIntegration(
    input,
    deps.projectIntegrationRepo,
  );
  return deps.projectIntegrationRepo.save(integration.withAutoSyncOff());
};
