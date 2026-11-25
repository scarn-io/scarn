import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import {
  normalizeSecretName,
  SecretEntityBase,
  type SecretEntityBaseProps,
  type SecretRowProps,
} from "./secret-entity-base";
import type { UserSecretOwner } from "../domain/secret-owner";
import { assertSecretExpiryInFuture } from "./secret-field-rules";

/** `login` is the GitHub account the token belongs to, when known. */
export type GitHubTokenSecretMetadata = { login: string | null };

export type GitHubTokenSecretEntityProps =
  SecretEntityBaseProps<UserSecretOwner> & {
    metadata: GitHubTokenSecretMetadata;
    expiresAt: Date | null;
  };

export type CreateGitHubTokenSecretEntityProps = Omit<
  GitHubTokenSecretEntityProps,
  "id" | "lastUsedAt" | "createdAt" | "updatedAt"
> & {
  id?: UuidV7 | undefined;
  now: Date;
};

const normalizeLogin = (login: string | null): string | null => {
  const trimmed = login?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * A user's GitHub personal access token, fine-grained or classic. Classic
 * tokens can be set to never expire, so `expiresAt` is optional.
 */
export class GitHubTokenSecretEntity extends SecretEntityBase<UserSecretOwner> {
  public readonly kind = "github_token" as const;
  public readonly metadata: GitHubTokenSecretMetadata;
  public readonly expiresAt: Date | null;

  private constructor(props: GitHubTokenSecretEntityProps) {
    const { metadata, expiresAt, ...baseProps } = props;
    super(baseProps, "github_token");
    this.metadata = metadata;
    this.expiresAt = expiresAt;
  }

  static create(
    props: CreateGitHubTokenSecretEntityProps,
  ): GitHubTokenSecretEntity {
    const { now, id, ...rest } = props;
    if (rest.expiresAt) {
      assertSecretExpiryInFuture(rest.expiresAt, now, "GitHub token");
    }
    return new GitHubTokenSecretEntity({
      ...rest,
      name: normalizeSecretName(rest.name),
      metadata: { login: normalizeLogin(rest.metadata.login) },
      id: id ?? createUuidV7(),
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static rehydrate(
    props: GitHubTokenSecretEntityProps,
  ): GitHubTokenSecretEntity {
    return new GitHubTokenSecretEntity(props);
  }

  protected withBaseProps(props: SecretEntityBaseProps<UserSecretOwner>): this {
    return new GitHubTokenSecretEntity({
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
      metadataJson: { login: this.metadata.login },
      expiresAt: this.expiresAt,
    };
  }
}
