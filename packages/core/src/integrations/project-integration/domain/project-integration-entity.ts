/**
 * `ProjectIntegrationEntity` is a discriminated union of per-kind variants
 * (`GitHubAppProjectIntegration`, `GitHubTokenProjectIntegration`,
 * `BitbucketProjectIntegration`, `JiraProjectIntegration`), so a wrong
 * combination of platform, connection method, installation id and scope
 * cannot be built. Callers narrow on `.kind`.
 *
 * `ProjectIntegrationEntity` is also a companion value whose
 * `create`/`rehydrate`/`fromStored` dispatch on `kind`. The stored reader
 * (`contracts/project-integration-scope-stored.ts`) rejects a scope that
 * doesn't fit its kind; `fromStored` rejects an installation id that doesn't.
 * See `entities/project-integration-entity-base.ts` for the shared lifecycle.
 */
import { CoreValidationError } from "@scarn/core/lib/errors";
import { assertNever } from "@scarn/core/lib/assert-never";
import {
  GitHubAppProjectIntegration,
  type CreateGitHubAppProjectIntegrationProps,
} from "../entities/github-app-project-integration-entity";
import {
  GitHubTokenProjectIntegration,
  type CreateGitHubTokenProjectIntegrationProps,
} from "../entities/github-token-project-integration-entity";
import {
  JiraProjectIntegration,
  type CreateJiraProjectIntegrationProps,
} from "../entities/jira-project-integration-entity";
import {
  BitbucketProjectIntegration,
  type CreateBitbucketProjectIntegrationProps,
} from "../entities/bitbucket-project-integration-entity";
import type { ProjectIntegrationRowProps } from "../entities/project-integration-entity-base";
import {
  CURRENT_PROJECT_INTEGRATION_SCHEMA_VERSION,
  readStoredProjectIntegrationScope,
  type StoredProjectIntegrationScope,
} from "../contracts/project-integration-scope-stored";

export {
  PROJECT_INTEGRATION_STATUSES,
  PROJECT_INTEGRATION_KINDS,
  PROJECT_INTEGRATION_AUTH_MODES,
  ProjectIntegrationEntityBase,
  type ProjectIntegrationStatus,
  type ProjectIntegrationKind,
  type ProjectIntegrationAuthMode,
  type ProjectIntegrationEntityBaseProps,
  type CreateProjectIntegrationEntityBaseProps,
  type ProjectIntegrationRowProps,
} from "../entities/project-integration-entity-base";
export {
  GitHubRepoScopedProjectIntegrationBase,
  type ProjectIntegrationRepoRef,
  type GitHubProjectIntegrationScope,
} from "../entities/github-repo-scoped-project-integration-base";
export {
  GitHubAppProjectIntegration,
  type GitHubAppProjectIntegrationProps,
  type CreateGitHubAppProjectIntegrationProps,
} from "../entities/github-app-project-integration-entity";
export {
  GitHubTokenProjectIntegration,
  type GitHubTokenProjectIntegrationProps,
  type CreateGitHubTokenProjectIntegrationProps,
} from "../entities/github-token-project-integration-entity";
export {
  JiraProjectIntegration,
  type JiraProjectIntegrationScope,
  type JiraProjectIntegrationProps,
  type CreateJiraProjectIntegrationProps,
} from "../entities/jira-project-integration-entity";
export {
  BitbucketProjectIntegration,
  type BitbucketRepoRef,
  type BitbucketProjectIntegrationScope,
  type BitbucketProjectIntegrationProps,
  type CreateBitbucketProjectIntegrationProps,
} from "../entities/bitbucket-project-integration-entity";

export type ProjectIntegrationEntity =
  | GitHubAppProjectIntegration
  | GitHubTokenProjectIntegration
  | BitbucketProjectIntegration
  | JiraProjectIntegration;

/** The variants that read GitHub repositories, however they authenticate. */
export type GitHubProjectIntegration =
  GitHubAppProjectIntegration | GitHubTokenProjectIntegration;

/** The variants that sign in with the requesting user's own credential. */
export type UserCredentialProjectIntegration =
  | GitHubTokenProjectIntegration
  | BitbucketProjectIntegration
  | JiraProjectIntegration;

export type CreateProjectIntegrationEntityProps =
  | (CreateGitHubAppProjectIntegrationProps & { kind: "github_app" })
  | (CreateGitHubTokenProjectIntegrationProps & { kind: "github_token" })
  | (CreateBitbucketProjectIntegrationProps & { kind: "bitbucket" })
  | (CreateJiraProjectIntegrationProps & { kind: "jira" });

export const isGitHubAppIntegration = (
  integration: ProjectIntegrationEntity,
): integration is GitHubAppProjectIntegration =>
  integration.kind === "github_app";

export const isGitHubIntegration = (
  integration: ProjectIntegrationEntity,
): integration is GitHubProjectIntegration =>
  integration.kind === "github_app" || integration.kind === "github_token";

export const isUserCredentialIntegration = (
  integration: ProjectIntegrationEntity,
): integration is UserCredentialProjectIntegration =>
  integration.authMode === "user_credential";

export const isJiraIntegration = (
  integration: ProjectIntegrationEntity,
): integration is JiraProjectIntegration => integration.kind === "jira";

export const isBitbucketIntegration = (
  integration: ProjectIntegrationEntity,
): integration is BitbucketProjectIntegration =>
  integration.kind === "bitbucket";

const rowInvalid = (kind: string, reason: string) =>
  new CoreValidationError(
    `Project integration row of kind '${kind}' is invalid: ${reason}`,
    "PROJECT_INTEGRATION_ROW_INVALID",
  );

/**
 * The flat row with its scope already read through
 * `readStoredProjectIntegrationScope`, so `kind` and `scope` agree.
 */
export type StoredProjectIntegrationRowProps = Omit<
  ProjectIntegrationRowProps,
  "kind" | "externalScopeJson"
> &
  StoredProjectIntegrationScope;

export const ProjectIntegrationEntity = {
  /** Constructs the variant matching `props.kind`. */
  create(props: CreateProjectIntegrationEntityProps): ProjectIntegrationEntity {
    switch (props.kind) {
      case "github_app":
        return GitHubAppProjectIntegration.create(props);
      case "github_token":
        return GitHubTokenProjectIntegration.create(props);
      case "bitbucket":
        return BitbucketProjectIntegration.create(props);
      case "jira":
        return JiraProjectIntegration.create(props);
      default:
        return assertNever(props);
    }
  },

  /**
   * Rehydrates the variant matching `row.kind` from the flat row shape,
   * reading its scope as the current stored version.
   */
  rehydrate(row: ProjectIntegrationRowProps): ProjectIntegrationEntity {
    const { kind, externalScopeJson, ...rest } = row;
    const read = readStoredProjectIntegrationScope(
      CURRENT_PROJECT_INTEGRATION_SCHEMA_VERSION,
      { kind, externalScopeJson },
    );
    if (!read.success) {
      throw rowInvalid(kind, "scope does not fit the kind");
    }
    return ProjectIntegrationEntity.fromStored({ ...rest, ...read.value });
  },

  /**
   * Rehydrates the variant from a row whose scope the stored reader already
   * parsed. Write-time scope rules are not re-applied.
   */
  fromStored(row: StoredProjectIntegrationRowProps): ProjectIntegrationEntity {
    const { installationId, ...base } = row;
    switch (base.kind) {
      case "github_app": {
        const { kind, ...props } = base;
        if (installationId === null) {
          throw rowInvalid(kind, "installationId is required");
        }
        return GitHubAppProjectIntegration.rehydrate({
          ...props,
          installationId,
        });
      }
      case "github_token": {
        const { kind, ...props } = base;
        if (installationId !== null) {
          throw rowInvalid(kind, "installationId is not allowed");
        }
        return GitHubTokenProjectIntegration.rehydrate(props);
      }
      case "bitbucket": {
        const { kind, ...props } = base;
        if (installationId !== null) {
          throw rowInvalid(kind, "installationId is not allowed");
        }
        return BitbucketProjectIntegration.rehydrate(props);
      }
      case "jira": {
        const { kind, ...props } = base;
        if (installationId !== null) {
          throw rowInvalid(kind, "installationId is not allowed");
        }
        return JiraProjectIntegration.rehydrate(props);
      }
      default:
        return assertNever(base);
    }
  },
};
