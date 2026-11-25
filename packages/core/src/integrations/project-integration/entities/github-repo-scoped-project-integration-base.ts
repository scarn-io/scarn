import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  ProjectIntegrationEntityBase,
  type ProjectIntegrationEntityBaseProps,
} from "./project-integration-entity-base";

export type ProjectIntegrationRepoRef = {
  id: number;
  fullName: string;
};

export type GitHubProjectIntegrationScope = {
  repos: ProjectIntegrationRepoRef[];
};

const normalizeRepos = (
  repos: readonly ProjectIntegrationRepoRef[],
): ProjectIntegrationRepoRef[] => {
  if (repos.length === 0) {
    throw new CoreValidationError(
      "Project integration must select at least one repository",
      "PROJECT_INTEGRATION_REPOS_REQUIRED",
    );
  }
  const seen = new Set<number>();
  return repos.map((repo) => {
    const fullName = repo.fullName.trim();
    if (!Number.isInteger(repo.id) || !fullName) {
      throw new CoreValidationError(
        "Project integration repos must have id and fullName",
        "PROJECT_INTEGRATION_REPO_INVALID",
      );
    }
    if (seen.has(repo.id)) {
      throw new CoreValidationError(
        `Duplicate repository in project integration scope: ${fullName}`,
        "PROJECT_INTEGRATION_REPO_DUPLICATE",
      );
    }
    seen.add(repo.id);
    return { id: repo.id, fullName };
  });
};

/**
 * The write-time scope rules shared by the GitHub variants, applied on
 * create and on scope changes but not on rehydrate.
 */
export const normalizeGitHubScope = (
  scope: GitHubProjectIntegrationScope,
): GitHubProjectIntegrationScope => ({ repos: normalizeRepos(scope.repos) });

/**
 * Shared base for the GitHub variants, which all scope to a set of
 * repositories: the "at least one repo / no duplicate repo / id + fullName"
 * checks and `withRepos`. The variants differ only in how they authenticate.
 */
export abstract class GitHubRepoScopedProjectIntegrationBase extends ProjectIntegrationEntityBase {
  public readonly platform = "github" as const;
  public readonly scope: GitHubProjectIntegrationScope;

  protected constructor(
    props: ProjectIntegrationEntityBaseProps & {
      scope: GitHubProjectIntegrationScope;
    },
    kind: "github_app" | "github_token",
  ) {
    const { scope, ...baseProps } = props;
    super(baseProps, kind);
    this.scope = scope;
  }

  /** Rebuilds this variant with a new scope, keeping everything else. */
  protected abstract withScopeProps(scope: GitHubProjectIntegrationScope): this;

  withRepos(repos: readonly ProjectIntegrationRepoRef[]): this {
    return this.withScopeProps({ repos: normalizeRepos(repos) });
  }
}
