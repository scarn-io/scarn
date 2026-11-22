import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { DeleteProjectSecretResponse } from "../contracts/project-secret-contracts";
import { projectSecretOwner } from "../domain/secret-owner";
import type { SecretRepo } from "./secret-repo";

type DeleteProjectSecretDeps = {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
};

/**
 * Hard-deletes a project secret. Requires `secrets:write`. A secret of
 * another project is a 404.
 */
export const deleteProjectSecret = async (
  input: { projectId: UuidV7; secretId: UuidV7 },
  deps: DeleteProjectSecretDeps,
): Promise<DeleteProjectSecretResponse> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "secrets:write",
  });
  const deleted = await deps.secretRepo.delete(
    input.secretId,
    projectSecretOwner(input.projectId),
  );
  if (!deleted) {
    throw new ResourceNotFoundError("secret", input.secretId);
  }
  return { deleted: true };
};
