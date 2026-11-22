import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  createBaseProps,
  ProjectIntegrationEntityBase,
  type CreateProjectIntegrationEntityBaseProps,
  type ProjectIntegrationEntityBaseProps,
  type ProjectIntegrationRowProps,
} from "./project-integration-entity-base";

export type BitbucketRepoRef = {
  workspace: string;
  slug: string;
  fullName: string;
};

export type BitbucketProjectIntegrationScope = {
  repos: BitbucketRepoRef[];
};

export type BitbucketProjectIntegrationProps =
  ProjectIntegrationEntityBaseProps & {
    scope: BitbucketProjectIntegrationScope;
  };

export type CreateBitbucketProjectIntegrationProps =
  CreateProjectIntegrationEntityBaseProps & {
    scope: BitbucketProjectIntegrationScope;
  };

const normalizeRepos = (
  repos: readonly BitbucketRepoRef[],
): BitbucketRepoRef[] => {
  if (repos.length === 0) {
    throw new CoreValidationError(
      "Project integration must select at least one repository",
      "PROJECT_INTEGRATION_REPOS_REQUIRED",
    );
  }
  const seen = new Set<string>();
  return repos.map((repo) => {
    const workspace = repo.workspace.trim();
    const slug = repo.slug.trim();
    const fullName = repo.fullName.trim();
    if (!workspace || !slug || !fullName) {
      throw new CoreValidationError(
        "Bitbucket integration repos must have workspace, slug and fullName",
        "PROJECT_INTEGRATION_REPO_INVALID",
      );
    }
    const key = fullName.toLowerCase();
    if (seen.has(key)) {
      throw new CoreValidationError(
        `Duplicate repository in project integration scope: ${fullName}`,
        "PROJECT_INTEGRATION_REPO_DUPLICATE",
      );
    }
    seen.add(key);
    return { workspace, slug, fullName };
  });
};

/**
 * A Bitbucket Cloud integration that reads its repositories' issues with a
 * user's Atlassian email + API token, chosen on each request. It has no
 * installation, and isn't synced on a schedule because a scheduled run has
 * no user to supply a token.
 */
export class BitbucketProjectIntegration extends ProjectIntegrationEntityBase {
  public readonly kind = "bitbucket" as const;
  public readonly platform = "bitbucket" as const;
  public readonly authMode = "user_credential" as const;
  public readonly scope: BitbucketProjectIntegrationScope;

  private constructor(props: BitbucketProjectIntegrationProps) {
    const { scope, ...baseProps } = props;
    super(baseProps, "bitbucket");
    this.scope = { repos: normalizeRepos(scope.repos) };
  }

  static create(
    props: CreateBitbucketProjectIntegrationProps,
  ): BitbucketProjectIntegration {
    return new BitbucketProjectIntegration({
      ...createBaseProps({ ...props, id: props.id ?? createUuidV7() }),
      scope: props.scope,
    });
  }

  static rehydrate(
    props: BitbucketProjectIntegrationProps,
  ): BitbucketProjectIntegration {
    return new BitbucketProjectIntegration(props);
  }

  protected withBaseProps(props: ProjectIntegrationEntityBaseProps): this {
    return new BitbucketProjectIntegration({
      ...props,
      scope: this.scope,
    }) as this;
  }

  withRepos(repos: readonly BitbucketRepoRef[]): this {
    return new BitbucketProjectIntegration({
      ...this.baseJSON(),
      scope: { repos: [...repos] },
    }) as this;
  }

  toJSON(): ProjectIntegrationRowProps {
    return {
      ...this.baseJSON(),
      kind: this.kind,
      installationId: null,
      externalScopeJson: {
        repos: this.scope.repos.map((repo) => ({
          workspace: repo.workspace,
          slug: repo.slug,
          fullName: repo.fullName,
        })),
      },
    };
  }
}
