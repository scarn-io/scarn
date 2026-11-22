import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import type { ManagedOAuthCallbackError } from "../contracts/managed-connection-contracts";
import {
  digestsMatch,
  managedOAuthCompletionSecretDigest,
  managedOAuthStateDigest,
} from "../domain/managed-oauth-digests";
import {
  completeManagedOAuthAttempt,
  unboundManagedOAuthOutcome,
  type CompleteManagedOAuthAttemptDeps,
  type ManagedOAuthCallbackOutcome,
} from "./complete-managed-oauth-attempt";

export type CompleteManagedLoopbackAttemptInput = {
  /** The signed-in user completing the attempt; it must be the one that started it. */
  actorUserId: UuidV7;
  attemptId: UuidV7;
  /** The secret start returned for this attempt. */
  completionSecret: string;
  /** What the provider's redirect to the CLI's loopback listener carried. */
  state: string;
  code?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
};

/**
 * A loopback completion that stored no candidate. `meta.reason` is the
 * attempt's safe failure code, never anything the provider sent; a redirect
 * that can't be tied to the caller's attempt is always `invalid_callback`,
 * so it reveals nothing about whether the attempt exists.
 */
export class ManagedLoopbackCompletionFailedError extends CoreError {
  constructor(reason: ManagedOAuthCallbackError) {
    super({
      code: "MANAGED_CONNECTION_COMPLETION_FAILED",
      message: "The sign-in could not be completed",
      status: 409,
      meta: { reason },
    });
  }
}

/**
 * Completes a loopback attempt with the redirect the CLI caught (decisions 3
 * and 4). The attempt is found by `state` and must be `attemptId`, started by
 * `actorUserId` for loopback completion, and hold `completionSecret`'s
 * digest; a mismatch on any of them, or an unknown `state`, fails like a
 * forged callback, naming no project. The rest is
 * {@link completeManagedOAuthAttempt}: the server exchanges the code with
 * its PKCE verifier and the attempt's loopback `redirect_uri`, and stores a
 * candidate to confirm. `errorDescription` is the provider's and is never
 * stored.
 */
export const completeManagedLoopbackAttempt = async (
  input: CompleteManagedLoopbackAttemptInput,
  deps: CompleteManagedOAuthAttemptDeps,
): Promise<ManagedOAuthCallbackOutcome> => {
  const attempt = await deps.managedOAuthAttemptRepo.findByStateDigest(
    managedOAuthStateDigest(input.state),
  );
  const secretDigest = managedOAuthCompletionSecretDigest(
    input.completionSecret,
  );
  if (
    !attempt ||
    attempt.id !== input.attemptId ||
    attempt.actorUserId !== input.actorUserId ||
    attempt.binding.kind !== "loopback" ||
    !digestsMatch(attempt.binding.secretDigest, secretDigest)
  ) {
    return unboundManagedOAuthOutcome();
  }
  return await completeManagedOAuthAttempt(
    attempt,
    {
      ...(input.code === undefined ? {} : { code: input.code }),
      ...(input.iss === undefined ? {} : { iss: input.iss }),
      ...(input.error === undefined ? {} : { error: input.error }),
    },
    deps,
  );
};
