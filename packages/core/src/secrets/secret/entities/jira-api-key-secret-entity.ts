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
import {
  assertSecretExpiryInFuture,
  normalizeSecretEmail,
} from "./secret-field-rules";

export type JiraApiKeySecretMetadata = { email: string };

export type JiraApiKeySecretEntityProps =
  SecretEntityBaseProps<UserSecretOwner> & {
    metadata: JiraApiKeySecretMetadata;
    expiresAt: Date;
  };

export type CreateJiraApiKeySecretEntityProps = Omit<
  JiraApiKeySecretEntityProps,
  "id" | "lastUsedAt" | "createdAt" | "updatedAt"
> & {
  id?: UuidV7 | undefined;
  now: Date;
};

/**
 * A user's Jira Cloud API token. The Atlassian email is non-secret metadata;
 * the token is the encrypted value. Atlassian tokens always expire, so
 * `expiresAt` is required.
 */
export class JiraApiKeySecretEntity extends SecretEntityBase<UserSecretOwner> {
  public readonly kind = "jira_api_key" as const;
  public readonly metadata: JiraApiKeySecretMetadata;
  public readonly expiresAt: Date;

  private constructor(props: JiraApiKeySecretEntityProps) {
    const { metadata, expiresAt, ...baseProps } = props;
    super(baseProps, "jira_api_key");
    this.metadata = metadata;
    this.expiresAt = expiresAt;
  }

  static create(
    props: CreateJiraApiKeySecretEntityProps,
  ): JiraApiKeySecretEntity {
    const { now, id, ...rest } = props;
    assertSecretExpiryInFuture(rest.expiresAt, now, "Jira API key");
    return new JiraApiKeySecretEntity({
      ...rest,
      name: normalizeSecretName(rest.name),
      metadata: {
        email: normalizeSecretEmail(rest.metadata.email, "Jira API key"),
      },
      id: id ?? createUuidV7(),
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static rehydrate(props: JiraApiKeySecretEntityProps): JiraApiKeySecretEntity {
    return new JiraApiKeySecretEntity(props);
  }

  protected withBaseProps(props: SecretEntityBaseProps<UserSecretOwner>): this {
    return new JiraApiKeySecretEntity({
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
