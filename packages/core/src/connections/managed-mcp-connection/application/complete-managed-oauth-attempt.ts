import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ManagedOAuthCallbackError } from "../contracts/managed-connection-contracts";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import { createManagedConnectionEvent } from "../domain/managed-connection-event";
import type {
  ManagedOAuthAttemptEntity,
  ManagedOAuthAttemptFailureCode,
} from "../domain/managed-oauth-attempt-entity";
import {
  ManagedOAuthGrantEntity,
  newManagedOAuthGrantId,
} from "../domain/managed-oauth-grant-entity";
import { holdsConnectionWrite } from "./managed-connection-access";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedGrantCrypto } from "./managed-grant-crypto";
import type { ManagedOAuthClientRegistry } from "./managed-oauth-client-registry";
import type { ManagedOAuthAttemptRepo } from "./managed-oauth-attempt-repo";
import type { ManagedOAuthGrantRepo } from "./managed-oauth-grant-repo";
import type {
  ManagedOAuthExchangeResult,
  ManagedOAuthServerMetadata,
} from "./oauth-provider";
import type { ManagedOAuthProviders } from "./managed-oauth-providers";

export type CompleteManagedOAuthAttemptDeps = {
  createUserAuthorizationService: (actorId: UuidV7) => UserAuthorizationService;
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
 * How completing an attempt ended. `projectId` is set only once the redirect
 * proved it belongs to the caller's attempt, so a stray or forged one learns
 * nothing about the project it names.
 */
export type ManagedOAuthCallbackOutcome =
  | { status: "candidate_stored"; projectId: UuidV7; connectionId: UuidV7 }
  | {
      status: "failed";
      error: ManagedOAuthCallbackError;
      projectId: UuidV7 | null;
      connectionId: UuidV7 | null;
    };

/** What the provider's redirect carried, besides `state`. */
export type ManagedOAuthRedirectParams = {
  code?: string;
  iss?: string;
  error?: string;
};

/** The failure for a redirect that can't be tied to the caller's attempt. */
export const unboundManagedOAuthOutcome = (): ManagedOAuthCallbackOutcome => ({
  status: "failed",
  error: "invalid_callback",
  projectId: null,
  connectionId: null,
});

/** The attempt left `exchanging` under us (e.g. a new connect cancelled it). */
class AttemptSupersededError extends Error {}

const attachableStates: Record<
  ManagedOAuthAttemptEntity["kind"],
  readonly ManagedConnectionEntity["state"][]
> = {
  connect: ["connecting"],
  reconnect: ["ready", "reconnect_required"],
};

/**
 * Null when the actor still holds `secrets:write` and the connection is still
 * at the attempt's generation, in a state that can take a candidate;
 * otherwise the failure code to end the attempt with.
 */
const checkStillBound = async (
  attempt: ManagedOAuthAttemptEntity,
  userAuthz: UserAuthorizationService,
  connectionRepo: ManagedConnectionRepo,
  dbExecutor?: DbExecutor,
): Promise<ManagedOAuthAttemptFailureCode | null> => {
  if (!(await holdsConnectionWrite(userAuthz, attempt.projectId, dbExecutor))) {
    return "permission_revoked";
  }
  const connection = await connectionRepo.findById(
    attempt.projectId,
    attempt.connectionId,
    dbExecutor,
  );
  if (
    !connection ||
    connection.generation !== attempt.expectedGeneration ||
    !attachableStates[attempt.kind].includes(connection.state)
  ) {
    return "stale_generation";
  }
  return null;
};

/**
 * Completes `attempt`, already proven to belong to the caller (its browser
 * session or its loopback completion secret), with the provider's redirect
 * (decisions 7 and 8). The redirect needs an `iss` that matches the issuer
 * when present (and present whenever the provider requires it), and exactly
 * one of `code` or `error`; error redirects are validated the same way
 * before being accepted. The attempt is claimed with compare-and-set before
 * the code is exchanged, the exchange runs outside any transaction and is
 * never retried, and the actor's `secrets:write`, the attempt and the
 * connection's generation and version are checked again, under the
 * connection's row lock, before the encrypted candidate is stored. A
 * rejected redirect makes no token request. An exchange the server refuses
 * with `invalid_client` marks the attempt's client stale, so the next
 * connect registers again.
 */
export const completeManagedOAuthAttempt = async (
  attempt: ManagedOAuthAttemptEntity,
  params: ManagedOAuthRedirectParams,
  deps: CompleteManagedOAuthAttemptDeps,
): Promise<ManagedOAuthCallbackOutcome> => {
  const fail = (
    error: ManagedOAuthCallbackError,
  ): ManagedOAuthCallbackOutcome => ({
    status: "failed",
    error,
    projectId: attempt.projectId,
    connectionId: attempt.connectionId,
  });

  const failAttempt = async (
    current: ManagedOAuthAttemptEntity,
    failureCode: ManagedOAuthAttemptFailureCode,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthCallbackOutcome> => {
    const at = deps.timeProvider.now();
    if (
      await deps.managedOAuthAttemptRepo.saveIfStatus(
        current.fail(failureCode, at),
        current.status,
        dbExecutor,
      )
    ) {
      await deps.managedConnectionEventRepo.append(
        createManagedConnectionEvent({
          projectId: current.projectId,
          connectionId: current.connectionId,
          actorUserId: current.actorUserId,
          type: "attempt_failed",
          generation: current.expectedGeneration,
          reasonCode: failureCode,
          createdAt: at,
        }),
        dbExecutor,
      );
    }
    return fail(failureCode);
  };

  const now = deps.timeProvider.now();
  if (attempt.progress.status !== "pending") {
    return fail("invalid_callback");
  }
  if (attempt.isExpiredAt(now)) {
    await deps.managedOAuthAttemptRepo.saveIfStatus(
      attempt.expire(now),
      "pending",
    );
    return fail("attempt_expired");
  }

  const owner = await deps.managedConnectionRepo.findById(
    attempt.projectId,
    attempt.connectionId,
  );
  if (!owner) {
    return await failAttempt(attempt, "stale_generation");
  }
  const provider = deps.managedOAuthProviders.for(owner);
  let metadata: ManagedOAuthServerMetadata;
  try {
    metadata = await provider.discover();
  } catch {
    return await failAttempt(attempt, "provider_error");
  }
  const issAccepted =
    params.iss === undefined
      ? !provider.requiresIssParameter(metadata)
      : params.iss === metadata.issuer;
  if (
    !issAccepted ||
    (params.code === undefined) === (params.error === undefined)
  ) {
    return await failAttempt(attempt, "invalid_callback");
  }

  const userAuthz = deps.createUserAuthorizationService(attempt.actorUserId);
  const unbindReason = await checkStillBound(
    attempt,
    userAuthz,
    deps.managedConnectionRepo,
  );
  if (unbindReason !== null) {
    return await failAttempt(attempt, unbindReason);
  }

  if (params.code === undefined) {
    return await failAttempt(
      attempt,
      params.error === "access_denied" ? "access_denied" : "provider_error",
    );
  }

  const exchanging = attempt.beginExchange(now);
  if (
    !(await deps.managedOAuthAttemptRepo.saveIfStatus(exchanging, "pending"))
  ) {
    return fail("invalid_callback");
  }

  let result: ManagedOAuthExchangeResult;
  try {
    result = await provider.exchangeCode({
      attempt: exchanging,
      code: params.code,
      pkceVerifier: deps.managedGrantCrypto.decryptPkceVerifier(
        {
          projectId: exchanging.projectId,
          connectionId: exchanging.connectionId,
          attemptId: exchanging.id,
        },
        attempt.progress.encryptedPkceVerifier,
      ),
    });
  } catch {
    result = { status: "failed", failureCode: "exchange_unknown" };
  }
  if (result.status === "failed") {
    if (result.failureCode === "client_configuration") {
      await deps.managedOAuthClientRegistry.markStale(
        metadata.issuer,
        exchanging.clientId,
      );
    }
    return await failAttempt(exchanging, result.failureCode);
  }
  const exchanged = result;

  try {
    return await getDb().transaction(async (tx) => {
      const connection = await deps.managedConnectionRepo.loadForUpdate(
        exchanging.projectId,
        exchanging.connectionId,
        tx,
      );
      const stale = await checkStillBound(
        exchanging,
        userAuthz,
        deps.managedConnectionRepo,
        tx,
      );
      if (stale !== null || !connection) {
        return await failAttempt(exchanging, stale ?? "stale_generation", tx);
      }

      const storedAt = deps.timeProvider.now();
      const grantId = newManagedOAuthGrantId();
      const target = {
        projectId: connection.projectId,
        connectionId: connection.id,
        grantId,
      };
      const attached = connection.attachCandidate(grantId, storedAt);
      await deps.managedOAuthGrantRepo.insert(
        ManagedOAuthGrantEntity.create({
          ...target,
          id: grantId,
          clientId: exchanging.clientId,
          issuer: exchanged.issuer,
          resource: exchanged.resource,
          credentialVersion: 1,
          encryptedCredentials: deps.managedGrantCrypto.encryptCredentials(
            { ...target, credentialVersion: 1 },
            exchanged.credentials,
          ),
          encryptedIdentity: deps.managedGrantCrypto.encryptIdentity(
            target,
            exchanged.identity,
          ),
          grantedScopes: exchanged.grantedScopes,
          authorizedAt: storedAt,
          createdByUserId: exchanging.actorUserId,
        }),
        tx,
      );
      const saved =
        (await deps.managedConnectionRepo.saveIfVersion(
          attached,
          connection.version,
          tx,
        )) &&
        (await deps.managedOAuthAttemptRepo.saveIfStatus(
          exchanging.succeed(grantId, storedAt),
          "exchanging",
          tx,
        ));
      if (!saved) {
        throw new AttemptSupersededError();
      }
      await deps.managedConnectionEventRepo.append(
        createManagedConnectionEvent({
          projectId: attached.projectId,
          connectionId: attached.id,
          actorUserId: exchanging.actorUserId,
          type: "candidate_attached",
          generation: attached.generation,
          createdAt: storedAt,
        }),
        tx,
      );
      return {
        status: "candidate_stored",
        projectId: attached.projectId,
        connectionId: attached.id,
      } satisfies ManagedOAuthCallbackOutcome;
    });
  } catch (error) {
    if (error instanceof AttemptSupersededError) {
      return await failAttempt(exchanging, "stale_generation");
    }
    throw error;
  }
};
