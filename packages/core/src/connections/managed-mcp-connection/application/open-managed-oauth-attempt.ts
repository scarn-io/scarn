import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { StartManagedConnectionResponse } from "../contracts/managed-connection-contracts";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import { createManagedConnectionEvent } from "../domain/managed-connection-event";
import { MANAGED_CONNECTION_LOOPBACK_CALLBACK_PATH } from "@scarn/sdk/managed-connections";
import { matchesManagedOAuthLoopbackRedirect } from "../contracts/managed-oauth-client-metadata";
import { parseLoopbackRedirectUri } from "../domain/loopback-redirect";
import {
  ManagedOAuthAttemptEntity,
  newManagedOAuthAttemptId,
  type ManagedOAuthAttemptBinding,
  type ManagedOAuthAttemptKind,
} from "../domain/managed-oauth-attempt-entity";
import {
  managedOAuthBrowserSessionDigest,
  managedOAuthCompletionSecretDigest,
  managedOAuthStateDigest,
  randomOAuthToken,
} from "../domain/managed-oauth-digests";
import { ManagedConnectionRequiresCliError } from "./managed-connection-access";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import type { ManagedGrantCrypto } from "./managed-grant-crypto";
import type { ManagedOAuthAttemptRepo } from "./managed-oauth-attempt-repo";
import type { ManagedOAuthClientIdentity } from "./oauth-provider";

export type OpenManagedOAuthAttemptDeps = {
  userAuthz: UserAuthorizationService;
  managedOAuthAttemptRepo: ManagedOAuthAttemptRepo;
  managedConnectionEventRepo: ManagedConnectionEventRepo;
  managedGrantCrypto: ManagedGrantCrypto;
};

/**
 * Who will finish an attempt being started: the browser session that started
 * it, at the server's callback, or the CLI catching the redirect on
 * `redirectUri`, which must be loopback (decision 4).
 */
export type ManagedOAuthStartBinding =
  | { kind: "browser"; sessionId: string }
  | { kind: "loopback"; redirectUri: string };

/**
 * What starting a loopback attempt hands the CLI, once. `redirectUri` is the
 * redirect the attempt uses: the CLI's own, or the fixed fallback port when
 * the server won't let the port vary, in which case the CLI must listen there.
 */
export type StartManagedLoopbackResponse = StartManagedConnectionResponse & {
  attemptId: UuidV7;
  completionSecret: string;
  redirectUri: string;
};

/** The start response for `B`: a loopback start also returns the attempt and its completion secret. */
export type StartManagedOAuthResponse<B extends ManagedOAuthStartBinding> =
  B extends { kind: "loopback" }
    ? StartManagedLoopbackResponse
    : StartManagedConnectionResponse;

/**
 * A start binding checked and turned into what the attempt stores. A
 * loopback binding gets a fresh completion secret, kept only as its digest.
 */
export type PreparedManagedOAuthBinding = {
  attemptBinding: ManagedOAuthAttemptBinding;
  /** The CLI's loopback redirect, for the client registry to resolve against; null for the server callback. */
  redirectUri: string | null;
  completionSecret: string | null;
};

/** The connection an attempt is for, as far as checking its start binding goes. */
export type ManagedOAuthStartTarget = {
  name: string;
  server: ManagedConnectionServer;
};

/**
 * The loopback redirect `target`'s server accepts `redirectUri` as. A
 * supplied client has one redirect, which the CLI must use exactly; Scarn's
 * own clients only know `http://127.0.0.1/callback`, on any port (decision
 * 7). Anything else is 422 `MANAGED_CONNECTION_REDIRECT_INVALID`.
 */
const acceptedLoopbackRedirect = (
  server: ManagedConnectionServer,
  redirectUri: string,
): string => {
  const loopback = parseLoopbackRedirectUri(redirectUri);
  if (server.clientRegistration === "supplied") {
    if (loopback !== server.suppliedRedirectUri) {
      throw new CoreValidationError(
        `This connection's client only accepts the redirect ${server.suppliedRedirectUri}.`,
        "MANAGED_CONNECTION_REDIRECT_INVALID",
      );
    }
    return loopback;
  }
  if (!matchesManagedOAuthLoopbackRedirect(loopback)) {
    throw new CoreValidationError(
      `This connection's server only accepts the redirect http://127.0.0.1:<port>${MANAGED_CONNECTION_LOOPBACK_CALLBACK_PATH}.`,
      "MANAGED_CONNECTION_REDIRECT_INVALID",
    );
  }
  return loopback;
};

/**
 * Checks `binding` for a `kind` attempt on `target`, before anything is
 * discovered or registered. A browser start on a supplied client is 409
 * `MANAGED_CONNECTION_REQUIRES_CLI`; a loopback redirect the server won't
 * accept is 422 `MANAGED_CONNECTION_REDIRECT_INVALID`.
 */
export const prepareManagedOAuthBinding = (
  binding: ManagedOAuthStartBinding,
  target: ManagedOAuthStartTarget,
  kind: ManagedOAuthAttemptKind,
): PreparedManagedOAuthBinding => {
  if (binding.kind === "browser") {
    if (target.server.clientRegistration === "supplied") {
      throw new ManagedConnectionRequiresCliError(target.name, kind);
    }
    return {
      attemptBinding: {
        kind: "browser",
        sessionDigest: managedOAuthBrowserSessionDigest(binding.sessionId),
      },
      redirectUri: null,
      completionSecret: null,
    };
  }
  const redirectUri = acceptedLoopbackRedirect(
    target.server,
    binding.redirectUri,
  );
  const completionSecret = randomOAuthToken();
  return {
    attemptBinding: {
      kind: "loopback",
      secretDigest: managedOAuthCompletionSecretDigest(completionSecret),
    },
    redirectUri,
    completionSecret,
  };
};

/** The start response for the attempt `prepared` was opened with. */
export const startManagedOAuthResponse = <B extends ManagedOAuthStartBinding>(
  prepared: PreparedManagedOAuthBinding,
  attempt: ManagedOAuthAttemptEntity,
  authorizationUrl: string,
): StartManagedOAuthResponse<B> => {
  const base = { connectionId: attempt.connectionId, authorizationUrl };
  return (
    prepared.completionSecret === null
      ? base
      : {
          ...base,
          attemptId: attempt.id,
          completionSecret: prepared.completionSecret,
          redirectUri: attempt.redirectUri,
        }
  ) as StartManagedOAuthResponse<B>;
};

/** Cancels the connection's `pending` and `exchanging` attempts. */
export const cancelOpenManagedOAuthAttempts = async (
  connection: ManagedConnectionEntity,
  attemptRepo: ManagedOAuthAttemptRepo,
  now: Date,
  dbExecutor: DbExecutor,
): Promise<void> => {
  for (const open of await attemptRepo.listOpenByConnection(
    connection.projectId,
    connection.id,
    dbExecutor,
  )) {
    await attemptRepo.saveIfStatus(open.cancel(now), open.status, dbExecutor);
  }
};

/**
 * Inside the caller's transaction, after it has moved `connection` into the
 * state the attempt starts from: records a single-use authorization attempt
 * bound to this browser session, actor and the connection's generation, and
 * the event that started it.
 */
export const openManagedOAuthAttempt = async (
  input: {
    connection: ManagedConnectionEntity;
    kind: ManagedOAuthAttemptKind;
    client: ManagedOAuthClientIdentity;
    requestedScopes: readonly string[];
    binding: PreparedManagedOAuthBinding;
    state: string;
    pkceVerifier: string;
    now: Date;
  },
  deps: OpenManagedOAuthAttemptDeps,
  tx: DbExecutor,
): Promise<ManagedOAuthAttemptEntity> => {
  const { connection, now } = input;
  const attemptId = newManagedOAuthAttemptId();
  const created = ManagedOAuthAttemptEntity.create({
    id: attemptId,
    connectionId: connection.id,
    projectId: connection.projectId,
    kind: input.kind,
    expectedGeneration: connection.generation,
    actorUserId: deps.userAuthz.actorId,
    binding: input.binding.attemptBinding,
    stateDigest: managedOAuthStateDigest(input.state),
    clientId: input.client.clientId,
    redirectUri: input.client.redirectUri,
    requestedScopes: input.requestedScopes,
    encryptedPkceVerifier: deps.managedGrantCrypto.encryptPkceVerifier(
      {
        projectId: connection.projectId,
        connectionId: connection.id,
        attemptId,
      },
      input.pkceVerifier,
    ),
    now,
  });
  await deps.managedOAuthAttemptRepo.insert(created, tx);
  await deps.managedConnectionEventRepo.append(
    createManagedConnectionEvent({
      projectId: connection.projectId,
      connectionId: connection.id,
      actorUserId: deps.userAuthz.actorId,
      type: input.kind === "connect" ? "connect_started" : "reconnect_started",
      generation: connection.generation,
      createdAt: now,
    }),
    tx,
  );
  return created;
};
