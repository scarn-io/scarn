import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  pauseIntegrationAutoSync,
  type PauseIntegrationAutoSyncDeps,
} from "@scarn/core/integrations/project-integration/application/pause-integration-auto-sync";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import { getDb } from "@scarn/core/lib/db";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { DeleteSecretResponse } from "../contracts/secret-contracts";
import { userSecretOwner } from "../domain/secret-owner";
import type { SecretRepo } from "./secret-repo";

type DeleteSecretArgs = {
  secretId: UuidV7;
};

type DeleteSecretDeps = Omit<
  PauseIntegrationAutoSyncDeps,
  "projectIntegrationRepo" | "secretRepo"
> & {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
  projectIntegrationRepo: Pick<
    ProjectIntegrationRepo,
    "findById" | "save" | "listBySyncSecretId"
  >;
};

/**
 * Hard-deletes one of the caller's secrets: once the value is gone there is
 * nothing left to audit. Another user's ID is a 404. In the same
 * transaction, every integration the key was lent to first pauses with
 * `key_removed`, since the foreign key's `ON DELETE SET NULL` can't record
 * why.
 */
export const deleteSecret = async (
  input: DeleteSecretArgs,
  deps: DeleteSecretDeps,
): Promise<DeleteSecretResponse> => {
  const owner = userSecretOwner(deps.userAuthz.actorId);
  await (deps.dbExecutor ?? getDb()).transaction(async (tx) => {
    const secret = await deps.secretRepo.findByIdForOwner(
      input.secretId,
      owner,
      tx,
    );
    if (!secret) {
      throw new ResourceNotFoundError("secret", input.secretId);
    }

    const lentTo = await deps.projectIntegrationRepo.listBySyncSecretId(
      input.secretId,
      tx,
    );
    for (const integration of lentTo) {
      await pauseIntegrationAutoSync(
        {
          integrationId: integration.id,
          lentSecretId: input.secretId,
          reason: "key_removed",
        },
        { ...deps, dbExecutor: tx },
      );
    }

    if (!(await deps.secretRepo.delete(input.secretId, owner, tx))) {
      throw new ResourceNotFoundError("secret", input.secretId);
    }
  });
  return { deleted: true };
};
