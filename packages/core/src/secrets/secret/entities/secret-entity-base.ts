import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import type { EncryptedSecretValue } from "../domain/encrypted-secret-value";
import type { SecretOwner, SecretOwnerType } from "../domain/secret-owner";

export const secretKindValues = [
  "jira_api_key",
  "github_token",
  "bitbucket_api_token",
  "project_secret",
] as const;

export type SecretKind = (typeof secretKindValues)[number];

/** The only owner type each kind may have, and so the only kinds each owner type may hold. */
export const SECRET_KIND_OWNER_TYPE = {
  jira_api_key: "user",
  github_token: "user",
  bitbucket_api_token: "user",
  project_secret: "project",
} as const satisfies Record<SecretKind, SecretOwnerType>;

/** How a secret's value is obtained. Only static values exist today; OAuth comes later. */
export const secretValueKindValues = ["static"] as const;

export type SecretValueKind = (typeof secretValueKindValues)[number];

export const secretStatusValues = [
  "active",
  "expiring_soon",
  "expired",
] as const;

export type SecretStatus = (typeof secretStatusValues)[number];

export const SECRET_NAME_MAX_LENGTH = 100;

const EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000;

/** The fields every secret carries regardless of kind. */
export type SecretEntityBaseProps<O extends SecretOwner = SecretOwner> = {
  id: UuidV7;
  owner: O;
  name: string;
  encryptedValue: EncryptedSecretValue;
  lastFour: string;
  lastUsedAt: Date | null;
  /** Who last created, renamed or replaced it, when recorded. */
  updatedByUserId?: UuidV7 | null | undefined;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The flat `secrets` row shape every variant's `toJSON()` returns and
 * `SecretEntity.rehydrate` (`domain/secret-entity.ts`) dispatches on. The
 * per-kind metadata is untyped JSON here and the expiry is nullable; each
 * variant parses and tightens them.
 */
export type SecretRowProps = SecretEntityBaseProps & {
  kind: SecretKind;
  valueKind: SecretValueKind;
  metadataJson: AnyJsonValue;
  expiresAt: Date | null;
};

export const normalizeSecretName = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > SECRET_NAME_MAX_LENGTH) {
    throw new CoreValidationError(
      `Secret name must be 1-${String(SECRET_NAME_MAX_LENGTH)} characters`,
      "SECRET_NAME_INVALID",
    );
  }
  return trimmed;
};

/** Throws `SECRET_OWNER_KIND_MISMATCH` unless `owner` may hold a secret of `kind`. */
export const assertOwnerMatchesKind = (
  owner: SecretOwner,
  kind: string,
): void => {
  const allowed: SecretOwnerType | undefined =
    SECRET_KIND_OWNER_TYPE[kind as SecretKind];
  if (owner.type !== allowed) {
    throw new CoreValidationError(
      `A ${owner.type} may not own a secret of kind '${kind}'`,
      "SECRET_OWNER_KIND_MISMATCH",
    );
  }
};

export const secretExpiredError = (name: string): CoreError =>
  new CoreError({
    code: "SECRET_EXPIRED",
    message: `The saved key "${name}" has expired. Replace it in Account settings.`,
    status: 400,
  });

/**
 * Shared base for every `SecretEntity` variant. It only ever holds the
 * encrypted value: encryption and decryption happen in the application layer
 * through `SecretCipher`. Transitions return `this` so a narrowed variant
 * keeps its type.
 */
export abstract class SecretEntityBase<O extends SecretOwner = SecretOwner> {
  public abstract readonly kind: SecretKind;
  public abstract readonly expiresAt: Date | null;
  public readonly id: UuidV7;
  public readonly owner: O;
  public readonly name: string;
  public readonly encryptedValue: EncryptedSecretValue;
  public readonly lastFour: string;
  public readonly lastUsedAt: Date | null;
  public readonly updatedByUserId: UuidV7 | null;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  protected constructor(props: SecretEntityBaseProps<O>, kind: SecretKind) {
    assertOwnerMatchesKind(props.owner, kind);
    this.id = props.id;
    this.owner = props.owner;
    this.name = this.normalizeName(props.name);
    this.encryptedValue = props.encryptedValue;
    this.lastFour = props.lastFour;
    this.lastUsedAt = props.lastUsedAt;
    this.updatedByUserId = props.updatedByUserId ?? null;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  protected abstract withBaseProps(props: SecretEntityBaseProps<O>): this;

  /** The kind's name rule. Runs in the constructor, so it must not read instance fields. */
  protected normalizeName(name: string): string {
    return normalizeSecretName(name);
  }

  abstract toJSON(): SecretRowProps;

  isExpired(now: Date): boolean {
    return this.expiresAt !== null && now.getTime() >= this.expiresAt.getTime();
  }

  status(now: Date): SecretStatus {
    if (this.expiresAt === null) {
      return "active";
    }
    if (this.isExpired(now)) {
      return "expired";
    }
    return this.expiresAt.getTime() - now.getTime() <= EXPIRING_SOON_MS
      ? "expiring_soon"
      : "active";
  }

  rename(name: string, now: Date, by: UuidV7 | null = null): this {
    return this.withBaseProps({
      ...this.baseJSON(),
      name: this.normalizeName(name),
      updatedByUserId: by ?? this.updatedByUserId,
      updatedAt: now,
    });
  }

  /** Swaps in a new encrypted value (already bound to this secret's id and owner). */
  replaceValue(
    replacement: { encryptedValue: EncryptedSecretValue; lastFour: string },
    now: Date,
    by: UuidV7,
  ): this {
    return this.withBaseProps({
      ...this.baseJSON(),
      encryptedValue: replacement.encryptedValue,
      lastFour: replacement.lastFour,
      updatedByUserId: by,
      updatedAt: now,
    });
  }

  markUsed(now: Date): this {
    return this.withBaseProps({ ...this.baseJSON(), lastUsedAt: now });
  }

  assertUsable(now: Date): void {
    if (this.isExpired(now)) {
      throw secretExpiredError(this.name);
    }
  }

  protected baseJSON(): SecretEntityBaseProps<O> {
    return {
      id: this.id,
      owner: this.owner,
      name: this.name,
      encryptedValue: this.encryptedValue,
      lastFour: this.lastFour,
      lastUsedAt: this.lastUsedAt,
      updatedByUserId: this.updatedByUserId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
