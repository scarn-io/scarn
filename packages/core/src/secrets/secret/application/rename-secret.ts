import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  renameSecretSchema,
  type RenameSecretInput,
  type SecretContract,
} from "../contracts/secret-contracts";
import { userSecretOwner } from "../domain/secret-owner";
import type { SecretRepo } from "./secret-repo";
import { secretEntityToContract } from "./secret-contract-mapper";
import { loadSecretUses, type LoadSecretUsesDeps } from "./load-secret-uses";

type RenameSecretArgs = {
  secretId: UuidV7;
  rename: RenameSecretInput;
};

type RenameSecretDeps = LoadSecretUsesDeps & {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
  timeProvider: TimeProvider;
};

/** Renames one of the caller's secrets. Another user's ID is a 404. */
export const renameSecret = async (
  input: RenameSecretArgs,
  deps: RenameSecretDeps,
): Promise<SecretContract> => {
  const { name } = renameSecretSchema.parse(input.rename);
  const now = deps.timeProvider.now();
  const owner = userSecretOwner(deps.userAuthz.actorId);

  const secret = await deps.secretRepo.findByIdForOwner(input.secretId, owner);
  if (!secret) {
    throw new ResourceNotFoundError("secret", input.secretId);
  }

  const saved = await deps.secretRepo.save(secret.rename(name, now));
  const uses = await loadSecretUses([saved.id], deps);
  return secretEntityToContract(saved, now, uses.get(saved.id) ?? []);
};
