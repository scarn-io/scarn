import { z } from "zod";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ManagedRevocationOutcome } from "../domain/managed-connection-event";
import type { ManagedOAuthAttemptFailureCode } from "../domain/managed-oauth-attempt-entity";
import type {
  ManagedOAuthAuthorizationRequest,
  ManagedOAuthExchangeRequest,
  ManagedOAuthExchangeResult,
  ManagedOAuthProvider,
  ManagedOAuthRefreshRequest,
  ManagedOAuthRefreshResult,
  ManagedOAuthRevokeRequest,
  ManagedOAuthServerMetadata,
} from "../application/oauth-provider";
import type {
  ManagedGrantCredentials,
  ManagedGrantIdentity,
} from "../application/managed-grant-crypto";
import type { ManagedConnectionPreset } from "../application/managed-connection-preset";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import { OutboundRequestError, type GuardedFetch } from "./guarded-fetch";
import { managedOAuthAuthorizationUrl } from "./managed-oauth-authorization-url";
import { fetchMcpOAuthMetadata } from "./mcp-oauth-metadata";
import { exchangeFailureOf, refreshFailureOf } from "./mcp-token-errors";

export const MANAGED_OAUTH_DISCOVERY_CACHE_MS = 5 * 60 * 1000;

export type McpOAuthProviderOptions = {
  guardedFetch: GuardedFetch;
  timeProvider: TimeProvider;
  server: ManagedConnectionServer;
  /** The preset the connection was created from, or null for a custom server. */
  preset: ManagedConnectionPreset | null;
};

const NO_IDENTITY: ManagedGrantIdentity = {
  userId: null,
  userName: null,
  workspaceId: null,
  workspaceName: null,
};

/** Only the standard fields Scarn uses; identity is read separately and anything else is ignored. */
const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.unknown().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

const nonEmpty = (value: string | null | undefined): string | null =>
  value?.trim() ? value : null;

/**
 * The scopes a token response's `scope` names. RFC 6749 separates them with
 * spaces; Slack uses commas on refresh, so both are accepted.
 */
export const parseGrantedScopes = (scope: string): string[] =>
  scope.split(/[\s,]+/u).filter(Boolean);

const formBody = (fields: Record<string, string>): string =>
  new URLSearchParams(fields).toString();

const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  accept: "application/json",
};

/**
 * One connection's MCP server as a managed OAuth provider, built from the
 * connection's stored server plus its preset, if any. Scarn is a public
 * client (PKCE S256, no secret). The `client_id` sent is the attempt's or
 * the grant's, from the client registry when the attempt was opened, so a
 * grant keeps working on its own client after the registry moves on.
 * Discovery is cached in memory for at most five minutes; an
 * instance serves one `(resource, issuerOrigin)`, so the cache is keyed by it.
 */
export class McpOAuthProvider implements ManagedOAuthProvider {
  private readonly guardedFetch: GuardedFetch;
  private readonly timeProvider: TimeProvider;
  private readonly server: ManagedConnectionServer;
  private readonly preset: ManagedConnectionPreset | null;
  private cached: {
    metadata: Promise<ManagedOAuthServerMetadata>;
    expiresAt: number;
  } | null = null;

  constructor(options: McpOAuthProviderOptions) {
    this.guardedFetch = options.guardedFetch;
    this.timeProvider = options.timeProvider;
    this.server = options.server;
    this.preset = options.preset;
  }

  discover(): Promise<ManagedOAuthServerMetadata> {
    const now = this.timeProvider.now().getTime();
    if (this.cached && now < this.cached.expiresAt) {
      return this.cached.metadata;
    }
    const metadata = fetchMcpOAuthMetadata(this.guardedFetch, this.server, {
      requireIssParameter: this.preset?.requireIssParameter ?? false,
    });
    const entry = {
      metadata,
      expiresAt: now + MANAGED_OAUTH_DISCOVERY_CACHE_MS,
    };
    this.cached = entry;
    metadata.catch(() => {
      if (this.cached === entry) {
        this.cached = null;
      }
    });
    return metadata;
  }

  private get tokenErrors() {
    return this.server.discovery?.tokenErrors;
  }

  requiresIssParameter(metadata: ManagedOAuthServerMetadata): boolean {
    return (
      metadata.issParameterSupported ||
      (this.preset?.requireIssParameter ?? false)
    );
  }

  async authorizationUrl({
    attempt,
    state,
    pkceVerifier,
  }: ManagedOAuthAuthorizationRequest): Promise<string> {
    return managedOAuthAuthorizationUrl({
      metadata: await this.discover(),
      clientId: attempt.clientId,
      redirectUri: attempt.redirectUri,
      state,
      pkceVerifier,
      scopes: attempt.requestedScopes,
    });
  }

  async exchangeCode({
    attempt,
    code,
    pkceVerifier,
  }: ManagedOAuthExchangeRequest): Promise<ManagedOAuthExchangeResult> {
    let metadata: ManagedOAuthServerMetadata;
    try {
      metadata = await this.discover();
    } catch {
      return { status: "failed", failureCode: "provider_error" };
    }

    let status: number;
    let body: string;
    try {
      const response = await this.guardedFetch.request(metadata.tokenEndpoint, {
        method: "POST",
        headers: FORM_HEADERS,
        body: formBody({
          grant_type: "authorization_code",
          code,
          redirect_uri: attempt.redirectUri,
          client_id: attempt.clientId,
          code_verifier: pkceVerifier,
          resource: metadata.resource,
        }),
      });
      status = response.status;
      body = await response.text();
    } catch (error) {
      return {
        status: "failed",
        failureCode:
          error instanceof OutboundRequestError && error.failure === "blocked"
            ? "exchange_failed"
            : "exchange_unknown",
      };
    }

    const failureCode = exchangeFailureOf(status, body, this.tokenErrors);
    if (failureCode !== null) {
      return { status: "failed", failureCode };
    }
    return this.parseTokenResponse(metadata, body, attempt.requestedScopes);
  }

  async refresh({
    grant,
    credentials,
  }: ManagedOAuthRefreshRequest): Promise<ManagedOAuthRefreshResult> {
    let metadata: ManagedOAuthServerMetadata;
    try {
      metadata = await this.discover();
    } catch {
      return { status: "not_attempted" };
    }

    let status: number;
    let body: string;
    try {
      const response = await this.guardedFetch.request(metadata.tokenEndpoint, {
        method: "POST",
        headers: FORM_HEADERS,
        body: formBody({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: grant.clientId,
          resource: metadata.resource,
        }),
      });
      status = response.status;
      body = await response.text();
    } catch (error) {
      return error instanceof OutboundRequestError &&
        (error.failure === "blocked" || error.failure === "unreachable")
        ? { status: "not_attempted" }
        : { status: "unknown" };
    }

    return (
      refreshFailureOf(status, body, this.tokenErrors) ??
      this.parseRefreshResponse(body, credentials)
    );
  }

  async revoke({
    grant,
    credentials,
  }: ManagedOAuthRevokeRequest): Promise<ManagedRevocationOutcome> {
    let metadata: ManagedOAuthServerMetadata;
    try {
      metadata = await this.discover();
    } catch {
      return "failed";
    }
    if (metadata.revocationEndpoint === null) {
      return "unconfirmed";
    }
    try {
      const response = await this.guardedFetch.request(
        metadata.revocationEndpoint,
        {
          method: "POST",
          headers: FORM_HEADERS,
          body: formBody({
            token: credentials.refreshToken,
            token_type_hint: "refresh_token",
            client_id: grant.clientId,
          }),
        },
      );
      await response.discard();
      return response.status === 200 ? "accepted" : "failed";
    } catch (error) {
      return error instanceof OutboundRequestError &&
        error.failure === "blocked"
        ? "failed"
        : "unconfirmed";
    }
  }

  private parseTokenResponse(
    metadata: ManagedOAuthServerMetadata,
    body: string,
    requestedScopes: readonly string[],
  ): ManagedOAuthExchangeResult {
    const fail = (failureCode: ManagedOAuthAttemptFailureCode) =>
      ({ status: "failed", failureCode }) as const;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return fail("exchange_failed");
    }
    const parsed = tokenResponseSchema.safeParse(json);
    const parseIdentity = this.preset?.parseIdentity;
    const identity = parseIdentity ? parseIdentity(json) : NO_IDENTITY;
    if (!parsed.success || !identity) {
      return fail("exchange_failed");
    }
    const token = parsed.data;
    const accessToken = nonEmpty(token.access_token);
    if (!accessToken) {
      return fail("exchange_failed");
    }
    if (token.token_type?.toLowerCase() !== "bearer") {
      return fail("exchange_failed");
    }
    const expiry = expiresInSchema.safeParse(token.expires_in);
    if (!expiry.success) {
      return fail("missing_expiry");
    }
    const refreshToken = nonEmpty(token.refresh_token);
    if (!refreshToken) {
      return fail("missing_refresh");
    }
    const grantedScopes =
      token.scope === undefined
        ? [...requestedScopes]
        : parseGrantedScopes(token.scope);
    if (parseIdentity && !identity.userId && !identity.workspaceId) {
      return fail("missing_identity");
    }

    const authorizedAt = this.timeProvider.now();
    return {
      status: "succeeded",
      issuer: metadata.issuer,
      resource: metadata.resource,
      credentials: {
        accessToken,
        tokenType: "bearer",
        accessExpiresAt: new Date(authorizedAt.getTime() + expiry.data * 1000),
        refreshToken,
      },
      identity,
      grantedScopes,
      authorizedAt,
    };
  }

  private parseRefreshResponse(
    body: string,
    previous: ManagedGrantCredentials,
  ): ManagedOAuthRefreshResult {
    const unknown = { status: "unknown" } as const;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return unknown;
    }
    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      return unknown;
    }
    const token = parsed.data;
    const accessToken = nonEmpty(token.access_token);
    if (!accessToken || token.token_type?.toLowerCase() !== "bearer") {
      return unknown;
    }
    const expiry = expiresInSchema.safeParse(token.expires_in);
    if (!expiry.success) {
      return unknown;
    }
    const now = this.timeProvider.now();
    return {
      status: "refreshed",
      credentials: {
        accessToken,
        tokenType: "bearer",
        accessExpiresAt: new Date(now.getTime() + expiry.data * 1000),
        refreshToken: nonEmpty(token.refresh_token) ?? previous.refreshToken,
      },
    };
  }
}

const expiresInSchema = z.number().positive();
