import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { SecretContract } from "../contracts/secret-contracts";
import { userSecretOwner } from "../domain/secret-owner";
import type { SecretRepo } from "./secret-repo";
import { secretEntityToContract } from "./secret-contract-mapper";
import { loadSecretUses, type LoadSecretUsesDeps } from "./load-secret-uses";

type StopLendingSecretArgs = {
  secretId: UuidV7;
  integrationId: UuidV7;
};

type StopLendingSecretDeps = LoadSecretUsesDeps & {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
  projectIntegrationRepo: Pick<ProjectIntegrationRepo, "findById" | "save">;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor;
};

/**
 * "Stop using": the key's owner withdraws it from one integration, which
 * turns that integration's auto-sync off. Needs no project permission — the
 * owner may have lost access but can always take their own key back. Another
 * user's secret, or an integration the key isn't lent to, is a 404.
 */
export const stopLendingSecret = async (
  input: StopLendingSecretArgs,
  deps: StopLendingSecretDeps,
): Promise<SecretContract> => {
  const owner = userSecretOwner(deps.userAuthz.actorId);
  return (deps.dbExecutor ?? getDb()).transaction(async (tx) => {
    const secret = await deps.secretRepo.findByIdForOwner(
      input.secretId,
      owner,
      tx,
    );
    if (!secret) {
      throw new ResourceNotFoundError("secret", input.secretId);
    }

    const integration = await deps.projectIntegrationRepo.findById(
      input.integrationId,
      tx,
    );
    if (integration?.syncSecretId !== input.secretId) {
      throw new ResourceNotFoundError(
        "project integration",
        input.integrationId,
      );
    }
    await deps.projectIntegrationRepo.save(integration.withAutoSyncOff(), tx);

    const uses = await loadSecretUses([secret.id], deps, tx);
    return secretEntityToContract(
      secret,
      deps.timeProvider.now(),
      uses.get(secret.id) ?? [],
    );
  });
};
