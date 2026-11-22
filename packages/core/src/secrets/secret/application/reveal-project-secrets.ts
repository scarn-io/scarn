import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { secretAad } from "../domain/secret-aad";
import { projectSecretOwner } from "../domain/secret-owner";
import type { SecretCipher } from "./secret-cipher";
import type { SecretRepo } from "./secret-repo";

export type RevealProjectSecretsDeps = {
  secretRepo: SecretRepo;
  secretCipher: SecretCipher;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

export type RevealedProjectSecrets = {
  values: Map<string, string>;
  missing: string[];
};

/**
 * Decrypts the project's secrets named in `names` and marks each one used.
 * Names the project has no secret for come back in `missing`, in request
 * order. Does no authorization: the caller must already have checked that
 * the actor may read these values (for a Task run, a valid claim plus
 * `executions:write`).
 */
export const revealProjectSecrets = async (
  projectId: UuidV7,
  names: readonly string[],
  deps: RevealProjectSecretsDeps,
): Promise<RevealedProjectSecrets> => {
  const owner = projectSecretOwner(projectId);
  const wanted = new Set(names);
  const saved = await deps.secretRepo.listByOwner(
    owner,
    { kind: "project_secret" },
    deps.dbExecutor,
  );
  const now = deps.timeProvider.now();

  const values = new Map<string, string>();
  for (const secret of saved) {
    if (!wanted.has(secret.name)) {
      continue;
    }
    values.set(
      secret.name,
      deps.secretCipher.decrypt(
        secret.encryptedValue,
        secretAad({ id: secret.id, owner: secret.owner }),
      ),
    );
    await deps.secretRepo.save(secret.markUsed(now), deps.dbExecutor);
  }

  return {
    values,
    missing: names.filter((name) => !values.has(name)),
  };
};
