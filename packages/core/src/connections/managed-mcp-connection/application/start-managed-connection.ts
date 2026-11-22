import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getDb } from "@scarn/core/lib/db";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import type { ManagedConnectionDefinition } from "../domain/managed-connection-server";
import { randomOAuthToken } from "../domain/managed-oauth-digests";
import { sameManagedConnectionTarget } from "./managed-oauth-providers";
import {
  managedConnectionNameTaken,
  managedConnectionResourceTaken,
  managedConnectionVersionConflict,
  requireConnectionWriter,
} from "./managed-connection-access";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import { expireLapsedManagedConnection } from "./expire-lapsed-managed-connection";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedGrantCrypto } from "./managed-grant-crypto";
import type { ManagedOAuthAttemptRepo } from "./managed-oauth-attempt-repo";
import type { ManagedOAuthClientRegistry } from "./managed-oauth-client-registry";
import type { ManagedOAuthGrantRepo } from "./managed-oauth-grant-repo";
import type { ManagedOAuthProviders } from "./managed-oauth-providers";
import {
  cancelOpenManagedOAuthAttempts,
  openManagedOAuthAttempt,
  prepareManagedOAuthBinding,
  startManagedOAuthResponse,
  type ManagedOAuthStartBinding,
  type StartManagedOAuthResponse,
} from "./open-managed-oauth-attempt";

type StartManagedConnectionInput<B extends ManagedOAuthStartBinding> = {
  projectId: UuidV7;
  /** The connection to create when the project has none with this name. */
  definition: ManagedConnectionDefinition;
  /** Who finishes the attempt: the starting browser session, or the CLI on a loopback redirect. */
  binding: B;
};

export type StartManagedConnectionDeps = {
  userAuthz: UserAuthorizationService;
  managedConnectionRepo: ManagedConnectionRepo;
  managedOAuthAttemptRepo: ManagedOAuthAttemptRepo;
  managedOAuthGrantRepo: ManagedOAuthGrantRepo;
  managedConnectionEventRepo: ManagedConnectionEventRepo;
  managedGrantCrypto: ManagedGrantCrypto;
  managedOAuthProviders: ManagedOAuthProviders;
  managedOAuthClientRegistry: ManagedOAuthClientRegistry;
  timeProvider: TimeProvider;
};

/**
 * Whether `existing`, the project's connection named like `definition`, is
 * the connection `definition` describes: created from the same preset (or
 * both without one). The server isn't compared: the row is the source of
 * truth, so a preset whose URL changed still restarts its existing row.
 */
const isSameConnection = (
  existing: ManagedConnectionEntity,
  definition: ManagedConnectionDefinition,
): boolean => existing.preset === definition.preset;

/**
 * Starts a first connect: creates the project's connection from `definition`,
 * or reuses its connection of the same name, and opens a single-use
 * authorization attempt bound to `binding`, the actor and the generation. A
 * loopback start also returns the attempt ID and its completion secret.
 *
 * - A same-named connection from another preset (or with no preset when
 *   `definition` has one, and vice versa) is `MANAGED_CONNECTION_EXISTS`
 *   (409): the name is taken.
 * - With no same-named connection, another connection already using the
 *   definition's MCP URL is `MANAGED_CONNECTION_EXISTS` (409) as well.
 * - On the same connection, a connect already in flight is replaced, and a
 *   lapsed connect or candidate is expired first; a connection that has (or
 *   is waiting to confirm) a grant is `MANAGED_CONNECTION_STATE_CONFLICT`
 *   (409).
 *
 * Discovery and client resolution (which registers a DCR client on the
 * server's first connect) run against the existing row's server when there
 * is one (the row is the source of truth), else the definition's, before the
 * transaction; if the row it then locks or creates has another server it's a
 * version conflict. Requires `secrets:write`.
 */
export const startManagedConnection = async <
  B extends ManagedOAuthStartBinding,
>(
  input: StartManagedConnectionInput<B>,
  deps: StartManagedConnectionDeps,
): Promise<StartManagedOAuthResponse<B>> => {
  await requireConnectionWriter(deps.userAuthz, input.projectId);
  const named = await deps.managedConnectionRepo.loadByName(
    input.projectId,
    input.definition.name,
  );
  if (named && !isSameConnection(named, input.definition)) {
    throw managedConnectionNameTaken(input.definition.name);
  }
  if (!named) {
    const sameResource = await deps.managedConnectionRepo.loadByResource(
      input.projectId,
      input.definition.server.resource,
    );
    if (sameResource) {
      throw managedConnectionResourceTaken(sameResource.name);
    }
  }
  const target = named ?? input.definition;
  const prepared = prepareManagedOAuthBinding(
    input.binding,
    { name: input.definition.name, server: target.server },
    "connect",
  );
  const provider = deps.managedOAuthProviders.for(target);
  const metadata = await provider.discover();
  const client = await deps.managedOAuthClientRegistry.resolve(
    target.server,
    metadata,
    prepared.redirectUri,
  );

  const state = randomOAuthToken();
  const pkceVerifier = randomOAuthToken();
  const now = deps.timeProvider.now();

  const attempt = await getDb().transaction(async (tx) => {
    await requireConnectionWriter(deps.userAuthz, input.projectId, tx);
    const existing = await deps.managedConnectionRepo.loadByNameForUpdate(
      input.projectId,
      input.definition.name,
      tx,
    );
    let connection: ManagedConnectionEntity;
    if (existing && !isSameConnection(existing, input.definition)) {
      throw managedConnectionNameTaken(input.definition.name);
    }
    if (existing) {
      const current =
        (await expireLapsedManagedConnection(existing, now, deps, tx))
          ?.connection ?? existing;
      connection = current.startConnect(now);
      if (
        !(await deps.managedConnectionRepo.saveIfVersion(
          connection,
          current.version,
          tx,
        ))
      ) {
        throw managedConnectionVersionConflict();
      }
      await cancelOpenManagedOAuthAttempts(
        current,
        deps.managedOAuthAttemptRepo,
        now,
        tx,
      );
    } else {
      connection = ManagedConnectionEntity.create({
        ...input.definition,
        projectId: input.projectId,
        now,
      }).startConnect(now);
      await deps.managedConnectionRepo.insert(connection, tx);
    }
    if (!sameManagedConnectionTarget(connection, target)) {
      throw managedConnectionVersionConflict();
    }

    return await openManagedOAuthAttempt(
      {
        connection,
        kind: "connect",
        client,
        requestedScopes: connection.server.scopes ?? metadata.scopesSupported,
        binding: prepared,
        state,
        pkceVerifier,
        now,
      },
      deps,
      tx,
    );
  });

  return startManagedOAuthResponse<B>(
    prepared,
    attempt,
    await provider.authorizationUrl({ attempt, state, pkceVerifier }),
  );
};
