import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  GitHubRepoScopedProjectIntegrationBase,
  normalizeGitHubScope,
  type GitHubProjectIntegrationScope,
} from "./github-repo-scoped-project-integration-base";
import {
  createBaseProps,
  type CreateProjectIntegrationEntityBaseProps,
  type ProjectIntegrationEntityBaseProps,
  type ProjectIntegrationRowProps,
} from "./project-integration-entity-base";

export type GitHubAppProjectIntegrationProps =
  ProjectIntegrationEntityBaseProps & {
    installationId: string;
    scope: GitHubProjectIntegrationScope;
  };

export type CreateGitHubAppProjectIntegrationProps =
  CreateProjectIntegrationEntityBaseProps & {
    installationId: string;
    scope: GitHubProjectIntegrationScope;
  };

/**
 * A GitHub integration that reads its repositories through a GitHub App
 * installation. The only variant with an `installationId`.
 */
export class GitHubAppProjectIntegration extends GitHubRepoScopedProjectIntegrationBase {
  public readonly kind = "github_app" as const;
  public readonly authMode = "github_app" as const;
  public readonly installationId: string;

  private constructor(props: GitHubAppProjectIntegrationProps) {
    const { installationId, ...rest } = props;
    super(rest, "github_app");
    const trimmed = installationId.trim();
    if (!trimmed) {
      throw new CoreValidationError(
        "Project integration installationId is required",
        "PROJECT_INTEGRATION_INSTALLATION_REQUIRED",
      );
    }
    this.installationId = trimmed;
  }

  static create(
    props: CreateGitHubAppProjectIntegrationProps,
  ): GitHubAppProjectIntegration {
    return new GitHubAppProjectIntegration({
      ...createBaseProps({ ...props, id: props.id ?? createUuidV7() }),
      installationId: props.installationId,
      scope: normalizeGitHubScope(props.scope),
    });
  }

  static rehydrate(
    props: GitHubAppProjectIntegrationProps,
  ): GitHubAppProjectIntegration {
    return new GitHubAppProjectIntegration(props);
  }

  protected withBaseProps(props: ProjectIntegrationEntityBaseProps): this {
    return new GitHubAppProjectIntegration({
      ...props,
      installationId: this.installationId,
      scope: this.scope,
    }) as this;
  }

  protected withScopeProps(scope: GitHubProjectIntegrationScope): this {
    return new GitHubAppProjectIntegration({
      ...this.baseJSON(),
      installationId: this.installationId,
      scope,
    }) as this;
  }

  toJSON(): ProjectIntegrationRowProps {
    return {
      ...this.baseJSON(),
      kind: this.kind,
      installationId: this.installationId,
      externalScopeJson: {
        repos: this.scope.repos.map((repo) => ({
          id: repo.id,
          fullName: repo.fullName,
        })),
      },
    };
  }
}
