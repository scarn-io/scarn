import type { ManagedRevocationOutcome } from "../domain/managed-connection-event";
import type {
  ManagedOAuthAttemptEntity,
  ManagedOAuthAttemptFailureCode,
} from "../domain/managed-oauth-attempt-entity";
import type { ManagedOAuthGrantEntity } from "../domain/managed-oauth-grant-entity";
import type {
  ManagedGrantCredentials,
  ManagedGrantIdentity,
} from "./managed-grant-crypto";

/** The provider's checked OAuth metadata. Every endpoint is on the connection's issuer origin. */
export type ManagedOAuthServerMetadata = {
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Null when the server doesn't offer revocation. */
  revocationEndpoint: string | null;
  /** Null when the server doesn't offer dynamic client registration. */
  registrationEndpoint: string | null;
  /** Whether the server advertises `authorization_response_iss_parameter_supported`. */
  issParameterSupported: boolean;
  scopesSupported: readonly string[];
};

/** Who Scarn is to the provider: a public client, by its CIMD URL or its registered client ID. */
export type ManagedOAuthClientIdentity = {
  clientId: string;
  redirectUri: string;
};

export type ManagedOAuthAuthorizationRequest = {
  attempt: ManagedOAuthAttemptEntity;
  /** The plaintext `state`; only its digest is on the attempt. */
  state: string;
  pkceVerifier: string;
};

export type ManagedOAuthExchangeRequest = {
  attempt: ManagedOAuthAttemptEntity;
  code: string;
  pkceVerifier: string;
};

export type ManagedOAuthExchangeResult =
  | {
      status: "succeeded";
      issuer: string;
      resource: string;
      credentials: ManagedGrantCredentials;
      identity: ManagedGrantIdentity;
      grantedScopes: readonly string[];
      authorizedAt: Date;
    }
  | { status: "failed"; failureCode: ManagedOAuthAttemptFailureCode };

export type ManagedOAuthRevokeRequest = {
  grant: ManagedOAuthGrantEntity;
  credentials: ManagedGrantCredentials;
};

export type ManagedOAuthRefreshRequest = {
  grant: ManagedOAuthGrantEntity;
  credentials: ManagedGrantCredentials;
};

/**
 * How one refresh request ended. `rejected` means the refresh token is
 * definitely dead (`invalid_grant`); `client_rejected` means the server no
 * longer recognises the grant's client (`invalid_client`); `not_attempted`
 * means nothing was sent. `unknown` and `server_error` mean the provider may
 * have rotated the refresh token, so the stored one may be dead too.
 */
export type ManagedOAuthRefreshResult =
  | { status: "refreshed"; credentials: ManagedGrantCredentials }
  | { status: "rejected" }
  | { status: "client_rejected" }
  | { status: "not_attempted" }
  | { status: "unknown" }
  | { status: "server_error" };

/**
 * The OAuth provider behind a managed connection. Implementations talk only
 * to the provider's fixed origin, never return what the provider sent beyond
 * the parsed fields below, and never retry: an exchange whose outcome is
 * unknown comes back as a failure.
 */
export interface ManagedOAuthProvider {
  /** Fetches and checks the provider's metadata. Throws when it doesn't meet our requirements. */
  discover(): Promise<ManagedOAuthServerMetadata>;
  /**
   * Whether a callback must carry `iss`: always when the server advertises
   * support for it. A present `iss` must match the issuer either way.
   */
  requiresIssParameter(metadata: ManagedOAuthServerMetadata): boolean;
  authorizationUrl(request: ManagedOAuthAuthorizationRequest): Promise<string>;
  exchangeCode(
    request: ManagedOAuthExchangeRequest,
  ): Promise<ManagedOAuthExchangeResult>;
  /**
   * One `refresh_token` grant request. A response without a refresh token
   * keeps the old one; identity isn't on refresh responses and is untouched.
   */
  refresh(
    request: ManagedOAuthRefreshRequest,
  ): Promise<ManagedOAuthRefreshResult>;
  /** One revocation request; the response body is never surfaced. */
  revoke(request: ManagedOAuthRevokeRequest): Promise<ManagedRevocationOutcome>;
}
