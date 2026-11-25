import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { DeleteSecretResponse } from "../contracts/secret-contracts";
import { userSecretOwner } from "../domain/secret-owner";
import type { SecretRepo } from "./secret-repo";

type DeleteSecretArgs = {
  secretId: UuidV7;
};

type DeleteSecretDeps = {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
};

/**
 * Hard-deletes one of the caller's secrets: once the value is gone there is
 * nothing left to audit. Another user's ID is a 404.
 */
export const deleteSecret = async (
  input: DeleteSecretArgs,
  deps: DeleteSecretDeps,
): Promise<DeleteSecretResponse> => {
  const owner = userSecretOwner(deps.userAuthz.actorId);
  if (!(await deps.secretRepo.delete(input.secretId, owner))) {
    throw new ResourceNotFoundError("secret", input.secretId);
  }
  return { deleted: true };
};
