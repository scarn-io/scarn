import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { userSecretOwner } from "../domain/secret-owner";
import type { SecretRepo } from "./secret-repo";

export type MarkSecretUsedDeps = {
  secretRepo: SecretRepo;
  userAuthz: UserAuthorizationService;
  timeProvider: TimeProvider;
};

/**
 * Records that the caller's saved secret was just used successfully. Does
 * nothing for a pasted credential (`secretId` null) or a secret that has
 * since been deleted.
 */
export const markSecretUsed = async (
  secretId: UuidV7 | null,
  deps: MarkSecretUsedDeps,
): Promise<void> => {
  if (secretId === null) {
    return;
  }
  const owner = userSecretOwner(deps.userAuthz.actorId);
  const secret = await deps.secretRepo.findByIdForOwner(secretId, owner);
  if (!secret) {
    return;
  }
  await deps.secretRepo.save(secret.markUsed(deps.timeProvider.now()));
};

export type MarkLentSecretUsedDeps = {
  secretRepo: Pick<SecretRepo, "findById" | "save">;
  timeProvider: TimeProvider;
};

/**
 * Records that a key lent to a project integration was just used by the
 * auto-sync poller, which runs with no user and so can't scope the lookup to
 * an owner. Does nothing if the secret has since been deleted.
 */
export const markLentSecretUsed = async (
  secretId: UuidV7,
  deps: MarkLentSecretUsedDeps,
): Promise<void> => {
  const secret = await deps.secretRepo.findById(secretId);
  if (!secret) {
    return;
  }
  await deps.secretRepo.save(secret.markUsed(deps.timeProvider.now()));
};
