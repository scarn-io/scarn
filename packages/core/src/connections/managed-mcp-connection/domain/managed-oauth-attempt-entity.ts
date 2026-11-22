import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import type { EncryptedSecretValue } from "@scarn/core/secrets/secret/domain/encrypted-secret-value";

/** How long an authorization attempt, and the candidate it produces, stays usable. */
export const MANAGED_OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export const managedOAuthAttemptKindValues = ["connect", "reconnect"] as const;

export type ManagedOAuthAttemptKind =
  (typeof managedOAuthAttemptKindValues)[number];

export const managedOAuthAttemptStatusValues = [
  "pending",
  "exchanging",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
] as const;

export type ManagedOAuthAttemptStatus =
  (typeof managedOAuthAttemptStatusValues)[number];

/** Safe failure codes an attempt can end with; never anything the provider sent. */
export const managedOAuthAttemptFailureCodeValues = [
  "provider_error",
  "access_denied",
  "invalid_callback",
  "exchange_failed",
  "exchange_unknown",
  "missing_refresh",
  "missing_expiry",
  "missing_identity",
  "client_configuration",
  "stale_generation",
  "permission_revoked",
] as const;

export type ManagedOAuthAttemptFailureCode =
  (typeof managedOAuthAttemptFailureCodeValues)[number];

/**
 * The PKCE verifier is held encrypted while the attempt can still be
 * exchanged, and dropped as soon as it can't.
 */
export type ManagedOAuthAttemptProgress =
  | { status: "pending"; encryptedPkceVerifier: EncryptedSecretValue }
  | { status: "exchanging"; encryptedPkceVerifier: EncryptedSecretValue }
  /** `candidateGrantId` is null once that candidate has been deleted. */
  | { status: "succeeded"; candidateGrantId: UuidV7 | null }
  | { status: "failed"; failureCode: ManagedOAuthAttemptFailureCode }
  | { status: "expired" }
  | { status: "cancelled" };

/**
 * Who may complete the attempt besides its actor. A browser attempt finishes
 * at the server's callback in the session that started it; a loopback attempt
 * is finished by the CLI holding the completion secret. Both are digests.
 */
export type ManagedOAuthAttemptBinding =
  | { kind: "browser"; sessionDigest: string }
  | { kind: "loopback"; secretDigest: string };

export type ManagedOAuthAttemptEntityProps = {
  id: UuidV7;
  connectionId: UuidV7;
  projectId: UuidV7;
  kind: ManagedOAuthAttemptKind;
  expectedGeneration: number;
  actorUserId: UuidV7;
  binding: ManagedOAuthAttemptBinding;
  stateDigest: string;
  clientId: string;
  redirectUri: string;
  requestedScopes: readonly string[];
  progress: ManagedOAuthAttemptProgress;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateManagedOAuthAttemptEntityProps = Omit<
  ManagedOAuthAttemptEntityProps,
  "progress" | "expiresAt" | "createdAt" | "updatedAt"
> & {
  encryptedPkceVerifier: EncryptedSecretValue;
  now: Date;
};

const attemptConflict = (message: string) =>
  new CoreError({
    code: "MANAGED_OAUTH_ATTEMPT_CONFLICT",
    message,
    status: 409,
  });

/**
 * One trip through the provider's consent. It is single use: `beginExchange`
 * moves it out of `pending` exactly once, and the PKCE verifier is dropped
 * once the exchange is over. The caller encrypts the verifier with the
 * attempt's `id` (use `newManagedOAuthAttemptId()`) before creating it.
 */
export class ManagedOAuthAttemptEntity {
  public readonly id: UuidV7;
  public readonly connectionId: UuidV7;
  public readonly projectId: UuidV7;
  public readonly kind: ManagedOAuthAttemptKind;
  public readonly expectedGeneration: number;
  public readonly actorUserId: UuidV7;
  public readonly binding: ManagedOAuthAttemptBinding;
  public readonly stateDigest: string;
  public readonly clientId: string;
  public readonly redirectUri: string;
  public readonly requestedScopes: readonly string[];
  public readonly progress: ManagedOAuthAttemptProgress;
  public readonly expiresAt: Date;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  private constructor(props: ManagedOAuthAttemptEntityProps) {
    if (
      !Number.isInteger(props.expectedGeneration) ||
      props.expectedGeneration < 0
    ) {
      throw new CoreValidationError(
        "Managed OAuth attempt expectedGeneration must be a non-negative integer",
        "MANAGED_OAUTH_ATTEMPT_INVALID",
      );
    }
    for (const [name, value] of [
      [
        "binding digest",
        props.binding.kind === "browser"
          ? props.binding.sessionDigest
          : props.binding.secretDigest,
      ],
      ["stateDigest", props.stateDigest],
      ["clientId", props.clientId],
      ["redirectUri", props.redirectUri],
    ] as const) {
      if (!value.trim()) {
        throw new CoreValidationError(
          `Managed OAuth attempt requires ${name}`,
          "MANAGED_OAUTH_ATTEMPT_INVALID",
        );
      }
    }
    this.id = props.id;
    this.connectionId = props.connectionId;
    this.projectId = props.projectId;
    this.kind = props.kind;
    this.expectedGeneration = props.expectedGeneration;
    this.actorUserId = props.actorUserId;
    this.binding = props.binding;
    this.stateDigest = props.stateDigest;
    this.clientId = props.clientId;
    this.redirectUri = props.redirectUri;
    this.requestedScopes = [...props.requestedScopes];
    this.progress = props.progress;
    this.expiresAt = props.expiresAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(
    props: CreateManagedOAuthAttemptEntityProps,
  ): ManagedOAuthAttemptEntity {
    const { encryptedPkceVerifier, now, ...rest } = props;
    return new ManagedOAuthAttemptEntity({
      ...rest,
      progress: { status: "pending", encryptedPkceVerifier },
      expiresAt: new Date(now.getTime() + MANAGED_OAUTH_ATTEMPT_TTL_MS),
      createdAt: now,
      updatedAt: now,
    });
  }

  static rehydrate(
    props: ManagedOAuthAttemptEntityProps,
  ): ManagedOAuthAttemptEntity {
    return new ManagedOAuthAttemptEntity(props);
  }

  get status(): ManagedOAuthAttemptStatus {
    return this.progress.status;
  }

  isExpiredAt(now: Date): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  /** Claims the single use. Throws if it was already used or has expired. */
  beginExchange(now: Date): ManagedOAuthAttemptEntity {
    if (this.progress.status !== "pending") {
      throw attemptConflict("This authorization attempt was already used.");
    }
    if (this.isExpiredAt(now)) {
      throw attemptConflict("This authorization attempt has expired.");
    }
    return this.with(
      {
        status: "exchanging",
        encryptedPkceVerifier: this.progress.encryptedPkceVerifier,
      },
      now,
    );
  }

  succeed(candidateGrantId: UuidV7, now: Date): ManagedOAuthAttemptEntity {
    if (this.progress.status !== "exchanging") {
      throw attemptConflict("This authorization attempt is not exchanging.");
    }
    return this.with({ status: "succeeded", candidateGrantId }, now);
  }

  fail(
    failureCode: ManagedOAuthAttemptFailureCode,
    now: Date,
  ): ManagedOAuthAttemptEntity {
    this.assertOpen();
    return this.with({ status: "failed", failureCode }, now);
  }

  expire(now: Date): ManagedOAuthAttemptEntity {
    this.assertOpen();
    return this.with({ status: "expired" }, now);
  }

  cancel(now: Date): ManagedOAuthAttemptEntity {
    this.assertOpen();
    return this.with({ status: "cancelled" }, now);
  }

  get isOpen(): boolean {
    return (
      this.progress.status === "pending" ||
      this.progress.status === "exchanging"
    );
  }

  toJSON(): ManagedOAuthAttemptEntityProps {
    return {
      id: this.id,
      connectionId: this.connectionId,
      projectId: this.projectId,
      kind: this.kind,
      expectedGeneration: this.expectedGeneration,
      actorUserId: this.actorUserId,
      binding: this.binding,
      stateDigest: this.stateDigest,
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      requestedScopes: this.requestedScopes,
      progress: this.progress,
      expiresAt: this.expiresAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  private assertOpen(): void {
    if (!this.isOpen) {
      throw attemptConflict(
        `This authorization attempt is already ${this.progress.status}.`,
      );
    }
  }

  private with(
    progress: ManagedOAuthAttemptProgress,
    now: Date,
  ): ManagedOAuthAttemptEntity {
    return new ManagedOAuthAttemptEntity({
      ...this.toJSON(),
      progress,
      updatedAt: now,
    });
  }
}

export const newManagedOAuthAttemptId = (): UuidV7 => createUuidV7();
