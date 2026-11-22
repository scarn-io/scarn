import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  GitHubRepoScopedProjectIntegrationBase,
  type GitHubProjectIntegrationScope,
} from "./github-repo-scoped-project-integration-base";
import {
  createBaseProps,
  type CreateProjectIntegrationEntityBaseProps,
  type ProjectIntegrationEntityBaseProps,
  type ProjectIntegrationRowProps,
} from "./project-integration-entity-base";

export type GitHubTokenProjectIntegrationProps =
  ProjectIntegrationEntityBaseProps & {
    scope: GitHubProjectIntegrationScope;
  };

export type CreateGitHubTokenProjectIntegrationProps =
  CreateProjectIntegrationEntityBaseProps & {
    scope: GitHubProjectIntegrationScope;
  };

/**
 * A GitHub integration that reads its repositories with a user's personal
 * access token, chosen on each request. It has no installation. It syncs on a
 * schedule only while a project member lends it a saved GitHub token
 * (`syncSecretId`); otherwise a scheduled run has no token to use.
 */
export class GitHubTokenProjectIntegration extends GitHubRepoScopedProjectIntegrationBase {
  public readonly kind = "github_token" as const;
  public readonly authMode = "user_credential" as const;

  private constructor(props: GitHubTokenProjectIntegrationProps) {
    super(props, "github_token");
  }

  static create(
    props: CreateGitHubTokenProjectIntegrationProps,
  ): GitHubTokenProjectIntegration {
    return new GitHubTokenProjectIntegration({
      ...createBaseProps({ ...props, id: props.id ?? createUuidV7() }),
      scope: props.scope,
    });
  }

  static rehydrate(
    props: GitHubTokenProjectIntegrationProps,
  ): GitHubTokenProjectIntegration {
    return new GitHubTokenProjectIntegration(props);
  }

  protected withBaseProps(props: ProjectIntegrationEntityBaseProps): this {
    return new GitHubTokenProjectIntegration({
      ...props,
      scope: this.scope,
    }) as this;
  }

  protected withScopeProps(scope: GitHubProjectIntegrationScope): this {
    return new GitHubTokenProjectIntegration({
      ...this.baseJSON(),
      scope,
    }) as this;
  }

  toJSON(): ProjectIntegrationRowProps {
    return {
      ...this.baseJSON(),
      kind: this.kind,
      installationId: null,
      externalScopeJson: {
        repos: this.scope.repos.map((repo) => ({
          id: repo.id,
          fullName: repo.fullName,
        })),
      },
    };
  }
}
