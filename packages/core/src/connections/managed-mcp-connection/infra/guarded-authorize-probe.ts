import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import type {
  ManagedOAuthAuthorizeProbe,
  ManagedOAuthAuthorizeProbeResult,
} from "../application/managed-oauth-authorize-probe";
import { OutboundRequestError } from "./guarded-fetch";
import type { ManagedConnectionGuards } from "./managed-connection-guards";

/** How long a probe of an authorization endpoint may take. */
export const MANAGED_OAUTH_AUTHORIZE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probes an authorization endpoint through the connection's own guard
 * (decision 46), which never follows a redirect: a redirect means the server
 * took the request. The response body is discarded unread.
 */
export class GuardedAuthorizeProbe implements ManagedOAuthAuthorizeProbe {
  private readonly guards: ManagedConnectionGuards;

  /** `guards` should carry a short timeout, such as {@link MANAGED_OAUTH_AUTHORIZE_PROBE_TIMEOUT_MS}. */
  constructor(guards: ManagedConnectionGuards) {
    this.guards = guards;
  }

  async probe(
    server: ManagedConnectionServer,
    authorizationUrl: string,
  ): Promise<ManagedOAuthAuthorizeProbeResult> {
    try {
      const response = await this.guards.for(server).request(authorizationUrl, {
        method: "GET",
        headers: { accept: "text/html" },
      });
      await response.discard();
      if (response.status >= 200 && response.status < 300) {
        return "accepted";
      }
      return response.status >= 400 && response.status < 500
        ? "rejected"
        : "unknown";
    } catch (error) {
      return error instanceof OutboundRequestError &&
        error.failure === "redirect"
        ? "accepted"
        : "unknown";
    }
  }
}
