import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  updateProjectSecretSchema,
  type ProjectSecretContract,
  type UpdateProjectSecretInput,
} from "../contracts/project-secret-contracts";
import { secretAad } from "../domain/secret-aad";
import { projectSecretOwner } from "../domain/secret-owner";
import type { SecretCipher } from "./secret-cipher";
import type { SecretRepo } from "./secret-repo";
import {
  asProjectSecret,
  projectSecretToContract,
  type ProjectSecretContractMapperDeps,
} from "./project-secret-contract-mapper";

export type UpdateProjectSecretArgs = {
  projectId: UuidV7;
  secretId: UuidV7;
  update: UpdateProjectSecretInput;
};

export type UpdateProjectSecretDeps = ProjectSecretContractMapperDeps & {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
  secretCipher: SecretCipher;
  timeProvider: TimeProvider;
};

/**
 * Renames a project secret, replaces its value, or both in one save.
 * Requires `secrets:write`. A secret of another project is a 404; a name the
 * project already uses is `SECRET_NAME_TAKEN` (409).
 */
export const updateProjectSecret = async (
  input: UpdateProjectSecretArgs,
  deps: UpdateProjectSecretDeps,
): Promise<ProjectSecretContract> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "secrets:write",
  });
  const { name, value } = updateProjectSecretSchema.parse(input.update);
  const now = deps.timeProvider.now();
  const actorId = deps.userAuthz.actorId;
  const owner = projectSecretOwner(input.projectId);

  const found = await deps.secretRepo.findByIdForOwner(input.secretId, owner);
  if (!found) {
    throw new ResourceNotFoundError("secret", input.secretId);
  }

  let secret = asProjectSecret(found);
  if (name !== undefined) {
    secret = secret.rename(name, now, actorId);
  }
  if (value !== undefined) {
    secret = secret.replaceValue(
      {
        encryptedValue: deps.secretCipher.encrypt(
          value,
          secretAad({ id: secret.id, owner }),
        ),
        lastFour: value.slice(-4),
      },
      now,
      actorId,
    );
  }

  return await projectSecretToContract(
    await deps.secretRepo.save(secret),
    deps,
  );
};
