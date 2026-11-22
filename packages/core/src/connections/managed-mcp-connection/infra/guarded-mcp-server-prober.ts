import { managedConnectionProviderUnavailable } from "../application/managed-connection-access";
import {
  managedConnectionDiscoveryFailed,
  managedConnectionResourceInvalid,
  type ManagedMcpServerProbe,
  type ManagedMcpServerProbeOptions,
  type ManagedMcpServerProber,
} from "../application/managed-mcp-server-prober";
import type { ManagedConnectionDiscovery } from "../domain/managed-connection-discovery";
import { OutboundRequestError, type GuardedFetch } from "./guarded-fetch";
import type { ManagedConnectionGuards } from "./managed-connection-guards";
import {
  checkAuthorizationServerMetadata,
  fetchAuthorizationServerMetadata,
  fetchProtectedResourceMetadata,
  ManagedOAuthDiscoveryError,
  wellKnownUrl,
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata,
} from "./mcp-oauth-metadata";

/**
 * {@link ManagedMcpServerProber} over guarded fetches (decision 46): the
 * first guard reaches only `resource`'s origin; the second adds the issuer's
 * origin once the protected-resource metadata names it, and the third the
 * authorization and token endpoints' origins once the issuer's metadata
 * names them. Guards come from {@link ManagedConnectionGuards} uncached,
 * since the server may never be stored.
 *
 * It finds the discovery overrides (decision 10) a server needs, each only
 * when the server deviates that way: `resourceMetadataUrl` when the
 * path-inserted metadata 404s and the 401 challenge names another URL on
 * `resource`'s origin; `advertisedResource` when the metadata names a
 * resource on that origin with another path; `endpointOrigins` for
 * authorization and token endpoints off the issuer's origin; and
 * `tokenErrors: "slack"` when the token endpoint is on one of
 * `slackTokenOrigins`.
 */

export type GuardedMcpServerProberOptions = {
  /** Origins whose token endpoints answer errors the Slack way; `https://slack.com` by default. */
  slackTokenOrigins?: readonly string[];
};

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "scarn", version: "1.0.0" },
  },
});

const RESOURCE_METADATA_PARAM =
  /(?:^|[\s,])resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/iu;

/** The `resource_metadata` URL a `WWW-Authenticate` challenge names, if any. */
export const resourceMetadataUrlOf = (
  challenge: string | null,
): string | null => {
  const match =
    challenge === null ? null : RESOURCE_METADATA_PARAM.exec(challenge);
  return match?.[1] ?? match?.[2] ?? null;
};

const originOf = (url: string): string | null => URL.parse(url)?.origin ?? null;

const isPlainUrl = (url: URL): boolean =>
  url.search === "" &&
  url.hash === "" &&
  url.username === "" &&
  url.password === "";

export class GuardedMcpServerProber implements ManagedMcpServerProber {
  private readonly slackTokenOrigins: readonly string[];

  constructor(
    private readonly guards: ManagedConnectionGuards,
    options: GuardedMcpServerProberOptions = {},
  ) {
    this.slackTokenOrigins = (
      options.slackTokenOrigins ?? ["https://slack.com"]
    ).map((origin) => new URL(origin).origin);
  }

  async probe(
    resource: string,
    options: ManagedMcpServerProbeOptions,
  ): Promise<ManagedMcpServerProbe> {
    if (!this.guards.reaches(resource)) {
      throw managedConnectionResourceInvalid("it must be an https URL");
    }
    try {
      return await this.discover(resource, options);
    } catch (error) {
      if (error instanceof ManagedOAuthDiscoveryError) {
        throw managedConnectionDiscoveryFailed(error.message);
      }
      if (error instanceof OutboundRequestError) {
        if (error.failure === "blocked") {
          throw managedConnectionResourceInvalid("Scarn may not reach it");
        }
        throw managedConnectionProviderUnavailable();
      }
      throw error;
    }
  }

  private async discover(
    resource: string,
    options: ManagedMcpServerProbeOptions,
  ): Promise<ManagedMcpServerProbe> {
    const resourceOrigin = new URL(resource).origin;
    const resourceGuard = this.guards.uncached({
      resource,
      issuerOrigin: resourceOrigin,
    });
    const challengedMetadataUrl = await this.challenge(resourceGuard, resource);
    const { metadata: resourceMetadata, resourceMetadataUrl } =
      await this.protectedResourceMetadata(
        resourceGuard,
        resource,
        challengedMetadataUrl,
      );
    const advertisedResource = advertisedResourceOf(
      resource,
      resourceMetadata.resource,
    );
    const issuer = this.issuerOf(resourceMetadata);
    const issuerOrigin = new URL(issuer).origin;
    const metadata = await fetchAuthorizationServerMetadata(
      this.guards.uncached({ resource, issuerOrigin }),
      issuer,
    );
    const endpointOrigins = this.endpointOriginsOf(metadata);
    const extraOrigins = endpointOrigins.filter(
      (origin) => origin !== issuerOrigin,
    );
    const discovery: ManagedConnectionDiscovery = {
      ...(resourceMetadataUrl === null ? {} : { resourceMetadataUrl }),
      ...(advertisedResource === null ? {} : { advertisedResource }),
      ...(extraOrigins.length === 0 ? {} : { endpointOrigins: extraOrigins }),
      ...(this.slackTokenOrigins.includes(
        originOf(metadata.token_endpoint) ?? "",
      )
        ? { tokenErrors: "slack" as const }
        : {}),
    };
    const supports = {
      cimd: metadata.client_id_metadata_document_supported === true,
      dcr: metadata.registration_endpoint !== undefined,
    };
    checkAuthorizationServerMetadata(
      this.guards.uncached({ resource, issuerOrigin, discovery }),
      metadata,
      {
        issuerOrigin,
        endpointOrigins: extraOrigins,
        clientRegistration:
          options.clientSupplied || (!supports.cimd && !supports.dcr)
            ? "supplied"
            : null,
        policy: { requireIssParameter: false },
      },
    );
    return {
      resource,
      issuer,
      issuerOrigin,
      endpointOrigins,
      supports,
      discovery,
    };
  }

  /** The single issuer the metadata names, which Scarn must be able to reach. */
  private issuerOf(resourceMetadata: ProtectedResourceMetadata): string {
    const [issuer, ...others] = resourceMetadata.authorization_servers;
    if (issuer === undefined || others.length > 0) {
      throw new ManagedOAuthDiscoveryError(
        "Protected resource metadata must name exactly one authorization server",
      );
    }
    const issuerUrl = URL.parse(issuer);
    if (
      issuerUrl === null ||
      !isPlainUrl(issuerUrl) ||
      !this.guards.reaches(issuer)
    ) {
      throw new ManagedOAuthDiscoveryError(
        "Protected resource metadata names an authorization server Scarn may not reach",
      );
    }
    return issuer;
  }

  /** The authorization and token endpoints' origins, each one Scarn may reach. */
  private endpointOriginsOf(metadata: AuthorizationServerMetadata): string[] {
    const origins: string[] = [];
    for (const [field, endpoint] of [
      ["authorization_endpoint", metadata.authorization_endpoint],
      ["token_endpoint", metadata.token_endpoint],
    ] as const) {
      const origin = originOf(endpoint);
      if (origin === null || !this.guards.reaches(endpoint)) {
        throw new ManagedOAuthDiscoveryError(
          `Authorization server ${field} is not a URL Scarn may reach`,
        );
      }
      if (!origins.includes(origin)) {
        origins.push(origin);
      }
    }
    return origins;
  }

  /**
   * Sends an unauthenticated `initialize`, which must be refused with 401,
   * and returns the `resource_metadata` URL its challenge names.
   */
  private async challenge(
    guard: GuardedFetch,
    resource: string,
  ): Promise<string | null> {
    const response = await guard.request(resource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: INITIALIZE_BODY,
    });
    await response.discard();
    if (response.status !== 401) {
      throw new ManagedOAuthDiscoveryError(
        `An unauthenticated MCP request returned ${String(response.status)}, not 401, so the server doesn't ask for OAuth`,
      );
    }
    return resourceMetadataUrlOf(response.headers.get("www-authenticate"));
  }

  /**
   * The path-inserted protected-resource metadata or, when that 404s and the
   * challenge named another URL on `resource`'s origin, the metadata there,
   * with that URL as the `resourceMetadataUrl` override.
   */
  private async protectedResourceMetadata(
    guard: GuardedFetch,
    resource: string,
    challengedMetadataUrl: string | null,
  ): Promise<{
    metadata: ProtectedResourceMetadata;
    resourceMetadataUrl: string | null;
  }> {
    const url = wellKnownUrl(new URL(resource), "oauth-protected-resource");
    try {
      return {
        metadata: await fetchProtectedResourceMetadata(guard, url),
        resourceMetadataUrl: null,
      };
    } catch (error) {
      const fallback = URL.parse(challengedMetadataUrl ?? "");
      if (
        !(error instanceof ManagedOAuthDiscoveryError) ||
        error.status !== 404 ||
        fallback === null ||
        !isPlainUrl(fallback) ||
        fallback.origin !== new URL(resource).origin ||
        fallback.href === url
      ) {
        throw error;
      }
      return {
        metadata: await fetchProtectedResourceMetadata(guard, fallback.href),
        resourceMetadataUrl: fallback.href,
      };
    }
  }
}

/**
 * The resource the metadata names, when it isn't `resource` but differs only
 * by path; null when it is `resource`.
 */
const advertisedResourceOf = (
  resource: string,
  advertised: string,
): string | null => {
  if (advertised === resource) {
    return null;
  }
  const url = URL.parse(advertised);
  if (
    url === null ||
    !isPlainUrl(url) ||
    url.origin !== new URL(resource).origin
  ) {
    throw new ManagedOAuthDiscoveryError(
      "Protected resource metadata names a resource on another origin",
    );
  }
  return advertised;
};
