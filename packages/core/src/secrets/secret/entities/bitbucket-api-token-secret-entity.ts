import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import {
  SecretEntityBase,
  type SecretEntityBaseProps,
  type SecretRowProps,
} from "./secret-entity-base";
import type { UserSecretOwner } from "../domain/secret-owner";
import {
  assertSecretExpiryInFuture,
  normalizeSecretEmail,
} from "./secret-field-rules";

export type BitbucketApiTokenSecretMetadata = { email: string };

export type BitbucketApiTokenSecretEntityProps =
  SecretEntityBaseProps<UserSecretOwner> & {
    metadata: BitbucketApiTokenSecretMetadata;
    expiresAt: Date;
  };

export type CreateBitbucketApiTokenSecretEntityProps = Omit<
  BitbucketApiTokenSecretEntityProps,
  "id" | "lastUsedAt" | "createdAt" | "updatedAt"
> & {
  id?: UuidV7 | undefined;
  now: Date;
};

/**
 * A user's Bitbucket Cloud API token (an Atlassian scoped API token, sent as
 * basic auth with the Atlassian email). The email is non-secret metadata; the
 * token is the encrypted value. Atlassian tokens last 1–365 days, so
 * `expiresAt` is required.
 */
export class BitbucketApiTokenSecretEntity extends SecretEntityBase<UserSecretOwner> {
  public readonly kind = "bitbucket_api_token" as const;
  public readonly metadata: BitbucketApiTokenSecretMetadata;
  public readonly expiresAt: Date;

  private constructor(props: BitbucketApiTokenSecretEntityProps) {
    const { metadata, expiresAt, ...baseProps } = props;
    super(baseProps, "bitbucket_api_token");
    this.metadata = {
      email: normalizeSecretEmail(metadata.email, "Bitbucket API token"),
    };
    this.expiresAt = expiresAt;
  }

  static create(
    props: CreateBitbucketApiTokenSecretEntityProps,
  ): BitbucketApiTokenSecretEntity {
    const { now, id, ...rest } = props;
    assertSecretExpiryInFuture(rest.expiresAt, now, "Bitbucket API token");
    return new BitbucketApiTokenSecretEntity({
      ...rest,
      id: id ?? createUuidV7(),
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static rehydrate(
    props: BitbucketApiTokenSecretEntityProps,
  ): BitbucketApiTokenSecretEntity {
    return new BitbucketApiTokenSecretEntity(props);
  }

  protected withBaseProps(props: SecretEntityBaseProps<UserSecretOwner>): this {
    return new BitbucketApiTokenSecretEntity({
      ...props,
      metadata: this.metadata,
      expiresAt: this.expiresAt,
    }) as this;
  }

  toJSON(): SecretRowProps {
    return {
      ...this.baseJSON(),
      kind: this.kind,
      valueKind: "static",
      metadataJson: { email: this.metadata.email },
      expiresAt: this.expiresAt,
    };
  }
}
