import { CoreValidationError } from "@scarn/core/lib/errors";
import { assertNever } from "@scarn/core/lib/assert-never";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  BitbucketProjectIntegrationScope,
  GitHubProjectIntegrationScope,
  JiraProjectIntegrationScope,
  ProjectIntegrationEntity,
} from "../domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "./project-integration-repo";

type UpdateProjectIntegrationScopeCommonInput = {
  id: UuidV7;
  projectId: UuidV7;
};

export type UpdateProjectIntegrationScopeInput =
  | (UpdateProjectIntegrationScopeCommonInput & {
      kind: "github_app";
      externalScope: GitHubProjectIntegrationScope;
    })
  | (UpdateProjectIntegrationScopeCommonInput & {
      kind: "github_token";
      externalScope: GitHubProjectIntegrationScope;
    })
  | (UpdateProjectIntegrationScopeCommonInput & {
      kind: "bitbucket";
      externalScope: BitbucketProjectIntegrationScope;
    })
  | (UpdateProjectIntegrationScopeCommonInput & {
      kind: "jira";
      externalScope: JiraProjectIntegrationScope;
    });

const kindMismatch = (expected: string, actual: string) =>
  new CoreValidationError(
    `Scope for a '${actual}' integration cannot be applied to a '${expected}' integration`,
    "PROJECT_INTEGRATION_KIND_MISMATCH",
  );

export const updateProjectIntegrationScope = async (
  input: UpdateProjectIntegrationScopeInput,
  repo: ProjectIntegrationRepo,
): Promise<ProjectIntegrationEntity> => {
  const existing = await repo.findById(input.id);
  if (!existing || existing.projectId !== input.projectId) {
    throw new CoreValidationError(
      "Project integration not found",
      "PROJECT_INTEGRATION_NOT_FOUND",
    );
  }

  switch (input.kind) {
    case "github_app":
      if (existing.kind !== input.kind) {
        throw kindMismatch(existing.kind, input.kind);
      }
      return repo.save(existing.withRepos(input.externalScope.repos));
    case "github_token":
      if (existing.kind !== input.kind) {
        throw kindMismatch(existing.kind, input.kind);
      }
      return repo.save(existing.withRepos(input.externalScope.repos));
    case "bitbucket":
      if (existing.kind !== input.kind) {
        throw kindMismatch(existing.kind, input.kind);
      }
      return repo.save(existing.withRepos(input.externalScope.repos));
    case "jira":
      if (existing.kind !== input.kind) {
        throw kindMismatch(existing.kind, input.kind);
      }
      return repo.save(existing.withJiraScope(input.externalScope));
    default:
      return assertNever(input);
  }
};
