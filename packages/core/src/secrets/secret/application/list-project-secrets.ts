import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ProjectSecretContract } from "../contracts/project-secret-contracts";
import { projectSecretOwner } from "../domain/secret-owner";
import type { SecretRepo } from "./secret-repo";
import {
  projectSecretsToContracts,
  type ProjectSecretContractMapperDeps,
} from "./project-secret-contract-mapper";

type ListProjectSecretsDeps = ProjectSecretContractMapperDeps & {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
};

/** The project's secrets, newest first, without values. Requires `secrets:read`. */
export const listProjectSecrets = async (
  input: { projectId: UuidV7 },
  deps: ListProjectSecretsDeps,
): Promise<ProjectSecretContract[]> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "secrets:read",
  });
  const secrets = await deps.secretRepo.listByOwner(
    projectSecretOwner(input.projectId),
  );
  return await projectSecretsToContracts(secrets, deps);
};
