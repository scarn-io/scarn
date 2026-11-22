import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import type { ManagedConnectionDiscovery } from "../domain/managed-connection-discovery";

/** What probing an MCP URL found, before anything is stored. */
export type ManagedMcpServerProbe = {
  /** The normalized MCP URL probed. */
  resource: string;
  /** The single issuer the protected-resource metadata names. */
  issuer: string;
  issuerOrigin: string;
  /** The origins of the authorization and token endpoints. */
  endpointOrigins: string[];
  /** Which ways Scarn can register itself as the client. */
  supports: { cimd: boolean; dcr: boolean };
  /** The discovery overrides the server needed to pass the checks (decision 10). */
  discovery: ManagedConnectionDiscovery;
};

export type ManagedMcpServerProbeOptions = {
  /**
   * Whether the user supplies the client, so the server needn't offer a way
   * for Scarn to register one or accept public clients.
   */
  clientSupplied: boolean;
};

/**
 * Probes an MCP server no connection uses yet: an unauthenticated
 * `initialize` must be refused with 401, then its protected-resource and
 * authorization-server metadata are fetched and checked, finding the
 * discovery overrides the server needs. Every request goes through a guard
 * that reaches only `resource`'s origin, plus the issuer's once the metadata
 * names it, plus its endpoints' origins once its metadata names them.
 *
 * Throws 422 `MANAGED_CONNECTION_RESOURCE_INVALID` for a URL Scarn may not
 * reach, 422 `MANAGED_CONNECTION_DISCOVERY_FAILED` for a server that fails a
 * check, and 502 `MANAGED_CONNECTION_PROVIDER_UNAVAILABLE` when it can't be
 * reached.
 */
export interface ManagedMcpServerProber {
  probe(
    resource: string,
    options: ManagedMcpServerProbeOptions,
  ): Promise<ManagedMcpServerProbe>;
}

export const managedConnectionResourceInvalid = (detail: string) =>
  new CoreValidationError(
    `The MCP URL can't be used: ${detail}`,
    "MANAGED_CONNECTION_RESOURCE_INVALID",
  );

export const managedConnectionDiscoveryFailed = (detail: string) =>
  new CoreValidationError(
    `Scarn couldn't sign in to this MCP server: ${detail}`,
    "MANAGED_CONNECTION_DISCOVERY_FAILED",
  );

/**
 * The issuer a fresh probe found isn't the one the user confirmed. Its
 * public `meta.issuerOrigin` is the one found now.
 */
export class ManagedConnectionIssuerChangedError extends CoreError {
  constructor(issuerOrigin: string) {
    super({
      code: "MANAGED_CONNECTION_ISSUER_CHANGED",
      message: `The server's authorization server is now ${issuerOrigin}, not the one you confirmed. Check it and try again.`,
      status: 409,
      meta: { issuerOrigin },
    });
  }
}
