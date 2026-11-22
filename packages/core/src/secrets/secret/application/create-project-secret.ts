import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  createProjectSecretSchema,
  type CreateProjectSecretInput,
  type ProjectSecretContract,
} from "../contracts/project-secret-contracts";
import { ProjectSecretEntity } from "../domain/secret-entity";
import { secretAad } from "../domain/secret-aad";
import { projectSecretOwner } from "../domain/secret-owner";
import type { SecretCipher } from "./secret-cipher";
import type { SecretRepo } from "./secret-repo";
import {
  projectSecretToContract,
  type ProjectSecretContractMapperDeps,
} from "./project-secret-contract-mapper";

type CreateProjectSecretArgs = {
  projectId: UuidV7;
  secret: CreateProjectSecretInput;
};

type CreateProjectSecretDeps = ProjectSecretContractMapperDeps & {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
  secretCipher: SecretCipher;
  timeProvider: TimeProvider;
};

/**
 * Encrypts and saves a new secret on the project. Requires `secrets:write`.
 * A name the project already uses is `SECRET_NAME_TAKEN` (409).
 */
export const createProjectSecret = async (
  input: CreateProjectSecretArgs,
  deps: CreateProjectSecretDeps,
): Promise<ProjectSecretContract> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "secrets:write",
  });
  const { name, value } = createProjectSecretSchema.parse(input.secret);
  const now = deps.timeProvider.now();
  const id = createUuidV7();
  const owner = projectSecretOwner(input.projectId);

  const entity = ProjectSecretEntity.create({
    id,
    owner,
    name,
    encryptedValue: deps.secretCipher.encrypt(value, secretAad({ id, owner })),
    lastFour: value.slice(-4),
    updatedByUserId: deps.userAuthz.actorId,
    now,
  });

  return await projectSecretToContract(
    await deps.secretRepo.save(entity),
    deps,
  );
};
