/**
 * `SecretEntity` is a discriminated union of per-kind classes
 * (`JiraApiKeySecretEntity`, `GitHubTokenSecretEntity`,
 * `BitbucketApiTokenSecretEntity`, owned by a user; `ProjectSecretEntity`,
 * owned by a project), so each kind carries exactly the owner, metadata and
 * expiry rules that apply to it. Callers narrow on `.kind`.
 *
 * `SecretEntity` is also a companion value whose `create`/`rehydrate`
 * dispatch on `kind`. See `entities/secret-entity-base.ts` for the shared
 * behaviour.
 */
import { z } from "zod";
import { CoreValidationError } from "@scarn/core/lib/errors";
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
  type SecretRowProps,
} from "../entities/secret-entity-base";
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

const storedEmailMetadataSchema = z.object({ email: z.string() });

const storedGitHubTokenMetadataSchema = z.object({
  login: z.string().nullable(),
});

const unsupportedKind = (kind: string) =>
  new CoreValidationError(
    `Secret kind '${kind}' is not supported`,
    "SECRET_KIND_UNSUPPORTED",
  );

const parseMetadata = <T>(
  schema: z.ZodType<T>,
  metadataJson: SecretRowProps["metadataJson"],
  kind: string,
  shape: string,
): T => {
  const parsed = schema.safeParse(metadataJson);
  if (!parsed.success) {
    throw new CoreValidationError(
      `Secret of kind '${kind}' requires metadata: ${shape}`,
      "SECRET_METADATA_INVALID",
    );
  }
  return parsed.data;
};

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

  /** Rehydrates the variant matching `row.kind` from the flat row shape. */
  rehydrate(row: SecretRowProps): SecretEntity {
    const { kind, valueKind, metadataJson, expiresAt, owner, ...base } = row;
    const untrustedKind: string = kind;
    switch (untrustedKind) {
      case "jira_api_key":
        return JiraApiKeySecretEntity.rehydrate({
          ...base,
          owner: userOwner(owner, untrustedKind),
          metadata: parseMetadata(
            storedEmailMetadataSchema,
            metadataJson,
            untrustedKind,
            "{ email }",
          ),
          expiresAt: requireExpiry(expiresAt, untrustedKind),
        });
      case "github_token":
        return GitHubTokenSecretEntity.rehydrate({
          ...base,
          owner: userOwner(owner, untrustedKind),
          metadata: parseMetadata(
            storedGitHubTokenMetadataSchema,
            metadataJson,
            untrustedKind,
            "{ login }",
          ),
          expiresAt,
        });
      case "bitbucket_api_token":
        return BitbucketApiTokenSecretEntity.rehydrate({
          ...base,
          owner: userOwner(owner, untrustedKind),
          metadata: parseMetadata(
            storedEmailMetadataSchema,
            metadataJson,
            untrustedKind,
            "{ email }",
          ),
          expiresAt: requireExpiry(expiresAt, untrustedKind),
        });
      case "project_secret":
        return ProjectSecretEntity.rehydrate({
          ...base,
          owner: projectOwner(owner, untrustedKind),
          valueKind,
        });
      default:
        throw unsupportedKind(untrustedKind);
    }
  },
};
