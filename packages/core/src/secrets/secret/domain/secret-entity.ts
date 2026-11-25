/**
 * `SecretEntity` is a discriminated union of per-kind classes
 * (`JiraApiKeySecretEntity`, `GitHubTokenSecretEntity`,
 * `BitbucketApiTokenSecretEntity`, owned by a user; `ProjectSecretEntity`,
 * owned by a project), so each kind carries exactly the owner, metadata and
 * expiry rules that apply to it. Callers narrow on `.kind`.
 *
 * `SecretEntity` is also a companion value whose `create`/`rehydrate`/
 * `fromStored` dispatch on `kind`. The stored reader
 * (`contracts/secret-metadata-stored.ts`) rejects metadata that doesn't fit
 * its kind; `fromStored` rejects an owner or expiry that doesn't. See
 * `entities/secret-entity-base.ts` for the shared behaviour.
 */
import { CoreValidationError } from "@scarn/core/lib/errors";
import { assertNever } from "@scarn/core/lib/assert-never";
import {
  JiraApiKeySecretEntity,
  type CreateJiraApiKeySecretEntityProps,
} from "../entities/jira-api-key-secret-entity";
import {
  GitHubTokenSecretEntity,
  type CreateGitHubTokenSecretEntityProps,
} from "../entities/github-token-secret-entity";
import {
  BitbucketApiTokenSecretEntity,
  type CreateBitbucketApiTokenSecretEntityProps,
} from "../entities/bitbucket-api-token-secret-entity";
import {
  ProjectSecretEntity,
  type CreateProjectSecretEntityProps,
} from "../entities/project-secret-entity";
import {
  assertOwnerMatchesKind,
  secretKindValues,
  type SecretRowProps,
} from "../entities/secret-entity-base";
import {
  CURRENT_SECRET_SCHEMA_VERSION,
  readStoredSecretMetadata,
  type StoredSecretMetadata,
} from "../contracts/secret-metadata-stored";
import type {
  ProjectSecretOwner,
  SecretOwner,
  UserSecretOwner,
} from "./secret-owner";

export {
  secretKindValues,
  secretStatusValues,
  secretValueKindValues,
  SECRET_KIND_OWNER_TYPE,
  SECRET_NAME_MAX_LENGTH,
  SecretEntityBase,
  secretExpiredError,
  type SecretKind,
  type SecretStatus,
  type SecretValueKind,
  type SecretEntityBaseProps,
  type SecretRowProps,
} from "../entities/secret-entity-base";
export {
  JiraApiKeySecretEntity,
  type JiraApiKeySecretMetadata,
  type JiraApiKeySecretEntityProps,
  type CreateJiraApiKeySecretEntityProps,
} from "../entities/jira-api-key-secret-entity";
export {
  GitHubTokenSecretEntity,
  type GitHubTokenSecretMetadata,
  type GitHubTokenSecretEntityProps,
  type CreateGitHubTokenSecretEntityProps,
} from "../entities/github-token-secret-entity";
export {
  BitbucketApiTokenSecretEntity,
  type BitbucketApiTokenSecretMetadata,
  type BitbucketApiTokenSecretEntityProps,
  type CreateBitbucketApiTokenSecretEntityProps,
} from "../entities/bitbucket-api-token-secret-entity";
export {
  ProjectSecretEntity,
  normalizeProjectSecretName,
  type ProjectSecretEntityProps,
  type CreateProjectSecretEntityProps,
} from "../entities/project-secret-entity";

export type SecretEntity =
  | JiraApiKeySecretEntity
  | GitHubTokenSecretEntity
  | BitbucketApiTokenSecretEntity
  | ProjectSecretEntity;

/** The kinds a user may own: their integration credentials. */
export type UserSecretEntity = Exclude<SecretEntity, ProjectSecretEntity>;

export type CreateSecretEntityProps =
  | (CreateJiraApiKeySecretEntityProps & { kind: "jira_api_key" })
  | (CreateGitHubTokenSecretEntityProps & { kind: "github_token" })
  | (CreateBitbucketApiTokenSecretEntityProps & {
      kind: "bitbucket_api_token";
    })
  | (CreateProjectSecretEntityProps & { kind: "project_secret" });

const unsupportedKind = (kind: string) =>
  new CoreValidationError(
    `Secret kind '${kind}' is not supported`,
    "SECRET_KIND_UNSUPPORTED",
  );

const requireExpiry = (expiresAt: Date | null, kind: string): Date => {
  if (!expiresAt) {
    throw new CoreValidationError(
      `Secret of kind '${kind}' requires expiresAt`,
      "SECRET_EXPIRY_REQUIRED",
    );
  }
  return expiresAt;
};

const userOwner = (owner: SecretOwner, kind: string): UserSecretOwner => {
  assertOwnerMatchesKind(owner, kind);
  return owner as UserSecretOwner;
};

const projectOwner = (owner: SecretOwner, kind: string): ProjectSecretOwner => {
  assertOwnerMatchesKind(owner, kind);
  return owner as ProjectSecretOwner;
};

/**
 * The flat row with its metadata already read through
 * `readStoredSecretMetadata`, so `kind` and `metadata` agree.
 */
export type StoredSecretRowProps = Omit<
  SecretRowProps,
  "kind" | "metadataJson"
> &
  StoredSecretMetadata;

export const SecretEntity = {
  /** Constructs the variant matching `props.kind`. */
  create(props: CreateSecretEntityProps): SecretEntity {
    const untrustedKind: string = props.kind;
    switch (props.kind) {
      case "jira_api_key":
        return JiraApiKeySecretEntity.create(props);
      case "github_token":
        return GitHubTokenSecretEntity.create(props);
      case "bitbucket_api_token":
        return BitbucketApiTokenSecretEntity.create(props);
      case "project_secret":
        return ProjectSecretEntity.create(props);
      default:
        throw unsupportedKind(untrustedKind);
    }
  },

  /**
   * Rehydrates the variant matching `row.kind` from the flat row shape,
   * reading its metadata as the current stored version.
   */
  rehydrate(row: SecretRowProps): SecretEntity {
    const { kind, metadataJson, ...rest } = row;
    const untrustedKind: string = kind;
    if (!(secretKindValues as readonly string[]).includes(untrustedKind)) {
      throw unsupportedKind(untrustedKind);
    }
    const read = readStoredSecretMetadata(CURRENT_SECRET_SCHEMA_VERSION, {
      kind,
      metadataJson,
    });
    if (!read.success) {
      throw new CoreValidationError(
        `Secret of kind '${kind}' has metadata that does not fit its kind`,
        "SECRET_METADATA_INVALID",
      );
    }
    return SecretEntity.fromStored({ ...rest, ...read.value });
  },

  /**
   * Rehydrates the variant from a row whose metadata the stored reader
   * already parsed. Write-time rules (name, email, login) are not re-applied.
   */
  fromStored(row: StoredSecretRowProps): SecretEntity {
    const { valueKind, expiresAt, owner, ...stored } = row;
    switch (stored.kind) {
      case "jira_api_key": {
        const { kind, ...props } = stored;
        return JiraApiKeySecretEntity.rehydrate({
          ...props,
          owner: userOwner(owner, kind),
          expiresAt: requireExpiry(expiresAt, kind),
        });
      }
      case "github_token": {
        const { kind, ...props } = stored;
        return GitHubTokenSecretEntity.rehydrate({
          ...props,
          owner: userOwner(owner, kind),
          expiresAt,
        });
      }
      case "bitbucket_api_token": {
        const { kind, ...props } = stored;
        return BitbucketApiTokenSecretEntity.rehydrate({
          ...props,
          owner: userOwner(owner, kind),
          expiresAt: requireExpiry(expiresAt, kind),
        });
      }
      case "project_secret": {
        const { kind, ...props } = stored;
        return ProjectSecretEntity.rehydrate({
          ...props,
          owner: projectOwner(owner, kind),
          valueKind,
        });
      }
      default:
        return assertNever(stored);
    }
  },
};
