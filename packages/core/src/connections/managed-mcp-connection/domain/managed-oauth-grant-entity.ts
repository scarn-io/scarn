import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import type { EncryptedSecretValue } from "@scarn/core/secrets/secret/domain/encrypted-secret-value";

/** How long a grant can be used before someone has to reconnect. */
export const MANAGED_GRANT_RECONNECT_AFTER_DAYS = 180;

/**
 * How old a refresh claim must be before it is presumed lost: three times the
 * 10 s token request timeout.
 */
export const MANAGED_REFRESH_STALE_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One refresh in flight: written before the refresh token is sent. */
export type ManagedOAuthRefreshClaim = {
  claimId: UuidV7;
  claimedAt: Date;
};

/**
 * A grant's credentials are held encrypted until it is retired (replaced,
 * cancelled or disconnected); a retired grant has none.
 */
export type ManagedOAuthGrantCredentials =
  | { status: "live"; encryptedCredentials: EncryptedSecretValue }
  | { status: "retired"; retiredAt: Date };

export type ManagedOAuthGrantEntityProps = {
  id: UuidV7;
  connectionId: UuidV7;
  projectId: UuidV7;
  clientId: string;
  issuer: string;
  resource: string;
  /** Part of the credentials AAD; goes up whenever the credentials are re-encrypted. */
  credentialVersion: number;
  credentials: ManagedOAuthGrantCredentials;
  refreshClaim: ManagedOAuthRefreshClaim | null;
  encryptedIdentity: EncryptedSecretValue;
  grantedScopes: readonly string[];
  authorizedAt: Date;
  reconnectBy: Date;
  createdByUserId: UuidV7;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateManagedOAuthGrantEntityProps = {
  id: UuidV7;
  connectionId: UuidV7;
  projectId: UuidV7;
  clientId: string;
  issuer: string;
  resource: string;
  credentialVersion: number;
  encryptedCredentials: EncryptedSecretValue;
  encryptedIdentity: EncryptedSecretValue;
  grantedScopes: readonly string[];
  authorizedAt: Date;
  createdByUserId: UuidV7;
};

const requireText = (name: string, value: string) => {
  if (!value.trim()) {
    throw new CoreValidationError(
      `Managed OAuth grant requires ${name}`,
      "MANAGED_OAUTH_GRANT_INVALID",
    );
  }
};

/**
 * The tokens, identity and scopes a provider issued to a managed connection.
 * It only ever holds ciphertext: the IDs it is encrypted under come from
 * `managed-grant-aad.ts`, so the caller encrypts with the grant's `id`
 * before creating it (use `newManagedOAuthGrantId()`).
 */
export class ManagedOAuthGrantEntity {
  public readonly id: UuidV7;
  public readonly connectionId: UuidV7;
  public readonly projectId: UuidV7;
  public readonly clientId: string;
  public readonly issuer: string;
  public readonly resource: string;
  public readonly credentialVersion: number;
  public readonly credentials: ManagedOAuthGrantCredentials;
  public readonly refreshClaim: ManagedOAuthRefreshClaim | null;
  public readonly encryptedIdentity: EncryptedSecretValue;
  public readonly grantedScopes: readonly string[];
  public readonly authorizedAt: Date;
  public readonly reconnectBy: Date;
  public readonly createdByUserId: UuidV7;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  private constructor(props: ManagedOAuthGrantEntityProps) {
    requireText("clientId", props.clientId);
    requireText("issuer", props.issuer);
    requireText("resource", props.resource);
    if (
      !Number.isInteger(props.credentialVersion) ||
      props.credentialVersion < 1
    ) {
      throw new CoreValidationError(
        "Managed OAuth grant credentialVersion must be a positive integer",
        "MANAGED_OAUTH_GRANT_INVALID",
      );
    }
    if (props.credentials.status === "retired" && props.refreshClaim !== null) {
      throw new CoreValidationError(
        "A retired managed OAuth grant cannot hold a refresh claim",
        "MANAGED_OAUTH_GRANT_INVALID",
      );
    }
    this.id = props.id;
    this.connectionId = props.connectionId;
    this.projectId = props.projectId;
    this.clientId = props.clientId;
    this.issuer = props.issuer;
    this.resource = props.resource;
    this.credentialVersion = props.credentialVersion;
    this.credentials = props.credentials;
    this.refreshClaim = props.refreshClaim;
    this.encryptedIdentity = props.encryptedIdentity;
    this.grantedScopes = [...props.grantedScopes];
    this.authorizedAt = props.authorizedAt;
    this.reconnectBy = props.reconnectBy;
    this.createdByUserId = props.createdByUserId;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(
    props: CreateManagedOAuthGrantEntityProps,
  ): ManagedOAuthGrantEntity {
    const { encryptedCredentials, ...rest } = props;
    return new ManagedOAuthGrantEntity({
      ...rest,
      credentials: { status: "live", encryptedCredentials },
      refreshClaim: null,
      reconnectBy: new Date(
        props.authorizedAt.getTime() +
          MANAGED_GRANT_RECONNECT_AFTER_DAYS * DAY_MS,
      ),
      createdAt: props.authorizedAt,
      updatedAt: props.authorizedAt,
    });
  }

  static rehydrate(
    props: ManagedOAuthGrantEntityProps,
  ): ManagedOAuthGrantEntity {
    return new ManagedOAuthGrantEntity(props);
  }

  get isRetired(): boolean {
    return this.credentials.status === "retired";
  }

  /** Whether the refresh claim (if any) is old enough to be presumed lost. */
  isRefreshClaimStale(now: Date): boolean {
    return (
      this.refreshClaim !== null &&
      now.getTime() - this.refreshClaim.claimedAt.getTime() >
        MANAGED_REFRESH_STALE_MS
    );
  }

  /**
   * Marks one refresh as in flight. Rejects a retired grant and a grant whose
   * claim is still fresh; recovering a stale claim is the caller's decision.
   */
  claimRefresh(claimId: UuidV7, now: Date): ManagedOAuthGrantEntity {
    if (this.credentials.status === "retired") {
      throw new CoreError({
        code: "MANAGED_OAUTH_GRANT_RETIRED",
        message: "Cannot refresh a retired managed OAuth grant",
        status: 409,
      });
    }
    if (this.refreshClaim !== null && !this.isRefreshClaimStale(now)) {
      throw new CoreError({
        code: "MANAGED_CONNECTION_REFRESH_BUSY",
        message: "A refresh of this managed connection is already in progress",
        status: 503,
        meta: { retryAfterSeconds: 1 },
      });
    }
    return new ManagedOAuthGrantEntity({
      ...this.toJSON(),
      refreshClaim: { claimId, claimedAt: now },
      updatedAt: now,
    });
  }

  /**
   * Stores the refreshed credentials, which the caller encrypted under
   * `credentialVersion + 1`, and clears the claim.
   */
  completeRefresh(
    claimId: UuidV7,
    encryptedCredentials: EncryptedSecretValue,
    now: Date,
  ): ManagedOAuthGrantEntity {
    this.requireClaim(claimId);
    return new ManagedOAuthGrantEntity({
      ...this.toJSON(),
      credentialVersion: this.credentialVersion + 1,
      credentials: { status: "live", encryptedCredentials },
      refreshClaim: null,
      updatedAt: now,
    });
  }

  /** Clears the claim after a definite failure that left the old token valid. */
  releaseClaim(claimId: UuidV7, now: Date): ManagedOAuthGrantEntity {
    this.requireClaim(claimId);
    return new ManagedOAuthGrantEntity({
      ...this.toJSON(),
      refreshClaim: null,
      updatedAt: now,
    });
  }

  /** Drops the credential ciphertext and any refresh claim. Retiring an already-retired grant is a no-op. */
  retire(now: Date): ManagedOAuthGrantEntity {
    if (this.credentials.status === "retired") {
      return this;
    }
    return new ManagedOAuthGrantEntity({
      ...this.toJSON(),
      credentials: { status: "retired", retiredAt: now },
      refreshClaim: null,
      updatedAt: now,
    });
  }

  private requireClaim(claimId: UuidV7): void {
    if (
      this.credentials.status === "retired" ||
      this.refreshClaim?.claimId !== claimId
    ) {
      throw new CoreError({
        code: "MANAGED_CONNECTION_CHANGED",
        message: "The managed connection changed during the refresh",
        status: 409,
      });
    }
  }

  toJSON(): ManagedOAuthGrantEntityProps {
    return {
      id: this.id,
      connectionId: this.connectionId,
      projectId: this.projectId,
      clientId: this.clientId,
      issuer: this.issuer,
      resource: this.resource,
      credentialVersion: this.credentialVersion,
      credentials: this.credentials,
      refreshClaim: this.refreshClaim,
      encryptedIdentity: this.encryptedIdentity,
      grantedScopes: this.grantedScopes,
      authorizedAt: this.authorizedAt,
      reconnectBy: this.reconnectBy,
      createdByUserId: this.createdByUserId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

export const newManagedOAuthGrantId = (): UuidV7 => createUuidV7();
