import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type {
  ListSecretsQuery,
  SecretContract,
} from "../contracts/secret-contracts";
import { userSecretOwner } from "../domain/secret-owner";
import type { SecretRepo } from "./secret-repo";
import { secretEntityToContract } from "./secret-contract-mapper";

type ListMySecretsDeps = {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
  timeProvider: TimeProvider;
};

/** The caller's own secrets, newest first. */
export const listMySecrets = async (
  input: ListSecretsQuery,
  deps: ListMySecretsDeps,
): Promise<SecretContract[]> => {
  const now = deps.timeProvider.now();
  const secrets = await deps.secretRepo.listByOwner(
    userSecretOwner(deps.userAuthz.actorId),
    { kind: input.kind },
  );
  return secrets.map((secret) => secretEntityToContract(secret, now));
};
