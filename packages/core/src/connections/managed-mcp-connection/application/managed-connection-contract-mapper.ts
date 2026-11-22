import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type {
  UserDisplay,
  UsernameReader,
} from "@scarn/core/organizations/organization/application/username-reader";
import type {
  ManagedConnectionAccountContract,
  ManagedConnectionCandidateContract,
  ManagedConnectionContract,
} from "../contracts/managed-connection-contracts";
import { identityFingerprint } from "../domain/identity-fingerprint";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import {
  lapseManagedConnection,
  managedCandidateExpiresAt,
} from "../domain/managed-connection-lapse";
import type { ManagedOAuthGrantEntity } from "../domain/managed-oauth-grant-entity";
import type {
  ManagedGrantCrypto,
  ManagedGrantIdentity,
} from "./managed-grant-crypto";
import type { ManagedOAuthGrantRepo } from "./managed-oauth-grant-repo";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";

export type ManagedConnectionContractMapperDeps = {
  managedConnectionEventRepo: ManagedConnectionEventRepo;
  managedOAuthGrantRepo: ManagedOAuthGrantRepo;
  managedGrantCrypto: ManagedGrantCrypto;
  usernameReader: UsernameReader;
};

export type LoadedManagedGrant = {
  grant: ManagedOAuthGrantEntity;
  identity: ManagedGrantIdentity;
};

export const managedGrantFingerprint = (
  grant: ManagedOAuthGrantEntity,
  identity: ManagedGrantIdentity,
): string =>
  identityFingerprint({
    issuer: grant.issuer,
    workspaceId: identity.workspaceId,
    userId: identity.userId,
    scopes: grant.grantedScopes,
  });

const identityVerified = (identity: ManagedGrantIdentity): boolean =>
  identity.userId !== null && identity.workspaceId !== null;

const toAccount = (
  identity: ManagedGrantIdentity,
): ManagedConnectionAccountContract => ({
  userName: identity.userName,
  workspaceName: identity.workspaceName,
  identityVerified: identityVerified(identity),
});

/** Whether two grants act as the same provider account; "unknown" unless both identities are verified. */
export const managedGrantsSameIdentity = (
  candidate: LoadedManagedGrant,
  active: LoadedManagedGrant | null,
): boolean | "unknown" => {
  if (
    !active ||
    !identityVerified(candidate.identity) ||
    !identityVerified(active.identity)
  ) {
    return "unknown";
  }
  return (
    candidate.grant.issuer === active.grant.issuer &&
    candidate.identity.userId === active.identity.userId &&
    candidate.identity.workspaceId === active.identity.workspaceId
  );
};

const loadGrant = async (
  connection: ManagedConnectionEntity,
  grantId: UuidV7 | null,
  deps: ManagedConnectionContractMapperDeps,
  dbExecutor: DbExecutor | undefined,
): Promise<LoadedManagedGrant | null> => {
  if (grantId === null) {
    return null;
  }
  const grant = await deps.managedOAuthGrantRepo.findById(
    connection.projectId,
    connection.id,
    grantId,
    dbExecutor,
  );
  if (!grant) {
    throw new InvariantViolationError(
      `Managed connection ${connection.id} points at missing grant ${grantId}`,
    );
  }
  const identity = deps.managedGrantCrypto.decryptIdentity(
    {
      projectId: grant.projectId,
      connectionId: grant.connectionId,
      grantId: grant.id,
    },
    grant.encryptedIdentity,
  );
  return { grant, identity };
};

const missingScopes = (
  requested: readonly string[] | undefined,
  granted: readonly string[],
): string[] => (requested ?? []).filter((scope) => !granted.includes(scope));

const toCandidate = (
  connection: ManagedConnectionEntity,
  candidate: LoadedManagedGrant,
  active: LoadedManagedGrant | null,
): ManagedConnectionCandidateContract => ({
  id: candidate.grant.id,
  account: toAccount(candidate.identity),
  grantedScopes: [...candidate.grant.grantedScopes],
  missingScopes: missingScopes(
    connection.server.scopes,
    candidate.grant.grantedScopes,
  ),
  fingerprint: managedGrantFingerprint(candidate.grant, candidate.identity),
  expiresAt: managedCandidateExpiresAt(candidate.grant).toISOString(),
  sameIdentityAsActive: managedGrantsSameIdentity(candidate, active),
});

const connectedByUserId = (
  connection: ManagedConnectionEntity,
): UuidV7 | null =>
  "connectedByUserId" in connection ? connection.connectedByUserId : null;

const reasonCode = (connection: ManagedConnectionEntity) =>
  "reasonCode" in connection ? connection.reasonCode : null;

/**
 * Maps a connection to its token-free contract. Grant identities are
 * decrypted only to read the display names and compute the fingerprint;
 * provider IDs never leave this function.
 *
 * Given `asOf`, a connection whose connect attempt or candidate has lapsed
 * by then is shown as already expired (its state after `expire`, without
 * the candidate), whether or not the sweep has written that yet. Nothing is
 * written; `version` stays the stored one.
 */
export const managedConnectionToContract = async (
  stored: ManagedConnectionEntity,
  deps: ManagedConnectionContractMapperDeps,
  dbExecutor?: DbExecutor,
  asOf?: Date,
): Promise<ManagedConnectionContract> => {
  const [active, storedCandidate, events] = await Promise.all([
    loadGrant(stored, stored.servingGrantId, deps, dbExecutor),
    loadGrant(stored, stored.pendingCandidateGrantId, deps, dbExecutor),
    deps.managedConnectionEventRepo.listByConnection(
      stored.projectId,
      stored.id,
      dbExecutor,
    ),
  ]);
  const lapsed =
    asOf === undefined
      ? null
      : lapseManagedConnection(stored, storedCandidate?.grant ?? null, asOf);
  const connection = lapsed?.connection ?? stored;
  const lastRevocation = events.find(
    (event) =>
      event.type === "revocation_attempted" &&
      event.generation === connection.generation,
  );
  const freshConnect = events.find(
    (event) =>
      event.type === "connect_started" &&
      event.generation === connection.generation,
  );
  const candidate = lapsed ? null : storedCandidate;
  const connectedBy = connectedByUserId(connection);
  const usernames =
    connectedBy === null
      ? new Map<UuidV7, UserDisplay>()
      : await deps.usernameReader.loadUsernamesByUserId([connectedBy]);

  return {
    id: connection.id,
    projectId: connection.projectId,
    name: connection.name,
    label: connection.label,
    preset: connection.preset,
    resource: connection.server.resource,
    issuerOrigin: connection.server.issuerOrigin,
    suppliedClient:
      connection.server.clientRegistration === "supplied"
        ? {
            clientId: connection.server.suppliedClientId,
            redirectUri: connection.server.suppliedRedirectUri,
          }
        : null,
    scopes:
      connection.server.scopes === undefined
        ? null
        : [...connection.server.scopes],
    state: connection.state,
    reasonCode: reasonCode(connection),
    generation: connection.generation,
    version: stored.version,
    connectedBy:
      connectedBy === null
        ? null
        : {
            userId: connectedBy,
            username: usernames.get(connectedBy)?.username ?? null,
          },
    account: active ? toAccount(active.identity) : null,
    grantedScopes: active ? [...active.grant.grantedScopes] : [],
    reconnectBy: active?.grant.reconnectBy.toISOString() ?? null,
    candidate: candidate ? toCandidate(connection, candidate, active) : null,
    lastRevocation:
      lastRevocation?.revocationOutcome == null ||
      (freshConnect !== undefined &&
        freshConnect.createdAt >= lastRevocation.createdAt)
        ? null
        : {
            outcome: lastRevocation.revocationOutcome,
            at: lastRevocation.createdAt.toISOString(),
          },
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
  };
};
