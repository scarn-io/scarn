import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { ManagedOAuthClientRegistry } from "../application/managed-oauth-client-registry";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import type { ManagedOAuthClientIdentity } from "../application/oauth-provider";

/**
 * The registry for connections signed in to with a client the user supplied
 * (decision 6): the client ID and its one loopback redirect are stored on the
 * connection, so resolving just returns them. The start has already checked
 * the CLI's redirect equals the stored one. There is nothing to re-register,
 * so `markStale` does nothing; a rejected client leaves the connection
 * needing a reconnect.
 */
export class SuppliedClientRegistry implements ManagedOAuthClientRegistry {
  resolve(
    server: ManagedConnectionServer,
  ): Promise<ManagedOAuthClientIdentity> {
    if (server.clientRegistration !== "supplied") {
      throw new InvariantViolationError(
        `${server.resource} doesn't use a supplied client`,
      );
    }
    return Promise.resolve({
      clientId: server.suppliedClientId,
      redirectUri: server.suppliedRedirectUri,
    });
  }

  markStale(): Promise<void> {
    return Promise.resolve();
  }
}
