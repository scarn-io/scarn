import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import { managedOAuthClients } from "@scarn/core/lib/db/schema";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  MANAGED_OAUTH_LOOPBACK_FALLBACK_REDIRECT_URI,
  MANAGED_OAUTH_LOOPBACK_REDIRECT_URI,
  managedOAuthClientMetadata,
} from "../contracts/managed-oauth-client-metadata";
import { randomOAuthToken } from "../domain/managed-oauth-digests";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import {
  managedConnectionProviderUnavailable,
  managedConnectionVersionConflict,
} from "../application/managed-connection-access";
import {
  managedOAuthClientConfigurationError,
  type ManagedOAuthClientRegistry,
} from "../application/managed-oauth-client-registry";
import type {
  ManagedOAuthClientIdentity,
  ManagedOAuthServerMetadata,
} from "../application/oauth-provider";
import type { ManagedOAuthAuthorizeProbe } from "../application/managed-oauth-authorize-probe";
import { cimdClientIdentity } from "./cimd-client-registry";
import { managedOAuthAuthorizationUrl } from "./managed-oauth-authorization-url";
import type { ManagedConnectionGuards } from "./managed-connection-guards";

export type DcrClientRegistryOptions = {
  /** The API's public base URL including `/api`, or null when it isn't configured. */
  apiBaseUrl: string | null;
  /** Registration goes through the connection's own guard (decision 46). */
  guards: ManagedConnectionGuards;
  /** Learns whether a server lets a loopback redirect's port vary. */
  authorizeProbe: ManagedOAuthAuthorizeProbe;
  timeProvider: TimeProvider;
};

/**
 * Only the fields Scarn checks. Anything else the server sent (a
 * registration access token, its own metadata) is ignored and never kept.
 */
const registrationResponseSchema = z.object({
  client_id: z.string().trim().min(1),
  client_secret: z.unknown().optional(),
  token_endpoint_auth_method: z.string().optional(),
  redirect_uris: z.array(z.string()).optional(),
});

/**
 * Whether a parsed registration response describes the public client Scarn
 * asked for: no secret, no other auth method, and no redirect URI but
 * Scarn's. Fields the server left out are taken as Scarn requested them.
 */
const isPublicClientFor = (
  registration: z.infer<typeof registrationResponseSchema>,
  redirectUri: string,
): boolean =>
  registration.client_secret === undefined &&
  (registration.token_endpoint_auth_method === undefined ||
    registration.token_endpoint_auth_method === "none") &&
  (registration.redirect_uris === undefined ||
    registration.redirect_uris.every((uri) => uri === redirectUri));

/**
 * Dynamic client registration (RFC 7591, ADR 0013 decision 43). Scarn
 * registers once per authorization server and redirect URI, the first time
 * a connection to that server starts, and stores the client in
 * `managed_oauth_clients`; later connects, from any project, reuse it. Each
 * environment has its own `APP_URL`, so its own redirect URI and client.
 * CLI sign-ins use separate clients, registered for the portless loopback
 * redirect and, for servers that match redirects exactly, the fixed fallback
 * port (decision 7); a live fallback client records that its issuer is strict.
 * Concurrent first registrations both complete, but only one is stored:
 * the others are abandoned and use the stored one. The registration
 * response is read for its client ID only; it is never logged, stored or
 * returned.
 */
export class DcrClientRegistry implements ManagedOAuthClientRegistry {
  private readonly options: DcrClientRegistryOptions;

  constructor(options: DcrClientRegistryOptions) {
    this.options = options;
  }

  async resolve(
    server: ManagedConnectionServer,
    metadata: ManagedOAuthServerMetadata,
    loopbackRedirectUri: string | null,
  ): Promise<ManagedOAuthClientIdentity> {
    if (loopbackRedirectUri !== null) {
      return await this.resolveLoopback(server, metadata, loopbackRedirectUri);
    }
    const { redirectUri } = cimdClientIdentity(this.options.apiBaseUrl);
    return {
      clientId: await this.clientFor(server, metadata, redirectUri),
      redirectUri,
    };
  }

  /**
   * A loopback attempt (decision 7). An issuer known to match redirects
   * exactly, by its live fixed-port client, gets that client and the fixed
   * port. Otherwise the portless client is probed with the CLI's redirect:
   * a 4xx marks the issuer strict and falls back to the fixed port, anything
   * else keeps the CLI's port.
   */
  private async resolveLoopback(
    server: ManagedConnectionServer,
    metadata: ManagedOAuthServerMetadata,
    cliRedirectUri: string,
  ): Promise<ManagedOAuthClientIdentity> {
    const fallback = await this.findLive(
      metadata.issuer,
      MANAGED_OAUTH_LOOPBACK_FALLBACK_REDIRECT_URI,
    );
    if (fallback) {
      return {
        clientId: fallback,
        redirectUri: MANAGED_OAUTH_LOOPBACK_FALLBACK_REDIRECT_URI,
      };
    }
    const portless = await this.clientFor(
      server,
      metadata,
      MANAGED_OAUTH_LOOPBACK_REDIRECT_URI,
    );
    const probed = await this.options.authorizeProbe.probe(
      server,
      managedOAuthAuthorizationUrl({
        metadata,
        clientId: portless,
        redirectUri: cliRedirectUri,
        state: randomOAuthToken(),
        pkceVerifier: randomOAuthToken(),
        scopes: server.scopes ?? metadata.scopesSupported,
      }),
    );
    if (probed !== "rejected") {
      return { clientId: portless, redirectUri: cliRedirectUri };
    }
    return {
      clientId: await this.clientFor(
        server,
        metadata,
        MANAGED_OAUTH_LOOPBACK_FALLBACK_REDIRECT_URI,
      ),
      redirectUri: MANAGED_OAUTH_LOOPBACK_FALLBACK_REDIRECT_URI,
    };
  }

  /** The live client for `(issuer, redirectUri)`, registering and storing one first if there is none. */
  private async clientFor(
    server: ManagedConnectionServer,
    metadata: ManagedOAuthServerMetadata,
    redirectUri: string,
  ): Promise<string> {
    const stored = await this.findLive(metadata.issuer, redirectUri);
    if (stored) {
      return stored;
    }
    const registered = await this.register(server, metadata, redirectUri);
    await getDb()
      .insert(managedOAuthClients)
      .values({
        id: createUuidV7(),
        issuer: metadata.issuer,
        redirectUri,
        clientId: registered,
        registeredAt: this.options.timeProvider.now(),
      })
      .onConflictDoNothing({
        target: [managedOAuthClients.issuer, managedOAuthClients.redirectUri],
        where: sql`${managedOAuthClients.staleAt} IS NULL`,
      });
    const winner = await this.findLive(metadata.issuer, redirectUri);
    if (!winner) {
      throw managedConnectionVersionConflict();
    }
    return winner;
  }

  async markStale(issuer: string, clientId: string): Promise<void> {
    await getDb()
      .update(managedOAuthClients)
      .set({ staleAt: this.options.timeProvider.now() })
      .where(
        and(
          eq(managedOAuthClients.issuer, issuer),
          eq(managedOAuthClients.clientId, clientId),
          isNull(managedOAuthClients.staleAt),
        ),
      );
  }

  private async findLive(
    issuer: string,
    redirectUri: string,
  ): Promise<string | null> {
    const [row] = await getDb()
      .select({ clientId: managedOAuthClients.clientId })
      .from(managedOAuthClients)
      .where(
        and(
          eq(managedOAuthClients.issuer, issuer),
          eq(managedOAuthClients.redirectUri, redirectUri),
          isNull(managedOAuthClients.staleAt),
        ),
      )
      .limit(1);
    return row?.clientId ?? null;
  }

  /** Registers a public client and returns its ID. A 4xx or unusable response is a configuration failure. */
  private async register(
    server: ManagedConnectionServer,
    metadata: ManagedOAuthServerMetadata,
    redirectUri: string,
  ): Promise<string> {
    if (metadata.registrationEndpoint === null) {
      throw managedOAuthClientConfigurationError();
    }
    let status: number;
    let body: string;
    try {
      const response = await this.options.guards
        .for(server)
        .request(metadata.registrationEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(managedOAuthClientMetadata(redirectUri)),
        });
      status = response.status;
      body = await response.text();
    } catch {
      throw managedConnectionProviderUnavailable();
    }
    if (status >= 500) {
      throw managedConnectionProviderUnavailable();
    }
    if (status !== 200 && status !== 201) {
      throw managedOAuthClientConfigurationError();
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw managedOAuthClientConfigurationError();
    }
    const parsed = registrationResponseSchema.safeParse(json);
    if (!parsed.success || !isPublicClientFor(parsed.data, redirectUri)) {
      throw managedOAuthClientConfigurationError();
    }
    return parsed.data.client_id;
  }
}
