import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { SecretRepo } from "@scarn/core/secrets/secret/application/secret-repo";
import type { ProjectIntegrationEntity } from "../domain/project-integration-entity";
import type { AutoSyncSyncsAsContract } from "../contracts/project-integration-contracts";
import type { AutoSyncDisplayBySecretId } from "./project-integration-contract-mapper";

/**
 * Resolves who each integration's lent key syncs as (the key's name, its
 * owner's id and username) for `projectIntegrationEntityToContract`. Reads
 * only value-free secret summaries. `displayName` is the owner's username, or
 * null when the user has none yet; the UI picks the fallback label.
 */
export const loadAutoSyncDisplay = async (
  integrations: readonly ProjectIntegrationEntity[],
  deps: {
    secretRepo: Pick<SecretRepo, "listSummariesByIds">;
    usernameReader: UsernameReader;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<AutoSyncDisplayBySecretId> => {
  const secretIds = [
    ...new Set(
      integrations.flatMap((integration) =>
        integration.syncSecretId ? [integration.syncSecretId] : [],
      ),
    ),
  ];
  if (secretIds.length === 0) {
    return new Map();
  }

  const summaries = await deps.secretRepo.listSummariesByIds(
    secretIds,
    deps.dbExecutor,
  );
  const usernames = await deps.usernameReader.loadUsernamesByUserId(
    summaries.map((summary) => summary.ownerUserId),
    deps.dbExecutor,
  );

  return new Map<UuidV7, AutoSyncSyncsAsContract>(
    summaries.map((summary) => [
      summary.id,
      {
        userId: summary.ownerUserId,
        displayName: usernames.get(summary.ownerUserId)?.username ?? null,
        secretName: summary.name,
      },
    ]),
  );
};
